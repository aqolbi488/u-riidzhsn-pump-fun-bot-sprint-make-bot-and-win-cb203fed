// Pump.fun replay bot: guardrail probes + dip-bounce rides.
// Protocol: agent-fun/replay/v2 — the harness sends hello, then one batch per slot;
// this bot answers each batch with orders. Fully deterministic: no clock, no randomness,
// no environment reads. All decisions derive from hello and the batch stream.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables -------------------------------------------------------------
const PROBE_BUY = 11_000_000n; // 0.011 SOL probe buys (just over the 0.01 guardrail floor)
const PROBE_TARGET_MINTS = 22; // distinct mints to round-trip for the guardrail
const PROBE_MIN_RESERVE = 2_000_000_000n; // probe only curves holding >= 2 SOL real
const PROBE_HOLD_SLOTS = 30; // sell a probe after this many slots at the latest
const MAIN_STAKE = 100_000_000n; // 0.10 SOL momentum stake
const MAIN_MIN_RESERVE = 10_000_000_000n; // momentum only on curves holding >= 10 SOL real
const MAIN_MIN_TRADES = 40;
const DIP_MAX_OF_HIGH = 75n; // enter only after price fell to <= 75% of its high
const DIP_MIN_OF_HIGH = 40n; // ...but not below 40% (curve likely dead)
const MAX_MAIN_BUYS = 25; // hard budget on main entries for the whole run
const TAKE_PROFIT_BPS = 2000; // +20% vs entry price (the bounce)
const STOP_LOSS_BPS = 1200; // -12% vs entry price
const TRAIL_DROP_BPS = 1000; // sell if price falls 10% from post-entry peak
const MAX_HOLD_SLOTS = 120; // bounces are fast or never
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10000;

// ---- per-mint bookkeeping ---------------------------------------------------
interface MintInfo {
  firstSlot: number;
  lastSlot: number;
  trades: number;
  buySol: bigint; // recent buy flow (last window of trades)
  sellSol: bigint; // recent sell flow
  flowTrades: number;
  highPrice: bigint; // scaled price high-water mark (vq * 1e12 / vt)
  lastPrice: bigint;
}

interface HeldInfo {
  entryPrice: bigint; // scaled cost per token at fill time
  entrySlot: number;
  peakPrice: bigint;
  isProbe: boolean;
}

const mints = new Map<string, MintInfo>();
const held = new Map<string, HeldInfo>();
const roundTripped = new Set<string>(); // mints with a completed >=0.01 SOL round trip
const probePending = new Set<string>(); // mints with a probe buy in flight or held
const mainTried = new Set<string>(); // mints that already had their one momentum entry
let mainBuysSent = 0;

function scaledPrice(vq: bigint, vt: bigint): bigint {
  if (vt <= 0n) return 0n;
  return (vq * 1_000_000_000_000n) / vt;
}

function observeBatch(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    let info = mints.get(e.mint);
    if (info === undefined) {
      info = {
        firstSlot: e.slot,
        lastSlot: e.slot,
        trades: 0,
        buySol: 0n,
        sellSol: 0n,
        flowTrades: 0,
        highPrice: 0n,
        lastPrice: 0n,
      };
      mints.set(e.mint, info);
    }
    info.lastSlot = e.slot;
    info.trades += 1;
    // rolling flow window: decay old flow every 25 trades on the mint
    if (info.flowTrades >= 25) {
      info.buySol = 0n;
      info.sellSol = 0n;
      info.flowTrades = 0;
    }
    info.flowTrades += 1;
    const sol = BigInt(e.quote_amount);
    if (e.is_buy) info.buySol += sol;
    else info.sellSol += sol;
    const price = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
    if (price > 0n) {
      info.lastPrice = price;
      if (price > info.highPrice) info.highPrice = price;
    }
  }
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.side === 'buy') {
      const tokens = BigInt(f.token_amount);
      const cost = BigInt(f.quote_lamports);
      const entryPrice = tokens > 0n ? (cost * 1_000_000_000_000n) / tokens : 0n;
      held.set(f.mint, {
        entryPrice,
        entrySlot: batch.slot,
        peakPrice: entryPrice,
        isProbe: probePending.has(f.mint),
      });
    }
    if (f.status === 'filled' && f.side === 'sell') {
      held.delete(f.mint);
      probePending.delete(f.mint);
      roundTripped.add(f.mint);
    }
    if (f.status !== 'filled' && f.side === 'buy') {
      probePending.delete(f.mint);
    }
  }
}

function pendingMints(state: BotState): Set<string> {
  const out = new Set<string>();
  for (const p of state.pending.values()) out.add(p.order.mint);
  return out;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  observeBatch(batch);
  const orders: OrderInput[] = [];
  const slot = batch.slot;
  const busy = pendingMints(state);
  const maxOrders = state.hello.caps.max_orders_per_batch;

  // ---- exits first ---------------------------------------------------------
  for (const [mint, pos] of state.positions) {
    if (orders.length >= maxOrders) break;
    if (busy.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const info = held.get(mint);
    const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (info !== undefined && price > info.peakPrice) info.peakPrice = price;

    let sell = false;
    if (info === undefined) {
      sell = true; // position we did not track: exit to stay safe
    } else if (info.isProbe) {
      if (slot - info.entrySlot >= PROBE_HOLD_SLOTS) sell = true;
      else if (info.entryPrice > 0n && price >= (info.entryPrice * 105n) / 100n) sell = true;
      else if (info.entryPrice > 0n && price <= (info.entryPrice * 92n) / 100n) sell = true;
    } else {
      const age = slot - info.entrySlot;
      if (age >= MAX_HOLD_SLOTS) sell = true;
      else if (info.entryPrice > 0n && price >= (info.entryPrice * BigInt(10000 + TAKE_PROFIT_BPS)) / 10000n) sell = true;
      else if (info.entryPrice > 0n && price <= (info.entryPrice * BigInt(10000 - STOP_LOSS_BPS)) / 10000n) sell = true;
      else if (info.peakPrice > info.entryPrice && price <= (info.peakPrice * BigInt(10000 - TRAIL_DROP_BPS)) / 10000n) sell = true;
    }
    if (sell && pos.token_amount > 0n) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      busy.add(mint);
    }
  }

  // ---- entries -------------------------------------------------------------
  const committed = state.committedPositionCount();
  const maxPositions = state.hello.caps.max_open_positions;
  let freeCash = state.freeCashLamports();
  for (const o of orders) freeCash -= state.txFeeLamports();
  let slotsLeft = maxPositions - committed;

  // main candidates: mature curves in a sharp dip off their high (capitulation),
  // bought for the bounce. One entry per mint ever, hard run-wide budget.
  if (slotsLeft > 0 && orders.length < maxOrders && mainBuysSent < MAX_MAIN_BUYS) {
    const cands: Array<{ mint: string; score: bigint }> = [];
    for (const [mint, info] of mints) {
      if (busy.has(mint) || state.positions.has(mint)) continue;
      if (mainTried.has(mint)) continue;
      if (info.trades < MAIN_MIN_TRADES) continue;
      if (info.lastPrice <= 0n || info.highPrice <= 0n) continue;
      if (info.lastPrice > (info.highPrice * DIP_MAX_OF_HIGH) / 100n) continue;
      if (info.lastPrice < (info.highPrice * DIP_MIN_OF_HIGH) / 100n) continue;
      if (info.buySol <= info.sellSol) continue; // dip must be stabilizing: buyers back
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MAIN_MIN_RESERVE) continue;
      // rank by dip depth: deeper dip (still above the dead floor) first
      cands.push({ mint, score: info.highPrice - info.lastPrice });
    }
    cands.sort((a, b) => (a.score === b.score ? (a.mint < b.mint ? -1 : 1) : a.score > b.score ? -1 : 1));
    for (const c of cands) {
      if (slotsLeft <= 0 || orders.length >= maxOrders || mainBuysSent >= MAX_MAIN_BUYS) break;
      const cap = state.maxBuyLamports(c.mint);
      let stake = MAIN_STAKE;
      if (stake > cap) stake = cap;
      if (stake < 10_000_000n) continue;
      if (freeCash < stake + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
      mainTried.add(c.mint);
      mainBuysSent += 1;
      busy.add(c.mint);
      freeCash -= stake + state.txFeeLamports();
      slotsLeft -= 1;
    }
  }

  // guardrail probes: small round trips on fresh liquid mints until target reached
  const doneCount = roundTripped.size;
  if (doneCount < PROBE_TARGET_MINTS && slotsLeft > 0 && orders.length < maxOrders) {
    const probes: string[] = [];
    for (const [mint, info] of mints) {
      if (busy.has(mint) || state.positions.has(mint)) continue;
      if (roundTripped.has(mint) || probePending.has(mint)) continue;
      if (info.trades < 3) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < PROBE_MIN_RESERVE) continue;
      if (state.maxBuyLamports(mint) < PROBE_BUY) continue;
      probes.push(mint);
    }
    probes.sort();
    for (const mint of probes) {
      if (slotsLeft <= 0 || orders.length >= maxOrders) break;
      if (freeCash < PROBE_BUY + state.txFeeLamports()) break;
      orders.push({ side: 'buy', mint, quote_lamports: PROBE_BUY, max_slippage_bps: BUY_SLIPPAGE_BPS });
      probePending.add(mint);
      busy.add(mint);
      freeCash -= PROBE_BUY + state.txFeeLamports();
      slotsLeft -= 1;
    }
  }

  return orders;
}

await runBot({
  onHello(state: BotState) {
    // hello carries caps, fees and the seed; nothing to precompute for this strategy.
    void state.hello.seed;
  },
  onBatch,
});

// Mirror of contract/src/pricing.rs. Any change there must be copied here;
// src/pricing.test.ts checks both against contract/tests/vectors.json.
import { sha256 } from "@noble/hashes/sha2.js";

export const GOODS = ["grain", "iron", "cloth", "spice"] as const;
export type Good = (typeof GOODS)[number];
export const BASE = [100, 400, 250, 900];
export const TOWNS = ["Millbrook", "Ironhold", "Saltmere"] as const;
export const TARGET = [
  [240, 90, 110, 40],
  [150, 180, 100, 50],
  [160, 100, 190, 80],
];
export const REF = [160, 110, 120, 60];
export const BUY_MARKUP_PCT = 105;
export const SELL_MARKDOWN_PCT = 95;
export const MAX_QTY = 100;
export const START_COINS = 1000;
export const RESTART_COINS = 600;
export const TRAVEL_COST = 30;
export const INVESTOR_SHARE_PCT = 50;

// Integer helpers: all values stay well below 2^53, so plain numbers are exact.
const idiv = (a: number, b: number) => Math.floor(a / b);
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export function demand(day: number, town: number, good: number): number {
  const msg = new Uint8Array(12);
  msg.set([0x72, 0x62]); // "rb"
  new DataView(msg.buffer).setBigUint64(2, BigInt(day), true);
  msg[10] = town;
  msg[11] = good;
  return 80 + (sha256(msg)[0] % 51);
}

export function mid(good: number, stock: number, demandPct: number): number {
  const base = BASE[good];
  const raw = idiv(base * REF[good] * demandPct, 100 * Math.max(stock, 1));
  return clamp(raw, Math.max(idiv(base, 4), 1), base * 4);
}

export function buyCost(good: number, stock: number, demandPct: number, qty: number): number | null {
  if (qty > stock) return null;
  let s = stock, total = 0;
  for (let i = 0; i < qty; i++) {
    total += Math.ceil((mid(good, s, demandPct) * BUY_MARKUP_PCT) / 100);
    s -= 1;
  }
  return total;
}

export function sellRevenue(good: number, stock: number, demandPct: number, qty: number): number {
  let s = stock, total = 0;
  for (let i = 0; i < qty; i++) {
    s += 1;
    total += idiv(mid(good, s, demandPct) * SELL_MARKDOWN_PCT, 100);
  }
  return total;
}

export function restock(stock: number, target: number, days: number): number {
  let s = stock;
  for (let i = 0; i < Math.min(days, 60); i++) {
    if (s < target) s += Math.max(idiv(target - s, 5), 1);
    else if (s > target) s -= Math.max(idiv(s - target, 5), 1);
  }
  return s;
}

export function investedTarget(baseTarget: number, invested: number): number {
  return idiv(baseTarget * (100 + Math.min(idiv(invested, 500), 100)), 100);
}

/** Coins shown as "12g 34c" style is confusing; we show plain coins. */
export const fmt = (n: number) => n.toLocaleString("en-US");

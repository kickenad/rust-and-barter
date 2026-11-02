// Rival traders. Each NPC looks at public quotes, picks one action, and says a line
// about it. Rule-based on purpose: deterministic, free, and easy to explain to judges.
// The same policies can drive testnet accounts (scripts/npc-testnet.ts replays each decision as a signed testnet transaction).
import { CART_CAPACITY, GOODS, TOWNS, TRAVEL_COST, buyCost, demand, sellRevenue } from "./pricing";
import type { Sim } from "./sim";

export type Persona = "hauler" | "investor" | "drifter";
export interface Npc { id: string; name: string; persona: Persona; seed: number }

export const NPCS: Npc[] = [
  { id: "npc-oswin", name: "Oswin the Hauler", persona: "hauler", seed: 1 },
  { id: "npc-mags", name: "Old Mags", persona: "investor", seed: 2 },
  { id: "npc-pell", name: "Pell Driftwood", persona: "drifter", seed: 3 },
];

const LINES: Record<string, string[]> = {
  buy: ["{good} is cheap in {town}. I'll take {qty}.", "Nobody wants {good} here. Good, I do.", "{qty} {good}, and don't tell Mags."],
  sell: ["Sold {qty} {good} for {amt}. Ironhold pays for honest work.", "{town} was starving for {good}. Not any more.", "{amt} coins. The road was worth it."],
  travel: ["Off to {town}. Roads are long, margins are thin.", "{town} smells like profit."],
  invest: ["Another {amt} in the {town} merchant. Let the young ones haul.", "Spreads pay. Legs don't."],
  idle: ["Prices are fair today. Fair is bad for business.", "Waiting. A good trader waits."],
};
const pick = (arr: string[], n: number) => arr[Math.abs(n) % arr.length];
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

export interface Plan { good: number; from: number; to: number; qty: number; profit: number }

/** Best single-good route from `from`, net of travel, for a budget. */
export function bestRoute(sim: Sim, from: number, budget: number): Plan | null {
  let best: Plan | null = null;
  const day = sim.day(), here = sim.getMerchant(from);
  for (let g = 0; g < GOODS.length; g++) {
    for (let to = 0; to < TOWNS.length; to++) {
      if (to === from) continue;
      const there = sim.getMerchant(to);
      for (const qty of [3, 5, 10, 15, 20].filter((q) => q <= CART_CAPACITY)) {
        const cost = buyCost(g, here.stock[g], demand(day, from, g), qty);
        if (cost === null || cost + TRAVEL_COST > budget) continue;
        const profit = sellRevenue(g, there.stock[g], demand(day, to, g), qty) - cost - TRAVEL_COST;
        if (!best || profit > best.profit) best = { good: g, from, to, qty, profit };
      }
    }
  }
  return best && best.profit > 0 ? best : null;
}

/** One NPC turn. Returns the line it says (also logged to sim.events). */
export function npcTurn(sim: Sim, npc: Npc): string {
  if (!sim.getPlayer(npc.id)) sim.join(npc.id);
  const p = sim.getPlayer(npc.id)!;
  const r = npc.seed * 7919 + sim.day() * 31 + p.trades;
  const say = (k: string, v: Record<string, string | number>) => {
    const line = `${npc.name}: “${fill(pick(LINES[k], r), v)}”`;
    sim.events.push({ day: sim.day(), who: npc.id, kind: "say", text: line });
    return line;
  };
  if (sim.day() < p.arrives_day) return `${npc.name} is on the road to ${TOWNS[p.town]}.`;
  try {
    // Carrying goods? Sell them where they fetch the most (travel first if needed).
    const held = p.goods.findIndex((n) => n > 0);
    if (held >= 0) {
      const day = sim.day();
      let bestT = p.town, bestRev = -1;
      for (let t = 0; t < 3; t++) {
        const rev = sellRevenue(held, sim.getMerchant(t).stock[held], demand(day, t, held), p.goods[held]) - (t === p.town ? 0 : TRAVEL_COST);
        if (rev > bestRev) { bestRev = rev; bestT = t; }
      }
      const hereRev = sellRevenue(held, sim.getMerchant(p.town).stock[held], demand(day, p.town, held), p.goods[held]);
      // Only move on if it beats selling here by a clear margin; stops NPCs bouncing between towns as demand drifts.
      if (bestT !== p.town && bestRev > hereRev * 1.1) { sim.travel(npc.id, bestT); return say("travel", { town: TOWNS[bestT] }); }
      const before = sim.getPlayer(npc.id)!.coins;
      sim.sell(npc.id, GOODS[held], p.goods[held], 0);
      return say("sell", { qty: p.goods[held], good: GOODS[held], town: TOWNS[p.town], amt: sim.getPlayer(npc.id)!.coins - before });
    }
    if (npc.persona === "investor" && p.coins >= 200 && sim.getStake(npc.id, p.town) < 1500) {
      const amt = Math.floor(p.coins / 2);
      sim.invest(npc.id, amt);
      return say("invest", { amt, town: TOWNS[p.town] });
    }
    if (npc.persona === "investor") { sim.claim(npc.id, p.town); return say("idle", {}); }
    const budget = npc.persona === "drifter" ? Math.floor(p.coins / 3) : p.coins;
    const plan = bestRoute(sim, p.town, budget);
    if (plan && (npc.persona === "hauler" || r % 3 !== 0)) {
      sim.buy(npc.id, GOODS[plan.good], plan.qty, Number.MAX_SAFE_INTEGER);
      return say("buy", { qty: plan.qty, good: GOODS[plan.good], town: TOWNS[p.town] });
    }
    if (npc.persona === "drifter" && p.coins > TRAVEL_COST * 3 && r % 4 === 0) {
      const to = (p.town + 1 + (r % 2)) % 3;
      sim.travel(npc.id, to);
      return say("travel", { town: TOWNS[to] });
    }
    if (p.coins < 100 && p.goods.every((g) => g === 0)) { sim.declareBankruptcy(npc.id); return `${npc.name} went bankrupt.`; }
    return say("idle", {});
  } catch (e) {
    return `${npc.name} hesitated (${(e as Error).message}).`;
  }
}

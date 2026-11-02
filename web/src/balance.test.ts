import { describe, expect, it } from "vitest";
import { Sim } from "./sim";
import { NPCS, npcTurn } from "./npc";
import { START_COINS } from "./pricing";

// Guard against runaway rivals: after a 60-day season the best NPC should be ahead,
// but not by orders of magnitude (it was ~110x before cart capacity, travel time and flatter spreads).
describe("economy balance", () => {
  it("keeps the best rival between 2x and 10x of starting coins after 60 days", () => {
    const sim = new Sim();
    for (let d = 0; d < 60; d++) { for (let i = 0; i < 8; i++) for (const n of NPCS) npcTurn(sim, n); sim.advance(1); }
    const best = Math.max(...NPCS.map((n) => sim.netWorth(n.id)));
    expect(best).toBeGreaterThan(2 * START_COINS);
    expect(best).toBeLessThan(10 * START_COINS);
  });
});

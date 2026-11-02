// Fast-forward balance check: N days of NPC play, then print net worth by persona.
// Run: npx tsx scripts/balance.ts [days] [turnsPerDay]
import { NPCS, npcTurn } from "../src/npc";
import { Sim } from "../src/sim";
import { TOWNS } from "../src/pricing";

const days = Number(process.argv[2] ?? 60), turns = Number(process.argv[3] ?? 4);
const sim = new Sim();
for (let d = 0; d < days; d++) {
  for (let i = 0; i < turns; i++) for (const n of NPCS) npcTurn(sim, n);
  sim.advance(1);
}
console.log(`after ${days} days x ${turns} turns`);
for (const n of NPCS) {
  const p = sim.getPlayer(n.id)!;
  console.log(`${n.name.padEnd(18)} ${n.persona.padEnd(9)} net worth ${sim.netWorth(n.id)} (coins ${p.coins}, trades ${p.trades}, bankrupt ${p.bankruptcies})`);
}
sim.merchants.forEach((m, t) => console.log(`${TOWNS[t].padEnd(10)} house profit ${m.house_profit}, invested ${m.invested}, stock ${m.stock.join("/")}`));

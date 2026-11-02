// Runs the three rival traders as real testnet accounts, using the same policies as practice mode.
//   npx tsx scripts/npc-testnet.ts [days=10]
// Accounts come from NEAR's testnet faucet; keys live in ../../secrets/npcs.json (mode 600), never printed.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ChainPlayer, createGuestAccount, getConfig, secondsToNextDay, txUrl, view } from "../src/chain";
import { NPCS, npcTurn } from "../src/npc";
import { RecordingSim, mirrorSim } from "../src/mirror";
import type { Merchant, Player } from "../src/sim";

const FILE = new URL("../../../secrets/npcs.json", import.meta.url).pathname;
const days = Number(process.argv[2] ?? 10);
const sleep = (s: number) => new Promise((ok) => setTimeout(ok, s * 1000));

const keys: Record<string, { accountId: string; secret: string }> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
for (const n of NPCS) {
  if (keys[n.id]) continue;
  keys[n.id] = await createGuestAccount(`rb-${n.id}`);
  writeFileSync(FILE, JSON.stringify(keys), { mode: 0o600 }); chmodSync(FILE, 0o600);
  console.log(`created ${keys[n.id].accountId} for ${n.name}`);
}
const cfg = await getConfig();
for (let d = 0; d < days; d++) {
  const day = await view<number>("day");
  const merchants = await Promise.all([0, 1, 2].map((town) => view<Merchant>("get_merchant", { town })));
  for (const n of NPCS) {
    const acct = keys[n.id].accountId, chainP = new ChainPlayer(acct, keys[n.id].secret);
    const p = await view<Player | null>("get_player", { account_id: acct });
    const stakes = p ? await view<[number, number][]>("get_stakes", { account_id: acct }) : [];
    const sim = mirrorSim(day, merchants, p ? [[n.id, p]] : [], p ? { [n.id]: stakes } : {}, RecordingSim);
    const line = npcTurn(sim, n);
    for (const c of sim.calls) {
      try { const { hash } = await chainP.call(c.method, c.args); console.log(`day ${day} ${n.name}: ${c.method} ${JSON.stringify(c.args)} ${txUrl(hash)}`); }
      catch (e) { console.log(`day ${day} ${n.name}: ${c.method} refused: ${(e as Error).message}`); }
    }
    console.log(`        ${line}`);
  }
  if (d < days - 1) await sleep(secondsToNextDay(cfg) + 2);
}

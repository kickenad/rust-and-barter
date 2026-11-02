// End-to-end check against the deployed testnet contract.
//   npx tsx scripts/e2e-testnet.ts            (uses a fresh faucet guest account, like the browser does)
// Keys are written to ../../secrets/ (mode 600) and never printed.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { CONTRACT, ChainPlayer, accountUrl, createGuestAccount, getConfig, loadState, secondsToNextDay, txUrl, view } from "../src/chain";
import type { Player, Quote } from "../src/sim";

const SECRETS = new URL("../../../secrets/", import.meta.url).pathname;
const sleep = (s: number) => new Promise((ok) => setTimeout(ok, s * 1000));
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error("FAIL: " + msg); console.log("  ok -", msg); };

const cfg = await getConfig();
console.log(`contract ${CONTRACT} · day ${await view<number>("day")} · day length ${Number(cfg.day_ns) / 1e9}s`);

const guest = await createGuestAccount("rb-e2e");
mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
const keyFile = `${SECRETS}${guest.accountId}.json`;
writeFileSync(keyFile, JSON.stringify({ account_id: guest.accountId, private_key: guest.secret }), { mode: 0o600 });
chmodSync(keyFile, 0o600);
console.log(`guest account ${guest.accountId} (${accountUrl(guest.accountId)}) · key saved to secrets/, not printed`);
const me = new ChainPlayer(guest.accountId, guest.secret);

const j = await me.call<Player>("join");
ok(j.result.coins === 1000 && j.result.town === 0, `join -> 1000 coins in Millbrook (${txUrl(j.hash)})`);

const qs = await view<Quote[]>("quotes", { town: 0 });
const grain = qs.find((q) => q.good === "grain")!;
const b = await me.call<Player>("buy", { good: "grain", qty: 10, max_total: 100000 });
ok(b.result.goods[0] === 10 && b.result.coins < 1000, `buy 10 grain for ${1000 - b.result.coins} (quote ${grain.buy_one}/unit) (${txUrl(b.hash)})`);

try { await me.call("buy", { good: "grain", qty: 6, max_total: 100000 }); ok(false, "cart limit"); }
catch (e) { ok(String((e as Error).message).includes("cart holds 15"), `cart limit enforced: "${(e as Error).message}"`); }

const t = await me.call<Player>("travel", { town: 1 });
ok(t.result.town === 1, `travel to Ironhold, arrives day ${t.result.arrives_day} (${txUrl(t.hash)})`);
try { await me.call("sell", { good: "grain", qty: 10, min_total: 0 }); ok(false, "on the road"); }
catch (e) { ok(String((e as Error).message).includes("still on the road"), `no trading on the road: "${(e as Error).message}"`); }

const wait = secondsToNextDay(cfg) + 3;
console.log(`  waiting ${wait}s for the next game day…`);
await sleep(wait);
const s = await me.call<Player>("sell", { good: "grain", qty: 10, min_total: 0 });
ok(s.result.goods[0] === 0, `sell 10 grain in Ironhold -> ${s.result.coins} coins (${txUrl(s.hash)})`);

const st = await loadState(guest.accountId, cfg);
const row = st.board.find((r) => r.id === guest.accountId);
ok(row && row.worth === s.result.coins, `leaderboard shows ${guest.accountId} at ${row?.worth}`);
console.log(`PASS · net ${s.result.coins - 1000 >= 0 ? "+" : ""}${s.result.coins - 1000} coins on one grain run`);

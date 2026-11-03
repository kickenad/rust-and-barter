// Testnet backend: JSON-RPC views + near-api-js signed calls against the deployed contract.
// Works in the browser and in Node (scripts/e2e-testnet.ts, scripts/npc-testnet.ts).
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider, teraToGas } from "near-api-js";
import type { Merchant, Player, Quote } from "./sim";
import { worthOf } from "./worth";

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const CONTRACT = env.VITE_CONTRACT ?? "rustbarter-8562c6.testnet";
export const RPC = env.VITE_RPC ?? "https://rpc.testnet.fastnear.com";
export const FAUCET = "https://helper.nearprotocol.com/account";
export const EXPLORER = "https://testnet.nearblocks.io";
export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

export interface Config { day_ns: string | number; genesis_ns: string | number; travel_days: number; cart_capacity: number; [k: string]: unknown }

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

// Public testnet RPCs rate-limit busy clients; rotate to the next one on any failure.
const RPCS = [RPC, ...["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"].filter((u) => u !== RPC)];
let rpcIdx = 0;
export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await viewAt<T>(method, args)).value;
}

/**
 * A view call that also returns the block height it was evaluated at. Pass `height` to read at exactly that
 * block, so one screen refresh never mixes state from different blocks or from a node that lags behind.
 */
export async function viewAt<T>(method: string, args: Record<string, unknown> = {}, height?: number): Promise<{ value: T; height: number }> {
  let lastErr: unknown;
  // Two passes over the RPC list, with a short pause between passes (rate limits reset quickly).
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    if (attempt === RPCS.length) await new Promise((r) => setTimeout(r, 1500));
    const url = RPCS[rpcIdx % RPCS.length];
    let j;
    try {
      const at = height === undefined ? { finality: "optimistic" } : { block_id: height };
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", ...at, account_id: CONTRACT, method_name: method, args_base64: b64(JSON.stringify(args)) } }),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      j = await res.json();
      // A node that has not seen the block yet (or is not synced) is not an answer: try the next node.
      if (j.error && /UNKNOWN_BLOCK|NOT_SYNCED|NO_SYNCED|GARBAGE_COLLECTED|TIMEOUT|INTERNAL/i.test(JSON.stringify(j.error))) throw new Error(`RPC ${j.error.cause?.name ?? "error"}`);
    } catch (e) { lastErr = e; rpcIdx++; continue; }
    if (j.error || j.result?.error) throw new Error(cleanError(String(j.result?.error ?? JSON.stringify(j.error))));
    return { value: JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T, height: j.result.block_height };
  }
  throw lastErr instanceof Error ? lastErr : new Error("testnet RPC unreachable");
}

/** Turn a node/near-api-js error into the contract's own panic message where possible. */
export function cleanError(e: unknown): string {
  const s = e instanceof Error ? `${e.message} ${JSON.stringify((e as { cause?: unknown }).cause ?? "")}` : String(e);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/) ?? s.match(/panicked at [^:]+:\d+:\d+:\s*([^"\\]+)/);
  if (m) return m[1].trim();
  if (/does not exist/i.test(s)) return "account does not exist on testnet";
  return s.slice(0, 200);
}

export interface ChainState { height: number; day: number; config: Config; me: Player | null; stakes: [number, number][]; merchants: Merchant[]; quotes: Quote[]; board: { id: string; worth: number; bankruptcies: number }[] }

export const getConfig = () => view<Config>("config");

/** Seconds until the next game day, from the contract's genesis and day length. */
export function secondsToNextDay(cfg: Config, nowMs = Date.now()) {
  const dayMs = Number(cfg.day_ns) / 1e6, gen = Number(cfg.genesis_ns) / 1e6;
  return Math.max(0, Math.ceil((dayMs - ((nowMs - gen) % dayMs)) / 1000));
}

/** The game day by the local clock (the contract uses the block timestamp, which tracks real time closely). */
export function localDay(cfg: Config, nowMs = Date.now()) {
  return Math.floor((nowMs - Number(cfg.genesis_ns) / 1e6) / (Number(cfg.day_ns) / 1e6));
}

/** A signer for one account. Secret key never leaves this object except via exportSecret(). */
export class ChainPlayer {
  readonly account: Account;
  constructor(readonly accountId: string, private secret: string) {
    this.account = new Account(accountId, new JsonRpcProvider({ url: RPC }), KeyPairSigner.fromSecretKey(secret as never));
  }
  exportSecret() { return this.secret; }
  /** Calls a change method. Returns the parsed result and the tx hash. Throws Error(panic message). */
  async call<T>(methodName: string, args: Record<string, unknown> = {}): Promise<{ result: T; hash: string }> {
    let out;
    try {
      out = await this.account.callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: teraToGas("50") });
    } catch (e) { throw new Error(cleanError(e)); }
    const hash = (out as { transaction?: { hash?: string } }).transaction?.hash ?? "";
    const status = (out as { status?: { SuccessValue?: string; Failure?: unknown } }).status ?? {};
    if (status.Failure) throw new Error(cleanError(JSON.stringify(status.Failure)));
    const raw = status.SuccessValue ? unb64(status.SuccessValue) : "";
    return { result: (raw ? JSON.parse(raw) : undefined) as T, hash };
  }
}

/** Creates a fresh, throwaway testnet account through NEAR's public faucet helper (testnet only, no real value). */
export async function createGuestAccount(prefix = "rb-player"): Promise<{ accountId: string; secret: string }> {
  const kp = KeyPair.fromRandom("ed25519");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
  const accountId = `${prefix}-${rand}.testnet`;
  const res = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!res.ok) throw new Error(`testnet faucet refused (${res.status}): ${(await res.text()).slice(0, 120)}`);
  // wait until the account is visible to RPC
  for (let i = 0; i < 20; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }) });
    if (!(await r.json()).error) break;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return { accountId, secret: kp.toString() };
}

/** Everything the UI needs in one round of parallel views. */
// Other players' stakes only matter for leaderboard net worth, so fetch them at most once per game day,
// a few at a time, to stay under public RPC rate limits. Your own stakes are fetched on every refresh.
// Other players' stakes only change when they invest or divest, and only feed the leaderboard, so they are
// re-read at most every few minutes. Your own stakes are read on every refresh.
const STAKE_TTL_MS = 5 * 60_000;
const stakeCache = new Map<string, { at: number; s: [number, number][] }>();
async function stakesFor(ids: string[]): Promise<[number, number][][]> {
  const todo = ids.filter((id) => Date.now() - (stakeCache.get(id)?.at ?? 0) > STAKE_TTL_MS);
  for (let i = 0; i < todo.length; i += 3) {
    const chunk = todo.slice(i, i + 3);
    const got = await Promise.all(chunk.map((id) => view<[number, number][]>("get_stakes", { account_id: id }).catch(() => null)));
    chunk.forEach((id, k) => { if (got[k]) stakeCache.set(id, { at: Date.now(), s: got[k]! }); });
  }
  return ids.map((id) => stakeCache.get(id)?.s ?? [[0, 0], [0, 0], [0, 0]]);
}

async function allPlayers() {
  const out: [string, Player][] = [];
  for (let from = 0; from < 500; from += 100) {
    const page = await view<[string, Player][]>("get_players", { from_index: from, limit: 100 });
    out.push(...page); if (page.length < 100) break;
  }
  return out;
}

// The leaderboard is the expensive part (every player, plus their stakes). It loads in the background, at most
// every 45 s, and never holds up the numbers you trade on.
type BoardRow = { id: string; worth: number; bankruptcies: number };
let boardCache: { at: number; players: [string, Player][]; stakes: [number, number][][] } | null = null;
let boardLoading: Promise<void> | null = null;
function refreshBoard(force = false) {
  if (boardLoading || (!force && boardCache && Date.now() - boardCache.at < 45_000)) return;
  boardLoading = (async () => {
    const players = await allPlayers();
    boardCache = { at: Date.now(), players, stakes: await stakesFor(players.map(([id]) => id)) };
  })().catch(() => {}).finally(() => { boardLoading = null; });
}

export async function loadState(me: string | null, cfg: Config): Promise<ChainState> {
  // Everything the trade panel shows is read at one block height, so it is a consistent snapshot.
  const { value: day, height } = await viewAt<number>("day");
  const at = <T,>(m: string, a: Record<string, unknown> = {}) => viewAt<T>(m, a, height).then((r) => r.value);
  const mine = me ? await at<Player | null>("get_player", { account_id: me }) : null;
  const [merchants, quotes, myStakes] = await Promise.all([
    Promise.all([0, 1, 2].map((town) => at<Merchant>("get_merchant", { town }))),
    at<Quote[]>("quotes", { town: mine?.town ?? 0 }),
    me && mine ? at<[number, number][]>("get_stakes", { account_id: me }) : Promise.resolve(null),
  ]);
  refreshBoard(!!me && !!mine && !boardCache?.players.some(([id]) => id === me));
  const rows: BoardRow[] = (boardCache?.players ?? []).map(([id, p], i) => ({ id, worth: worthOf(p, boardCache!.stakes[i], merchants, day), bankruptcies: p.bankruptcies }));
  const board = rows.filter((r) => r.id !== me);
  if (me && mine) board.push({ id: me, worth: worthOf(mine, myStakes ?? [[0, 0], [0, 0], [0, 0]], merchants, day), bankruptcies: mine.bankruptcies });
  return { height, day, config: cfg, me: mine, stakes: myStakes ?? [[0, 0], [0, 0], [0, 0]], merchants, quotes, board };
}

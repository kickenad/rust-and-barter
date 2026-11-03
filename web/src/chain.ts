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
  let lastErr: unknown;
  // Two passes over the RPC list, with a short pause between passes (rate limits reset quickly).
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    if (attempt === RPCS.length) await new Promise((r) => setTimeout(r, 1500));
    const url = RPCS[rpcIdx % RPCS.length];
    let j;
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: b64(JSON.stringify(args)) } }),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      j = await res.json();
    } catch (e) { lastErr = e; rpcIdx++; continue; }
    if (j.error || j.result?.error) throw new Error(cleanError(String(j.result?.error ?? JSON.stringify(j.error))));
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
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

export interface ChainState { day: number; config: Config; me: Player | null; stakes: [number, number][]; merchants: Merchant[]; quotes: Quote[]; board: { id: string; worth: number; bankruptcies: number }[] }

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
const stakeCache = new Map<string, { day: number; s: [number, number][] }>();
async function stakesFor(ids: string[], me: string | null, day: number): Promise<[number, number][][]> {
  const todo = ids.filter((id) => id === me || stakeCache.get(id)?.day !== day);
  for (let i = 0; i < todo.length; i += 4) {
    const chunk = todo.slice(i, i + 4);
    const got = await Promise.all(chunk.map((id) => view<[number, number][]>("get_stakes", { account_id: id }).catch(() => null)));
    chunk.forEach((id, k) => { if (got[k]) stakeCache.set(id, { day, s: got[k]! }); });
  }
  return ids.map((id) => stakeCache.get(id)?.s ?? [[0, 0], [0, 0], [0, 0]]);
}

export async function loadState(me: string | null, cfg: Config): Promise<ChainState> {
  const [day, merchants, players] = await Promise.all([
    view<number>("day"),
    Promise.all([0, 1, 2].map((town) => view<Merchant>("get_merchant", { town }))),
    view<[string, Player][]>("get_players", { from_index: 0, limit: 50 }),
  ]);
  const mine = me ? players.find(([id]) => id === me)?.[1] ?? null : null;
  // Quotes right after the player list, so they come from the same game day as `day` whenever possible.
  const quotes = await view<Quote[]>("quotes", { town: mine?.town ?? 0 });
  const stakesAll = await stakesFor(players.map(([id]) => id), me, day);
  const board = players.map(([id, p], i) => ({ id, worth: worthOf(p, stakesAll[i], merchants, day), bankruptcies: p.bankruptcies }));
  const myIdx = players.findIndex(([id]) => id === me);
  return { day, config: cfg, me: mine, stakes: myIdx >= 0 ? stakesAll[myIdx] : [[0, 0], [0, 0], [0, 0]], merchants, quotes, board };
}

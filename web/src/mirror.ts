// Build a local Sim that mirrors on-chain state, so the same tip engine and NPC policies
// can run against testnet. Only decisions are made locally; every move is a signed tx.
import { Sim, type Merchant, type Player } from "./sim";

export function mirrorSim<S extends Sim = Sim>(day: number, merchants: Merchant[], players: [string, Player][] = [], stakes: Record<string, [number, number][]> = {}, Cls: new (d: number) => S = Sim as never): S {
  const s = new Cls(day);
  s.merchants = merchants.map((m) => ({ ...m, stock: [...m.stock], acc_per_share: BigInt(Math.trunc(Number(m.acc_per_share))) }));
  for (const [id, p] of players) s.players.set(id, structuredClone(p));
  for (const [id, st] of Object.entries(stakes)) st.forEach(([amount], t) => { if (amount) s.stakes.set(`${id}|${t}`, { amount, debt: BigInt(amount) * s.merchants[t].acc_per_share }); });
  return s;
}

/** A Sim that records every state-changing call so it can be replayed on chain. */
export class RecordingSim extends Sim {
  calls: { method: string; args: Record<string, unknown> }[] = [];
  override join(who: string) { this.calls.push({ method: "join", args: {} }); return super.join(who); }
  override travel(who: string, town: number) { const r = super.travel(who, town); this.calls.push({ method: "travel", args: { town } }); return r; }
  override buy(who: string, good: string, qty: number, maxTotal: number) { const before = this.getPlayer(who)!.coins; const r = super.buy(who, good, qty, maxTotal); this.calls.push({ method: "buy", args: { good, qty, max_total: Math.ceil((before - r.coins) * 1.2) } }); return r; }
  override sell(who: string, good: string, qty: number, minTotal: number) { const r = super.sell(who, good, qty, minTotal); this.calls.push({ method: "sell", args: { good, qty, min_total: minTotal } }); return r; }
  override invest(who: string, amount: number) { const r = super.invest(who, amount); this.calls.push({ method: "invest", args: { amount } }); return r; }
  override claim(who: string, town: number) { const r = super.claim(who, town); if (r > 0) this.calls.push({ method: "claim", args: { town } }); return r; }
  override declareBankruptcy(who: string) { const r = super.declareBankruptcy(who); this.calls.push({ method: "declare_bankruptcy", args: {} }); return r; }
}

// Off-chain mirror of contract/src/lib.rs. It powers three things:
//  1. "Practice mode" in the browser, so judges can play with no wallet.
//  2. The fast-forward balance simulator (scripts/balance.ts).
//  3. NPC rival traders (npc.ts) that run against either backend.
// Rules and error messages are kept identical to the contract.
import {
  BUY_MARKUP_PCT, GOODS, INVESTOR_SHARE_PCT, MAX_QTY, RESTART_COINS, SELL_MARKDOWN_PCT,
  START_COINS, TARGET, TOWNS, TRAVEL_COST, buyCost, demand, investedTarget, mid, restock, sellRevenue,
} from "./pricing";

const ACC = 1_000_000_000_000n;

export interface Player { coins: number; goods: number[]; town: number; bankruptcies: number; trades: number; joined_day: number }
export interface Merchant { stock: number[]; last_day: number; invested: number; acc_per_share: bigint; house_profit: number }
export interface Quote { town: number; good: string; stock: number; demand_pct: number; mid: number; buy_one: number; sell_one: number }
export interface GameEvent { day: number; who: string; kind: string; text: string }

export class GameError extends Error {}
const require = (ok: boolean, msg: string) => { if (!ok) throw new GameError(msg); };
const goodId = (g: string) => { const i = GOODS.indexOf(g as never); require(i >= 0, "unknown good"); return i; };

export class Sim {
  players = new Map<string, Player>();
  merchants: Merchant[] = TARGET.map((t) => ({ stock: [...t], last_day: 0, invested: 0, acc_per_share: 0n, house_profit: 0 }));
  stakes = new Map<string, { amount: number; debt: bigint }>();
  events: GameEvent[] = [];
  constructor(public today = 0) {}

  day() { return this.today; }
  advance(days = 1) { this.today += days; }

  getPlayer(who: string) { const p = this.players.get(who); return p ? structuredClone(p) : null; }
  getMerchant(town: number) { const m = structuredClone(this.merchants[town]); this.roll(town, m); return m; }
  quotes(town: number): Quote[] {
    const m = this.getMerchant(town);
    return GOODS.map((good, g) => {
      const d = demand(this.today, town, g), s = m.stock[g];
      return { town, good, stock: s, demand_pct: d, mid: mid(g, s, d), buy_one: buyCost(g, s, d, 1) ?? 0, sell_one: sellRevenue(g, s, d, 1) };
    });
  }
  pendingDividends(who: string, town: number) {
    const st = this.stakes.get(`${who}|${town}`);
    return st ? Number((BigInt(st.amount) * this.merchants[town].acc_per_share - st.debt) / ACC) : 0;
  }
  getStake(who: string, town: number) { return this.stakes.get(`${who}|${town}`)?.amount ?? 0; }

  join(who: string) {
    require(!this.players.has(who), "already joined");
    const p: Player = { coins: START_COINS, goods: [0, 0, 0, 0], town: 0, bankruptcies: 0, trades: 0, joined_day: this.today };
    this.players.set(who, p);
    this.log(who, "join", `${who} opened a stall in ${TOWNS[0]}`);
    return structuredClone(p);
  }
  travel(who: string, town: number) {
    require(town >= 0 && town < TOWNS.length, "no such town");
    const p = this.player(who);
    require(p.town !== town, "already there");
    require(p.coins >= TRAVEL_COST, "not enough coins to travel");
    p.coins -= TRAVEL_COST; p.town = town;
    this.log(who, "travel", `${who} travelled to ${TOWNS[town]}`);
    return structuredClone(p);
  }
  buy(who: string, good: string, qty: number, maxTotal: number) {
    require(qty > 0 && qty <= MAX_QTY, "qty 1..100");
    const g = goodId(good), p = this.player(who), t = p.town, m = this.merchants[t];
    this.roll(t, m);
    const cost = buyCost(g, m.stock[g], demand(this.today, t, g), qty);
    require(cost !== null, "merchant is out of stock");
    require(cost! <= maxTotal, "price moved above your limit");
    require(p.coins >= cost!, "not enough coins");
    this.bookSpread(m, cost! - Math.floor((cost! * 100) / BUY_MARKUP_PCT));
    m.stock[g] -= qty; p.coins -= cost!; p.goods[g] += qty; p.trades += 1;
    this.log(who, "buy", `${who} bought ${qty} ${good} in ${TOWNS[t]} for ${cost}`);
    return structuredClone(p);
  }
  sell(who: string, good: string, qty: number, minTotal: number) {
    require(qty > 0 && qty <= MAX_QTY, "qty 1..100");
    const g = goodId(good), p = this.player(who);
    require(p.goods[g] >= qty, "you don't have that many");
    const t = p.town, m = this.merchants[t];
    this.roll(t, m);
    const revenue = sellRevenue(g, m.stock[g], demand(this.today, t, g), qty);
    require(revenue >= minTotal, "price moved below your limit");
    this.bookSpread(m, Math.max(Math.floor((revenue * 100) / SELL_MARKDOWN_PCT) - revenue, 0));
    m.stock[g] += qty; p.coins += revenue; p.goods[g] -= qty; p.trades += 1;
    this.log(who, "sell", `${who} sold ${qty} ${good} in ${TOWNS[t]} for ${revenue}`);
    return structuredClone(p);
  }
  mtTransfer(who: string, receiver: string, good: string, amount: number) {
    const g = goodId(good);
    require(who !== receiver, "cannot transfer to yourself");
    require(amount > 0, "amount must be positive");
    const a = this.player(who), b = this.player(receiver);
    require(a.goods[g] >= amount, "insufficient balance");
    a.goods[g] -= amount; b.goods[g] += amount;
    this.log(who, "transfer", `${who} gave ${amount} ${good} to ${receiver}`);
  }
  invest(who: string, amount: number) {
    require(amount > 0, "amount must be positive");
    const p = this.player(who);
    require(p.coins >= amount, "not enough coins");
    const t = p.town; this.claimInner(who, t, p);
    const m = this.merchants[t], key = `${who}|${t}`;
    const st = this.stakes.get(key) ?? { amount: 0, debt: 0n };
    st.amount += amount; st.debt = BigInt(st.amount) * m.acc_per_share;
    m.invested += amount; p.coins -= amount; this.stakes.set(key, st);
    this.log(who, "invest", `${who} invested ${amount} in the ${TOWNS[t]} merchant`);
    return st.amount;
  }
  divest(who: string, town: number) {
    const p = this.player(who);
    require(p.town === town, "travel to that town to divest");
    this.claimInner(who, town, p);
    const key = `${who}|${town}`, st = this.stakes.get(key);
    require(!!st, "no stake");
    this.stakes.delete(key); this.merchants[town].invested -= st!.amount; p.coins += st!.amount;
    this.log(who, "divest", `${who} pulled ${st!.amount} out of ${TOWNS[town]}`);
    return st!.amount;
  }
  claim(who: string, town: number) { return this.claimInner(who, town, this.player(who)); }
  declareBankruptcy(who: string) {
    const p = this.player(who);
    require(p.coins < 100 && p.goods.every((g) => g === 0), "you are not broke");
    require([0, 1, 2].every((t) => this.getStake(who, t) === 0), "divest first");
    p.coins = RESTART_COINS; p.bankruptcies += 1;
    this.log(who, "bankrupt", `${who} went bankrupt (x${p.bankruptcies}) and starts again`);
    return structuredClone(p);
  }

  /** Net worth: coins + stakes + goods valued at the best current sell price. */
  netWorth(who: string) {
    const p = this.players.get(who); if (!p) return 0;
    let w = p.coins;
    for (let t = 0; t < 3; t++) w += this.getStake(who, t) + this.pendingDividends(who, t);
    p.goods.forEach((n, g) => {
      if (n) w += Math.max(...[0, 1, 2].map((t) => { const m = this.getMerchant(t); return sellRevenue(g, m.stock[g], demand(this.today, t, g), n); }));
    });
    return w;
  }

  private player(who: string) { const p = this.players.get(who); require(!!p, "join first"); return p!; }
  private roll(town: number, m: Merchant) {
    if (this.today > m.last_day) {
      for (let g = 0; g < 4; g++) m.stock[g] = restock(m.stock[g], investedTarget(TARGET[town][g], m.invested), this.today - m.last_day);
      m.last_day = this.today;
    }
  }
  private bookSpread(m: Merchant, spread: number) {
    const toInv = Math.floor((spread * INVESTOR_SHARE_PCT) / 100);
    if (m.invested > 0 && toInv > 0) { m.acc_per_share += (BigInt(toInv) * ACC) / BigInt(m.invested); m.house_profit += spread - toInv; }
    else m.house_profit += spread;
  }
  private claimInner(who: string, town: number, p: Player) {
    const st = this.stakes.get(`${who}|${town}`); if (!st) return 0;
    const acc = this.merchants[town].acc_per_share;
    const owed = Number((BigInt(st.amount) * acc - st.debt) / ACC);
    st.debt = BigInt(st.amount) * acc; p.coins += owed; return owed;
  }
  /** Display names for event text (NPC ids -> names). */
  names: Record<string, string> = {};
  private log(who: string, kind: string, text: string) {
    for (const [id, name] of Object.entries(this.names)) text = text.split(id).join(name);
    this.events.push({ day: this.today, who, kind, text });
    if (this.events.length > 200) this.events.shift();
  }
}

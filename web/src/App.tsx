import { useMemo, useReducer, useState } from "react";
import { GOODS, TOWNS, TRAVEL_COST, buyCost, demand, fmt, sellRevenue } from "./pricing";
import { Sim } from "./sim";
import { NPCS, bestRoute, npcTurn } from "./npc";

const ME = "you";
const ICON: Record<string, string> = { grain: "🌾", iron: "⛏️", cloth: "🧵", spice: "🌶️" };
const BLURB = ["Grain town on the river", "Mining town in the hills", "Port, where cloth and spice arrive by sea"];

function newWorld() {
  const s = new Sim();
  s.names = Object.fromEntries([[ME, "You"], ...NPCS.map((n) => [n.id, n.name])]);
  s.join(ME);
  for (const n of NPCS) npcTurn(s, n);
  return s;
}

export default function App() {
  const sim = useMemo(newWorld, []);
  const [, rerender] = useReducer((x) => x + 1, 0);
  const [qty, setQty] = useState(5);
  const [msg, setMsg] = useState<string | null>(null);
  const me = sim.getPlayer(ME)!;
  const quotes = sim.quotes(me.town);

  const act = (f: () => unknown, after?: string) => {
    try { f(); setMsg(after ?? null); } catch (e) { setMsg((e as Error).message); }
    rerender();
  };
  const endDay = () => act(() => {
    for (let i = 0; i < 2; i++) for (const n of NPCS) npcTurn(sim, n);
    sim.advance(1);
  }, "A new day. Merchants restocked and prices shifted.");

  const hint = bestRoute(sim, me.town, me.coins);
  const board = [ME, ...NPCS.map((n) => n.id)]
    .map((id) => ({ id, name: id === ME ? "You" : NPCS.find((n) => n.id === id)!.name, worth: sim.netWorth(id), p: sim.getPlayer(id)! }))
    .sort((a, b) => b.worth - a.worth);

  return (
    <main>
      <header>
        <h1>Rust &amp; Barter</h1>
        <p className="sub">
          Buy low in one town, haul it, sell high in another. Practice mode runs in your browser using the same rules as
          the <a href="https://testnet.nearblocks.io/">NEAR testnet</a> contract. <b>Coins are game points with no real value.</b>
        </p>
      </header>

      <section className="status">
        <div><span>Day</span><b>{sim.day()}</b></div>
        <div><span>Coins</span><b>{fmt(me.coins)}</b></div>
        <div><span>Net worth</span><b>{fmt(sim.netWorth(ME))}</b></div>
        <div><span>Cart</span><b>{me.goods.map((n, g) => (n ? `${ICON[GOODS[g]]}${n}` : "")).join(" ") || "empty"}</b></div>
        <button className="primary" onClick={endDay}>End day ☀️</button>
      </section>
      {msg && <p className="msg">{msg}</p>}

      <section className="towns">
        {TOWNS.map((t, i) => (
          <button key={t} className={"town" + (i === me.town ? " here" : "")} disabled={i === me.town}
            onClick={() => act(() => sim.travel(ME, i), `You travel to ${t} (−${TRAVEL_COST} coins).`)}>
            <b>{t}</b><small>{BLURB[i]}</small>
            <small>{i === me.town ? "you are here" : `travel −${TRAVEL_COST}`}</small>
          </button>
        ))}
      </section>

      <section>
        <h2>Market in {TOWNS[me.town]}</h2>
        <label className="qty">Quantity <input type="number" min={1} max={100} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(100, +e.target.value || 1)))} /></label>
        <table>
          <thead><tr><th>Good</th><th>Stock</th><th>Demand</th><th>Buy {qty}</th><th>Sell {qty}</th><th>You hold</th><th></th></tr></thead>
          <tbody>
            {quotes.map((q, g) => {
              const d = demand(sim.day(), me.town, g);
              const cost = buyCost(g, q.stock, d, qty);
              const rev = sellRevenue(g, q.stock, d, qty);
              return (
                <tr key={q.good}>
                  <td>{ICON[q.good]} {q.good}</td><td>{q.stock}</td><td>{q.demand_pct}%</td>
                  <td>{cost === null ? "—" : fmt(cost)}</td><td>{fmt(rev)}</td><td>{me.goods[g]}</td>
                  <td className="btns">
                    <button disabled={cost === null || cost > me.coins} onClick={() => act(() => sim.buy(ME, q.good, qty, cost!), `Bought ${qty} ${q.good} for ${cost}.`)}>Buy</button>
                    <button disabled={me.goods[g] < qty} onClick={() => act(() => sim.sell(ME, q.good, qty, rev), `Sold ${qty} ${q.good} for ${rev}.`)}>Sell</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="hint">
          {hint ? <>Tip: {hint.qty} {GOODS[hint.good]} from here to {TOWNS[hint.to]} would clear about {hint.profit} coins after travel, if nobody beats you to it.</>
                : <>No profitable route from here right now. Try another town or wait a day.</>}
        </p>
        <div className="invest">
          <span>Invest in the {TOWNS[me.town]} merchant: your stake raises their stock and earns half of their trading spread.</span>
          <button disabled={me.coins < 100} onClick={() => act(() => sim.invest(ME, 100), "Invested 100.")}>Invest 100</button>
          <button disabled={!sim.getStake(ME, me.town)} onClick={() => act(() => sim.divest(ME, me.town), "Stake withdrawn.")}>Divest</button>
          <span>Stake {sim.getStake(ME, me.town)}, dividends {sim.pendingDividends(ME, me.town)}</span>
          <button disabled={!sim.pendingDividends(ME, me.town)} onClick={() => act(() => sim.claim(ME, me.town), "Dividends claimed.")}>Claim</button>
        </div>
        {me.coins < 100 && me.goods.every((n) => n === 0) && (
          <button className="danger" onClick={() => act(() => sim.declareBankruptcy(ME), "You start again with 600 coins. The ledger remembers.")}>Declare bankruptcy</button>
        )}
      </section>

      <div className="cols">
        <section>
          <h2>Leaderboard</h2>
          <ol>{board.map((r) => <li key={r.id} className={r.id === ME ? "me" : ""}>{r.name} · {fmt(r.worth)}{r.p.bankruptcies ? ` · bankrupt ×${r.p.bankruptcies}` : ""}</li>)}</ol>
        </section>
        <section>
          <h2>Town crier</h2>
          <ul className="log">{sim.events.slice(-12).reverse().map((e, i) => <li key={i}><small>day {e.day}</small> {e.text}</li>)}</ul>
        </section>
      </div>
      <footer>
        Testnet-only game. No real money, no wagering, nothing to buy. Source: MIT licence. Sister project: <i>Usage vs Price</i> (NEAR thesis track).
      </footer>
    </main>
  );
}

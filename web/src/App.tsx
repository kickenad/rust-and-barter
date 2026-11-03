import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { CART_CAPACITY, GOODS, TOWNS, TRAVEL_COST, buyCost, demand, fmt, sellRevenue } from "./pricing";
import { Sim, type Player, type Quote } from "./sim";
import { NPCS, bestRoute, npcTurn } from "./npc";
import { mirrorSim } from "./mirror";
import { CONTRACT, ChainPlayer, accountUrl, createGuestAccount, getConfig, loadState, secondsToNextDay, txUrl, view, type ChainState, type Config } from "./chain";

const ME = "you";
const ICON: Record<string, string> = { grain: "🌾", iron: "⛏️", cloth: "🧵", spice: "🌶️" };
const BLURB = ["Grain town on the river", "Mining town in the hills", "Port, where cloth and spice arrive by sea"];
const GUEST_KEY = "rustbarter.testnet.guest";
const NPC_NAME: Record<string, string> = Object.fromEntries(NPCS.map((n) => [n.id, n.name]));

type Mode = "practice" | "testnet";
interface Row { id: string; name: string; worth: number; bankruptcies: number }
interface Ev { day: number; text: string; href?: string }
interface Snap { day: number; me: Player | null; quotes: Quote[]; stake: number; pending: number; board: Row[]; events: Ev[]; hintSim: Sim | null }

function newWorld() {
  const s = new Sim();
  s.names = Object.fromEntries([[ME, "You"], ...NPCS.map((n) => [n.id, n.name])]);
  s.join(ME);
  for (const n of NPCS) npcTurn(s, n);
  return s;
}

const cartUnits = (p: Player) => p.goods.reduce((a, b) => a + b, 0);
const chainName = (id: string, me: string | null) => (id === me ? "You" : NPC_NAME[id.split(".")[0].replace(/^rb-/, "").replace(/-[0-9a-f]+$/, "")] ?? id);

export default function App() {
  const [mode, setMode] = useState<Mode>(location.hash === "#testnet" ? "testnet" : "practice");
  const sim = useMemo(newWorld, []);
  const [tick, rerender] = useReducer((x) => x + 1, 0);
  const [qty, setQty] = useState(5);
  const [msg, setMsg] = useState<{ text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- testnet state ----
  const [cfg, setCfg] = useState<Config | null>(null);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [guest, setGuest] = useState<{ accountId: string; secret: string } | null>(() => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) ?? "null"); } catch { return null; } });
  const [txLog, setTxLog] = useState<Ev[]>([]);
  const [now, setNow] = useState(Date.now());
  const player = useMemo(() => (guest ? new ChainPlayer(guest.accountId, guest.secret) : null), [guest]);

  useEffect(() => { location.hash = mode === "testnet" ? "testnet" : ""; setMsg(null); }, [mode]);
  const refresh = useCallback(async () => {
    try { const c = cfg ?? (await getConfig()); if (!cfg) setCfg(c); setChain(await loadState(guest?.accountId ?? null, c)); }
    catch (e) { setMsg({ text: `Could not reach testnet: ${(e as Error).message}` }); }
  }, [cfg, guest]);
  useEffect(() => {
    if (mode !== "testnet") return;
    refresh();
    const a = setInterval(refresh, 10000), b = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [mode, refresh]);

  // ---- one snapshot for rendering, whichever backend ----
  const snap: Snap = useMemo(() => {
    if (mode === "practice") {
      const me = sim.getPlayer(ME)!;
      const board = [ME, ...NPCS.map((n) => n.id)].map((id) => ({ id, name: id === ME ? "You" : NPC_NAME[id], worth: sim.netWorth(id), bankruptcies: sim.getPlayer(id)!.bankruptcies }));
      return { day: sim.day(), me, quotes: sim.quotes(me.town), stake: sim.getStake(ME, me.town), pending: sim.pendingDividends(ME, me.town),
        board, events: sim.events.slice(-12).reverse(), hintSim: sim };
    }
    if (!chain) return { day: 0, me: null, quotes: [], stake: 0, pending: 0, board: [], events: txLog, hintSim: null };
    const me = chain.me, t = me?.town ?? 0;
    const board = chain.board.map((r) => ({ ...r, id: r.id === guest?.accountId ? ME : r.id, name: chainName(r.id, guest?.accountId ?? null) }));
    const hintSim = mirrorSim(chain.day, chain.merchants);
    return { day: chain.day, me, quotes: chain.quotes, stake: chain.stakes[t]?.[0] ?? 0, pending: chain.stakes[t]?.[1] ?? 0, board, events: txLog, hintSim };
  }, [mode, sim, tick, chain, txLog, guest]); // eslint-disable-line react-hooks/exhaustive-deps

  const me = snap.me;
  const onRoad = !!me && snap.day < me.arrives_day;
  const secs = cfg ? secondsToNextDay(cfg, now) : 0;

  // ---- actions ----
  // On testnet, other players and NPCs trade between your click and the block, so buy/sell allow 5% slippage
  // and the message reports the price actually paid (from the returned player).
  type Act = { practice: () => unknown; method: string; args?: Record<string, unknown>; done: string; chainArgs?: Record<string, unknown>; chainDone?: (p: { coins: number }) => string };
  const act = async ({ practice, method, args = {}, done, chainArgs, chainDone }: Act) => {
    if (mode === "practice") {
      try { practice(); setMsg({ text: done }); } catch (e) { setMsg({ text: (e as Error).message }); }
      return rerender();
    }
    if (!player) return;
    setBusy(true); setMsg({ text: `Signing ${method} on testnet…` });
    try {
      const { result, hash } = await player.call<{ coins: number }>(method, chainArgs ?? args);
      const text = chainDone && result ? chainDone(result) : done;
      setMsg({ text, href: txUrl(hash) });
      setTxLog((l) => [{ day: chain?.day ?? 0, text, href: txUrl(hash) }, ...l].slice(0, 12));
    } catch (e) { setMsg({ text: (e as Error).message }); }
    setBusy(false); refresh();
  };
  const endDay = () => act({ practice: () => { for (let i = 0; i < 2; i++) for (const n of NPCS) npcTurn(sim, n); sim.advance(1); }, method: "", done: "A new day. Merchants restocked and prices shifted." });

  const startGuest = async () => {
    setBusy(true); setMsg({ text: "Creating a throwaway testnet account through NEAR's public faucet…" });
    try {
      const g = await createGuestAccount();
      localStorage.setItem(GUEST_KEY, JSON.stringify(g)); setGuest(g);
      const p = new ChainPlayer(g.accountId, g.secret);
      const { hash } = await p.call("join");
      const day = await view<number>("day");
      setMsg({ text: `You opened a stall in Millbrook as ${g.accountId}.`, href: txUrl(hash) });
      setTxLog([{ day, text: "You opened a stall in Millbrook.", href: txUrl(hash) }]);
    } catch (e) { setMsg({ text: (e as Error).message }); }
    setBusy(false); refresh();
  };
  const forgetGuest = () => { if (!confirm("Forget this throwaway testnet account? Its key is only stored in this browser.")) return; localStorage.removeItem(GUEST_KEY); setGuest(null); setChain(null); setTxLog([]); };
  const joinExisting = () => act({ practice: () => 0, method: "join", done: "You opened a stall in Millbrook." });

  const hint = me && snap.hintSim && !onRoad ? bestRoute(snap.hintSim, me.town, me.coins) : null;
  const board = [...snap.board].sort((a, b) => b.worth - a.worth);

  return (
    <main>
      <header>
        <h1>Rust &amp; Barter</h1>
        <p className="sub">
          Buy low in one town, haul it, sell high in another. <b>Coins are game points with no real value.</b>
        </p>
        <div className="modes" role="tablist">
          <button className={mode === "practice" ? "on" : ""} onClick={() => setMode("practice")}>Practice (in browser)</button>
          <button className={mode === "testnet" ? "on" : ""} onClick={() => setMode("testnet")}>Play on NEAR testnet</button>
        </div>
        <p className="sub small">
          {mode === "practice"
            ? <>Practice runs a local copy of the contract rules with three rival traders. You choose when the day ends.</>
            : <>Every move is a signed transaction to <a href={accountUrl(CONTRACT)} target="_blank">{CONTRACT}</a>. A game day lasts {cfg ? Number(cfg.day_ns) / 1e9 : "…"} seconds; travel takes until the next day.</>}
        </p>
      </header>

      {mode === "testnet" && !guest && (
        <section className="guest">
          <p>No wallet needed. We create a <b>throwaway testnet account</b> from NEAR's public faucet. Its key stays in this browser's local storage. Testnet tokens have no value.</p>
          <button className="primary" disabled={busy} onClick={startGuest}>Create throwaway account and join</button>
        </section>
      )}
      {mode === "testnet" && guest && (
        <p className="acct">Playing as <a href={accountUrl(guest.accountId)} target="_blank">{guest.accountId}</a> (throwaway testnet key in this browser) · <button className="link" onClick={forgetGuest}>forget</button>
          {chain && !me && <> · <button disabled={busy} onClick={joinExisting}>Join game</button></>}</p>
      )}

      {me && (<>
        <section className="status">
          <div><span>Day</span><b>{snap.day}</b></div>
          <div><span>Coins</span><b>{fmt(me.coins)}</b></div>
          <div><span>Net worth</span><b>{fmt(snap.board.find((r) => r.id === ME)?.worth ?? me.coins)}</b></div>
          <div><span>Cart {cartUnits(me)}/{CART_CAPACITY}</span><b>{me.goods.map((n, g) => (n ? `${ICON[GOODS[g]]}${n}` : "")).filter(Boolean).join(" ") || "empty"}</b></div>
          {mode === "practice"
            ? <button className="primary" onClick={endDay}>End day ☀️</button>
            : <div className="clock"><span>Next day in</span><b>{secs}s</b></div>}
        </section>
        {msg && <p className="msg">{msg.text} {msg.href && <a href={msg.href} target="_blank">view transaction ↗</a>}</p>}
        {onRoad && <p className="road">🐴 On the road to {TOWNS[me.town]}. You arrive on day {me.arrives_day}{mode === "practice" ? " (end the day)." : ` (in about ${secs}s).`}</p>}

        <section className="towns">
          {TOWNS.map((t, i) => (
            <button key={t} className={"town" + (i === me.town ? " here" : "")} disabled={i === me.town || busy || onRoad}
              onClick={() => act({ practice: () => sim.travel(ME, i), method: "travel", args: { town: i }, done: `You set off for ${t} (−${TRAVEL_COST} coins). You arrive next day.` })}>
              <b>{t}</b><small>{BLURB[i]}</small>
              <small>{i === me.town ? (onRoad ? "heading here" : "you are here") : `travel −${TRAVEL_COST}, arrive next day`}</small>
            </button>
          ))}
        </section>

        <section>
          <h2>Market in {TOWNS[me.town]}</h2>
          <label className="qty">Quantity <input type="number" min={1} max={CART_CAPACITY} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(CART_CAPACITY, +e.target.value || 1)))} />
            <small> your cart holds {CART_CAPACITY} units</small></label>
          <table>
            <thead><tr><th>Good</th><th>Stock</th><th>Demand</th><th>Buy {qty}</th><th>Sell {qty}</th><th>You hold</th><th></th></tr></thead>
            <tbody>
              {snap.quotes.map((q, g) => {
                const d = demand(snap.day, me.town, g);
                const cost = buyCost(g, q.stock, d, qty);
                const rev = sellRevenue(g, q.stock, d, qty);
                const full = cartUnits(me) + qty > CART_CAPACITY;
                return (
                  <tr key={q.good}>
                    <td>{ICON[q.good]} {q.good}</td><td>{q.stock}</td><td>{q.demand_pct}%</td>
                    <td>{cost === null ? "—" : fmt(cost)}</td><td>{fmt(rev)}</td><td>{me.goods[g]}</td>
                    <td className="btns">
                      <button title={full ? "cart full" : ""} disabled={busy || onRoad || full || cost === null || cost > me.coins}
                        onClick={() => act({ practice: () => sim.buy(ME, q.good, qty, cost!), method: "buy", args: { good: q.good, qty, max_total: cost }, done: `Bought ${qty} ${q.good} for ${cost}.`, chainArgs: { good: q.good, qty, max_total: Math.ceil(cost! * 1.05) }, chainDone: (r) => `Bought ${qty} ${q.good} for ${me.coins - r.coins}.` })}>Buy</button>
                      <button disabled={busy || onRoad || me.goods[g] < qty}
                        onClick={() => act({ practice: () => sim.sell(ME, q.good, qty, rev), method: "sell", args: { good: q.good, qty, min_total: rev }, done: `Sold ${qty} ${q.good} for ${rev}.`, chainArgs: { good: q.good, qty, min_total: Math.floor(rev * 0.95) }, chainDone: (r) => `Sold ${qty} ${q.good} for ${r.coins - me.coins}.` })}>Sell</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            {onRoad ? <>No trading while you travel.</>
              : hint ? <>Tip: {hint.qty} {GOODS[hint.good]} from here to {TOWNS[hint.to]} would clear about {hint.profit} coins after travel, if nobody beats you to it.</>
              : <>No profitable route from here right now. Try another town or wait a day.</>}
          </p>
          <div className="invest">
            <span>Invest in the {TOWNS[me.town]} merchant: your stake raises their stock and earns half of their trading spread.</span>
            <button disabled={busy || onRoad || me.coins < 100} onClick={() => act({ practice: () => sim.invest(ME, 100), method: "invest", args: { amount: 100 }, done: "Invested 100." })}>Invest 100</button>
            <button disabled={busy || onRoad || !snap.stake} onClick={() => act({ practice: () => sim.divest(ME, me.town), method: "divest", args: { town: me.town }, done: "Stake withdrawn." })}>Divest</button>
            <span>Stake {snap.stake}, dividends {snap.pending}</span>
            <button disabled={busy || !snap.pending} onClick={() => act({ practice: () => sim.claim(ME, me.town), method: "claim", args: { town: me.town }, done: "Dividends claimed." })}>Claim</button>
          </div>
          {me.coins < 100 && me.goods.every((n) => n === 0) && (
            <button className="danger" disabled={busy} onClick={() => act({ practice: () => sim.declareBankruptcy(ME), method: "declare_bankruptcy", done: "You start again with 600 coins. The ledger remembers." })}>Declare bankruptcy</button>
          )}
        </section>
      </>)}
      {!me && msg && <p className="msg">{msg.text} {msg.href && <a href={msg.href} target="_blank">view transaction ↗</a>}</p>}

      <div className="cols">
        <section>
          <h2>Leaderboard{mode === "testnet" ? " (on chain)" : ""}</h2>
          {board.length ? <ol>{board.map((r) => <li key={r.id} className={r.id === ME ? "me" : ""}>{r.name} · {fmt(r.worth)}{r.bankruptcies ? ` · bankrupt ×${r.bankruptcies}` : ""}</li>)}</ol>
            : <p className="hint">{mode === "testnet" ? "Loading testnet…" : ""}</p>}
        </section>
        <section>
          <h2>{mode === "testnet" ? "Your transactions" : "Town crier"}</h2>
          <ul className="log">{snap.events.map((e, i) => <li key={i}><small>day {e.day}</small> {e.text} {e.href && <a href={e.href} target="_blank">tx ↗</a>}</li>)}</ul>
        </section>
      </div>
      <footer>
        Testnet-only game. No real money, no wagering, nothing to buy. Source: MIT licence. Sister project: <i>Usage vs Price</i> (NEAR thesis track).
      </footer>
    </main>
  );
}

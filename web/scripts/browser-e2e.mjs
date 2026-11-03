import puppeteer from "puppeteer-core";
// Needs: npm i -D puppeteer-core (or run from a folder that has it) and a Chrome at $CHROME.
// Start `npm run build && npx vite preview --port 4173` first, or set URL=https://kickenad.github.io/rust-and-barter/ to test the live site.
const URL_ = process.env.URL ?? "http://localhost:4173/";
const shots = process.env.SHOTS ?? "/tmp";
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
const p = await b.newPage(); await p.setViewport({ width: 1100, height: 1300 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const text = () => p.evaluate(() => document.body.innerText);
const waitText = async (re, ms = 90000) => { try { await p.waitForFunction((s) => new RegExp(s, "i").test(document.body.innerText), { timeout: ms, polling: 500 }, re.source); } catch (e) { console.log("FAIL waiting for", re.source); console.log((await text()).slice(0, 1500)); console.log("errors:", errs); await p.screenshot({ path: `${shots}/fail.png` }); await b.close(); process.exit(1); } };
const click = (label, nth = 0) => p.evaluate((l, n) => { const bs = [...document.querySelectorAll("button")].filter((x) => x.innerText.trim().startsWith(l) && !x.disabled); bs[n].click(); return bs.length; }, label, nth);
const step = (s) => console.log("ok -", s);
process.on("unhandledRejection", async (e) => { console.log("FAIL", e.message); console.log((await text()).slice(0, 1500)); console.log("errors:", errs); await p.screenshot({ path: `${shots}/fail.png` }); await b.close(); process.exit(1); });

// practice
await p.goto(URL_);
await waitText(/Market in Millbrook/); await click("Buy"); await waitText(/Bought 5 grain/); step("practice buy");
await click("Ironhold"); await waitText(/On the road to Ironhold/); step("practice travel shows on-the-road");
await click("End day"); await waitText(/Market in Ironhold/); await click("Sell"); await waitText(/Sold 5 grain/); step("practice sell after a day");
await p.screenshot({ path: `${shots}/practice.png` });

// testnet
await p.goto(URL_ + "#testnet"); await p.reload();
await waitText(/Create throwaway account/); await click("Create throwaway account");
await waitText(/Playing as rb-player-/); await waitText(/Market in Millbrook/, 60000); step("guest account created via faucet + joined");
await waitText(/Leaderboard \(on chain\)[\s\S]*You ·/, 30000); step("on-chain leaderboard shows you");
await click("Buy"); await waitText(/Bought 5 grain/); step("testnet buy (signed tx)");
await waitText(/Cart 5\/15/, 20000); step("cart 5/15 from chain");
await click("Ironhold"); await waitText(/You set off for Ironhold/); await waitText(/On the road to Ironhold/, 20000); step("testnet travel, on the road");
await p.screenshot({ path: `${shots}/testnet-road.png` });
await waitText(/Market in Ironhold(?![\s\S]*On the road)/, 60000);
await p.waitForFunction(() => [...document.querySelectorAll("button")].some((x) => x.innerText === "Sell" && !x.disabled), { timeout: 60000, polling: 500 });
await click("Sell"); await waitText(/Sold 5 grain/); step("testnet sell after arrival");
await new Promise((r) => setTimeout(r, 7000));
await p.screenshot({ path: `${shots}/testnet.png` });
const t = await text(); console.log((t.match(/Playing as [^\s]+/) || [""])[0]); console.log("tx links:", await p.evaluate(() => document.querySelectorAll('a[href*="/txns/"]').length));
console.log("errors:", errs.length ? errs : "none");
await b.close();

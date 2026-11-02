import { describe, expect, it } from "vitest";
import { Sim } from "./sim";

// Same scenario as contract/tests/test_basics.rs (sandbox): the two must agree.
describe("Sim mirrors the contract", () => {
  it("replays the sandbox scenario to the same balances", () => {
    const s = new Sim();
    s.join("alice"); s.join("bob");
    expect(() => s.join("alice")).toThrow("already joined");
    s.invest("bob", 400);
    s.buy("alice", "grain", 10, 10_000);
    expect(s.pendingDividends("bob", 0)).toBeGreaterThan(0);
    s.travel("alice", 1);
    expect(() => s.sell("alice", "grain", 10, 0)).toThrow("still on the road");
    s.advance(1);
    s.sell("alice", "grain", 10, 0);
    expect(s.getPlayer("alice")!.coins).toBe(1270);
  });
  it("enforces slippage limits and bankruptcy rules", () => {
    const s = new Sim(); s.join("a");
    expect(() => s.buy("a", "spice", 5, 10)).toThrow("price moved above your limit");
    expect(() => s.declareBankruptcy("a")).toThrow("you are not broke");
    s.buy("a", "grain", 10, 1e9);
    expect(() => s.buy("a", "grain", 6, 1e9)).toThrow("your cart holds 15 units");
  });
  it("restocks over days", () => {
    const s = new Sim(); s.join("a");
    s.buy("a", "grain", 8, 1e9);
    const low = s.getMerchant(0).stock[0];
    s.advance(10);
    expect(s.getMerchant(0).stock[0]).toBeGreaterThan(low);
  });
});

import { describe, expect, it } from "vitest";
import vectors from "../../contract/tests/vectors.json";
import { buyCost, demand, mid, restock, sellRevenue } from "./pricing";

describe("pricing.ts matches pricing.rs", () => {
  it(`agrees on all ${vectors.length} vectors`, () => {
    for (const v of vectors) {
      const tag = `day ${v.day} town ${v.town} good ${v.good} stock ${v.stock}`;
      expect(demand(v.day, v.town, v.good), tag).toBe(v.demand);
      expect(mid(v.good, v.stock, v.demand), tag).toBe(v.mid);
      expect(buyCost(v.good, v.stock, v.demand, 5), tag).toBe(v.buy5);
      expect(sellRevenue(v.good, v.stock, v.demand, 5), tag).toBe(v.sell5);
      expect(restock(v.stock, v.target, 3), tag).toBe(v.restock3);
    }
  });
});

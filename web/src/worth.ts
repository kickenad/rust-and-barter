// Net worth, shared by practice and testnet modes: coins + stakes + pending dividends
// + goods valued at the best current sell price across the three towns.
import { demand, investedTarget, restock, sellRevenue, TARGET } from "./pricing";
import type { Merchant, Player } from "./sim";

export function rolledStock(m: Merchant, town: number, day: number) {
  if (day <= m.last_day) return m.stock;
  return m.stock.map((s, g) => restock(s, investedTarget(TARGET[town][g], m.invested), day - m.last_day));
}

export function worthOf(p: Player, stakes: [number, number][], merchants: Merchant[], day: number) {
  let w = p.coins + stakes.reduce((a, [s, d]) => a + s + d, 0);
  p.goods.forEach((n, g) => {
    if (n) w += Math.max(...merchants.map((m, t) => sellRevenue(g, rolledStock(m, t, day)[g], demand(day, t, g), n)));
  });
  return w;
}

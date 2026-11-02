//! Deterministic market maths. Pure functions, no NEAR environment: the frontend
//! mirrors this file in `web/src/pricing.ts`, and `tests/vectors.json` (generated
//! by `cargo test -- --ignored write_vectors`) keeps both implementations identical.

use near_sdk::env;

pub const GOODS: [&str; 4] = ["grain", "iron", "cloth", "spice"];
pub const BASE: [u64; 4] = [100, 400, 250, 900];
pub const TOWNS: [&str; 3] = ["Millbrook", "Ironhold", "Saltmere"];
/// Target stock per town per good: each town over-produces something.
pub const TARGET: [[u64; 4]; 3] = [
    [240, 90, 110, 40], // Millbrook: grain town
    [150, 180, 100, 50], // Ironhold: mines
    [160, 100, 190, 80], // Saltmere: port, cloth and spice arrive by sea
];
/// Reference stock per good: a merchant holding this much charges the base price.
/// Towns that hold more are cheap, towns that hold less are dear; that gap is the trade route.
pub const REF: [u64; 4] = [160, 110, 120, 60];
pub const BUY_MARKUP_PCT: u64 = 105; // player pays mid * 1.05
pub const SELL_MARKDOWN_PCT: u64 = 95; // player receives mid * 0.95
pub const MAX_QTY: u32 = 100;

/// Town demand for a good on a given game day, 80..=130 (% of normal).
/// sha256("rb" ‖ day as u64 LE ‖ town ‖ good)[0] % 51 + 80
pub fn demand(day: u64, town: u8, good: u8) -> u64 {
    let mut msg = b"rb".to_vec();
    msg.extend_from_slice(&day.to_le_bytes());
    msg.push(town);
    msg.push(good);
    let h = env::sha256(&msg);
    80 + (h[0] as u64 % 51)
}

/// Mid price in coppers for one unit, given the merchant's current stock.
pub fn mid(good: u8, stock: u64, demand_pct: u64) -> u64 {
    let base = BASE[good as usize];
    let raw = base * REF[good as usize] * demand_pct / (100 * stock.max(1));
    raw.clamp((base / 4).max(1), base * 4)
}

/// Total cost to buy `qty` units, walking the price up one unit at a time.
pub fn buy_cost(good: u8, stock: u64, demand_pct: u64, qty: u32) -> Option<u64> {
    if qty as u64 > stock {
        return None;
    }
    let mut s = stock;
    let mut total = 0u64;
    for _ in 0..qty {
        let m = mid(good, s, demand_pct);
        total += (m * BUY_MARKUP_PCT).div_ceil(100);
        s -= 1;
    }
    Some(total)
}

/// Total revenue for selling `qty` units, walking the price down one unit at a time.
pub fn sell_revenue(good: u8, stock: u64, demand_pct: u64, qty: u32) -> u64 {
    let mut s = stock;
    let mut total = 0u64;
    for _ in 0..qty {
        s += 1;
        let m = mid(good, s, demand_pct);
        total += m * SELL_MARKDOWN_PCT / 100;
    }
    total
}

/// Restock: each elapsed day closes 1/5 of the gap to target (at least 1 unit).
pub fn restock(stock: u64, target: u64, days: u64) -> u64 {
    let mut s = stock;
    for _ in 0..days.min(60) {
        if s < target {
            s += ((target - s) / 5).max(1);
        } else if s > target {
            s -= ((s - target) / 5).max(1);
        }
    }
    s
}

/// Investment raises a merchant's target stock: +1% per 500 coppers invested, max +100%.
pub fn invested_target(base_target: u64, invested: u64) -> u64 {
    let bonus = (invested / 500).min(100);
    base_target * (100 + bonus) / 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_rises_as_stock_falls() {
        assert_eq!(mid(0, 160, 100), 100);
        assert_eq!(mid(0, 80, 100), 200);
        assert_eq!(mid(0, 320, 100), 50);
    }

    #[test]
    fn price_is_clamped() {
        assert_eq!(mid(3, 1, 130), 3600);
        assert_eq!(mid(3, 100_000, 80), 225);
    }

    #[test]
    fn round_trip_loses_money() {
        // Buying then immediately selling in the same town must never profit.
        for g in 0..4u8 {
            for t in 0..3usize {
                let target = TARGET[t][g as usize];
                for q in [1u32, 5, 20] {
                    if let Some(cost) = buy_cost(g, target, 100, q) {
                        let back = sell_revenue(g, target - q as u64, 100, q);
                        assert!(back < cost, "g{g} t{t} q{q}: {back} >= {cost}");
                    }
                }
            }
        }
    }

    #[test]
    fn every_good_has_a_profitable_route_at_equilibrium() {
        // Buy 5 where a good is most plentiful, sell 5 where it is scarcest, net of travel.
        for g in 0..4u8 {
            let stocks: Vec<u64> = (0..3).map(|t| TARGET[t][g as usize]).collect();
            let hi = *stocks.iter().max().unwrap();
            let lo = *stocks.iter().min().unwrap();
            let cost = buy_cost(g, hi, 100, 5).unwrap();
            let rev = sell_revenue(g, lo, 100, 5);
            assert!(rev > cost + 30, "good {g}: cost {cost} rev {rev}");
        }
    }

    #[test]
    fn restock_converges() {
        assert_eq!(restock(0, 100, 60), 100);
        assert_eq!(restock(500, 100, 60), 100);
        assert_eq!(restock(90, 100, 1), 92);
    }

    #[test]
    fn demand_in_range() {
        for d in 0..50 {
            for t in 0..3 {
                for g in 0..4 {
                    let x = demand(d, t, g);
                    assert!((80..=130).contains(&x));
                }
            }
        }
    }

    /// Writes cross-language test vectors for the TypeScript mirror.
    #[test]
    #[ignore]
    fn write_vectors() {
        let mut v = vec![];
        for day in [0u64, 1, 7, 365] {
            for t in 0..3u8 {
                for g in 0..4u8 {
                    let target = TARGET[t as usize][g as usize];
                    let d = demand(day, t, g);
                    for stock in [1u64, target / 3, target, target * 2] {
                        v.push(near_sdk::serde_json::json!({
                            "day": day, "town": t, "good": g, "target": target, "stock": stock, "demand": d,
                            "mid": mid(g, stock, d),
                            "buy5": buy_cost(g, stock, d, 5),
                            "sell5": sell_revenue(g, stock, d, 5),
                            "restock3": restock(stock, target, 3),
                        }));
                    }
                }
            }
        }
        std::fs::write("tests/vectors.json", near_sdk::serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }
}

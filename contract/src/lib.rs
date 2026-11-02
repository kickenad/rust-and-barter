//! Rust & Barter: a market-town trading game. Testnet only; coins have no real-money value
//! and cannot be bought, sold or withdrawn. No wagering or chance-based payouts.
//!
//! Loop: travel between three towns, buy where a good is plentiful, sell where it is
//! scarce, and invest profits in merchants for a share of their trading spread. Go broke
//! and you can declare bankruptcy for a smaller restart.
//! Goods are tracked as NEP-245-style multi-token balances (`mt_*` views, `mt_transfer`, events).

pub mod pricing;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};
use pricing::*;

const START_COINS: u64 = 1000;
const RESTART_COINS: u64 = 600;
const TRAVEL_COST: u64 = 30;
const TRAVEL_DAYS: u64 = 1; // you arrive at the start of the next game day
const CART_CAPACITY: u64 = 15; // total units of goods a player can carry
const ACC: u128 = 1_000_000_000_000; // fixed-point scale for dividends per share
const INVESTOR_SHARE_PCT: u64 = 50; // half of every spread goes to the merchant's investors

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Player {
    pub coins: u64,
    pub goods: [u64; 4],
    pub town: u8,
    pub bankruptcies: u32,
    pub trades: u32,
    pub joined_day: u64,
    /// game day the player arrives in `town`; no trading while on the road
    pub arrives_day: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Merchant {
    pub stock: [u64; 4],
    pub last_day: u64,
    pub invested: u64,
    /// accumulated investor dividends per invested copper, scaled by ACC
    pub acc_per_share: u128,
    pub house_profit: u64,
}

#[near(serializers = [borsh])]
pub struct Stake {
    pub amount: u64,
    pub debt: u128,
}

#[near(serializers = [json])]
pub struct Quote {
    pub town: u8,
    pub good: String,
    pub stock: u64,
    pub demand_pct: u64,
    pub mid: u64,
    pub buy_one: u64,
    pub sell_one: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Game {
    owner: AccountId,
    genesis_ns: u64,
    day_ns: u64,
    players: IterableMap<AccountId, Player>,
    merchants: Vec<Merchant>,
    stakes: LookupMap<(AccountId, u8), Stake>,
}

fn emit(standard: &str, event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard": standard, "version": "1.0.0", "event": event, "data": [data]})
    ));
}

fn good_id(token_id: &str) -> u8 {
    GOODS.iter().position(|g| *g == token_id).unwrap_or_else(|| env::panic_str("unknown good")) as u8
}

#[near]
impl Game {
    /// `day_seconds`: length of a game day (e.g. 120 for demos, 3600 for a slower world).
    #[init]
    pub fn new(day_seconds: u64) -> Self {
        require!(day_seconds >= 10, "day too short");
        let merchants = (0..3)
            .map(|t| Merchant { stock: TARGET[t], last_day: 0, invested: 0, acc_per_share: 0, house_profit: 0 })
            .collect();
        Self {
            owner: env::predecessor_account_id(),
            genesis_ns: env::block_timestamp(),
            day_ns: day_seconds * 1_000_000_000,
            players: IterableMap::new(b"p"),
            merchants,
            stakes: LookupMap::new(b"s"),
        }
    }

    // ---------- views ----------

    pub fn day(&self) -> u64 {
        (env::block_timestamp() - self.genesis_ns) / self.day_ns
    }

    pub fn config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "owner": self.owner, "genesis_ns": self.genesis_ns.to_string(), "day_ns": self.day_ns.to_string(),
            "goods": GOODS, "base": BASE, "towns": TOWNS, "target": TARGET,
            "travel_cost": TRAVEL_COST, "travel_days": TRAVEL_DAYS, "cart_capacity": CART_CAPACITY, "start_coins": START_COINS, "restart_coins": RESTART_COINS,
        })
    }

    pub fn get_player(&self, account_id: AccountId) -> Option<Player> {
        self.players.get(&account_id).cloned()
    }

    pub fn get_players(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Player)> {
        self.players
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(a, p)| (a.clone(), p.clone()))
            .collect()
    }

    /// Merchant state as it would be right now (restock applied lazily).
    pub fn get_merchant(&self, town: u8) -> Merchant {
        let mut m = self.merchants[town as usize].clone();
        self.roll(town, &mut m);
        m
    }

    pub fn quotes(&self, town: u8) -> Vec<Quote> {
        let m = self.get_merchant(town);
        let day = self.day();
        (0..4u8)
            .map(|g| {
                let d = demand(day, town, g);
                let s = m.stock[g as usize];
                Quote {
                    town,
                    good: GOODS[g as usize].into(),
                    stock: s,
                    demand_pct: d,
                    mid: mid(g, s, d),
                    buy_one: buy_cost(g, s, d, 1).unwrap_or(0),
                    sell_one: sell_revenue(g, s, d, 1),
                }
            })
            .collect()
    }

    pub fn pending_dividends(&self, account_id: AccountId, town: u8) -> u64 {
        let m = &self.merchants[town as usize];
        self.stakes
            .get(&(account_id, town))
            .map(|s| ((s.amount as u128 * m.acc_per_share - s.debt) / ACC) as u64)
            .unwrap_or(0)
    }

    pub fn get_stake(&self, account_id: AccountId, town: u8) -> u64 {
        self.stakes.get(&(account_id, town)).map(|s| s.amount).unwrap_or(0)
    }

    /// Stake in each town plus pending dividends, for leaderboards: [[stake, pending]; 3].
    pub fn get_stakes(&self, account_id: AccountId) -> Vec<(u64, u64)> {
        (0..3u8).map(|t| (self.get_stake(account_id.clone(), t), self.pending_dividends(account_id.clone(), t))).collect()
    }

    // NEP-245-style views
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let g = good_id(&token_id) as usize;
        U128(self.players.get(&account_id).map(|p| p.goods[g] as u128).unwrap_or(0))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    // ---------- actions ----------

    pub fn join(&mut self) -> Player {
        let who = env::predecessor_account_id();
        require!(self.players.get(&who).is_none(), "already joined");
        let p = Player { coins: START_COINS, goods: [0; 4], town: 0, bankruptcies: 0, trades: 0, joined_day: self.day(), arrives_day: self.day() };
        self.players.insert(who.clone(), p.clone());
        emit("rust_and_barter", "join", near_sdk::serde_json::json!({"account_id": who}));
        p
    }

    pub fn travel(&mut self, town: u8) -> Player {
        require!((town as usize) < TOWNS.len(), "no such town");
        let who = env::predecessor_account_id();
        let mut p = self.player(&who);
        require!(p.town != town, "already there");
        require!(p.coins >= TRAVEL_COST, "not enough coins to travel");
        require!(self.day() >= p.arrives_day, "still on the road");
        p.coins -= TRAVEL_COST;
        p.town = town;
        p.arrives_day = self.day() + TRAVEL_DAYS;
        self.players.insert(who.clone(), p.clone());
        emit("rust_and_barter", "travel", near_sdk::serde_json::json!({"account_id": who, "town": town}));
        p
    }

    /// Buy `qty` of a good in your current town. Fails if the cost would exceed `max_total`.
    pub fn buy(&mut self, good: String, qty: u32, max_total: u64) -> Player {
        require!(qty > 0 && qty <= MAX_QTY, "qty 1..100");
        let g = good_id(&good);
        let who = env::predecessor_account_id();
        let mut p = self.arrived(&who);
        require!(p.goods.iter().sum::<u64>() + qty as u64 <= CART_CAPACITY, "your cart holds 15 units");
        let t = p.town;
        let mut m = self.merchants[t as usize].clone();
        self.roll(t, &mut m);
        let d = demand(self.day(), t, g);
        let s = m.stock[g as usize];
        let cost = buy_cost(g, s, d, qty).unwrap_or_else(|| env::panic_str("merchant is out of stock"));
        require!(cost <= max_total, "price moved above your limit");
        require!(p.coins >= cost, "not enough coins");
        let fair = (cost * 100) / BUY_MARKUP_PCT;
        self.book_spread(&mut m, cost - fair);
        m.stock[g as usize] -= qty as u64;
        p.coins -= cost;
        p.goods[g as usize] += qty as u64;
        p.trades += 1;
        self.merchants[t as usize] = m;
        self.players.insert(who.clone(), p.clone());
        emit("nep245", "mt_mint", near_sdk::serde_json::json!({"owner_id": who, "token_ids": [good], "amounts": [qty.to_string()], "memo": format!("bought in {} for {}", TOWNS[t as usize], cost)}));
        p
    }

    /// Sell `qty` of a good in your current town. Fails if revenue would be below `min_total`.
    pub fn sell(&mut self, good: String, qty: u32, min_total: u64) -> Player {
        require!(qty > 0 && qty <= MAX_QTY, "qty 1..100");
        let g = good_id(&good);
        let who = env::predecessor_account_id();
        let mut p = self.arrived(&who);
        require!(p.goods[g as usize] >= qty as u64, "you don't have that many");
        let t = p.town;
        let mut m = self.merchants[t as usize].clone();
        self.roll(t, &mut m);
        let d = demand(self.day(), t, g);
        let s = m.stock[g as usize];
        let revenue = sell_revenue(g, s, d, qty);
        require!(revenue >= min_total, "price moved below your limit");
        let fair = (revenue * 100) / SELL_MARKDOWN_PCT;
        self.book_spread(&mut m, fair.saturating_sub(revenue));
        m.stock[g as usize] += qty as u64;
        p.coins += revenue;
        p.goods[g as usize] -= qty as u64;
        p.trades += 1;
        self.merchants[t as usize] = m;
        self.players.insert(who.clone(), p.clone());
        emit("nep245", "mt_burn", near_sdk::serde_json::json!({"owner_id": who, "token_ids": [good], "amounts": [qty.to_string()], "memo": format!("sold in {} for {}", TOWNS[t as usize], revenue)}));
        p
    }

    /// Give goods to another player (NEP-245-style transfer).
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, memo: Option<String>) {
        let g = good_id(&token_id) as usize;
        let who = env::predecessor_account_id();
        require!(who != receiver_id, "cannot transfer to yourself");
        let amt: u64 = amount.0.try_into().unwrap_or_else(|_| env::panic_str("amount too large"));
        require!(amt > 0, "amount must be positive");
        let mut a = self.player(&who);
        let mut b = self.player(&receiver_id);
        require!(a.goods[g] >= amt, "insufficient balance");
        require!(b.goods.iter().sum::<u64>() + amt <= CART_CAPACITY, "receiver's cart is full");
        a.goods[g] -= amt;
        b.goods[g] += amt;
        self.players.insert(who.clone(), a);
        self.players.insert(receiver_id.clone(), b);
        emit("nep245", "mt_transfer", near_sdk::serde_json::json!({"old_owner_id": who, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amt.to_string()], "memo": memo}));
    }

    /// Invest coins in the merchant of your current town: bigger stock targets, and you earn
    /// a pro-rata share of half of that merchant's trading spread.
    pub fn invest(&mut self, amount: u64) -> u64 {
        require!(amount > 0, "amount must be positive");
        let who = env::predecessor_account_id();
        let mut p = self.arrived(&who);
        require!(p.coins >= amount, "not enough coins");
        let t = p.town;
        self.claim_inner(&who, t, &mut p);
        let m = &mut self.merchants[t as usize];
        let mut st = self.stakes.remove(&(who.clone(), t)).unwrap_or(Stake { amount: 0, debt: 0 });
        st.amount += amount;
        st.debt = st.amount as u128 * m.acc_per_share;
        m.invested += amount;
        p.coins -= amount;
        let total = st.amount;
        self.stakes.insert((who.clone(), t), st);
        self.players.insert(who.clone(), p);
        emit("rust_and_barter", "invest", near_sdk::serde_json::json!({"account_id": who, "town": t, "amount": amount}));
        total
    }

    /// Withdraw your whole stake in `town` (plus pending dividends). Must be in that town.
    pub fn divest(&mut self, town: u8) -> u64 {
        let who = env::predecessor_account_id();
        let mut p = self.arrived(&who);
        require!(p.town == town, "travel to that town to divest");
        self.claim_inner(&who, town, &mut p);
        let st = self.stakes.remove(&(who.clone(), town)).unwrap_or_else(|| env::panic_str("no stake"));
        self.merchants[town as usize].invested -= st.amount;
        p.coins += st.amount;
        self.players.insert(who.clone(), p);
        emit("rust_and_barter", "divest", near_sdk::serde_json::json!({"account_id": who, "town": town, "amount": st.amount}));
        st.amount
    }

    pub fn claim(&mut self, town: u8) -> u64 {
        let who = env::predecessor_account_id();
        let mut p = self.player(&who);
        let got = self.claim_inner(&who, town, &mut p);
        self.players.insert(who, p);
        got
    }

    /// Broke and empty-handed? Restart with fewer coins. Your bankruptcy count is public.
    pub fn declare_bankruptcy(&mut self) -> Player {
        let who = env::predecessor_account_id();
        let mut p = self.player(&who);
        require!(p.coins < 100 && p.goods.iter().all(|g| *g == 0), "you are not broke");
        require!((0..3u8).all(|t| self.get_stake(who.clone(), t) == 0), "divest first");
        p.coins = RESTART_COINS;
        p.bankruptcies += 1;
        self.players.insert(who.clone(), p.clone());
        emit("rust_and_barter", "bankrupt", near_sdk::serde_json::json!({"account_id": who, "count": p.bankruptcies}));
        p
    }

    // ---------- internals ----------

    fn arrived(&self, who: &AccountId) -> Player {
        let p = self.player(who);
        require!(self.day() >= p.arrives_day, "still on the road");
        p
    }

    fn player(&self, who: &AccountId) -> Player {
        self.players.get(who).cloned().unwrap_or_else(|| env::panic_str("join first"))
    }

    fn target(&self, town: u8, good: u8, m: &Merchant) -> u64 {
        invested_target(TARGET[town as usize][good as usize], m.invested)
    }

    fn roll(&self, town: u8, m: &mut Merchant) {
        let today = self.day();
        if today > m.last_day {
            for g in 0..4u8 {
                let target = self.target(town, g, m);
                m.stock[g as usize] = restock(m.stock[g as usize], target, today - m.last_day);
            }
            m.last_day = today;
        }
    }

    fn book_spread(&self, m: &mut Merchant, spread: u64) {
        let to_investors = spread * INVESTOR_SHARE_PCT / 100;
        if m.invested > 0 && to_investors > 0 {
            m.acc_per_share += to_investors as u128 * ACC / m.invested as u128;
            m.house_profit += spread - to_investors;
        } else {
            m.house_profit += spread;
        }
    }

    fn claim_inner(&mut self, who: &AccountId, town: u8, p: &mut Player) -> u64 {
        let acc = self.merchants[town as usize].acc_per_share;
        if let Some(st) = self.stakes.get_mut(&(who.clone(), town)) {
            let owed = ((st.amount as u128 * acc - st.debt) / ACC) as u64;
            st.debt = st.amount as u128 * acc;
            p.coins += owed;
            owed
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: usize, ts_s: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(who)).block_timestamp(ts_s * 1_000_000_000).build());
    }

    fn game() -> Game {
        ctx(0, 1000);
        Game::new(60)
    }

    #[test]
    fn join_buy_travel_sell() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        let p = g.buy("grain".into(), 5, 10_000);
        assert_eq!(p.goods[0], 5);
        assert!(p.coins < 1000);
        let p = g.travel(1);
        assert_eq!(p.town, 1);
        assert_eq!(p.arrives_day, 1);
        ctx(1, 1000 + 60);
        let before = p.coins;
        let p = g.sell("grain".into(), 5, 0);
        assert!(p.coins > before, "grain should sell for more in Ironhold");
        assert_eq!(g.mt_balance_of(accounts(1), "grain".into()).0, 0);
    }

    #[test]
    #[should_panic(expected = "price moved above your limit")]
    fn slippage_guard() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.buy("spice".into(), 3, 1);
    }

    #[test]
    fn restock_after_days() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.buy("grain".into(), 5, 10_000);
        assert_eq!(g.get_merchant(0).stock[0], 195);
        ctx(1, 1000 + 60 * 3);
        assert!(g.get_merchant(0).stock[0] > 195);
    }

    #[test]
    fn investors_earn_from_other_players_trades() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.invest(500);
        ctx(2, 1000);
        g.join();
        g.buy("grain".into(), 5, 10_000);
        assert!(g.pending_dividends(accounts(1), 0) > 0);
        ctx(1, 1000);
        let got = g.claim(0);
        assert!(got > 0);
        assert_eq!(g.pending_dividends(accounts(1), 0), 0);
        assert_eq!(g.divest(0), 500);
    }

    #[test]
    fn bankruptcy_rules() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        // spend almost everything on travel
        for i in 0..31u64 {
            ctx(1, 1000 + 60 * i);
            g.travel(((i % 2) + 1) as u8);
        }
        ctx(1, 1000 + 60 * 31);
        let p = g.get_player(accounts(1)).unwrap();
        assert!(p.coins < 100);
        let p = g.declare_bankruptcy();
        assert_eq!(p.coins, RESTART_COINS);
        assert_eq!(p.bankruptcies, 1);
    }

    #[test]
    #[should_panic(expected = "you are not broke")]
    fn cannot_fake_bankruptcy() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.declare_bankruptcy();
    }

    #[test]
    #[should_panic(expected = "still on the road")]
    fn no_trading_while_travelling() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.travel(2);
        g.buy("spice".into(), 1, 10_000);
    }

    #[test]
    #[should_panic(expected = "your cart holds 15 units")]
    fn cart_capacity() {
        let mut g = game();
        ctx(1, 1000);
        g.join();
        g.buy("grain".into(), 10, 10_000);
        g.buy("grain".into(), 6, 10_000);
    }

    #[test]
    fn transfer_between_players() {
        let mut g = game();
        ctx(2, 1000);
        g.join();
        ctx(1, 1000);
        g.join();
        g.buy("cloth".into(), 2, 10_000);
        g.mt_transfer(accounts(2), "cloth".into(), U128(2), None);
        assert_eq!(g.mt_balance_of(accounts(2), "cloth".into()).0, 2);
    }
}

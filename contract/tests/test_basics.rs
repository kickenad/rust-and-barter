//! End-to-end on a local NEAR sandbox: deploy the real wasm, play a trade route with two accounts.
use near_api::{AccountId, NearToken};
use near_sdk::serde_json::{json, Value};

async fn acct(sb: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<near_api::Account> {
    let id: AccountId = name.parse()?;
    sb.create_account(id.clone()).initial_balance(NearToken::from_near(10)).send().await?;
    Ok(near_api::Account(id))
}

#[tokio::test]
async fn trade_route_on_sandbox() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sb = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sb.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let game = acct(&sb, "game.sandbox").await?.as_contract();
    let alice = acct(&sb, "alice.sandbox").await?;
    let bob = acct(&sb, "bob.sandbox").await?;

    near_api::Contract::deploy(game.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({"day_seconds": 10}))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    macro_rules! call {
        ($who:expr, $m:expr, $args:expr) => {
            game.call_function($m, $args).transaction().with_signer($who.account_id().clone(), signer.clone()).send_to(&net).await?
        };
    }
    macro_rules! view {
        ($m:expr, $args:expr) => {{
            let v: Value = game.call_function($m, $args).read_only().fetch_from(&net).await?.data;
            v
        }};
    }

    call!(alice, "join", json!({})).assert_success();
    call!(bob, "join", json!({})).assert_success();
    call!(alice, "join", json!({})).assert_failure(); // only once

    // Bob invests in Millbrook's merchant; Alice runs grain from Millbrook to Ironhold.
    call!(bob, "invest", json!({"amount": 400})).assert_success();
    call!(alice, "buy", json!({"good": "grain", "qty": 10, "max_total": 1000})).assert_success();
    let q = view!("pending_dividends", json!({"account_id": bob.account_id(), "town": 0}));
    assert!(q.as_u64().unwrap() > 0, "investor should earn from Alice's trade");

    call!(alice, "travel", json!({"town": 1})).assert_success();
    call!(alice, "sell", json!({"good": "grain", "qty": 10, "min_total": 0})).assert_failure(); // still on the road
    tokio::time::sleep(std::time::Duration::from_secs(11)).await; // one 10-second game day
    call!(alice, "sell", json!({"good": "grain", "qty": 10, "min_total": 0})).assert_success();
    let p = view!("get_player", json!({"account_id": alice.account_id()}));
    let coins = p["coins"].as_u64().unwrap();
    assert!(coins > 1000, "the grain route should be profitable, got {coins}");

    // NEP-245-style balance view
    let b = view!("mt_balance_of", json!({"account_id": alice.account_id(), "token_id": "grain"}));
    assert_eq!(b, json!("0"));
    println!("alice coins after one route: {coins}");
    Ok(())
}

//! The gateway. A Solana-compatible JSON-RPC subset (so @solana/web3.js and the Solana CLI
//! work), a small REST API and event stream for the site, and Solana pubsub on port + 1.

use crate::exec::ExecCmd;
use crate::lab::Lab;
use crate::net::{Net, SubmitError, LAMPORTS_PER_SOL};
use crate::state::TxRecord;
use crate::types::now_us;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;
use solana_transaction::versioned::VersionedTransaction;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::CorsLayer;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub struct Gateway {
    pub net: Arc<Net>,
    pub lab: Arc<Lab>,
    pub trust_proxy: bool,
    limits: Mutex<HashMap<String, Vec<u64>>>,
}

type App = Arc<Gateway>;

pub const FAUCET_LAMPORTS: u64 = 2 * LAMPORTS_PER_SOL;
const FAUCET_PER_KEY: usize = 3;
const FAUCET_PER_IP: usize = 10;
const FAUCET_WINDOW_US: u64 = 24 * 3600 * 1_000_000;

impl Gateway {
    pub fn new(net: Arc<Net>, lab: Arc<Lab>, trust_proxy: bool) -> App {
        Arc::new(Gateway { net, lab, trust_proxy, limits: Mutex::new(HashMap::new()) })
    }

    /// Returns false when `key` already used `max` grants in the window.
    fn allow(&self, key: &str, max: usize) -> bool {
        let now = now_us();
        let mut l = self.limits.lock();
        let v = l.entry(key.to_string()).or_default();
        v.retain(|t| now.saturating_sub(*t) < FAUCET_WINDOW_US);
        v.len() < max
    }

    /// Sealed transactions cannot be checked for fees before they open, so they are rate
    /// limited per connection instead: 30 a minute.
    fn allow_sealed(&self, ip: &str) -> bool {
        let now = now_us();
        let mut l = self.limits.lock();
        let v = l.entry(format!("sealed:{ip}")).or_default();
        v.retain(|t| now.saturating_sub(*t) < 60_000_000);
        if v.len() >= 30 {
            return false;
        }
        v.push(now);
        true
    }

    fn submit_sealed(&self, b64: &str, ip: &str) -> Result<String, (i64, String)> {
        if !self.allow_sealed(ip) {
            return Err((429, "30 sealed transactions a minute per connection. Try again shortly.".into()));
        }
        let raw = B64.decode(b64.trim()).map_err(|_| (-32602, "envelope is not valid base64".to_string()))?;
        self.net.submit_sealed(raw, "user").map_err(|e| (-32602, e.message()))
    }

    fn record(&self, key: &str) {
        self.limits.lock().entry(key.to_string()).or_default().push(now_us());
    }

    fn faucet(&self, address: &str, ip: &str) -> Result<String, (i64, String)> {
        let addr = Address::from_str(address).map_err(|_| (-32602, "Invalid address".to_string()))?;
        let (kk, ik) = (format!("k:{address}"), format!("ip:{ip}"));
        if !self.allow(&kk, FAUCET_PER_KEY) {
            return Err((429, "This address already had 3 grants in the last 24 hours".into()));
        }
        if !self.allow(&ik, FAUCET_PER_IP) {
            return Err((429, "Too many grants from this connection in the last 24 hours".into()));
        }
        let sig = self.net.airdrop(&addr, FAUCET_LAMPORTS).map_err(|e| (-32005, e.message()))?;
        self.record(&kk);
        self.record(&ik);
        Ok(sig)
    }
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/", post(rpc_http))
        .route("/health", get(|| async { "ok" }))
        .route("/events", get(events_ws))
        .route("/v1/net", get(v1_net))
        .route("/v1/blocks", get(v1_blocks))
        .route("/v1/blocks/{slot}", get(v1_block))
        .route("/v1/tx/{sig}", get(v1_tx))
        .route("/v1/address/{addr}", get(v1_address))
        .route("/v1/latency", get(v1_latency))
        .route("/v1/faucet", post(v1_faucet))
        .route("/v1/seal", get(v1_seal))
        .route("/v1/sealed", post(v1_sealed))
        .route("/v1/lab/scenarios", get(v1_lab_scenarios))
        .route("/v1/lab/runs", post(v1_lab_start))
        .route("/v1/lab/runs/{id}", get(v1_lab_run))
        .layer(CorsLayer::permissive())
        .with_state(app)
}

pub fn pubsub_router(app: App) -> Router {
    Router::new().route("/", get(pubsub_ws)).layer(CorsLayer::permissive()).with_state(app)
}

fn client_ip(app: &Gateway, headers: &HeaderMap, peer: SocketAddr) -> String {
    if app.trust_proxy {
        if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(last) = xff.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).next_back() {
                return last.to_string();
            }
        }
    }
    peer.ip().to_string()
}

// ---------- JSON-RPC ----------

async fn rpc_http(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
    let ip = client_ip(&app, &headers, peer);
    if let Value::Array(reqs) = body {
        let mut out = Vec::new();
        for r in reqs {
            out.push(handle_rpc(&app, r, &ip).await);
        }
        Json(Value::Array(out))
    } else {
        Json(handle_rpc(&app, body, &ip).await)
    }
}

fn ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = json!({ "code": code, "message": message });
    if let Some(d) = data {
        e["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": e })
}

fn ctx(slot: u64, value: Value) -> Value {
    json!({ "context": { "apiVersion": "3.1.14", "slot": slot }, "value": value })
}

fn decode_tx(encoded: &str, encoding: &str) -> Result<Vec<u8>, String> {
    if encoding == "base64" {
        B64.decode(encoded).map_err(|e| e.to_string())
    } else {
        bs58::decode(encoded).into_vec().map_err(|e| e.to_string())
    }
}

async fn accounts(app: &Gateway, keys: Vec<Address>) -> Vec<Option<solana_account::Account>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if app.net.exec.send(ExecCmd::Accounts(keys, tx)).is_err() {
        return vec![];
    }
    rx.await.unwrap_or_default()
}

fn account_json(a: &solana_account::Account, encoding: &str) -> Value {
    let data = if encoding == "base58" {
        json!([bs58::encode(&a.data).into_string(), "base58"])
    } else {
        json!([B64.encode(&a.data), "base64"])
    };
    json!({
        "data": data, "executable": a.executable, "lamports": a.lamports,
        "owner": a.owner.to_string(), "rentEpoch": u64::MAX, "space": a.data.len(),
    })
}

fn tx_status(rec: &TxRecord) -> Value {
    let (status, conf) = match rec.status {
        "finalized" => (json!({ "Ok": null }), "finalized"),
        "failed" => (json!({ "Err": rec.err }), "finalized"),
        _ => (json!({ "Ok": null }), "processed"),
    };
    let err = if rec.status == "failed" { json!(rec.err) } else { Value::Null };
    json!({ "slot": rec.slot.unwrap_or(0), "confirmations": if conf == "finalized" { Value::Null } else { json!(0) }, "err": err, "status": status, "confirmationStatus": conf })
}

async fn handle_rpc(app: &Gateway, req: Value, ip: &str) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!([]));
    let p0 = params.get(0).cloned().unwrap_or(Value::Null);
    let p1 = params.get(1).cloned().unwrap_or(Value::Null);
    let net = &app.net;
    let slot = net.state.read().slot();
    match method {
        "getHealth" => ok(&id, json!("ok")),
        "getVersion" => ok(&id, json!({ "solana-core": "3.1.14", "feature-set": 0, "salvo": env!("CARGO_PKG_VERSION") })),
        "getGenesisHash" => ok(&id, json!(net.genesis_hash.to_string())),
        "getIdentity" => ok(&id, json!({ "identity": net.state.read().validators.first().map(|v| v.identity.clone()) })),
        "getSlot" | "getBlockHeight" => ok(&id, json!(slot)),
        "getTransactionCount" => ok(&id, json!(net.state.read().stats.txs)),
        "getFirstAvailableBlock" => ok(&id, json!(net.state.read().blocks.front().map(|b| b.slot).unwrap_or(0))),
        "getEpochInfo" => {
            let txs = net.state.read().stats.txs;
            ok(&id, json!({ "absoluteSlot": slot, "blockHeight": slot, "epoch": 0, "slotIndex": slot, "slotsInEpoch": u64::MAX / 2, "transactionCount": txs }))
        }
        "getLatestBlockhash" => {
            let (h, s) = net.latest_blockhash();
            ok(&id, ctx(slot, json!({ "blockhash": h.to_string(), "lastValidBlockHeight": s + net.valid_blocks() })))
        }
        "isBlockhashValid" => {
            let valid = p0.as_str().and_then(|s| Hash::from_str(s).ok()).map(|h| net.blockhashes.read().contains(&h)).unwrap_or(false);
            ok(&id, ctx(slot, json!(valid)))
        }
        "getFeeForMessage" => {
            let fee = p0
                .as_str()
                .and_then(|s| B64.decode(s).ok())
                .and_then(|b| bincode::deserialize::<solana_message::VersionedMessage>(&b).ok())
                .map(|m| m.header().num_required_signatures as u64 * 5000);
            ok(&id, ctx(slot, json!(fee)))
        }
        "getRecentPrioritizationFees" => ok(&id, json!([])),
        "getMinimumBalanceForRentExemption" => {
            let len = p0.as_u64().unwrap_or(0) as usize;
            let (tx, rx) = tokio::sync::oneshot::channel();
            let _ = net.exec.send(ExecCmd::RentExempt(len, tx));
            ok(&id, json!(rx.await.unwrap_or(0)))
        }
        "getBalance" => match p0.as_str().and_then(|s| Address::from_str(s).ok()) {
            Some(a) => {
                let acc = accounts(app, vec![a]).await;
                let lamports = acc.first().and_then(|a| a.as_ref()).map(|a| a.lamports).unwrap_or(0);
                ok(&id, ctx(slot, json!(lamports)))
            }
            None => err(&id, -32602, "Invalid param: Invalid", None),
        },
        "getAccountInfo" => match p0.as_str().and_then(|s| Address::from_str(s).ok()) {
            Some(a) => {
                let enc = p1.get("encoding").and_then(|e| e.as_str()).unwrap_or("base64").to_string();
                let acc = accounts(app, vec![a]).await;
                let v = acc.first().and_then(|a| a.as_ref()).map(|a| account_json(a, &enc)).unwrap_or(Value::Null);
                ok(&id, ctx(slot, v))
            }
            None => err(&id, -32602, "Invalid param: Invalid", None),
        },
        "getMultipleAccounts" => {
            let keys: Vec<Address> = p0.as_array().map(|a| a.iter().filter_map(|k| k.as_str()).filter_map(|s| Address::from_str(s).ok()).collect()).unwrap_or_default();
            let enc = p1.get("encoding").and_then(|e| e.as_str()).unwrap_or("base64").to_string();
            let accs = accounts(app, keys).await;
            let v: Vec<Value> = accs.iter().map(|a| a.as_ref().map(|a| account_json(a, &enc)).unwrap_or(Value::Null)).collect();
            ok(&id, ctx(slot, json!(v)))
        }
        "requestAirdrop" => {
            let addr = p0.as_str().unwrap_or("");
            match app.faucet(addr, ip) {
                Ok(sig) => ok(&id, json!(sig)),
                Err((c, m)) => err(&id, c, &m, None),
            }
        }
        "sendTransaction" | "simulateTransaction" => {
            let enc = p1.get("encoding").and_then(|e| e.as_str()).unwrap_or("base58").to_string();
            let raw = match p0.as_str().map(|s| decode_tx(s, &enc)) {
                Some(Ok(r)) => r,
                _ => return err(&id, -32602, "invalid transaction: failed to decode", None),
            };
            let tx: VersionedTransaction = match bincode::deserialize(&raw) {
                Ok(t) => t,
                Err(e) => return err(&id, -32602, &format!("failed to deserialize transaction: {e}"), None),
            };
            let skip = p1.get("skipPreflight").and_then(|v| v.as_bool()).unwrap_or(false);
            if method == "simulateTransaction" || !skip {
                let (stx, srx) = tokio::sync::oneshot::channel();
                let _ = net.exec.send(ExecCmd::Simulate(Box::new(tx.clone()), stx));
                let sim = srx.await.unwrap_or(json!({ "err": "unavailable" }));
                if method == "simulateTransaction" {
                    return ok(&id, ctx(slot, json!({ "err": sim["err"], "logs": sim["logs"], "accounts": null, "unitsConsumed": sim["unitsConsumed"], "returnData": null })));
                }
                if !sim["err"].is_null() {
                    return err(&id, -32002, &format!("Transaction simulation failed: {}", sim["err"].as_str().unwrap_or("error")), Some(json!({ "err": sim["err"], "logs": sim["logs"], "unitsConsumed": sim["unitsConsumed"], "accounts": null })));
                }
            }
            match net.submit(raw, "user") {
                Ok(sig) => ok(&id, json!(sig)),
                Err(e @ SubmitError::Blockhash) => err(&id, -32002, &e.message(), Some(json!({ "err": "BlockhashNotFound", "logs": [] }))),
                Err(e) => err(&id, -32003, &e.message(), None),
            }
        }
        "getSignatureStatuses" => {
            let st = net.state.read();
            let v: Vec<Value> = p0
                .as_array()
                .map(|a| a.iter().map(|s| s.as_str().and_then(|s| st.txs.get(s)).filter(|r| r.status != "received").map(tx_status).unwrap_or(Value::Null)).collect())
                .unwrap_or_default();
            ok(&id, ctx(slot, json!(v)))
        }
        "getTransaction" => {
            let enc = p1.get("encoding").and_then(|e| e.as_str()).unwrap_or("json").to_string();
            let st = net.state.read();
            match p0.as_str().and_then(|s| st.txs.get(s)) {
                Some(r) if r.status == "finalized" || r.status == "failed" => ok(&id, transaction_json(r, &enc)),
                _ => ok(&id, Value::Null),
            }
        }
        "getBlockTime" => {
            let st = net.state.read();
            let t = p0.as_u64().and_then(|s| st.block_at(s)).map(|b| b.executed_at_us / 1_000_000);
            ok(&id, json!(t))
        }
        "salvo_stats" => ok(&id, net.state.read().stats_json()),
        "salvo_sendSealed" => match app.submit_sealed(p0.as_str().unwrap_or(""), ip) {
            Ok(k) => ok(&id, json!(k)),
            Err((c, m)) => err(&id, c, &m, None),
        },
        "salvo_getSealKeys" => ok(&id, seal_keys(net)),
        _ => err(&id, -32601, "Method not found", None),
    }
}

fn transaction_json(r: &TxRecord, enc: &str) -> Value {
    let status = if r.err.is_some() { json!({ "Err": r.err }) } else { json!({ "Ok": null }) };
    let meta = json!({
        "err": r.err, "status": status, "fee": r.fee, "preBalances": r.pre_balances, "postBalances": r.post_balances,
        "logMessages": r.logs, "innerInstructions": [], "preTokenBalances": [], "postTokenBalances": [],
        "rewards": [], "computeUnitsConsumed": r.compute_units, "loadedAddresses": { "writable": [], "readonly": [] },
    });
    let tx = match (&r.raw, enc) {
        (Some(raw), "base64") => json!([B64.encode(raw.as_slice()), "base64"]),
        (Some(raw), _) => match bincode::deserialize::<VersionedTransaction>(raw) {
            Ok(t) => {
                let m = &t.message;
                let h = m.header();
                let ixs: Vec<Value> = m
                    .instructions()
                    .iter()
                    .map(|ix| json!({ "programIdIndex": ix.program_id_index, "accounts": ix.accounts, "data": bs58::encode(&ix.data).into_string(), "stackHeight": null }))
                    .collect();
                json!({
                    "signatures": t.signatures.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                    "message": {
                        "header": { "numRequiredSignatures": h.num_required_signatures, "numReadonlySignedAccounts": h.num_readonly_signed_accounts, "numReadonlyUnsignedAccounts": h.num_readonly_unsigned_accounts },
                        "accountKeys": m.static_account_keys().iter().map(|k| k.to_string()).collect::<Vec<_>>(),
                        "recentBlockhash": m.recent_blockhash().to_string(),
                        "instructions": ixs,
                    }
                })
            }
            Err(_) => Value::Null,
        },
        (None, _) => Value::Null,
    };
    json!({ "slot": r.slot, "blockTime": r.executed_at_us.map(|t| t / 1_000_000), "meta": meta, "transaction": tx, "version": "legacy" })
}

// ---------- REST for the site ----------

async fn v1_net(State(app): State<App>) -> Json<Value> {
    let st = app.net.state.read();
    let recent: Vec<Value> = st.blocks.iter().rev().take(240).map(block_summary).collect();
    Json(json!({
        "stats": st.stats_json(),
        "instances": st.instances,
        "validators": st.validators,
        "recentBlocks": recent,
        "recentActivity": st.recent_activity,
        "observerCity": app.net.cfg.observer_city.code(),
        "rpc": { "faucetLamports": FAUCET_LAMPORTS },
    }))
}

fn block_summary(b: &crate::state::BlockRecord) -> Value {
    json!({
        "slot": b.slot, "instance": b.instance, "view": b.view, "leader": b.leader, "city": b.leader_city,
        "txs": b.tx_count, "proposedAtUs": b.proposed_at_us, "finalizedAtUs": b.finalized_at_us,
        "mergedAtUs": b.merged_at_us, "executedAtUs": b.executed_at_us, "blockhash": b.blockhash,
        "sealed": b.sealed,
    })
}

#[derive(Deserialize)]
struct BlocksQuery {
    before: Option<u64>,
    limit: Option<usize>,
}

async fn v1_blocks(State(app): State<App>, Query(q): Query<BlocksQuery>) -> Json<Value> {
    let st = app.net.state.read();
    let limit = q.limit.unwrap_or(50).min(500);
    let before = q.before.unwrap_or(u64::MAX);
    let v: Vec<Value> = st.blocks.iter().rev().filter(|b| b.slot < before).take(limit).map(block_summary).collect();
    Json(json!({ "blocks": v, "tip": st.slot() }))
}

async fn v1_block(State(app): State<App>, Path(slot): Path<u64>) -> Response {
    let st = app.net.state.read();
    match st.block_at(slot) {
        Some(b) => {
            let txs: Vec<Value> = b
                .signatures
                .iter()
                .filter_map(|s| st.txs.get(s))
                .map(|t| json!({ "signature": t.signature, "status": t.status, "fee": t.fee, "feePayer": t.fee_payer, "source": t.source, "err": t.err, "computeUnits": t.compute_units, "sealed": t.sealed_id.is_some() }))
                .collect();
            let mut v = serde_json::to_value(b).unwrap_or(Value::Null);
            v["transactions"] = json!(txs);
            v["tip"] = json!(st.slot());
            Json(v).into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "This block is not kept any more, or does not exist yet", "tip": st.slot() }))).into_response(),
    }
}

/// Balance and recent transactions of one account, for the "Mine" page.
async fn v1_address(State(app): State<App>, Path(addr): Path<String>) -> Response {
    let Ok(a) = Address::from_str(addr.trim()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "That is not a valid Solana address" }))).into_response();
    };
    let acc = accounts(&app, vec![a]).await;
    let lamports = acc.first().and_then(|x| x.as_ref()).map(|x| x.lamports).unwrap_or(0);
    let st = app.net.state.read();
    let txs: Vec<Value> = st
        .by_address
        .get(&a.to_string())
        .map(|l| {
            l.iter()
                .rev()
                .filter_map(|s| st.txs.get(s))
                .map(|t| {
                    let i = t.accounts.iter().position(|x| x == &addr);
                    let change = i.and_then(|i| Some(*t.post_balances.get(i)? as i64 - *t.pre_balances.get(i)? as i64));
                    json!({
                        "signature": t.signature, "status": t.status, "slot": t.slot, "err": t.err,
                        "sealed": t.sealed_id.is_some(), "source": t.source, "fee": t.fee,
                        "executedAtUs": t.executed_at_us, "receivedAtUs": t.received_at_us, "change": change,
                        "feePayer": t.fee_payer,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(json!({ "address": a.to_string(), "lamports": lamports, "transactions": txs, "tip": st.slot() })).into_response()
}

fn seal_keys(net: &Net) -> Value {
    json!({
        "n": net.seal_pubs.len(),
        "threshold": net.seal_t,
        "keys": net.seal_pubs.iter().map(|k| crate::types::hex(k)).collect::<Vec<_>>(),
        "format": "SLV1",
    })
}

async fn v1_seal(State(app): State<App>) -> Json<Value> {
    Json(seal_keys(&app.net))
}

#[derive(Deserialize)]
struct SealedBody {
    envelope: String,
}

async fn v1_sealed(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(b): Json<SealedBody>) -> Response {
    let ip = client_ip(&app, &headers, peer);
    match app.submit_sealed(&b.envelope, &ip) {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err((code, m)) => {
            let status = if code == 429 { StatusCode::TOO_MANY_REQUESTS } else { StatusCode::BAD_REQUEST };
            (status, Json(json!({ "error": m }))).into_response()
        }
    }
}

async fn v1_tx(State(app): State<App>, Path(sig): Path<String>) -> Response {
    let st = app.net.state.read();
    // A sealed envelope's id resolves to the transaction it opened into, once it has.
    let rec = st.txs.get(&sig).map(|t| match &t.revealed_as {
        Some(real) => st.txs.get(real).unwrap_or(t),
        None => t,
    });
    match rec {
        Some(t) => Json(json!({ "tx": t, "tip": st.slot() })).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "No transaction with this signature on this net" }))).into_response(),
    }
}

async fn v1_latency(State(app): State<App>) -> Json<Value> {
    let st = app.net.state.read();
    Json(json!({
        "gapMs": st.stats.gap.values().iter().rev().take(600).collect::<Vec<_>>(),
        "blockFinalityMs": st.stats.block_finality.values().iter().rev().take(600).collect::<Vec<_>>(),
        "txFinalityMs": st.stats.tx_finality.values(),
    }))
}

#[derive(Deserialize)]
struct FaucetBody {
    address: String,
}

async fn v1_faucet(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(b): Json<FaucetBody>) -> Response {
    let ip = client_ip(&app, &headers, peer);
    match app.faucet(b.address.trim(), &ip) {
        Ok(sig) => Json(json!({ "signature": sig, "lamports": FAUCET_LAMPORTS })).into_response(),
        Err((code, m)) => {
            let status = if code == 429 { StatusCode::TOO_MANY_REQUESTS } else { StatusCode::BAD_REQUEST };
            (status, Json(json!({ "error": m }))).into_response()
        }
    }
}

async fn v1_lab_scenarios(State(app): State<App>) -> Json<Value> {
    Json(app.lab.scenarios_json())
}

#[derive(Deserialize)]
struct LabStart {
    scenario: String,
}

async fn v1_lab_start(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(b): Json<LabStart>) -> Response {
    let ip = client_ip(&app, &headers, peer);
    let key = format!("lab:{ip}");
    {
        let now = now_us();
        let mut l = app.limits.lock();
        let v = l.entry(key.clone()).or_default();
        v.retain(|t| now.saturating_sub(*t) < 3600 * 1_000_000);
        if v.len() >= 6 {
            return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "Six runs an hour per connection. Try again later." }))).into_response();
        }
        v.push(now);
    }
    match app.lab.start(&b.scenario) {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

async fn v1_lab_run(State(app): State<App>, Path(id): Path<String>) -> Response {
    match app.lab.get(&id) {
        Some(v) => Json(v).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "No such run" }))).into_response(),
    }
}

// ---------- event stream for the site ----------

async fn events_ws(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| events_loop(app, socket))
}

async fn events_loop(app: App, mut socket: WebSocket) {
    let (snapshot, mut rx) = {
        let st = app.net.state.read();
        let recent: Vec<Value> = st.blocks.iter().rev().take(240).map(block_summary).collect();
        let snap = json!({ "type": "snapshot", "stats": st.stats_json(), "instances": st.instances, "validators": st.validators, "recentBlocks": recent, "recentActivity": st.recent_activity });
        (snap.to_string(), st.events.subscribe())
    };
    if socket.send(WsMessage::Text(snapshot.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(m) => {
                    if socket.send(WsMessage::Text(m.as_str().to_owned().into())).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            }
        }
    }
}

// ---------- Solana pubsub (signatureSubscribe, slotSubscribe) ----------

async fn pubsub_ws(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| pubsub_loop(app, socket))
}

async fn pubsub_loop(app: App, mut socket: WebSocket) {
    let mut next_id = 1u64;
    let mut sigs: HashMap<u64, String> = HashMap::new();
    let mut slot_subs: Vec<u64> = Vec::new();
    let mut last_slot = 0u64;
    let mut iv = tokio::time::interval(Duration::from_millis(40));
    loop {
        tokio::select! {
            _ = iv.tick() => {
                let mut out = Vec::new();
                {
                    let st = app.net.state.read();
                    let slot = st.slot();
                    if slot != last_slot && !slot_subs.is_empty() {
                        for s in &slot_subs {
                            out.push(json!({ "jsonrpc": "2.0", "method": "slotNotification", "params": { "result": { "parent": slot.saturating_sub(1), "root": slot, "slot": slot }, "subscription": s } }));
                        }
                        last_slot = slot;
                    }
                    let mut done = Vec::new();
                    for (sub, sig) in &sigs {
                        if let Some(r) = st.txs.get(sig) {
                            if r.status == "finalized" || r.status == "failed" {
                                let e = if r.status == "failed" { json!(r.err) } else { Value::Null };
                                out.push(json!({ "jsonrpc": "2.0", "method": "signatureNotification", "params": { "result": { "context": { "slot": r.slot }, "value": { "err": e } }, "subscription": sub } }));
                                done.push(*sub);
                            }
                        }
                    }
                    for d in done { sigs.remove(&d); }
                }
                for m in out {
                    if socket.send(WsMessage::Text(m.to_string().into())).await.is_err() { return; }
                }
            }
            incoming = socket.recv() => {
                let text = match incoming {
                    Some(Ok(WsMessage::Text(t))) => t.to_string(),
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return,
                    _ => continue,
                };
                let Ok(req) = serde_json::from_str::<Value>(&text) else { continue };
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let reply = match method {
                    "signatureSubscribe" => {
                        let sub = next_id; next_id += 1;
                        if let Some(s) = req["params"][0].as_str() { sigs.insert(sub, s.to_string()); }
                        ok(&id, json!(sub))
                    }
                    "slotSubscribe" | "rootSubscribe" => { let sub = next_id; next_id += 1; slot_subs.push(sub); ok(&id, json!(sub)) }
                    "signatureUnsubscribe" => { let s = req["params"][0].as_u64().unwrap_or(0); ok(&id, json!(sigs.remove(&s).is_some())) }
                    "slotUnsubscribe" | "rootUnsubscribe" => { let s = req["params"][0].as_u64().unwrap_or(0); slot_subs.retain(|x| *x != s); ok(&id, json!(true)) }
                    _ => err(&id, -32601, "Method not found", None),
                };
                if socket.send(WsMessage::Text(reply.to_string().into())).await.is_err() { return; }
            }
        }
    }
}

//! What the gateway knows about the net: merged blocks, transactions, instances, validators,
//! rolling measurements, and the events it streams to the site.

use crate::geo::City;
use crate::types::NodeId;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::broadcast;

pub const KEEP_BLOCKS: usize = 4096;
pub const KEEP_TXS: usize = 100_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRecord {
    pub slot: u64,
    pub instance: u16,
    pub view: u64,
    pub height: u64,
    pub leader: NodeId,
    pub leader_city: &'static str,
    pub proposed_at_us: u64,
    pub notarized_at_us: Option<u64>,
    pub finalized_at_us: u64,
    pub merged_at_us: u64,
    pub executed_at_us: u64,
    pub digest: String,
    pub parent: String,
    pub blockhash: String,
    pub log_hash: String,
    pub tx_count: usize,
    pub signatures: Vec<String>,
    pub failed: usize,
    pub duplicates: usize,
    pub sealed: usize,
    pub fees: u64,
    pub compute_units: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRecord {
    pub signature: String,
    pub received_at_us: u64,
    pub status: &'static str,
    pub included_at_us: Option<u64>,
    pub instance: Option<u16>,
    pub view: Option<u64>,
    pub slot: Option<u64>,
    pub finalized_at_us: Option<u64>,
    pub executed_at_us: Option<u64>,
    pub err: Option<String>,
    pub logs: Vec<String>,
    pub fee: u64,
    pub compute_units: u64,
    pub copies: u32,
    pub fee_payer: String,
    pub accounts: Vec<String>,
    pub pre_balances: Vec<u64>,
    pub post_balances: Vec<u64>,
    /// "user" for transactions sent through the gateway, "traffic" for the demo load.
    pub source: &'static str,
    /// For a sealed transaction: the envelope id (hex). Set on both the envelope's record and
    /// the record of the transaction it opened into.
    pub sealed_id: Option<String>,
    pub revealed_at_us: Option<u64>,
    /// On an envelope's record: the signature of the transaction inside, once revealed.
    pub revealed_as: Option<String>,
    #[serde(skip)]
    pub raw: Option<Arc<Vec<u8>>>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    pub instance: u16,
    pub view: u64,
    pub finalized_view: u64,
    pub finalized_height: u64,
    pub blocks: u64,
    pub skipped: u64,
    pub next_proposal_us: u64,
    pub leader: NodeId,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorInfo {
    pub id: NodeId,
    pub city: &'static str,
    pub city_name: &'static str,
    pub identity: String,
    pub proposed: u64,
    pub last_proposed_at_us: u64,
    pub down: bool,
}

/// A fixed-size window of recent samples for percentiles.
#[derive(Default)]
pub struct Window {
    v: VecDeque<f64>,
    cap: usize,
}

impl Window {
    pub fn new(cap: usize) -> Window {
        Window { v: VecDeque::with_capacity(cap), cap }
    }
    pub fn push(&mut self, x: f64) {
        if self.v.len() == self.cap {
            self.v.pop_front();
        }
        self.v.push_back(x);
    }
    pub fn pct(&self, p: f64) -> Option<f64> {
        if self.v.is_empty() {
            return None;
        }
        let mut s: Vec<f64> = self.v.iter().copied().collect();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let i = ((s.len() - 1) as f64 * p).round() as usize;
        Some(s[i])
    }
    pub fn values(&self) -> Vec<f64> {
        self.v.iter().copied().collect()
    }
}

pub struct Stats {
    pub merged: u64,
    pub txs: u64,
    pub failed_txs: u64,
    pub duplicates: u64,
    pub skipped_views: u64,
    /// The last 2000 finalizations: true if the fast lane (80% notarize) got there first.
    pub fast_finals: VecDeque<bool>,
    pub sealed_submitted: u64,
    pub sealed_revealed: u64,
    /// Merged to revealed, for sealed transactions, ms.
    pub reveal_ms: Window,
    /// Time between consecutive merged blocks' proposals, ms.
    pub gap: Window,
    /// Proposal to merged in the log, ms.
    pub block_finality: Window,
    /// Received by the gateway to executed, ms.
    pub tx_finality: Window,
    pub started_us: u64,
    pub last_proposed_us: u64,
    /// (second, merged blocks in that second) for the last minute.
    pub per_second: VecDeque<(u64, u32)>,
}

pub struct NetState {
    pub name: String,
    pub k: usize,
    pub n: usize,
    pub delta_ms: u64,
    pub timeout_ms: u64,
    pub genesis_us: u64,
    pub genesis_hash: String,
    pub blocks: VecDeque<BlockRecord>,
    pub txs: HashMap<String, TxRecord>,
    pub tx_order: VecDeque<String>,
    pub tx_ids: HashMap<[u8; 32], String>,
    /// Recent signatures per account, newest last, for the "Mine" page.
    pub by_address: HashMap<String, VecDeque<String>>,
    /// The latest notable events (sealed reveals, sends, faucet grants, lab runs), newest last,
    /// so a new visitor sees what just happened with real timestamps.
    pub recent_activity: VecDeque<Value>,
    last_traffic_activity_us: u64,
    pub instances: Vec<InstanceStatus>,
    pub validators: Vec<ValidatorInfo>,
    pub stats: Stats,
    pub notarized_at: HashMap<[u8; 32], u64>,
    pending: Vec<Value>,
    pub events: broadcast::Sender<Arc<String>>,
}

pub type SharedState = Arc<RwLock<NetState>>;

impl NetState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(name: &str, k: usize, n: usize, delta_ms: u64, timeout_ms: u64, genesis_us: u64, genesis_hash: String, validators: Vec<(NodeId, City, String)>) -> NetState {
        let (events, _) = broadcast::channel(1024);
        NetState {
            name: name.to_string(),
            k,
            n,
            delta_ms,
            timeout_ms,
            genesis_us,
            genesis_hash,
            blocks: VecDeque::with_capacity(KEEP_BLOCKS),
            txs: HashMap::new(),
            tx_order: VecDeque::new(),
            tx_ids: HashMap::new(),
            by_address: HashMap::new(),
            recent_activity: VecDeque::new(),
            last_traffic_activity_us: 0,
            instances: (0..k as u16).map(|i| InstanceStatus { instance: i, ..Default::default() }).collect(),
            validators: validators
                .into_iter()
                .map(|(id, city, identity)| ValidatorInfo {
                    id,
                    city: city.code(),
                    city_name: city.name(),
                    identity,
                    proposed: 0,
                    last_proposed_at_us: 0,
                    down: false,
                })
                .collect(),
            stats: Stats {
                merged: 0,
                txs: 0,
                failed_txs: 0,
                duplicates: 0,
                skipped_views: 0,
                fast_finals: VecDeque::new(),
                sealed_submitted: 0,
                sealed_revealed: 0,
                reveal_ms: Window::new(500),
                gap: Window::new(2000),
                block_finality: Window::new(2000),
                tx_finality: Window::new(500),
                started_us: genesis_us,
                last_proposed_us: 0,
                per_second: VecDeque::new(),
            },
            notarized_at: HashMap::new(),
            pending: Vec::new(),
            events,
        }
    }

    pub fn push_event(&mut self, ev: Value) {
        if self.events.receiver_count() > 0 {
            self.pending.push(ev);
        }
        if self.pending.len() > 5000 {
            self.pending.drain(..1000);
        }
    }

    pub fn take_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }

    pub fn tip(&self) -> Option<&BlockRecord> {
        self.blocks.back()
    }

    pub fn slot(&self) -> u64 {
        self.stats.merged
    }

    pub fn block_at(&self, slot: u64) -> Option<&BlockRecord> {
        let first = self.blocks.front()?.slot;
        if slot < first {
            return None;
        }
        self.blocks.get((slot - first) as usize)
    }

    /// A real event worth showing on the live strip. `fields` must be a JSON object.
    pub fn activity(&mut self, kind: &str, mut fields: Value) {
        // Background sealed transfers arrive several times a second; show one every 1.5 s so
        // rarer events (sends, faucet grants, lab runs) stay visible.
        if kind == "sealed" && fields["source"] == "traffic" {
            let now = crate::types::now_us();
            if now.saturating_sub(self.last_traffic_activity_us) < 1_500_000 {
                return;
            }
            self.last_traffic_activity_us = now;
        }
        if let Some(o) = fields.as_object_mut() {
            o.insert("type".into(), json!("activity"));
            o.insert("kind".into(), json!(kind));
            o.entry("atUs").or_insert(json!(crate::types::now_us()));
        }
        self.recent_activity.push_back(fields.clone());
        while self.recent_activity.len() > 40 {
            self.recent_activity.pop_front();
        }
        self.push_event(fields);
    }

    pub fn index_tx(&mut self, sig: &str, accounts: &[String]) {
        for a in accounts {
            let list = self.by_address.entry(a.clone()).or_default();
            if list.back().map(|s| s == sig).unwrap_or(false) {
                continue;
            }
            list.push_back(sig.to_string());
            while list.len() > 50 {
                list.pop_front();
            }
        }
        if self.by_address.len() > 50_000 {
            self.by_address.retain(|_, v| v.len() > 1);
        }
    }

    pub fn add_tx(&mut self, rec: TxRecord, id: [u8; 32]) {
        if self.txs.contains_key(&rec.signature) {
            return;
        }
        self.tx_ids.insert(id, rec.signature.clone());
        self.tx_order.push_back(rec.signature.clone());
        self.txs.insert(rec.signature.clone(), rec);
        while self.tx_order.len() > KEEP_TXS {
            if let Some(old) = self.tx_order.pop_front() {
                self.txs.remove(&old);
            }
        }
        if self.tx_ids.len() > KEEP_TXS * 2 {
            let keep: std::collections::HashSet<&String> = self.tx_order.iter().collect();
            self.tx_ids.retain(|_, s| keep.contains(s));
        }
    }

    pub fn stats_json(&self) -> Value {
        let s = &self.stats;
        let now = crate::types::now_us();
        let last_minute: u32 = s.per_second.iter().map(|(_, c)| *c).sum();
        let secs = s.per_second.len().max(1) as f64;
        json!({
            "name": self.name,
            "instances": self.k,
            "validators": self.n,
            "deltaMs": self.delta_ms,
            "targetGapMs": self.delta_ms as f64 / self.k as f64,
            "timeoutMs": self.timeout_ms,
            // Alpenglow thresholds: 60% for certificates, 80% for the fast lane, rounded up.
            "quorum": (self.n * 60).div_ceil(100),
            "fastQuorum": (self.n * 80).div_ceil(100),
            "safetyViolations": crate::consensus::SAFETY_VIOLATIONS.load(std::sync::atomic::Ordering::Relaxed),
            "fastShare": if s.fast_finals.is_empty() { Value::Null } else { json!(s.fast_finals.iter().filter(|f| **f).count() as f64 / s.fast_finals.len() as f64) },
            "sealThreshold": (self.n - 1) / 3 + 1,
            "slot": s.merged,
            "transactions": s.txs,
            "failedTransactions": s.failed_txs,
            "duplicateCopies": s.duplicates,
            "skippedViews": s.skipped_views,
            "sealedSubmitted": s.sealed_submitted,
            "sealedRevealed": s.sealed_revealed,
            "revealMs": { "p50": s.reveal_ms.pct(0.5), "p90": s.reveal_ms.pct(0.9) },
            "gapMs": { "p50": s.gap.pct(0.5), "p90": s.gap.pct(0.9), "p99": s.gap.pct(0.99) },
            "blockFinalityMs": { "p50": s.block_finality.pct(0.5), "p90": s.block_finality.pct(0.9), "p99": s.block_finality.pct(0.99) },
            "txFinalityMs": { "p50": s.tx_finality.pct(0.5), "p90": s.tx_finality.pct(0.9), "p99": s.tx_finality.pct(0.99) },
            "blocksPerSecond": last_minute as f64 / secs,
            "uptimeSeconds": (now.saturating_sub(s.started_us)) / 1_000_000,
            "genesisUs": self.genesis_us,
            "nowUs": now,
            "live": s.last_proposed_us > 0 && now.saturating_sub(s.last_proposed_us) < 3_000_000,
        })
    }
}

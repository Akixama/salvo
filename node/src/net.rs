//! Starts a net: N validators and one observer on a simulated wire, the chain task that merges
//! what the observer sees, the executor thread, and optional background traffic.

use crate::bus::Bus;
use crate::consensus::{tx_id, Node, ObsEvent, Params, Role, Shared};
use crate::exec::{genesis_hash, Blockhashes, ExecCmd, Executor, Merged};
use crate::geo::{city_of, City};
use crate::merge::Merger;
use crate::state::{NetState, SharedState, TxRecord};
use crate::types::*;
use ed25519_dalek::VerifyingKey;
use parking_lot::RwLock;
use rand::{Rng, SeedableRng};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction::Transaction;
use crate::seal;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

#[derive(Clone, Debug)]
pub struct NetConfig {
    pub name: String,
    pub params: Params,
    pub seed: Vec<u8>,
    /// Background transfers per second between demo wallets.
    pub traffic: f64,
    pub observer_city: City,
}

pub struct Net {
    pub cfg: NetConfig,
    pub shared: Arc<Shared>,
    pub state: SharedState,
    pub exec: std::sync::mpsc::Sender<ExecCmd>,
    pub blockhashes: Arc<RwLock<Blockhashes>>,
    pub observer: NodeId,
    observer_inbox: UnboundedSender<Envelope>,
    pub faucet: Arc<Keypair>,
    pub genesis_hash: Hash,
    /// Validators' X25519 keys for sealing, in validator order, and how many shares open one.
    pub seal_pubs: Vec<[u8; 32]>,
    pub seal_t: u8,
    stop: tokio::sync::watch::Sender<bool>,
}

#[derive(Debug)]
pub enum SubmitError {
    Decode(String),
    Signature,
    Blockhash,
}

impl SubmitError {
    pub fn message(&self) -> String {
        match self {
            SubmitError::Decode(e) => format!("failed to deserialize transaction: {e}"),
            SubmitError::Signature => "Transaction signature verification failure".into(),
            SubmitError::Blockhash => "Transaction simulation failed: Blockhash not found".into(),
        }
    }
}

fn keypair_from_seed(seed: &[u8], label: &str) -> Keypair {
    let d: [u8; 32] = Sha256::digest([b"salvo/".as_slice(), label.as_bytes(), seed].concat()).into();
    Keypair::new_from_array(d)
}

impl Net {
    pub fn start(cfg: NetConfig) -> Arc<Net> {
        let p = cfg.params.clone();
        let n = p.n;
        let observer = n as NodeId;
        let keys: Vec<_> = (0..n as u16).map(|i| derive_key(&cfg.seed, i)).collect();
        let pubkeys: Vec<VerifyingKey> = keys.iter().map(|k| k.verifying_key()).collect();
        let mut cities: Vec<City> = (0..n).map(city_of).collect();
        cities.push(cfg.observer_city);

        let mut inboxes = Vec::new();
        let mut receivers = Vec::new();
        for _ in 0..=n {
            let (tx, rx) = unbounded_channel::<Envelope>();
            inboxes.push(tx);
            receivers.push(rx);
        }
        let observer_inbox = inboxes[n].clone();
        let seed64 = u64::from_le_bytes(Sha256::digest(&cfg.seed)[..8].try_into().unwrap());
        let bus = Arc::new(Bus::new(inboxes, cities.clone(), seed64));
        let genesis = Instant::now() + Duration::from_millis(800);
        let genesis_us = now_us() + 800_000;
        let shared = Arc::new(Shared { params: Params { seed: seed64, ..p.clone() }, genesis, genesis_us, pubkeys: pubkeys.clone(), bus: bus.clone() });

        let gh = genesis_hash(&cfg.seed);
        let validators = (0..n as u16)
            .map(|i| (i, cities[i as usize], bs58::encode(pubkeys[i as usize].as_bytes()).into_string()))
            .collect();
        let state: SharedState = Arc::new(RwLock::new(NetState::new(
            &cfg.name, p.k, n, p.delta_ms, p.timeout_ms, genesis_us, gh.to_string(), validators,
        )));

        // Genesis accounts: the faucet and the demo wallets of the background traffic.
        let faucet = Arc::new(keypair_from_seed(&cfg.seed, "faucet"));
        let demo: Vec<Keypair> = (0..16).map(|i| keypair_from_seed(&cfg.seed, &format!("demo-{i}"))).collect();
        let mut funded = vec![(faucet.pubkey(), 500_000_000 * LAMPORTS_PER_SOL)];
        for d in &demo {
            funded.push((d.pubkey(), 10_000 * LAMPORTS_PER_SOL));
        }
        let blockhashes = Arc::new(RwLock::new(Blockhashes::default()));
        let (exec_tx, exec_rx) = std::sync::mpsc::channel();
        {
            let state = state.clone();
            let bh = blockhashes.clone();
            let seed = cfg.seed.clone();
            let window = (90_000.0 / p.gap_ms()).max(1.0) as u64;
            std::thread::Builder::new()
                .name("salvo-exec".into())
                .spawn(move || Executor::new(state, bh, &seed, funded, window).run(exec_rx))
                .expect("spawn executor");
        }

        let seal_secrets: Vec<[u8; 32]> = (0..n as u16).map(|i| seal::validator_secret(&cfg.seed, i)).collect();
        let seal_pubs: Vec<[u8; 32]> = seal_secrets.iter().map(seal::public_of).collect();
        let seal_t = ((n - 1) / 3 + 1) as u8;
        let (stop, stop_rx) = tokio::sync::watch::channel(false);
        let (obs_tx, obs_rx) = unbounded_channel::<ObsEvent>();
        let mut receivers = receivers.into_iter();
        for (i, key) in keys.into_iter().enumerate() {
            let node = Node::new(i as NodeId, shared.clone(), Role::Validator(key), Some(seal_secrets[i]));
            let rx = receivers.next().unwrap();
            let mut s = stop_rx.clone();
            tokio::spawn(async move {
                tokio::select! { _ = node.run(rx) => {}, _ = s.changed() => {} }
            });
        }
        {
            let node = Node::new(observer, shared.clone(), Role::Observer(obs_tx), None);
            let rx = receivers.next().unwrap();
            let mut s = stop_rx.clone();
            tokio::spawn(async move {
                tokio::select! { _ = node.run(rx) => {}, _ = s.changed() => {} }
            });
        }

        let net = Arc::new(Net {
            cfg: cfg.clone(),
            shared: shared.clone(),
            state: state.clone(),
            exec: exec_tx.clone(),
            blockhashes,
            observer,
            observer_inbox,
            faucet,
            genesis_hash: gh,
            seal_pubs,
            seal_t,
            stop,
        });

        {
            let mut s = stop_rx.clone();
            let fut = chain_task(obs_rx, state.clone(), exec_tx, shared.clone());
            tokio::spawn(async move {
                tokio::select! { _ = fut => {}, _ = s.changed() => {} }
            });
        }
        {
            let mut s = stop_rx.clone();
            let fut = ticker(state.clone());
            tokio::spawn(async move {
                tokio::select! { _ = fut => {}, _ = s.changed() => {} }
            });
        }
        if cfg.traffic > 0.0 {
            let mut s = stop_rx.clone();
            let fut = traffic(net.clone(), demo, cfg.traffic);
            tokio::spawn(async move {
                tokio::select! { _ = fut => {}, _ = s.changed() => {} }
            });
        }
        net
    }

    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }

    pub fn latest_blockhash(&self) -> (Hash, u64) {
        self.blockhashes.read().latest().unwrap_or((self.genesis_hash, 0))
    }

    /// Blocks a blockhash stays valid for, given the target cadence.
    pub fn valid_blocks(&self) -> u64 {
        (crate::exec::BLOCKHASH_VALID_US as f64 / 1000.0 / self.shared.params.gap_ms()) as u64
    }

    pub fn submit(&self, raw: Vec<u8>, source: &'static str) -> Result<String, SubmitError> {
        let tx: VersionedTransaction = bincode::deserialize(&raw).map_err(|e| SubmitError::Decode(e.to_string()))?;
        if tx.signatures.is_empty() || !tx.verify_with_results().iter().all(|ok| *ok) {
            return Err(SubmitError::Signature);
        }
        if !self.blockhashes.read().contains(tx.message.recent_blockhash()) {
            return Err(SubmitError::Blockhash);
        }
        let sig = tx.signatures[0].to_string();
        let raw = Arc::new(raw);
        let id = tx_id(&raw);
        {
            let mut st = self.state.write();
            if st.txs.contains_key(&sig) {
                return Ok(sig);
            }
            let keys: Vec<String> = tx.message.static_account_keys().iter().map(|k| k.to_string()).collect();
            st.add_tx(
                TxRecord {
                    signature: sig.clone(),
                    received_at_us: now_us(),
                    status: "received",
                    included_at_us: None,
                    instance: None,
                    view: None,
                    slot: None,
                    finalized_at_us: None,
                    executed_at_us: None,
                    err: None,
                    logs: vec![],
                    fee: 0,
                    compute_units: 0,
                    copies: 0,
                    fee_payer: keys.first().cloned().unwrap_or_default(),
                    accounts: keys,
                    pre_balances: vec![],
                    post_balances: vec![],
                    source,
                    raw: Some(raw.clone()),
                    sealed_id: None,
                    revealed_at_us: None,
                    revealed_as: None,
                },
                id,
            );
            if source == "user" {
                st.push_event(json!({ "type": "tx", "signature": sig, "status": "received" }));
            }
        }
        let _ = self.observer_inbox.send(Envelope { from: self.observer, msg: Msg::Tx(TxIn { bytes: raw, id }) });
        Ok(sig)
    }

    /// Accept a sealed envelope. Nobody on the net can read it until the block that carries
    /// it is finalized; the returned id is the envelope's hash.
    pub fn submit_sealed(&self, raw: Vec<u8>, source: &'static str) -> Result<String, SubmitError> {
        let env = seal::Envelope::parse(&raw).ok_or_else(|| SubmitError::Decode("not a sealed envelope".into()))?;
        if env.n as usize != self.seal_pubs.len() || env.t != self.seal_t {
            return Err(SubmitError::Decode(format!("seal for {} validators with threshold {}", self.seal_pubs.len(), self.seal_t)));
        }
        let raw = Arc::new(raw);
        let id = tx_id(&raw);
        let key = hex(&id);
        {
            let mut st = self.state.write();
            if st.txs.contains_key(&key) {
                return Ok(key);
            }
            st.add_tx(
                TxRecord {
                    signature: key.clone(),
                    received_at_us: now_us(),
                    status: "received",
                    included_at_us: None,
                    instance: None,
                    view: None,
                    slot: None,
                    finalized_at_us: None,
                    executed_at_us: None,
                    err: None,
                    logs: vec![],
                    fee: 0,
                    compute_units: 0,
                    copies: 0,
                    fee_payer: String::new(),
                    accounts: vec![],
                    pre_balances: vec![],
                    post_balances: vec![],
                    source,
                    raw: None,
                    sealed_id: Some(key.clone()),
                    revealed_at_us: None,
                    revealed_as: None,
                },
                id,
            );
            st.stats.sealed_submitted += 1;
            if source == "user" {
                st.push_event(json!({ "type": "tx", "signature": key, "status": "received", "sealed": true }));
            }
        }
        let _ = self.observer_inbox.send(Envelope { from: self.observer, msg: Msg::Tx(TxIn { bytes: raw, id }) });
        Ok(key)
    }

    /// Send test SOL from the faucet. Each grant carries a unique compute-unit limit so two
    /// grants of the same amount to the same address never share a signature.
    pub fn airdrop(&self, to: &Address, lamports: u64) -> Result<String, SubmitError> {
        let (bh, _) = self.latest_blockhash();
        let nonce: u32 = rand::thread_rng().gen_range(0..100_000);
        let mut cu_data = vec![2u8];
        cu_data.extend_from_slice(&(200_000u32 + nonce).to_le_bytes());
        let cu_ix = solana_instruction::Instruction {
            program_id: compute_budget_id(),
            accounts: vec![],
            data: cu_data,
        };
        let ix = solana_system_interface::instruction::transfer(&self.faucet.pubkey(), to, lamports);
        let msg = Message::new(&[cu_ix, ix], Some(&self.faucet.pubkey()));
        let tx = Transaction::new(&[self.faucet.as_ref()], msg, bh);
        let raw = bincode::serialize(&VersionedTransaction::from(tx)).expect("serialize");
        let sig = self.submit(raw, "user")?;
        self.state.write().activity("faucet", json!({ "signature": sig, "to": to.to_string(), "lamports": lamports }));
        Ok(sig)
    }
}

pub fn compute_budget_id() -> Address {
    "ComputeBudget111111111111111111111111111111".parse().unwrap()
}

/// What the observer knows about one sealed envelope.
struct SealState {
    env: Option<seal::Envelope>,
    shares: Vec<(u8, [u8; 32])>,
    plain: Option<Arc<Vec<u8>>>,
    failed: bool,
    seen: Instant,
    /// Sent to the executor already; later copies from other leaders run as duplicates.
    forwarded: bool,
}

impl SealState {
    fn new() -> SealState {
        SealState { env: None, shares: Vec::new(), plain: None, failed: false, seen: Instant::now(), forwarded: false }
    }

    /// Open the envelope once enough checked shares are in.
    fn try_open(&mut self) -> Option<Arc<Vec<u8>>> {
        if self.plain.is_some() || self.failed {
            return None;
        }
        let env = self.env.as_ref()?;
        if self.shares.len() < env.t as usize {
            return None;
        }
        match seal::open(env, &self.shares) {
            Some(p) => {
                let p = Arc::new(p);
                self.plain = Some(p.clone());
                Some(p)
            }
            None => {
                self.failed = true;
                None
            }
        }
    }
}

fn note_envelopes(seals: &mut HashMap<Digest, SealState>, state: &SharedState, block: &Block) {
    for tx in &block.txs {
        if !seal::is_sealed(tx) {
            continue;
        }
        let id = tx_id(tx);
        let e = seals.entry(id).or_insert_with(SealState::new);
        if e.env.is_some() || e.failed {
            continue;
        }
        e.env = seal::Envelope::parse(tx);
        match &e.env {
            None => e.failed = true,
            Some(env) => {
                // Shares that arrived before the envelope are checked now.
                let hashes = env.hashes.clone();
                e.shares.retain(|(i, sh)| hashes.get(*i as usize) == Some(&seal::share_hash(sh)));
            }
        }
        if let Some(p) = e.try_open() {
            on_revealed(state, &id, &p, now_us());
        }
    }
}

/// Record that an envelope opened: the envelope's record points at the transaction inside,
/// and the transaction gets a record that remembers it arrived sealed.
fn on_revealed(state: &SharedState, id: &Digest, plain: &[u8], at_us: u64) {
    let key = hex(id);
    let tx = bincode::deserialize::<VersionedTransaction>(plain).ok();
    let sig = tx.as_ref().and_then(|t| t.signatures.first().map(|s| s.to_string()));
    let lamports = tx.as_ref().and_then(crate::exec::transfer_lamports);
    let mut st = state.write();
    st.stats.sealed_revealed += 1;
    let Some(sig) = sig else { return };
    let source = st.txs.get(&key).map(|r| r.source).unwrap_or("traffic");
    st.activity("sealed", json!({ "signature": sig, "sealedId": key, "lamports": lamports, "source": source, "atUs": at_us }));
    let mut base = None;
    if let Some(rec) = st.txs.get_mut(&key) {
        rec.status = "revealed";
        rec.revealed_at_us = Some(at_us);
        rec.revealed_as = Some(sig.clone());
        base = Some(rec.clone());
    }
    if let Some(b) = base {
        if !st.txs.contains_key(&sig) {
            let mut r = b.clone();
            r.signature = sig.clone();
            r.raw = Some(Arc::new(plain.to_vec()));
            r.revealed_as = None;
            st.add_tx(r, tx_id(plain));
        }
        if b.source == "user" {
            st.push_event(json!({ "type": "tx", "signature": key, "status": "revealed", "revealedAs": sig, "atUs": at_us }));
        }
    }
}

async fn chain_task(mut rx: UnboundedReceiver<ObsEvent>, state: SharedState, exec: std::sync::mpsc::Sender<ExecCmd>, shared: Arc<Shared>) {
    let mut merger = Merger::new(shared.params.k);
    let mut notarized_at: HashMap<Digest, u64> = HashMap::new();
    let mut seals: HashMap<Digest, SealState> = HashMap::new();
    // Merged blocks wait here, in order, until every sealed transaction in them is opened.
    let mut held: VecDeque<Merged> = VecDeque::new();
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    let mut last_gc = Instant::now();
    loop {
        let ev = tokio::select! {
            ev = rx.recv() => match ev { Some(e) => Some(e), None => return },
            _ = tick.tick() => None,
        };
        if let Some(ev) = ev {
            handle_obs(ev, &state, &mut merger, &mut notarized_at, &mut seals, &mut held, &shared);
        }
        flush(&mut held, &mut seals, &exec, &state);
        if last_gc.elapsed() > Duration::from_secs(5) {
            last_gc = Instant::now();
            seals.retain(|_, s| s.seen.elapsed() < Duration::from_secs(60));
        }
    }
}

/// Send every merged block whose sealed transactions are all opened (or given up on) to the
/// executor, in order. Opened transactions replace their envelopes; an envelope that cannot
/// be opened within 2 seconds of merging is dropped.
fn flush(held: &mut VecDeque<Merged>, seals: &mut HashMap<Digest, SealState>, exec: &std::sync::mpsc::Sender<ExecCmd>, state: &SharedState) {
    let mut ready = Vec::new();
    let now = now_us();
    while let Some(m) = held.front() {
        let waited = now.saturating_sub(m.merged_at_us);
        let pending = waited < 2_000_000
            && m.block.txs.iter().any(|tx| {
                seal::is_sealed(tx) && !seals.get(&tx_id(tx)).map(|s| s.plain.is_some() || s.failed).unwrap_or(false)
            });
        if pending {
            break;
        }
        let mut m = held.pop_front().unwrap();
        let mut sealed = 0;
        let mut txs = Vec::with_capacity(m.block.txs.len());
        let mut any_sealed = false;
        for tx in &m.block.txs {
            if !seal::is_sealed(tx) {
                txs.push(tx.clone());
                continue;
            }
            any_sealed = true;
            let id = tx_id(tx);
            let plain = seals.get(&id).and_then(|s| s.plain.clone());
            match plain {
                Some(p) => {
                    if let Some(s) = seals.get_mut(&id) {
                        if !s.forwarded {
                            s.forwarded = true;
                            sealed += 1;
                        }
                    }
                    txs.push(p)
                }
                None => {
                    if let Some(s) = seals.get_mut(&id) {
                        s.failed = true;
                    }
                    let mut st = state.write();
                    if let Some(rec) = st.txs.get_mut(&hex(&id)) {
                        if rec.status != "failed" {
                            rec.status = "failed";
                            rec.err = Some("The envelope could not be opened".into());
                        }
                    }
                }
            }
        }
        if any_sealed {
            if sealed > 0 {
                state.write().stats.reveal_ms.push(now.saturating_sub(m.merged_at_us) as f64 / 1000.0);
            }
            let mut b = (*m.block).clone();
            b.txs = txs;
            m.block = Arc::new(b);
            m.sealed = sealed;
        }
        ready.push(m);
    }
    if !ready.is_empty() {
        let _ = exec.send(ExecCmd::Apply(ready));
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_obs(
    ev: ObsEvent,
    state: &SharedState,
    merger: &mut Merger,
    notarized_at: &mut HashMap<Digest, u64>,
    seals: &mut HashMap<Digest, SealState>,
    held: &mut VecDeque<Merged>,
    shared: &Arc<Shared>,
) {
    match ev {
        ObsEvent::Proposed { block, seen_us } => {
            note_envelopes(seals, state, &block);
            let mut st = state.write();
            st.stats.last_proposed_us = seen_us;
            if let Some(v) = st.validators.get_mut(block.leader as usize) {
                v.proposed += 1;
                v.last_proposed_at_us = block.proposed_at_us;
            }
            for raw in &block.txs {
                let id = tx_id(raw);
                if let Some(sig) = st.tx_ids.get(&id).cloned() {
                    let mut ev = None;
                    if let Some(rec) = st.txs.get_mut(&sig) {
                        rec.copies += 1;
                        if rec.status == "received" {
                            rec.status = "included";
                            rec.included_at_us = Some(block.proposed_at_us);
                            rec.instance = Some(block.instance);
                            rec.view = Some(block.view);
                            if rec.source == "user" {
                                ev = Some(json!({ "type": "tx", "signature": sig, "status": "included", "instance": block.instance, "view": block.view, "atUs": block.proposed_at_us }));
                            }
                        }
                    }
                    if let Some(e) = ev {
                        st.push_event(e);
                    }
                }
            }
            st.push_event(json!({ "type": "cell", "s": "p", "i": block.instance, "v": block.view, "l": block.leader, "n": block.txs.len(), "t": block.proposed_at_us }));
        }
        ObsEvent::Notarized { instance, view, digest, at_us } => {
            notarized_at.insert(digest, at_us);
            if notarized_at.len() > 50_000 {
                notarized_at.clear();
            }
            state.write().push_event(json!({ "type": "cell", "s": "n", "i": instance, "v": view, "t": at_us }));
        }
        ObsEvent::Nullified { instance, view, at_us } => {
            let mut st = state.write();
            st.stats.skipped_views += 1;
            if let Some(s) = st.instances.get_mut(instance as usize) {
                s.skipped += 1;
            }
            st.push_event(json!({ "type": "cell", "s": "x", "i": instance, "v": view, "t": at_us }));
        }
        ObsEvent::Finalized { blocks, at_us, fast } => {
            {
                let mut st = state.write();
                st.stats.fast_finals.push_back(fast);
                if st.stats.fast_finals.len() > 2000 {
                    st.stats.fast_finals.pop_front();
                }
                for b in &blocks {
                    if let Some(s) = st.instances.get_mut(b.instance as usize) {
                        s.finalized_view = s.finalized_view.max(b.view);
                        s.finalized_height = s.finalized_height.max(b.height);
                        s.blocks += 1;
                    }
                    st.push_event(json!({ "type": "cell", "s": "f", "i": b.instance, "v": b.view, "t": at_us }));
                }
            }
            for b in blocks {
                note_envelopes(seals, state, &b);
                for m in merger.push(b) {
                    held.push_back(Merged {
                        notarized_at_us: notarized_at.remove(&m.digest),
                        finalized_at_us: at_us,
                        merged_at_us: now_us(),
                        leader_city: shared.bus.city(m.leader).code(),
                        sealed: 0,
                        block: m,
                    });
                }
            }
            state.write().push_event(json!({ "type": "cursor", "v": merger.cursor_view, "i": merger.cursor_instance }));
        }
        ObsEvent::Views { views } => {
            let mut st = state.write();
            for (k, v) in views.into_iter().enumerate() {
                let leader = shared.leader(k as u16, v);
                let next = shared.proposal_time_us(k as u16, v);
                if let Some(s) = st.instances.get_mut(k) {
                    s.view = v;
                    s.leader = leader;
                    s.next_proposal_us = next;
                }
            }
        }
        ObsEvent::Reveal { id, index, share, at_us } => {
            let e = seals.entry(id).or_insert_with(SealState::new);
            if e.plain.is_some() || e.failed || e.shares.iter().any(|(i, _)| *i as u16 == index) {
                return;
            }
            if let Some(env) = &e.env {
                if env.hashes.get(index as usize) != Some(&seal::share_hash(&share)) {
                    return;
                }
            }
            e.shares.push((index as u8, share));
            if let Some(p) = e.try_open() {
                on_revealed(state, &id, &p, at_us);
            }
        }
    }
}

/// Every 100 ms, send the events gathered since the last batch to everyone listening.
async fn ticker(state: SharedState) {
    let mut iv = tokio::time::interval(Duration::from_millis(100));
    let mut n = 0u64;
    loop {
        iv.tick().await;
        n += 1;
        let mut st = state.write();
        let events = st.take_events();
        if !events.is_empty() {
            let msg = json!({ "type": "batch", "events": events }).to_string();
            let _ = st.events.send(Arc::new(msg));
        }
        if n % 5 == 0 {
            let msg = json!({ "type": "stats", "stats": st.stats_json(), "instances": st.instances, "validators": st.validators }).to_string();
            let _ = st.events.send(Arc::new(msg));
        }
    }
}

/// Demo load: small transfers between the demo wallets, like the reference prototype's
/// submit-tx task. It keeps the net busy so the numbers are measured under load.
async fn traffic(net: Arc<Net>, demo: Vec<Keypair>, per_second: f64) {
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mut rng = rand::rngs::StdRng::from_entropy();
    let base = 1.0 / per_second;
    loop {
        let wait = base * rng.gen_range(0.5..1.5);
        tokio::time::sleep(Duration::from_secs_f64(wait)).await;
        let a = rng.gen_range(0..demo.len());
        let mut b = rng.gen_range(0..demo.len());
        if b == a {
            b = (b + 1) % demo.len();
        }
        let lamports = rng.gen_range(1_000..5_000_000u64);
        let (bh, _) = net.latest_blockhash();
        let ix = solana_system_interface::instruction::transfer(&demo[a].pubkey(), &demo[b].pubkey(), lamports);
        let msg = Message::new(&[ix], Some(&demo[a].pubkey()));
        let tx = Transaction::new(&[&demo[a]], msg, bh);
        if let Ok(raw) = bincode::serialize(&VersionedTransaction::from(tx)) {
            // About a third of the demo load is sealed, so reveals run all the time.
            if rng.gen_bool(0.3) {
                let env = seal::seal(&raw, &net.seal_pubs, net.seal_t, &mut rng);
                let _ = net.submit_sealed(env, "traffic");
            } else {
                let _ = net.submit(raw, "traffic");
            }
        }
    }
}

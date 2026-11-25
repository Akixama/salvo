//! One node of the net: a validator, or the observer that the gateway reads from.
//!
//! Each node runs K consensus instances side by side. In instance k, the leader of view v
//! proposes at `genesis + v·Δ + k·Δ/K`, so across instances a proposal goes out every Δ/K.
//!
//! Voting follows Alpenglow's Votor (Solana's next consensus), per instance:
//! - Each validator casts one initial vote per view: notarize a valid proposal, or nullify
//!   (skip) if its timer runs out first. A validator that voted notarize does not skip on
//!   timeout; that is what makes the fast lane safe.
//! - 80% notarize votes for a block finalize it at once (fast lane, one round).
//! - 60% notarize votes notarize it; validators that voted for it then vote finalize, unless
//!   they cast a skip or fallback vote in that view; 60% finalize votes finalize it (slow lane).
//! - 60% nullify (+ nullify-fallback) votes skip the view.
//! - Fallbacks keep the net live when a view splits: SafeToNotar lets a validator back a block
//!   that already has 40% (or 20% with 60% notarize+skip); SafeToSkip lets a notarize voter skip
//!   once skip votes plus votes for other blocks reach 40%. Notarize + notarize-fallback votes at
//!   60% make a fallback notarization, which later blocks can build on.
//! Safe while fewer than 20% of validators are faulty; live with up to 40% offline.

use crate::bus::Bus;
use crate::types::*;
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

#[derive(Clone, Debug)]
pub struct Params {
    /// Number of validators.
    pub n: usize,
    /// Number of parallel consensus instances.
    pub k: usize,
    /// Time between two views of one instance, in ms.
    pub delta_ms: u64,
    /// How long after a view's proposal time a validator waits before voting nullify, in ms.
    pub timeout_ms: u64,
    pub max_block_txs: usize,
    pub seed: u64,
}

impl Params {
    /// At least `p` percent of the validators, rounded up.
    fn pct(&self, p: usize) -> u32 {
        ((self.n * p).div_ceil(100)) as u32
    }
    /// 60%: notarize, skip and (slow) finalize certificates.
    pub fn quorum(&self) -> u32 {
        self.pct(60)
    }
    /// 80% notarize votes in the first round finalize a block at once (the fast lane).
    pub fn fast_quorum(&self) -> u32 {
        self.pct(80)
    }
    /// The 40% and 20% marks of Alpenglow's SafeToNotar and SafeToSkip rules.
    fn pct40(&self) -> u32 {
        self.pct(40)
    }
    fn pct20(&self) -> u32 {
        self.pct(20)
    }
    pub fn gap_ms(&self) -> f64 {
        self.delta_ms as f64 / self.k as f64
    }
}

pub struct Shared {
    pub params: Params,
    pub genesis: Instant,
    pub genesis_us: u64,
    pub pubkeys: Vec<VerifyingKey>,
    pub bus: Arc<Bus>,
}

impl Shared {
    pub fn leader(&self, instance: u16, view: u64) -> NodeId {
        let mut x = self.params.seed ^ ((instance as u64) << 48) ^ view.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        x ^= x >> 30;
        x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x ^= x >> 27;
        x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^= x >> 31;
        (x % self.params.n as u64) as NodeId
    }

    /// When the leader of (instance, view) may propose.
    pub fn proposal_time(&self, instance: u16, view: u64) -> Instant {
        let p = &self.params;
        let offset_us = view * p.delta_ms * 1000 + instance as u64 * p.delta_ms * 1000 / p.k as u64;
        self.genesis + Duration::from_micros(offset_us)
    }

    pub fn proposal_time_us(&self, instance: u16, view: u64) -> u64 {
        let p = &self.params;
        self.genesis_us + view * p.delta_ms * 1000 + instance as u64 * p.delta_ms * 1000 / p.k as u64
    }
}

/// What the observer reports to the chain task.
#[derive(Debug)]
pub enum ObsEvent {
    Proposed { block: Arc<Block>, seen_us: u64 },
    Notarized { instance: u16, view: u64, digest: Digest, at_us: u64 },
    Nullified { instance: u16, view: u64, at_us: u64 },
    /// Finalized blocks of one instance, oldest first. `fast`: the tip was finalized by the
    /// fast lane (80% notarize votes) rather than by finalize votes.
    Finalized { blocks: Vec<Arc<Block>>, at_us: u64, fast: bool },
    Views { views: Vec<u64> },
    Reveal { id: Digest, index: u16, share: [u8; 32], at_us: u64 },
}

pub enum Role {
    Validator(SigningKey),
    Observer(UnboundedSender<ObsEvent>),
}

/// Safety checks. Every node counts a violation if a block it finalizes does not extend its own
/// finalized chain. With SALVO_CHECK_SAFETY=1 (for tests: it keeps every finalized block in
/// memory) all nodes also record what they finalized, and two nodes finalizing different blocks
/// at the same height of the same instance counts too. Both must stay at zero.
pub static SAFETY_VIOLATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static AGREEMENT: std::sync::OnceLock<Option<parking_lot::Mutex<HashMap<(u64, u16, u64), Digest>>>> = std::sync::OnceLock::new();

fn violation(what: String) {
    SAFETY_VIOLATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    tracing::error!("SAFETY VIOLATION: {what}");
}

fn check_agreement(net: u64, b: &Block) {
    let map = AGREEMENT.get_or_init(|| std::env::var("SALVO_CHECK_SAFETY").ok().filter(|v| v == "1").map(|_| parking_lot::Mutex::new(HashMap::new())));
    let Some(map) = map else { return };
    let mut m = map.lock();
    match m.get(&(net, b.instance, b.height)) {
        Some(d) if *d != b.digest => violation(format!("instance {} height {}: two different blocks finalized", b.instance, b.height)),
        Some(_) => {}
        None => {
            m.insert((net, b.instance, b.height), b.digest);
        }
    }
}

pub fn tx_id(bytes: &[u8]) -> Digest {
    Sha256::digest(bytes).into()
}

struct Inst {
    k: u16,
    view: u64,
    propose_at: Option<Instant>,
    timeout_at: Instant,
    rebroadcast_at: Option<Instant>,
    blocks: HashMap<Digest, Arc<Block>>,
    proposals: HashMap<u64, Arc<Block>>,
    /// Voter bitsets. Ordered so one view's blocks can be read together.
    notar_votes: BTreeMap<(u64, Digest), u64>,
    notar_fb_votes: HashMap<(u64, Digest), u64>,
    final_votes: HashMap<(u64, Digest), u64>,
    null_votes: HashMap<u64, u64>,
    null_fb_votes: HashMap<u64, u64>,
    /// Views with a notarization of either kind (60% notarize, or 60% notarize + fallback):
    /// what later blocks may build on.
    notarized: BTreeMap<u64, Digest>,
    /// Views with a plain 60% notarize certificate, which is what finalize votes need.
    notarized_plain: BTreeSet<u64>,
    nullified: BTreeSet<u64>,
    /// Views where this validator skipped or cast a fallback vote. It does not vote finalize
    /// in those (Alpenglow's BadWindow).
    bad_window: BTreeSet<u64>,
    my_votes: BTreeMap<(u64, u8), Arc<Vote>>,
    finalized_view: u64,
    finalized_tip: Digest,
    finalized_height: u64,
    pending_final: Option<(u64, Digest, bool)>,
    requested: HashMap<Digest, Instant>,
}

impl Inst {
    fn new(k: u16, now: Instant) -> Inst {
        Inst {
            k,
            view: 0,
            propose_at: None,
            timeout_at: now + Duration::from_secs(3600),
            rebroadcast_at: None,
            blocks: HashMap::new(),
            proposals: HashMap::new(),
            notar_votes: BTreeMap::new(),
            notar_fb_votes: HashMap::new(),
            final_votes: HashMap::new(),
            null_votes: HashMap::new(),
            null_fb_votes: HashMap::new(),
            notarized: BTreeMap::new(),
            notarized_plain: BTreeSet::new(),
            nullified: BTreeSet::new(),
            bad_window: BTreeSet::new(),
            my_votes: BTreeMap::new(),
            finalized_view: 0,
            finalized_tip: GENESIS,
            finalized_height: 0,
            pending_final: None,
            requested: HashMap::new(),
        }
    }

    fn voted(&self, view: u64, kind: VoteKind) -> bool {
        self.my_votes.contains_key(&(view, kind as u8))
    }

    /// This validator's initial vote in `view` is in (notarize or skip).
    fn voted_initial(&self, view: u64) -> bool {
        self.voted(view, VoteKind::Notarize) || self.voted(view, VoteKind::Nullify)
    }

    /// Whether `view` has a certificate that lets the instance move past it.
    fn view_done(&self, view: u64) -> bool {
        self.notarized.contains_key(&view) || self.nullified.contains(&view)
    }

    /// Notarize votes in `view`, one entry per block: (digest, voters).
    fn notar_in(&self, view: u64) -> impl Iterator<Item = (Digest, u64)> + '_ {
        self.notar_votes.range((view, [0u8; 32])..=(view, [0xffu8; 32])).map(|((_, d), b)| (*d, *b))
    }

    /// The block a leader of `view` should extend: the notarized block of the highest view below
    /// `view` such that every view in between is nullified.
    fn parent_for(&self, view: u64) -> Option<(Digest, u64)> {
        let mut v = view - 1;
        loop {
            if v == 0 {
                return Some((GENESIS, 0));
            }
            if let Some(d) = self.notarized.get(&v) {
                return self.blocks.get(d).map(|b| (*d, b.height));
            }
            if !self.nullified.contains(&v) {
                return None;
            }
            v -= 1;
        }
    }

    fn parent_ok(&self, b: &Block) -> bool {
        let (pv, ph) = if b.parent == GENESIS {
            (0, 0)
        } else {
            match self.blocks.get(&b.parent) {
                Some(p) if self.notarized.get(&p.view) == Some(&b.parent) => (p.view, p.height),
                _ => return false,
            }
        };
        b.height == ph + 1 && pv < b.view && (pv + 1..b.view).all(|x| self.nullified.contains(&x))
    }
}

pub struct Node {
    id: NodeId,
    shared: Arc<Shared>,
    role: Role,
    insts: Vec<Inst>,
    mempool: VecDeque<TxIn>,
    in_pool: HashSet<Digest>,
    included: HashSet<Digest>,
    included_order: VecDeque<Digest>,
    next_prune: Instant,
    next_views_report: Instant,
    /// This validator's X25519 secret for opening its shares of sealed transactions.
    seal_sk: Option<[u8; 32]>,
    revealed: HashSet<Digest>,
    revealed_order: VecDeque<Digest>,
}

impl Node {
    pub fn new(id: NodeId, shared: Arc<Shared>, role: Role, seal_sk: Option<[u8; 32]>) -> Node {
        let now = Instant::now();
        let insts = (0..shared.params.k as u16).map(|k| Inst::new(k, now)).collect();
        Node {
            id,
            shared,
            role,
            insts,
            mempool: VecDeque::new(),
            in_pool: HashSet::new(),
            included: HashSet::new(),
            included_order: VecDeque::new(),
            next_prune: now + Duration::from_secs(1),
            next_views_report: now,
            seal_sk,
            revealed: HashSet::new(),
            revealed_order: VecDeque::new(),
        }
    }

    /// Publish my share of every sealed transaction in blocks that just became final. Their
    /// place in the log is fixed now, so seeing their contents gives no one a head start.
    fn reveal(&mut self, blocks: &[Arc<Block>]) {
        let Some(sk) = self.seal_sk else { return };
        for b in blocks {
            for tx in &b.txs {
                if !crate::seal::is_sealed(tx) {
                    continue;
                }
                let id = tx_id(tx);
                if !self.revealed.insert(id) {
                    continue;
                }
                self.revealed_order.push_back(id);
                if self.revealed_order.len() > 100_000 {
                    if let Some(old) = self.revealed_order.pop_front() {
                        self.revealed.remove(&old);
                    }
                }
                let Some(env) = crate::seal::Envelope::parse(tx) else { continue };
                if let Some(share) = crate::seal::open_share(&env, self.id as usize, &sk) {
                    self.shared.bus.broadcast(self.id, Msg::Reveal { id, index: self.id, share });
                }
            }
        }
    }

    fn is_validator(&self) -> bool {
        matches!(self.role, Role::Validator(_))
    }

    fn report(&self, ev: ObsEvent) {
        if let Role::Observer(tx) = &self.role {
            let _ = tx.send(ev);
        }
    }

    pub async fn run(mut self, mut inbox: UnboundedReceiver<Envelope>) {
        let start = self.shared.genesis.max(Instant::now());
        tokio::time::sleep_until(start.into()).await;
        for k in 0..self.insts.len() {
            self.enter(k, 1);
        }
        loop {
            let deadline = self.next_deadline();
            tokio::select! {
                env = inbox.recv() => {
                    match env {
                        Some(env) => self.handle(env),
                        None => return,
                    }
                    while let Ok(env) = inbox.try_recv() {
                        self.handle(env);
                    }
                }
                _ = tokio::time::sleep_until(deadline.into()) => {}
            }
            self.tick();
        }
    }

    fn next_deadline(&self) -> Instant {
        let mut d = self.next_prune.min(self.next_views_report);
        if !self.is_validator() {
            return d;
        }
        for inst in &self.insts {
            if let Some(p) = inst.propose_at {
                d = d.min(p);
            }
            if inst.rebroadcast_at.is_none() && !inst.view_done(inst.view) {
                d = d.min(inst.timeout_at);
            }
            if let Some(r) = inst.rebroadcast_at {
                d = d.min(r);
            }
        }
        d
    }

    fn tick(&mut self) {
        let now = Instant::now();
        for k in 0..self.insts.len() {
            if !self.is_validator() {
                break;
            }
            if let Some(p) = self.insts[k].propose_at {
                if now >= p {
                    self.insts[k].propose_at = None;
                    self.propose(k);
                }
            }
            let inst = &self.insts[k];
            let view = inst.view;
            if now >= inst.timeout_at && inst.rebroadcast_at.is_none() && !inst.view_done(view) {
                // Out of time. Skip only if I have not voted yet: a validator that voted for a
                // block never skips on a timer (the fallback rules decide that). Either way,
                // start sending my votes again while the view is stuck.
                let t = self.shared.params.timeout_ms;
                self.insts[k].rebroadcast_at = Some(now + Duration::from_millis(t));
                if !self.insts[k].voted_initial(view) {
                    self.cast(k, view, VoteKind::Nullify, GENESIS);
                }
            }
            if let Some(r) = self.insts[k].rebroadcast_at {
                if now >= r {
                    self.rebroadcast(k);
                }
            }
        }
        if now >= self.next_views_report {
            self.next_views_report = now + Duration::from_millis(50);
            if let Role::Observer(_) = self.role {
                self.report(ObsEvent::Views { views: self.insts.iter().map(|i| i.view).collect() });
            }
        }
        if now >= self.next_prune {
            self.next_prune = now + Duration::from_secs(1);
            self.prune();
        }
    }

    /// While stuck in a view, send my votes again and ask for any block a certificate names
    /// that I do not have. This is what keeps the net live under packet loss.
    fn rebroadcast(&mut self, k: usize) {
        let now = Instant::now();
        let t = self.shared.params.timeout_ms;
        let inst = &mut self.insts[k];
        let from_view = inst.finalized_view;
        let votes: Vec<Arc<Vote>> = inst.my_votes.range((from_view, 0)..).map(|(_, v)| v.clone()).collect();
        inst.rebroadcast_at = Some(now + Duration::from_millis(t));
        for v in votes {
            self.shared.bus.broadcast(self.id, Msg::Vote(v));
        }
        if let Some((_, d, _)) = self.insts[k].pending_final {
            self.request_missing(k, d);
        }
    }

    fn enter(&mut self, k: usize, view: u64) {
        let now = Instant::now();
        let (id, shared) = (self.id, self.shared.clone());
        let is_validator = self.is_validator();
        let inst = &mut self.insts[k];
        if view <= inst.view {
            return;
        }
        inst.view = view;
        inst.rebroadcast_at = None;
        let pt = shared.proposal_time(inst.k, view);
        let start = pt.max(now);
        inst.timeout_at = start + Duration::from_millis(shared.params.timeout_ms);
        inst.propose_at = if is_validator && shared.leader(inst.k, view) == id { Some(start) } else { None };
        self.try_vote(k);
    }

    fn propose(&mut self, k: usize) {
        let view = self.insts[k].view;
        let Some((parent, parent_height)) = self.insts[k].parent_for(view) else {
            // Not ready to build yet; try again shortly.
            self.insts[k].propose_at = Some(Instant::now() + Duration::from_millis(2));
            return;
        };
        let max = self.shared.params.max_block_txs;
        let mut txs = Vec::new();
        while txs.len() < max {
            let Some(tx) = self.mempool.pop_front() else { break };
            self.in_pool.remove(&tx.id);
            if !self.included.contains(&tx.id) {
                txs.push(tx.bytes);
            }
        }
        let proposed_at_us = now_us();
        let instance = k as u16;
        let height = parent_height + 1;
        let digest = Block::compute_digest(instance, view, height, &parent, self.id, proposed_at_us, &txs);
        let block = Arc::new(Block { instance, view, height, parent, leader: self.id, proposed_at_us, txs, digest });
        self.shared.bus.broadcast(self.id, Msg::Proposal(block.clone()));
        self.on_block(block, true);
    }

    fn cast(&mut self, k: usize, view: u64, kind: VoteKind, digest: Digest) {
        let Role::Validator(key) = &self.role else { return };
        if self.insts[k].voted(view, kind) {
            return;
        }
        let vote = Arc::new(Vote::sign(key, self.id, k as u16, view, kind, digest));
        self.insts[k].my_votes.insert((view, kind as u8), vote.clone());
        if matches!(kind, VoteKind::Nullify | VoteKind::NotarizeFallback | VoteKind::NullifyFallback) {
            self.insts[k].bad_window.insert(view);
        }
        self.shared.bus.broadcast(self.id, Msg::Vote(vote.clone()));
        self.on_vote(&vote);
    }

    fn try_vote(&mut self, k: usize) {
        if !self.is_validator() {
            return;
        }
        let inst = &self.insts[k];
        let view = inst.view;
        if inst.voted_initial(view) {
            return;
        }
        let Some(b) = inst.proposals.get(&view) else { return };
        if !inst.parent_ok(b) {
            return;
        }
        let d = b.digest;
        self.cast(k, view, VoteKind::Notarize, d);
    }

    fn handle(&mut self, env: Envelope) {
        match env.msg {
            Msg::Proposal(b) | Msg::BlockResponse(b) => {
                if (b.instance as usize) < self.insts.len() && b.is_valid_digest() {
                    self.on_block(b, false);
                }
            }
            Msg::Vote(v) => {
                let ok = (v.voter as usize) < self.shared.pubkeys.len()
                    && (v.instance as usize) < self.insts.len()
                    && v.verify(&self.shared.pubkeys[v.voter as usize]);
                if ok {
                    self.on_vote(&v);
                }
            }
            Msg::Tx(tx) => self.add_tx(tx),
            Msg::Reveal { id, index, share } => {
                if index == env.from {
                    self.report(ObsEvent::Reveal { id, index, share, at_us: now_us() });
                }
            }
            Msg::BlockRequest { instance, digest } => {
                if let Some(b) = self.insts.get(instance as usize).and_then(|i| i.blocks.get(&digest)) {
                    self.shared.bus.send(self.id, env.from, Msg::BlockResponse(b.clone()));
                }
            }
        }
    }

    pub fn add_tx(&mut self, tx: TxIn) {
        if self.in_pool.contains(&tx.id) || self.included.contains(&tx.id) {
            return;
        }
        if self.is_validator() {
            self.in_pool.insert(tx.id);
            self.mempool.push_back(tx);
        } else {
            // The observer is where transactions enter: pass them to every validator.
            self.shared.bus.broadcast(self.id, Msg::Tx(tx));
        }
    }

    fn on_block(&mut self, b: Arc<Block>, mine: bool) {
        let k = b.instance as usize;
        if self.shared.leader(b.instance, b.view) != b.leader {
            return;
        }
        let inst = &mut self.insts[k];
        if inst.blocks.contains_key(&b.digest) {
            return;
        }
        inst.requested.remove(&b.digest);
        inst.blocks.insert(b.digest, b.clone());
        let first_for_view = !inst.proposals.contains_key(&b.view);
        if first_for_view {
            inst.proposals.insert(b.view, b.clone());
            if !mine {
                self.report(ObsEvent::Proposed { block: b.clone(), seen_us: now_us() });
            }
        }
        if self.insts[k].notarized.get(&b.view) == Some(&b.digest) {
            self.mark_included(&b);
        }
        self.try_vote(k);
        if let Some((v, d, fast)) = self.insts[k].pending_final {
            self.try_finalize(k, v, d, fast);
        }
        // A newly known block can be the parent a later proposal was waiting for.
        self.try_vote(k);
    }

    fn mark_included(&mut self, b: &Block) {
        if !self.is_validator() {
            return;
        }
        for tx in &b.txs {
            let id = tx_id(tx);
            if self.included.insert(id) {
                self.included_order.push_back(id);
            }
        }
        while self.included_order.len() > 200_000 {
            if let Some(old) = self.included_order.pop_front() {
                self.included.remove(&old);
            }
        }
    }

    fn on_vote(&mut self, v: &Vote) {
        let k = v.instance as usize;
        let bit = 1u64 << v.voter;
        let inst = &mut self.insts[k];
        if v.view <= inst.finalized_view && v.kind != VoteKind::Finalize {
            return;
        }
        let e = match v.kind {
            VoteKind::Notarize => inst.notar_votes.entry((v.view, v.digest)).or_insert(0),
            VoteKind::NotarizeFallback => inst.notar_fb_votes.entry((v.view, v.digest)).or_insert(0),
            VoteKind::Nullify => inst.null_votes.entry(v.view).or_insert(0),
            VoteKind::NullifyFallback => inst.null_fb_votes.entry(v.view).or_insert(0),
            VoteKind::Finalize => inst.final_votes.entry((v.view, v.digest)).or_insert(0),
        };
        if *e & bit != 0 {
            return;
        }
        *e |= bit;
        match v.kind {
            VoteKind::Finalize => {
                let n = self.insts[k].final_votes[&(v.view, v.digest)].count_ones();
                if n >= self.shared.params.quorum() {
                    self.on_finalize_cert(k, v.view, v.digest, false);
                }
            }
            VoteKind::Notarize | VoteKind::NotarizeFallback => {
                self.check_notar(k, v.view, v.digest);
                self.check_fallbacks(k, v.view);
            }
            VoteKind::Nullify | VoteKind::NullifyFallback => {
                self.check_skip(k, v.view);
                self.check_fallbacks(k, v.view);
            }
        }
    }

    /// Certificates for one block: plain notarization (60% notarize), fallback notarization
    /// (60% notarize + notarize-fallback), and fast finalization (80% notarize).
    fn check_notar(&mut self, k: usize, view: u64, digest: Digest) {
        let p = &self.shared.params;
        let (q, fast) = (p.quorum(), p.fast_quorum());
        let inst = &self.insts[k];
        let plain = inst.notar_votes.get(&(view, digest)).copied().unwrap_or(0);
        let fb = inst.notar_fb_votes.get(&(view, digest)).copied().unwrap_or(0);
        if plain.count_ones() >= q && !inst.notarized_plain.contains(&view) {
            self.insts[k].notarized_plain.insert(view);
            self.on_notarized(k, view, digest, true);
        } else if (plain | fb).count_ones() >= q && !inst.notarized.contains_key(&view) {
            self.on_notarized(k, view, digest, false);
        }
        if plain.count_ones() >= fast {
            self.on_finalize_cert(k, view, digest, true);
        }
    }

    fn check_skip(&mut self, k: usize, view: u64) {
        let inst = &self.insts[k];
        let skips = inst.null_votes.get(&view).copied().unwrap_or(0) | inst.null_fb_votes.get(&view).copied().unwrap_or(0);
        if skips.count_ones() >= self.shared.params.quorum() && !inst.nullified.contains(&view) {
            self.on_nullified(k, view);
        }
    }

    /// Alpenglow's fallback votes, for a view this validator already cast its initial vote in.
    /// They are what keep a split view from getting stuck now that notarize voters no longer
    /// skip on a timer, and each is cast only when the votes already seen make it safe.
    fn check_fallbacks(&mut self, k: usize, view: u64) {
        if !self.is_validator() {
            return;
        }
        let p = &self.shared.params;
        let (q, p40, p20) = (p.quorum(), p.pct40(), p.pct20());
        let inst = &self.insts[k];
        // Only for a view I voted in that has no certificate yet: once it does, it is settled.
        if view <= inst.finalized_view || !inst.voted_initial(view) || inst.view_done(view) {
            return;
        }
        let mine = inst.my_votes.get(&(view, VoteKind::Notarize as u8)).map(|v| v.digest);
        let skip = inst.null_votes.get(&view).copied().unwrap_or(0).count_ones();
        let blocks: Vec<(Digest, u32)> = inst.notar_in(view).map(|(d, b)| (d, b.count_ones())).collect();

        // SafeToNotar: back a block I did not vote for once it has 40% of the notarize votes,
        // or 20% with notarize + skip votes together at 60%.
        if !inst.voted(view, VoteKind::NotarizeFallback) {
            let pick = blocks.iter().find(|(d, n)| Some(*d) != mine && (*n >= p40 || (skip + n >= q && *n >= p20)));
            if let Some(&(d, _)) = pick {
                self.cast(k, view, VoteKind::NotarizeFallback, d);
                if !self.insts[k].blocks.contains_key(&d) {
                    self.request_block(k, d);
                }
            }
        }

        // SafeToSkip: I voted for a block, and skip votes plus votes for other blocks reach 40%,
        // so no block in this view can reach the fast lane any more.
        let inst = &self.insts[k];
        if mine.is_some() && !inst.voted(view, VoteKind::NullifyFallback) {
            let total: u32 = blocks.iter().map(|(_, n)| n).sum();
            let top = blocks.iter().map(|(_, n)| *n).max().unwrap_or(0);
            if skip + total - top >= p40 {
                self.cast(k, view, VoteKind::NullifyFallback, GENESIS);
            }
        }
    }

    fn on_notarized(&mut self, k: usize, view: u64, digest: Digest, plain: bool) {
        if !self.insts[k].notarized.contains_key(&view) {
            self.insts[k].notarized.insert(view, digest);
            self.report(ObsEvent::Notarized { instance: k as u16, view, digest, at_us: now_us() });
            if let Some(b) = self.insts[k].blocks.get(&digest).cloned() {
                self.mark_included(&b);
            } else {
                self.request_block(k, digest);
            }
        }
        // Finalize vote: only for the block I voted notarize for, on a plain notarization, and
        // only if I did not skip or cast a fallback vote in this view.
        if plain {
            let inst = &self.insts[k];
            let voted_it = inst.my_votes.get(&(view, VoteKind::Notarize as u8)).map(|v| v.digest) == Some(digest);
            if voted_it && !inst.bad_window.contains(&view) {
                self.cast(k, view, VoteKind::Finalize, digest);
            }
        }
        if view >= self.insts[k].view {
            self.enter(k, view + 1);
        }
        self.try_vote(k);
    }

    fn on_nullified(&mut self, k: usize, view: u64) {
        self.insts[k].nullified.insert(view);
        self.report(ObsEvent::Nullified { instance: k as u16, view, at_us: now_us() });
        if view >= self.insts[k].view {
            self.enter(k, view + 1);
        }
        self.try_vote(k);
    }

    fn on_finalize_cert(&mut self, k: usize, view: u64, digest: Digest, fast: bool) {
        let inst = &mut self.insts[k];
        if view <= inst.finalized_view {
            return;
        }
        if let Some((pv, _, _)) = inst.pending_final {
            if pv > view {
                return;
            }
        }
        inst.pending_final = Some((view, digest, fast));
        self.try_finalize(k, view, digest, fast);
    }

    /// Finalize `digest` and every ancestor not yet finalized, oldest first. If a block in the
    /// chain is missing, ask for it and try again when it arrives.
    fn try_finalize(&mut self, k: usize, view: u64, digest: Digest, fast: bool) {
        let inst = &self.insts[k];
        let mut chain = Vec::new();
        let mut cur = digest;
        loop {
            if cur == inst.finalized_tip || cur == GENESIS {
                break;
            }
            match inst.blocks.get(&cur) {
                Some(b) => {
                    if b.height <= inst.finalized_height {
                        // Walked below my finalized height without meeting my finalized tip:
                        // the new block is on another branch.
                        violation(format!("node {} instance {k}: finalized view {view} does not extend its finalized chain", self.id));
                        return;
                    }
                    chain.push(b.clone());
                    cur = b.parent;
                }
                None => {
                    self.request_block(k, cur);
                    return;
                }
            }
        }
        chain.reverse();
        let inst = &mut self.insts[k];
        inst.pending_final = None;
        inst.finalized_view = view;
        inst.finalized_tip = digest;
        if let Some(last) = chain.last() {
            inst.finalized_height = last.height;
        }
        for b in &chain {
            check_agreement(self.shared.genesis_us, b);
        }
        if !chain.is_empty() {
            self.reveal(&chain);
            self.report(ObsEvent::Finalized { blocks: chain, at_us: now_us(), fast });
        }
    }

    fn request_missing(&mut self, k: usize, digest: Digest) {
        let inst = &self.insts[k];
        let mut cur = digest;
        while let Some(b) = inst.blocks.get(&cur) {
            if b.height <= inst.finalized_height {
                return;
            }
            cur = b.parent;
        }
        if cur != GENESIS && cur != inst.finalized_tip {
            self.insts[k].requested.remove(&cur);
            self.request_block(k, cur);
        }
    }

    fn request_block(&mut self, k: usize, digest: Digest) {
        let now = Instant::now();
        let inst = &mut self.insts[k];
        if let Some(t) = inst.requested.get(&digest) {
            if now.duration_since(*t) < Duration::from_millis(self.shared.params.timeout_ms) {
                return;
            }
        }
        inst.requested.insert(digest, now);
        // Ask two random peers; any honest holder answers.
        let n = self.shared.params.n as u64;
        let seed = u64::from_le_bytes(digest[..8].try_into().unwrap()) ^ now_us();
        for i in 0..2u64 {
            let to = ((seed.wrapping_add(i * 7919)) % n) as NodeId;
            if to != self.id {
                self.shared.bus.send(self.id, to, Msg::BlockRequest { instance: k as u16, digest });
            }
        }
    }

    fn prune(&mut self) {
        for inst in &mut self.insts {
            let keep_from = inst.finalized_view.saturating_sub(64);
            if keep_from == 0 {
                continue;
            }
            let hkeep = inst.finalized_height.saturating_sub(64);
            inst.blocks.retain(|_, b| b.height >= hkeep || b.view >= keep_from);
            inst.proposals.retain(|v, _| *v >= keep_from);
            inst.notar_votes = inst.notar_votes.split_off(&(keep_from, [0u8; 32]));
            inst.notar_fb_votes.retain(|(v, _), _| *v >= keep_from);
            inst.final_votes.retain(|(v, _), _| *v >= keep_from);
            inst.null_votes.retain(|v, _| *v >= keep_from);
            inst.null_fb_votes.retain(|v, _| *v >= keep_from);
            inst.notarized = inst.notarized.split_off(&keep_from);
            inst.notarized_plain = inst.notarized_plain.split_off(&keep_from);
            inst.nullified = inst.nullified.split_off(&keep_from);
            inst.bad_window = inst.bad_window.split_off(&keep_from);
            inst.my_votes = inst.my_votes.split_off(&(keep_from, 0));
            let now = Instant::now();
            inst.requested.retain(|_, t| now.duration_since(*t) < Duration::from_secs(10));
        }
    }
}

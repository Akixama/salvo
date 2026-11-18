//! One node of the net: a validator, or the observer that the gateway reads from.
//!
//! Each node runs K Simplex instances side by side. In instance k, the leader of view v
//! proposes at `genesis + v·Δ + k·Δ/K`, so across instances a proposal goes out every Δ/K.
//! Validators vote notarize on a valid proposal, and once a block is notarized they vote
//! finalize (unless they already timed out in that view). A view whose leader is silent or
//! late times out: validators vote nullify and move on. 2f+1 matching votes make a certificate.

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
    pub fn quorum(&self) -> u32 {
        let f = (self.n - 1) / 3;
        (self.n - f) as u32
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
    /// Finalized blocks of one instance, oldest first.
    Finalized { blocks: Vec<Arc<Block>>, at_us: u64 },
    Views { views: Vec<u64> },
    Reveal { id: Digest, index: u16, share: [u8; 32], at_us: u64 },
}

pub enum Role {
    Validator(SigningKey),
    Observer(UnboundedSender<ObsEvent>),
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
    notar_votes: HashMap<(u64, Digest), u64>,
    final_votes: HashMap<(u64, Digest), u64>,
    null_votes: HashMap<u64, u64>,
    notarized: BTreeMap<u64, Digest>,
    nullified: BTreeSet<u64>,
    my_votes: BTreeMap<(u64, u8), Arc<Vote>>,
    finalized_view: u64,
    finalized_tip: Digest,
    finalized_height: u64,
    pending_final: Option<(u64, Digest)>,
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
            notar_votes: HashMap::new(),
            final_votes: HashMap::new(),
            null_votes: HashMap::new(),
            notarized: BTreeMap::new(),
            nullified: BTreeSet::new(),
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
            if !inst.voted(inst.view, VoteKind::Nullify) && !inst.notarized.contains_key(&inst.view) {
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
            if now >= inst.timeout_at && !inst.voted(view, VoteKind::Nullify) && !inst.notarized.contains_key(&view) {
                self.cast(k, view, VoteKind::Nullify, GENESIS);
                let t = self.shared.params.timeout_ms;
                self.insts[k].rebroadcast_at = Some(now + Duration::from_millis(t));
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
        if let Some((_, d)) = self.insts[k].pending_final {
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
        self.shared.bus.broadcast(self.id, Msg::Vote(vote.clone()));
        self.on_vote(&vote);
    }

    fn try_vote(&mut self, k: usize) {
        if !self.is_validator() {
            return;
        }
        let inst = &self.insts[k];
        let view = inst.view;
        if inst.voted(view, VoteKind::Notarize) || inst.voted(view, VoteKind::Nullify) {
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
        if let Some((v, d)) = self.insts[k].pending_final {
            self.try_finalize(k, v, d);
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
        let q = self.shared.params.quorum();
        let bit = 1u64 << v.voter;
        let inst = &mut self.insts[k];
        if v.view <= inst.finalized_view && v.kind != VoteKind::Finalize {
            return;
        }
        match v.kind {
            VoteKind::Notarize => {
                let e = inst.notar_votes.entry((v.view, v.digest)).or_insert(0);
                if *e & bit != 0 {
                    return;
                }
                *e |= bit;
                if e.count_ones() == q && !inst.notarized.contains_key(&v.view) {
                    self.on_notarized(k, v.view, v.digest);
                }
            }
            VoteKind::Nullify => {
                let e = inst.null_votes.entry(v.view).or_insert(0);
                if *e & bit != 0 {
                    return;
                }
                *e |= bit;
                if e.count_ones() == q && !inst.nullified.contains(&v.view) {
                    self.on_nullified(k, v.view);
                }
            }
            VoteKind::Finalize => {
                let e = inst.final_votes.entry((v.view, v.digest)).or_insert(0);
                if *e & bit != 0 {
                    return;
                }
                *e |= bit;
                if e.count_ones() == q {
                    self.on_finalize_cert(k, v.view, v.digest);
                }
            }
        }
    }

    fn on_notarized(&mut self, k: usize, view: u64, digest: Digest) {
        self.insts[k].notarized.insert(view, digest);
        self.report(ObsEvent::Notarized { instance: k as u16, view, digest, at_us: now_us() });
        if let Some(b) = self.insts[k].blocks.get(&digest).cloned() {
            self.mark_included(&b);
        } else {
            self.request_block(k, digest);
        }
        if view >= self.insts[k].view {
            if !self.insts[k].voted(view, VoteKind::Nullify) {
                self.cast(k, view, VoteKind::Finalize, digest);
            }
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

    fn on_finalize_cert(&mut self, k: usize, view: u64, digest: Digest) {
        let inst = &mut self.insts[k];
        if view <= inst.finalized_view {
            return;
        }
        if let Some((pv, _)) = inst.pending_final {
            if pv > view {
                return;
            }
        }
        inst.pending_final = Some((view, digest));
        self.try_finalize(k, view, digest);
    }

    /// Finalize `digest` and every ancestor not yet finalized, oldest first. If a block in the
    /// chain is missing, ask for it and try again when it arrives.
    fn try_finalize(&mut self, k: usize, view: u64, digest: Digest) {
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
                        break;
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
        if !chain.is_empty() {
            self.reveal(&chain);
            self.report(ObsEvent::Finalized { blocks: chain, at_us: now_us() });
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
            inst.notar_votes.retain(|(v, _), _| *v >= keep_from);
            inst.final_votes.retain(|(v, _), _| *v >= keep_from);
            inst.null_votes.retain(|v, _| *v >= keep_from);
            inst.notarized = inst.notarized.split_off(&keep_from);
            inst.nullified = inst.nullified.split_off(&keep_from);
            inst.my_votes = inst.my_votes.split_off(&(keep_from, 0));
            let now = Instant::now();
            inst.requested.retain(|_, t| now.duration_since(*t) < Duration::from_secs(10));
        }
    }
}

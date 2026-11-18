//! Execution. One thread owns a LiteSVM bank and applies the merged log in order. Solana
//! transactions run unchanged; a transaction that two leaders both put in a block runs once.

use crate::state::{BlockRecord, SharedState, TxRecord};
use crate::types::{hex, now_us, Block};
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_hash::Hash;
use solana_transaction::versioned::VersionedTransaction;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use tokio::sync::oneshot;

/// How long a blockhash stays valid, in microseconds (Solana: about 60 to 90 seconds).
pub const BLOCKHASH_VALID_US: u64 = 90_000_000;

pub struct Merged {
    pub block: Arc<Block>,
    pub notarized_at_us: Option<u64>,
    pub finalized_at_us: u64,
    pub merged_at_us: u64,
    pub leader_city: &'static str,
    /// How many of the block's transactions arrived sealed.
    pub sealed: usize,
}

pub enum ExecCmd {
    Apply(Vec<Merged>),
    Accounts(Vec<Address>, oneshot::Sender<Vec<Option<Account>>>),
    Simulate(Box<VersionedTransaction>, oneshot::Sender<Value>),
    RentExempt(usize, oneshot::Sender<u64>),
    Fund(Address, u64),
}

/// Blockhashes the net accepts, newest last.
#[derive(Default)]
pub struct Blockhashes {
    order: VecDeque<(Hash, u64, u64)>,
    set: HashMap<Hash, u64>,
}

impl Blockhashes {
    pub fn push(&mut self, h: Hash, slot: u64, at_us: u64) {
        self.order.push_back((h, slot, at_us));
        self.set.insert(h, slot);
        while let Some((old, _, t)) = self.order.front() {
            if at_us.saturating_sub(*t) > BLOCKHASH_VALID_US {
                self.set.remove(old);
                self.order.pop_front();
            } else {
                break;
            }
        }
    }
    pub fn contains(&self, h: &Hash) -> bool {
        self.set.contains_key(h)
    }
    pub fn latest(&self) -> Option<(Hash, u64)> {
        self.order.back().map(|(h, s, _)| (*h, *s))
    }
}

pub struct Executor {
    svm: LiteSVM,
    state: SharedState,
    blockhashes: Arc<parking_lot::RwLock<Blockhashes>>,
    processed: HashSet<[u8; 64]>,
    processed_order: VecDeque<[u8; 64]>,
    log_hash: [u8; 32],
    slot: u64,
    recent_proposals: VecDeque<u64>,
    blocks_per_valid_window: u64,
}

pub fn genesis_hash(seed: &[u8]) -> Hash {
    let d: [u8; 32] = Sha256::digest([b"salvo/genesis".as_slice(), seed].concat()).into();
    Hash::new_from_array(d)
}

impl Executor {
    pub fn new(
        state: SharedState,
        blockhashes: Arc<parking_lot::RwLock<Blockhashes>>,
        seed: &[u8],
        funded: Vec<(Address, u64)>,
        blocks_per_valid_window: u64,
    ) -> Executor {
        let mut svm = LiteSVM::new().with_blockhash_check(false).with_sigverify(true).with_transaction_history(0);
        for (addr, lamports) in funded {
            svm.set_account(addr, Account { lamports, data: vec![], owner: Address::default(), executable: false, rent_epoch: 0 })
                .expect("fund genesis account");
        }
        let g = genesis_hash(seed);
        blockhashes.write().push(g, 0, now_us());
        Executor {
            svm,
            state,
            blockhashes,
            processed: HashSet::new(),
            processed_order: VecDeque::new(),
            log_hash: g.to_bytes(),
            slot: 0,
            recent_proposals: VecDeque::new(),
            blocks_per_valid_window,
        }
    }

    pub fn run(mut self, rx: Receiver<ExecCmd>) {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                ExecCmd::Apply(blocks) => {
                    for m in blocks {
                        self.apply(m);
                    }
                }
                ExecCmd::Accounts(keys, reply) => {
                    let _ = reply.send(keys.iter().map(|k| self.svm.get_account(k)).collect());
                }
                ExecCmd::Simulate(tx, reply) => {
                    let _ = reply.send(self.simulate(*tx));
                }
                ExecCmd::RentExempt(len, reply) => {
                    let _ = reply.send(self.svm.minimum_balance_for_rent_exemption(len));
                }
                ExecCmd::Fund(addr, lamports) => {
                    let mut acc = self.svm.get_account(&addr).unwrap_or(Account {
                        lamports: 0,
                        data: vec![],
                        owner: Address::default(),
                        executable: false,
                        rent_epoch: 0,
                    });
                    acc.lamports += lamports;
                    let _ = self.svm.set_account(addr, acc);
                }
            }
        }
    }

    fn simulate(&self, tx: VersionedTransaction) -> Value {
        match self.svm.simulate_transaction(tx) {
            Ok(info) => json!({ "err": null, "logs": info.meta.logs, "unitsConsumed": info.meta.compute_units_consumed }),
            Err(f) => json!({ "err": format!("{:?}", f.err), "logs": f.meta.logs, "unitsConsumed": f.meta.compute_units_consumed }),
        }
    }

    fn balances(&self, keys: &[Address]) -> Vec<u64> {
        keys.iter().map(|k| self.svm.get_balance(k).unwrap_or(0)).collect()
    }

    fn apply(&mut self, m: Merged) {
        let b = &m.block;
        self.slot += 1;
        let slot = self.slot;
        let now = now_us();
        let mut clock: Clock = self.svm.get_sysvar();
        clock.slot = slot;
        clock.unix_timestamp = (now / 1_000_000) as i64;
        self.svm.set_sysvar(&clock);

        let mut h = Sha256::new();
        h.update(self.log_hash);
        h.update(b.digest);

        let mut signatures = Vec::new();
        let mut updates: Vec<TxRecord> = Vec::new();
        let (mut failed, mut duplicates, mut fees, mut cus) = (0usize, 0usize, 0u64, 0u64);
        for raw in &b.txs {
            let Ok(tx) = bincode::deserialize::<VersionedTransaction>(raw) else {
                failed += 1;
                continue;
            };
            let Some(sig) = tx.signatures.first().copied() else { continue };
            let sig_bytes: [u8; 64] = sig.into();
            if self.processed.contains(&sig_bytes) {
                duplicates += 1;
                continue;
            }
            self.processed.insert(sig_bytes);
            self.processed_order.push_back(sig_bytes);
            if self.processed_order.len() > 400_000 {
                if let Some(old) = self.processed_order.pop_front() {
                    self.processed.remove(&old);
                }
            }
            let sig_str = sig.to_string();
            signatures.push(sig_str.clone());
            h.update(sig_bytes);
            let keys: Vec<Address> = tx.message.static_account_keys().to_vec();
            let fee_payer = keys.first().map(|k| k.to_string()).unwrap_or_default();
            let blockhash_ok = self.blockhashes.read().contains(tx.message.recent_blockhash());
            let pre = self.balances(&keys);
            let (err, logs, fee, cu) = if !blockhash_ok {
                (Some("BlockhashNotFound".to_string()), vec![], 0, 0)
            } else {
                let res: TransactionResult = self.svm.send_transaction(tx);
                match res {
                    Ok(meta) => (None, meta.logs, meta.fee, meta.compute_units_consumed),
                    Err(f) => (Some(format!("{:?}", f.err)), f.meta.logs, f.meta.fee, f.meta.compute_units_consumed),
                }
            };
            let post = self.balances(&keys);
            if err.is_some() {
                failed += 1;
                h.update([0u8]);
            } else {
                h.update([1u8]);
            }
            fees += fee;
            cus += cu;
            updates.push(TxRecord {
                signature: sig_str,
                received_at_us: 0,
                status: if err.is_some() { "failed" } else { "finalized" },
                included_at_us: Some(b.proposed_at_us),
                instance: Some(b.instance),
                view: Some(b.view),
                slot: Some(slot),
                finalized_at_us: Some(m.merged_at_us),
                executed_at_us: Some(now_us()),
                err,
                logs,
                fee,
                compute_units: cu,
                copies: 1,
                fee_payer,
                accounts: keys.iter().map(|k| k.to_string()).collect(),
                pre_balances: pre,
                post_balances: post,
                source: "traffic",
                raw: Some(raw.clone()),
                sealed_id: None,
                revealed_at_us: None,
                revealed_as: None,
            });
        }
        self.log_hash = h.finalize().into();
        let bh_bytes: [u8; 32] = Sha256::digest([b"salvo/blockhash".as_slice(), &self.log_hash].concat()).into();
        let blockhash = Hash::new_from_array(bh_bytes);
        let executed_at = now_us();
        self.blockhashes.write().push(blockhash, slot, executed_at);

        let rec = BlockRecord {
            slot,
            instance: b.instance,
            view: b.view,
            height: b.height,
            leader: b.leader,
            leader_city: m.leader_city,
            proposed_at_us: b.proposed_at_us,
            notarized_at_us: m.notarized_at_us,
            finalized_at_us: m.finalized_at_us,
            merged_at_us: m.merged_at_us,
            executed_at_us: executed_at,
            digest: hex(&b.digest),
            parent: hex(&b.parent),
            blockhash: blockhash.to_string(),
            log_hash: hex(&self.log_hash),
            tx_count: signatures.len(),
            signatures,
            failed,
            duplicates,
            sealed: m.sealed,
            fees,
            compute_units: cus,
        };

        let mut st = self.state.write();
        // Leaders' proposal times are not always in log order (a leader running late proposes
        // after its successor), so the spacing is measured over runs of 25 blocks: the time
        // they span divided by 24.
        self.recent_proposals.push_back(b.proposed_at_us);
        if self.recent_proposals.len() > 25 {
            self.recent_proposals.pop_front();
        }
        if self.recent_proposals.len() == 25 {
            let lo = *self.recent_proposals.iter().min().unwrap();
            let hi = *self.recent_proposals.iter().max().unwrap();
            st.stats.gap.push((hi - lo) as f64 / 1000.0 / 24.0);
        }
        st.stats.block_finality.push((m.merged_at_us.saturating_sub(b.proposed_at_us)) as f64 / 1000.0);
        st.stats.merged = slot;
        st.stats.txs += updates.len() as u64;
        st.stats.failed_txs += failed as u64;
        st.stats.duplicates += duplicates as u64;
        let sec = executed_at / 1_000_000;
        match st.stats.per_second.back_mut() {
            Some((s, c)) if *s == sec => *c += 1,
            _ => {
                st.stats.per_second.push_back((sec, 1));
                while st.stats.per_second.len() > 60 {
                    st.stats.per_second.pop_front();
                }
            }
        }
        for mut u in updates {
            if let Some(prev) = st.txs.get(&u.signature) {
                u.received_at_us = prev.received_at_us;
                u.copies = prev.copies.max(1);
                u.source = prev.source;
                u.sealed_id = prev.sealed_id.clone();
                u.revealed_at_us = prev.revealed_at_us;
                if let Some(t) = prev.included_at_us {
                    u.included_at_us = Some(t);
                }
                if u.received_at_us > 0 {
                    let ms = (executed_at.saturating_sub(u.received_at_us)) as f64 / 1000.0;
                    st.stats.tx_finality.push(ms);
                }
                let sig = u.signature.clone();
                let ev = json!({ "type": "tx", "signature": sig, "status": u.status, "slot": slot, "err": u.err });
                st.txs.insert(sig, u);
                st.push_event(ev);
            } else {
                // Transactions that did not come through this gateway (background traffic).
                let id: [u8; 32] = Sha256::digest(u.signature.as_bytes()).into();
                st.add_tx(u, id);
            }
        }
        let summary = json!({
            "type": "block",
            "slot": rec.slot, "instance": rec.instance, "view": rec.view, "leader": rec.leader,
            "city": rec.leader_city, "txs": rec.tx_count, "proposedAtUs": rec.proposed_at_us,
            "finalizedAtUs": rec.finalized_at_us, "mergedAtUs": rec.merged_at_us, "executedAtUs": rec.executed_at_us,
            "blockhash": rec.blockhash,
        });
        st.push_event(summary);
        st.blocks.push_back(rec);
        while st.blocks.len() > crate::state::KEEP_BLOCKS {
            st.blocks.pop_front();
        }
        let _ = self.blocks_per_valid_window;
    }
}

pub type ExecTx = Sender<ExecCmd>;

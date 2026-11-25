//! Blocks, votes and the messages that travel on the wire.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest as _, Sha256};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub type Digest = [u8; 32];
pub type NodeId = u16;

pub const GENESIS: Digest = [0u8; 32];
const NAMESPACE: &[u8] = b"salvo/gatling/v1";

pub fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64
}

pub fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// A block proposed by the leader of (instance, view). `height` counts blocks in this
/// instance's own chain; `txs` are serialized Solana transactions.
#[derive(Clone, Debug)]
pub struct Block {
    pub instance: u16,
    pub view: u64,
    pub height: u64,
    pub parent: Digest,
    pub leader: NodeId,
    pub proposed_at_us: u64,
    pub txs: Vec<Arc<Vec<u8>>>,
    pub digest: Digest,
}

impl Block {
    pub fn compute_digest(
        instance: u16,
        view: u64,
        height: u64,
        parent: &Digest,
        leader: NodeId,
        proposed_at_us: u64,
        txs: &[Arc<Vec<u8>>],
    ) -> Digest {
        let mut h = Sha256::new();
        h.update(NAMESPACE);
        h.update(instance.to_le_bytes());
        h.update(view.to_le_bytes());
        h.update(height.to_le_bytes());
        h.update(parent);
        h.update(leader.to_le_bytes());
        h.update(proposed_at_us.to_le_bytes());
        h.update((txs.len() as u32).to_le_bytes());
        for tx in txs {
            h.update(Sha256::digest(tx.as_slice()));
        }
        h.finalize().into()
    }

    pub fn is_valid_digest(&self) -> bool {
        self.digest
            == Self::compute_digest(
                self.instance,
                self.view,
                self.height,
                &self.parent,
                self.leader,
                self.proposed_at_us,
                &self.txs,
            )
    }
}

/// Votes follow Alpenglow's Votor rules. Notarize or Nullify (skip) is a validator's one initial
/// vote in a view. The two fallback votes may be cast later, only once the votes already seen
/// prove it is safe (SafeToNotar and SafeToSkip in the Alpenglow paper).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VoteKind {
    Notarize,
    Finalize,
    Nullify,
    NotarizeFallback,
    NullifyFallback,
}

#[derive(Clone, Debug)]
pub struct Vote {
    pub instance: u16,
    pub view: u64,
    pub kind: VoteKind,
    pub digest: Digest,
    pub voter: NodeId,
    pub sig: Signature,
    /// The nodes share one process, so a vote's signature is checked once and the result is
    /// reused by every receiver of the same message.
    pub checked: std::sync::OnceLock<bool>,
}

fn vote_message(instance: u16, view: u64, kind: VoteKind, digest: &Digest) -> Vec<u8> {
    let mut m = Vec::with_capacity(64);
    m.extend_from_slice(NAMESPACE);
    m.extend_from_slice(&instance.to_le_bytes());
    m.extend_from_slice(&view.to_le_bytes());
    m.push(kind as u8);
    m.extend_from_slice(digest);
    m
}

impl Vote {
    pub fn sign(key: &SigningKey, voter: NodeId, instance: u16, view: u64, kind: VoteKind, digest: Digest) -> Vote {
        let sig = key.sign(&vote_message(instance, view, kind, &digest));
        Vote { instance, view, kind, digest, voter, sig, checked: std::sync::OnceLock::new() }
    }

    pub fn verify(&self, key: &VerifyingKey) -> bool {
        *self
            .checked
            .get_or_init(|| key.verify(&vote_message(self.instance, self.view, self.kind, &self.digest), &self.sig).is_ok())
    }
}

/// A Solana transaction entering the net, with the time the gateway first saw it.
#[derive(Clone, Debug)]
pub struct TxIn {
    pub bytes: Arc<Vec<u8>>,
    pub id: Digest,
}

#[derive(Clone, Debug)]
pub enum Msg {
    Proposal(Arc<Block>),
    Vote(Arc<Vote>),
    Tx(TxIn),
    BlockRequest { instance: u16, digest: Digest },
    BlockResponse(Arc<Block>),
    /// A validator's share of a sealed transaction's key, sent only after the block that
    /// carries it is finalized.
    Reveal { id: Digest, index: u16, share: [u8; 32] },
}

#[derive(Clone, Debug)]
pub struct Envelope {
    pub from: NodeId,
    pub msg: Msg,
}

/// Deterministic validator keys from a seed, so a restart with the same seed keeps identities.
pub fn derive_key(seed: &[u8], index: u16) -> SigningKey {
    let mut h = Sha256::new();
    h.update(b"salvo/validator-key");
    h.update(seed);
    h.update(index.to_le_bytes());
    let bytes: [u8; 32] = h.finalize().into();
    SigningKey::from_bytes(&bytes)
}

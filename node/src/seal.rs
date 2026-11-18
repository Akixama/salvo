//! Sealed transactions: order first, reveal after.
//!
//! A client encrypts its transaction under a fresh key K, splits K into n Shamir shares (any t
//! rebuild it, t = f + 1) and locks share i to validator i's X25519 key. Leaders put the sealed
//! envelope in a block without being able to read it. Once a validator sees the block finalized
//! (its place in the log can no longer change), it opens its own share and publishes it. Any t
//! shares rebuild K, and the transaction runs in the position it was ordered in.
//!
//! The same format is implemented in web/lib/seal.ts.
//!
//! Envelope layout:
//!   "SLV1" | t u8 | n u8 | ephemeral X25519 public (32) | nonce (12) | ct_len u32 LE | ct
//!   | n × share box (48: AES-256-GCM of the 32-byte share) | n × sha256(share) (32)

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand::RngCore;
use sha2::{Digest as _, Sha256};

pub const MAGIC: &[u8; 4] = b"SLV1";
pub const MAX_ENVELOPE: usize = 8 * 1024;

pub fn is_sealed(b: &[u8]) -> bool {
    b.len() > 4 && &b[..4] == MAGIC
}

#[derive(Clone, Debug)]
pub struct Envelope {
    pub t: u8,
    pub n: u8,
    pub eph: [u8; 32],
    pub nonce: [u8; 12],
    pub ct: Vec<u8>,
    pub boxes: Vec<[u8; 48]>,
    pub hashes: Vec<[u8; 32]>,
}

impl Envelope {
    pub fn parse(b: &[u8]) -> Option<Envelope> {
        if !is_sealed(b) || b.len() > MAX_ENVELOPE {
            return None;
        }
        let t = *b.get(4)?;
        let n = *b.get(5)?;
        if t == 0 || n == 0 || t > n {
            return None;
        }
        let mut p = 6;
        let eph: [u8; 32] = b.get(p..p + 32)?.try_into().ok()?;
        p += 32;
        let nonce: [u8; 12] = b.get(p..p + 12)?.try_into().ok()?;
        p += 12;
        let len = u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?) as usize;
        p += 4;
        let ct = b.get(p..p + len)?.to_vec();
        p += len;
        let mut boxes = Vec::with_capacity(n as usize);
        for _ in 0..n {
            boxes.push(b.get(p..p + 48)?.try_into().ok()?);
            p += 48;
        }
        let mut hashes = Vec::with_capacity(n as usize);
        for _ in 0..n {
            hashes.push(b.get(p..p + 32)?.try_into().ok()?);
            p += 32;
        }
        if p != b.len() {
            return None;
        }
        Some(Envelope { t, n, eph, nonce, ct, boxes, hashes })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(6 + 48 + self.ct.len() + 80 * self.n as usize);
        out.extend_from_slice(MAGIC);
        out.push(self.t);
        out.push(self.n);
        out.extend_from_slice(&self.eph);
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&(self.ct.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.ct);
        for b in &self.boxes {
            out.extend_from_slice(b);
        }
        for h in &self.hashes {
            out.extend_from_slice(h);
        }
        out
    }
}

// ---------- Shamir secret sharing over GF(2^8), polynomial 0x11b ----------

fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    while b != 0 {
        if b & 1 != 0 {
            p ^= a;
        }
        let hi = a & 0x80;
        a <<= 1;
        if hi != 0 {
            a ^= 0x1b;
        }
        b >>= 1;
    }
    p
}

fn gf_inv(a: u8) -> u8 {
    // a^254 = a^-1 in GF(2^8)
    let mut r = 1u8;
    let mut base = a;
    let mut e = 254u32;
    while e > 0 {
        if e & 1 == 1 {
            r = gf_mul(r, base);
        }
        base = gf_mul(base, base);
        e >>= 1;
    }
    r
}

/// Share i (0-based) is the polynomial evaluated at x = i + 1.
pub fn split(secret: &[u8; 32], t: u8, n: u8, rng: &mut impl RngCore) -> Vec<[u8; 32]> {
    let mut coeffs = vec![[0u8; 32]; t as usize];
    coeffs[0] = *secret;
    for c in coeffs.iter_mut().skip(1) {
        rng.fill_bytes(c);
    }
    (0..n)
        .map(|i| {
            let x = i + 1;
            let mut share = [0u8; 32];
            for (byte, s) in share.iter_mut().enumerate() {
                // Horner's rule from the highest coefficient down.
                let mut y = 0u8;
                for c in coeffs.iter().rev() {
                    y = gf_mul(y, x) ^ c[byte];
                }
                *s = y;
            }
            share
        })
        .collect()
}

/// Rebuild the secret from (index, share) pairs, index 0-based. Needs at least t of them.
pub fn combine(shares: &[(u8, [u8; 32])]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (j, (ij, yj)) in shares.iter().enumerate() {
        let xj = ij + 1;
        // Lagrange basis at 0: prod over m != j of x_m / (x_m - x_j); minus is XOR here.
        let mut num = 1u8;
        let mut den = 1u8;
        for (m, (im, _)) in shares.iter().enumerate() {
            if m == j {
                continue;
            }
            let xm = im + 1;
            num = gf_mul(num, xm);
            den = gf_mul(den, xm ^ xj);
        }
        let l = gf_mul(num, gf_inv(den));
        for b in 0..32 {
            out[b] ^= gf_mul(yj[b], l);
        }
    }
    out
}

// ---------- keys and boxes ----------

pub fn validator_secret(seed: &[u8], index: u16) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"salvo/seal-key");
    h.update(seed);
    h.update(index.to_le_bytes());
    h.finalize().into()
}

pub fn public_of(secret: &[u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(*secret).to_bytes()
}

fn share_key(shared: &[u8; 32], eph: &[u8; 32], vpub: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"salvo/share-key");
    h.update(shared);
    h.update(eph);
    h.update(vpub);
    h.finalize().into()
}

fn share_nonce(i: u8) -> [u8; 12] {
    let d: [u8; 32] = Sha256::digest([b"salvo/share-nonce".as_slice(), &[i]].concat()).into();
    d[..12].try_into().unwrap()
}

pub fn share_hash(share: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(share).into()
}

/// Seal `tx` for validators with X25519 public keys `pubs`, any `t` of whom can open it.
pub fn seal(tx: &[u8], pubs: &[[u8; 32]], t: u8, rng: &mut impl RngCore) -> Vec<u8> {
    let n = pubs.len() as u8;
    let mut k = [0u8; 32];
    rng.fill_bytes(&mut k);
    let mut nonce = [0u8; 12];
    rng.fill_bytes(&mut nonce);
    let ct = Aes256Gcm::new_from_slice(&k).unwrap().encrypt(Nonce::from_slice(&nonce), tx).expect("encrypt");
    let mut eph_sk = [0u8; 32];
    rng.fill_bytes(&mut eph_sk);
    let eph = public_of(&eph_sk);
    let shares = split(&k, t, n, rng);
    let mut boxes = Vec::with_capacity(n as usize);
    let mut hashes = Vec::with_capacity(n as usize);
    for (i, (share, vpub)) in shares.iter().zip(pubs).enumerate() {
        let shared = MontgomeryPoint(*vpub).mul_clamped(eph_sk).to_bytes();
        let key = share_key(&shared, &eph, vpub);
        let b = Aes256Gcm::new_from_slice(&key).unwrap().encrypt(Nonce::from_slice(&share_nonce(i as u8)), share.as_slice()).expect("encrypt");
        boxes.push(b.try_into().expect("48-byte box"));
        hashes.push(share_hash(share));
    }
    Envelope { t, n, eph, nonce, ct, boxes, hashes }.encode()
}

/// Validator `i` opens its own share of the envelope.
pub fn open_share(env: &Envelope, i: usize, secret: &[u8; 32]) -> Option<[u8; 32]> {
    let b = env.boxes.get(i)?;
    let vpub = public_of(secret);
    let shared = MontgomeryPoint(env.eph).mul_clamped(*secret).to_bytes();
    let key = share_key(&shared, &env.eph, &vpub);
    let s = Aes256Gcm::new_from_slice(&key).ok()?.decrypt(Nonce::from_slice(&share_nonce(i as u8)), b.as_slice()).ok()?;
    let share: [u8; 32] = s.try_into().ok()?;
    if share_hash(&share) != env.hashes[i] {
        return None;
    }
    Some(share)
}

/// Rebuild K from at least t checked shares and decrypt the transaction.
pub fn open(env: &Envelope, shares: &[(u8, [u8; 32])]) -> Option<Vec<u8>> {
    if shares.len() < env.t as usize {
        return None;
    }
    let k = combine(&shares[..env.t as usize]);
    Aes256Gcm::new_from_slice(&k).ok()?.decrypt(Nonce::from_slice(&env.nonce), env.ct.as_slice()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn shamir_any_t_rebuild() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(7);
        let mut secret = [0u8; 32];
        rng.fill_bytes(&mut secret);
        let shares = split(&secret, 4, 10, &mut rng);
        let pick = |idx: &[u8]| idx.iter().map(|i| (*i, shares[*i as usize])).collect::<Vec<_>>();
        assert_eq!(combine(&pick(&[0, 1, 2, 3])), secret);
        assert_eq!(combine(&pick(&[9, 4, 7, 2])), secret);
        assert_ne!(combine(&pick(&[0, 1, 2])), secret);
    }

    #[test]
    fn seal_and_open() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(9);
        let secrets: Vec<[u8; 32]> = (0..10).map(|i| validator_secret(b"t", i)).collect();
        let pubs: Vec<[u8; 32]> = secrets.iter().map(public_of).collect();
        let tx = b"a solana transaction".to_vec();
        let raw = seal(&tx, &pubs, 4, &mut rng);
        let env = Envelope::parse(&raw).unwrap();
        assert_eq!(env.encode(), raw);
        let got: Vec<(u8, [u8; 32])> = [8usize, 1, 5, 3].iter().map(|i| (*i as u8, open_share(&env, *i, &secrets[*i]).unwrap())).collect();
        assert_eq!(open(&env, &got).unwrap(), tx);
        // A validator cannot open someone else's share.
        assert!(open_share(&env, 2, &secrets[3]).is_none());
    }
}

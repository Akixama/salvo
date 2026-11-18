//! The wire. Every message between two nodes is delivered after the simulated one-way delay
//! between their cities, plus jitter. Faults (crashed nodes, cut-off cities, packet loss,
//! slow nodes) are applied here, so the Fault Lab can switch them on while the net runs.

use crate::geo::{one_way_ms, City};
use crate::types::{Envelope, Msg, NodeId};
use parking_lot::{Mutex, RwLock};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Default, Clone, Debug)]
pub struct Faults {
    /// Nodes that neither send nor receive.
    pub down: HashSet<NodeId>,
    /// Cities cut off from every other city (messages inside the city still flow).
    pub cut: HashSet<City>,
    /// Probability in [0, 1] that any message between two different nodes is lost.
    pub loss: f64,
    /// Extra delay in ms added to everything a node sends.
    pub slow: HashMap<NodeId, f64>,
}

impl Faults {
    pub fn is_empty(&self) -> bool {
        self.down.is_empty() && self.cut.is_empty() && self.loss == 0.0 && self.slow.is_empty()
    }
}

pub struct Bus {
    inboxes: Vec<UnboundedSender<Envelope>>,
    cities: Vec<City>,
    pub faults: RwLock<Faults>,
    rng: Mutex<ChaCha8Rng>,
    jitter: f64,
    pub sent: AtomicU64,
    pub dropped: AtomicU64,
}

impl Bus {
    pub fn new(inboxes: Vec<UnboundedSender<Envelope>>, cities: Vec<City>, seed: u64) -> Bus {
        Bus {
            inboxes,
            cities,
            faults: RwLock::new(Faults::default()),
            rng: Mutex::new(ChaCha8Rng::seed_from_u64(seed ^ 0x5a17_0b05)),
            jitter: 0.1,
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    pub fn city(&self, id: NodeId) -> City {
        self.cities[id as usize]
    }

    pub fn len(&self) -> usize {
        self.inboxes.len()
    }

    pub fn send(&self, from: NodeId, to: NodeId, msg: Msg) {
        if from == to {
            let _ = self.inboxes[to as usize].send(Envelope { from, msg });
            return;
        }
        let (a, b) = (self.city(from), self.city(to));
        let delay_ms = {
            let f = self.faults.read();
            if !f.is_empty() {
                if f.down.contains(&from) || f.down.contains(&to) {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                if a != b && (f.cut.contains(&a) || f.cut.contains(&b)) {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
            let mut rng = self.rng.lock();
            if f.loss > 0.0 && rng.gen::<f64>() < f.loss {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let base = one_way_ms(a, b);
            let j = 1.0 + self.jitter * (rng.gen::<f64>() * 2.0 - 1.0);
            base * j + f.slow.get(&from).copied().unwrap_or(0.0)
        };
        self.sent.fetch_add(1, Ordering::Relaxed);
        let inbox = self.inboxes[to as usize].clone();
        let env = Envelope { from, msg };
        if delay_ms < 0.5 {
            let _ = inbox.send(env);
        } else {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_micros((delay_ms * 1000.0) as u64)).await;
                let _ = inbox.send(env);
            });
        }
    }

    /// Send to every other node, including the observer.
    pub fn broadcast(&self, from: NodeId, msg: Msg) {
        for to in 0..self.inboxes.len() as NodeId {
            if to != from {
                self.send(from, to, msg.clone());
            }
        }
    }
}

//! The Gatling merge: K per-instance finalized chains become one log.
//!
//! Cells (view, instance) are read in lexicographic order: every instance's cell for view 1,
//! then every instance's cell for view 2, and so on. A cell either holds a finalized block or
//! is a gap (the instance skipped that view). This follows GATLING_SPEC.md section 7 of the
//! reference prototype (github.com/scaffino/Gatling, MIT/Apache-2.0).

use crate::types::Block;
use std::collections::BTreeMap;
use std::sync::Arc;

pub struct Merger {
    k: usize,
    queues: Vec<BTreeMap<u64, Option<Arc<Block>>>>,
    finalized_up_to: Vec<u64>,
    pub cursor_view: u64,
    pub cursor_instance: usize,
}

impl Merger {
    pub fn new(k: usize) -> Merger {
        Merger {
            k,
            queues: (0..k).map(|_| BTreeMap::new()).collect(),
            finalized_up_to: vec![0; k],
            cursor_view: 1,
            cursor_instance: 0,
        }
    }

    /// Feed one finalized block. Blocks of one instance must arrive in height order.
    /// Returns the blocks that enter the global log because of it, in log order.
    pub fn push(&mut self, block: Arc<Block>) -> Vec<Arc<Block>> {
        let idx = block.instance as usize;
        let view = block.view;
        if view <= self.finalized_up_to[idx] {
            return Vec::new();
        }
        let q = &mut self.queues[idx];
        let highest_queued = q.keys().next_back().copied().unwrap_or(0);
        let highest_seen = self.finalized_up_to[idx].max(highest_queued);
        if highest_seen > 0 && view > highest_seen + 1 {
            for gap in highest_seen + 1..view {
                q.entry(gap).or_insert(None);
            }
        }
        q.insert(view, Some(block));
        self.drain()
    }

    fn advance(&mut self) {
        self.cursor_instance += 1;
        if self.cursor_instance >= self.k {
            self.cursor_instance = 0;
            self.cursor_view += 1;
        }
    }

    fn drain(&mut self) -> Vec<Arc<Block>> {
        let mut out = Vec::new();
        loop {
            let (v, i) = (self.cursor_view, self.cursor_instance);
            if self.finalized_up_to[i] >= v {
                self.advance();
                continue;
            }
            match self.queues[i].remove(&v) {
                Some(Some(block)) => {
                    self.finalized_up_to[i] = v;
                    let stale: Vec<u64> = self.queues[i].range(..v).map(|(k, _)| *k).collect();
                    for s in stale {
                        self.queues[i].remove(&s);
                    }
                    out.push(block);
                    self.advance();
                }
                Some(None) => self.advance(),
                None => {
                    if self.queues[i].range(v + 1..).next().is_some() {
                        self.advance();
                    } else {
                        break;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GENESIS;

    fn blk(instance: u16, view: u64, height: u64) -> Arc<Block> {
        Arc::new(Block {
            instance,
            view,
            height,
            parent: GENESIS,
            leader: 0,
            proposed_at_us: 0,
            txs: vec![],
            digest: [instance as u8; 32],
        })
    }

    #[test]
    fn orders_by_view_then_instance() {
        let mut m = Merger::new(3);
        assert!(m.push(blk(1, 1, 1)).is_empty());
        assert!(m.push(blk(2, 1, 1)).is_empty());
        let out = m.push(blk(0, 1, 1));
        assert_eq!(out.iter().map(|b| b.instance).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn skips_views_an_instance_never_finalized() {
        let mut m = Merger::new(2);
        m.push(blk(0, 1, 1));
        let out = m.push(blk(1, 1, 1));
        assert_eq!(out.len(), 1);
        // instance 0 skips view 2 and finalizes view 3
        m.push(blk(0, 3, 2));
        let out = m.push(blk(1, 2, 2));
        assert_eq!(out.iter().map(|b| (b.view, b.instance)).collect::<Vec<_>>(), vec![(2, 1), (3, 0)]);
        let out = m.push(blk(1, 3, 3));
        assert_eq!(out.iter().map(|b| (b.view, b.instance)).collect::<Vec<_>>(), vec![(3, 1)]);
    }
}

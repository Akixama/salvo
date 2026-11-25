//! The Fault Lab. Each run starts a fresh, separate net in this process, lets it settle,
//! switches a fault on for a few seconds, switches it off, and reports what happened.

use crate::bus::Faults;
use crate::consensus::Params;
use crate::geo::City;
use crate::net::{Net, NetConfig};
use crate::types::now_us;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct Scenario {
    pub id: &'static str,
    pub title: &'static str,
    pub fault: &'static str,
    pub expect: &'static str,
}

pub const SCENARIOS: &[Scenario] = &[
    Scenario {
        id: "baseline",
        title: "No faults",
        fault: "Nothing is switched off. A control run to compare the others against.",
        expect: "Steady cadence and no skipped views.",
    },
    Scenario {
        id: "three-down",
        title: "Three validators crash",
        fault: "Validators 1, 4 and 7 stop sending and receiving for 6 seconds. That is 3 of 10; the net is built to keep going with up to 4 of 10 offline.",
        expect: "Views those three were due to lead time out and are skipped. The 7 left still give blocks the 6 votes they need, though not the 8 the fast lane needs, so blocks take the two-round path until the three return.",
    },
    Scenario {
        id: "slow-leader",
        title: "One slow validator",
        fault: "Everything validator 2 sends arrives 450 ms late for 6 seconds.",
        expect: "Its proposals miss the timeout and its views are skipped. One slow machine costs a few gaps, not a stall.",
    },
    Scenario {
        id: "packet-loss",
        title: "5% packet loss",
        fault: "One message in twenty, between any two nodes, is dropped for 6 seconds.",
        expect: "Votes are sent again while a view is stuck, so the net keeps finalizing. Some views take longer.",
    },
    Scenario {
        id: "london-cut",
        title: "London cut off",
        fault: "The two London validators can talk to each other but to no one else for 6 seconds.",
        expect: "8 of 10 is still above the 6 needed, so the net keeps going. London's views are skipped.",
    },
    Scenario {
        id: "ocean-cut",
        title: "Asia is cut off",
        fault: "The four validators in Tokyo and Singapore are cut off from Europe and America for 6 seconds.",
        expect: "The six in Europe and America are 60%, exactly the 6 votes a certificate needs, so they keep finalizing and Asia's views are skipped. The four in Asia can never reach 6, so the net cannot fork. When the link returns, Asia catches up on its own.",
    },
];

const SETTLE_S: u64 = 4;
const FAULT_S: u64 = 6;
const RECOVER_S: u64 = 5;

pub struct Lab {
    params: Params,
    /// The live net's state, where run starts and results show up as activity.
    main: crate::state::SharedState,
    runs: Mutex<HashMap<String, Value>>,
    busy: AtomicBool,
    counter: AtomicU64,
}

impl Lab {
    pub fn new(params: Params, main: crate::state::SharedState) -> Arc<Lab> {
        Arc::new(Lab { params, main, runs: Mutex::new(HashMap::new()), busy: AtomicBool::new(false), counter: AtomicU64::new(0) })
    }

    pub fn scenarios_json(&self) -> Value {
        let list: Vec<Value> = SCENARIOS
            .iter()
            .map(|s| json!({ "id": s.id, "title": s.title, "fault": s.fault, "expect": s.expect }))
            .collect();
        let mut recent: Vec<Value> = self.runs.lock().values().cloned().collect();
        recent.sort_by_key(|r| std::cmp::Reverse(r["startedAtUs"].as_u64().unwrap_or(0)));
        recent.truncate(12);
        for r in &mut recent {
            if let Some(o) = r.as_object_mut() {
                o.remove("timeline");
            }
        }
        json!({
            "scenarios": list,
            "busy": self.busy.load(Ordering::Relaxed),
            "durations": { "settleSeconds": SETTLE_S, "faultSeconds": FAULT_S, "recoverSeconds": RECOVER_S },
            "recent": recent,
        })
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.runs.lock().get(id).cloned()
    }

    pub fn start(self: &Arc<Self>, scenario: &str) -> Result<String, String> {
        let sc = SCENARIOS.iter().find(|s| s.id == scenario).ok_or("Unknown scenario")?;
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("Another run is in progress. Runs take about 15 seconds.".into());
        }
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("run-{}-{n}", now_us() / 1000);
        self.runs.lock().insert(id.clone(), json!({ "id": id, "scenario": sc.id, "title": sc.title, "status": "starting", "startedAtUs": now_us() }));
        // Keep the 50 most recent runs.
        {
            let mut runs = self.runs.lock();
            if runs.len() > 50 {
                let mut ids: Vec<(u64, String)> = runs.iter().map(|(k, v)| (v["startedAtUs"].as_u64().unwrap_or(0), k.clone())).collect();
                ids.sort();
                for (_, k) in ids.into_iter().take(runs.len() - 50) {
                    runs.remove(&k);
                }
            }
        }
        self.main.write().activity("lab", json!({ "runId": id, "title": sc.title, "status": "started" }));
        let lab = self.clone();
        let rid = id.clone();
        tokio::spawn(async move {
            lab.run(rid, sc).await;
            lab.busy.store(false, Ordering::SeqCst);
        });
        Ok(id)
    }

    fn faults_for(sc: &Scenario) -> Faults {
        let mut f = Faults::default();
        match sc.id {
            "three-down" => {
                f.down.extend([1, 4, 7]);
            }
            "slow-leader" => {
                f.slow.insert(2, 450.0);
            }
            "packet-loss" => f.loss = 0.05,
            "london-cut" => {
                f.cut.insert(City::LON);
            }
            "ocean-cut" => {
                f.cut.insert(City::TYO);
                f.cut.insert(City::SIN);
            }
            _ => {}
        }
        f
    }

    async fn run(&self, id: String, sc: &'static Scenario) {
        let cfg = NetConfig {
            name: format!("lab:{}", sc.id),
            params: Params { seed: 0, ..self.params.clone() },
            seed: format!("lab-{id}").into_bytes(),
            traffic: 20.0,
            observer_city: City::FRA,
        };
        let net = Net::start(cfg);
        let t0 = now_us() + 800_000;
        let mut timeline = Vec::new();
        let total = SETTLE_S + FAULT_S + RECOVER_S;
        let fault_from = t0 + SETTLE_S * 1_000_000;
        let fault_to = fault_from + FAULT_S * 1_000_000;
        let mut fault_on = false;
        let mut last_merged = 0u64;
        let mut last_skipped = 0u64;
        tokio::time::sleep(Duration::from_millis(800)).await;
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let now = now_us();
            if !fault_on && now >= fault_from && now < fault_to {
                *net.shared.bus.faults.write() = Self::faults_for(sc);
                fault_on = true;
                self.update(&id, json!({ "status": "fault" }));
            }
            if fault_on && now >= fault_to {
                *net.shared.bus.faults.write() = Faults::default();
                fault_on = false;
                self.update(&id, json!({ "status": "recovering" }));
            }
            let (merged, skipped) = {
                let st = net.state.read();
                (st.stats.merged, st.stats.skipped_views)
            };
            timeline.push(json!({
                "t": (now.saturating_sub(t0)) as f64 / 1e6,
                "merged": merged - last_merged,
                "skipped": skipped - last_skipped,
                "fault": fault_on,
            }));
            last_merged = merged;
            last_skipped = skipped;
            if timeline.len() % 4 == 0 {
                self.update(&id, json!({ "timeline": timeline, "status": if fault_on { "fault" } else if now < fault_from { "settling" } else { "recovering" } }));
            }
            if now >= t0 + total * 1_000_000 {
                break;
            }
        }
        // Let the executor catch up before reading the blocks.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let report = {
            let st = net.state.read();
            let phase = |from: u64, to: u64| -> Value {
                let blocks: Vec<&crate::state::BlockRecord> = st.blocks.iter().filter(|b| b.proposed_at_us >= from && b.proposed_at_us < to).collect();
                // Spacing between proposals in time order; leaders' clocks are not always in log order.
                let mut times: Vec<u64> = blocks.iter().map(|b| b.proposed_at_us).collect();
                times.sort();
                let mut gaps: Vec<f64> = times.windows(2).map(|w| (w[1] - w[0]) as f64 / 1000.0).collect();
                gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let mut fin: Vec<f64> = blocks.iter().map(|b| (b.merged_at_us.saturating_sub(b.proposed_at_us)) as f64 / 1000.0).collect();
                fin.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let pct = |v: &Vec<f64>, p: f64| if v.is_empty() { Value::Null } else { json!(v[((v.len() - 1) as f64 * p).round() as usize]) };
                let secs = (to - from) as f64 / 1e6;
                json!({
                    "blocks": blocks.len(),
                    "blocksPerSecond": blocks.len() as f64 / secs,
                    "gapP50": pct(&gaps, 0.5), "gapMax": gaps.last(),
                    "finalityP50": pct(&fin, 0.5), "finalityMax": fin.last(),
                    "transactions": blocks.iter().map(|b| b.tx_count).sum::<usize>(),
                })
            };
            let before = phase(t0, fault_from);
            let during = phase(fault_from, fault_to);
            let after = phase(fault_to, t0 + total * 1_000_000);
            let skipped_by: Vec<Value> = st.instances.iter().map(|i| json!({ "instance": i.instance, "skipped": i.skipped })).collect();
            let skipped = st.stats.skipped_views;
            let during_blocks = during["blocks"].as_u64().unwrap_or(0);
            let mut evidence = vec![
                format!("{} blocks entered the merged log while the fault was on, against {} in the {} seconds before it.", during_blocks, before["blocks"], SETTLE_S),
                format!("{} views were skipped in total across {} instances.", skipped, st.k),
            ];
            if let (Some(a), Some(b)) = (before["gapP50"].as_f64(), during["gapP50"].as_f64()) {
                evidence.push(format!("Median time between merged blocks: {:.1} ms before, {:.1} ms during.", a, b));
            }
            if let Some(m) = during["finalityMax"].as_f64() {
                evidence.push(format!("Slowest block to finalize during the fault took {:.0} ms.", m));
            }
            if let Some(a) = after["blocks"].as_u64() {
                evidence.push(format!("{} blocks landed in the {} seconds after the fault was switched off.", a, RECOVER_S));
            }
            let verdict = if during_blocks > 0 {
                "Kept finalizing"
            } else if after["blocks"].as_u64().unwrap_or(0) > 0 {
                "Stopped while split, resumed on its own"
            } else {
                "Stopped"
            };
            json!({
                "status": "done",
                "phases": { "before": before, "during": during, "after": after },
                "skippedByInstance": skipped_by,
                "evidence": evidence,
                "verdict": verdict,
                "logHash": st.tip().map(|b| b.log_hash.clone()),
                "slot": st.slot(),
                "timeline": timeline,
                "finishedAtUs": now_us(),
            })
        };
        net.stop();
        let verdict = report["verdict"].as_str().unwrap_or("").to_string();
        self.update(&id, report);
        self.main.write().activity("lab", json!({ "runId": id, "title": sc.title, "status": "done", "verdict": verdict }));
    }

    fn update(&self, id: &str, patch: Value) {
        let mut runs = self.runs.lock();
        if let Some(r) = runs.get_mut(id) {
            if let (Some(o), Some(p)) = (r.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    o.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

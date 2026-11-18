mod bus;
mod consensus;
mod exec;
mod geo;
mod lab;
mod merge;
mod net;
mod rpc;
mod seal;
mod state;
mod types;

use clap::{Parser, Subcommand};
use consensus::Params;
use std::net::SocketAddr;

#[derive(Parser)]
#[command(name = "salvo", version, about = "Gatling parallel consensus with Solana execution")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the net: validators, the gateway, the Fault Lab.
    Up {
        #[arg(long, default_value = "127.0.0.1")]
        bind: String,
        #[arg(long, default_value_t = 8899)]
        port: u16,
        /// Validators.
        #[arg(long, default_value_t = 10)]
        n: usize,
        /// Parallel consensus instances.
        #[arg(long, default_value_t = 24)]
        k: usize,
        /// Time between two views of one instance, ms.
        #[arg(long, default_value_t = 240)]
        delta_ms: u64,
        #[arg(long, default_value_t = 400)]
        timeout_ms: u64,
        /// Background transfers per second.
        #[arg(long, default_value_t = 25.0)]
        traffic: f64,
        #[arg(long, default_value = "salvo-net")]
        seed: String,
        #[arg(long, default_value = "Salvo Net")]
        name: String,
        /// Read the client address from X-Forwarded-For (behind a reverse proxy).
        #[arg(long)]
        trust_proxy: bool,
        /// Instances in Fault Lab runs.
        #[arg(long, default_value_t = 12)]
        lab_k: usize,
        /// Validators in Fault Lab runs (the scenarios are written for 10).
        #[arg(long, default_value_t = 10)]
        lab_n: usize,
    },
}

#[cfg(windows)]
fn fine_timers() {
    // Windows sleeps in 15.6 ms steps by default; ask for 1 ms for this process.
    unsafe {
        windows_sys::Win32::Media::timeBeginPeriod(1);
    }
}

#[cfg(not(windows))]
fn fine_timers() {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    fine_timers();
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Up { bind, port, n, k, delta_ms, timeout_ms, traffic, seed, name, trust_proxy, lab_k, lab_n } => {
            anyhow::ensure!((4..=64).contains(&n), "n must be between 4 and 64");
            anyhow::ensure!(k >= 1 && k <= 64, "k must be between 1 and 64");
            let params = Params { n, k, delta_ms, timeout_ms, max_block_txs: 512, seed: 0 };
            let net = net::Net::start(net::NetConfig {
                name,
                params: params.clone(),
                seed: seed.into_bytes(),
                traffic,
                observer_city: geo::City::FRA,
            });
            let lab = lab::Lab::new(Params { k: lab_k, n: lab_n, ..params.clone() });
            let gw = rpc::Gateway::new(net.clone(), lab, trust_proxy);
            let addr: SocketAddr = format!("{bind}:{port}").parse()?;
            let ps_addr: SocketAddr = format!("{bind}:{}", port + 1).parse()?;
            tracing::info!(
                "net up: {n} validators, {k} instances, view every {delta_ms} ms per instance, a proposal every {:.1} ms",
                params.gap_ms()
            );
            tracing::info!("rpc http://{addr}  pubsub ws://{ps_addr}  events ws://{addr}/events");
            let l1 = tokio::net::TcpListener::bind(addr).await?;
            let l2 = tokio::net::TcpListener::bind(ps_addr).await?;
            let r1 = rpc::router(gw.clone()).into_make_service_with_connect_info::<SocketAddr>();
            let r2 = rpc::pubsub_router(gw.clone()).into_make_service_with_connect_info::<SocketAddr>();
            let reporter = {
                let net = net.clone();
                tokio::spawn(async move {
                    let mut iv = tokio::time::interval(std::time::Duration::from_secs(5));
                    loop {
                        iv.tick().await;
                        let s = net.state.read().stats_json();
                        tracing::info!(
                            "slot {} | {:.1} blocks/s | gap p50 {} ms | block finality p50 {} ms | tx finality p50 {} ms | skipped {} | txs {}",
                            s["slot"], s["blocksPerSecond"].as_f64().unwrap_or(0.0), s["gapMs"]["p50"], s["blockFinalityMs"]["p50"], s["txFinalityMs"]["p50"], s["skippedViews"], s["transactions"]
                        );
                    }
                })
            };
            tokio::select! {
                r = axum::serve(l1, r1) => r?,
                r = axum::serve(l2, r2) => r?,
                _ = tokio::signal::ctrl_c() => {}
            }
            reporter.abort();
        }
    }
    Ok(())
}

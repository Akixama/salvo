# The node: one binary that runs the net, the gateway and the Fault Lab.
# Build context is the repository root (Railway, and deploy/compose.yml, both use it).
FROM rust:1-bookworm AS build
WORKDIR /src
COPY node/ ./
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/salvo /usr/local/bin/salvo
EXPOSE 8899
# Settings come from the environment, so a host's variables can change them without a rebuild:
#   PORT (set by Railway), SALVO_SEED (keep it secret: the faucet key comes from it),
#   SALVO_N validators, SALVO_TRAFFIC background transfers a second.
ENV SALVO_BIND=0.0.0.0
CMD ["sh", "-c", "exec salvo up --trust-proxy --n ${SALVO_N:-7} --traffic ${SALVO_TRAFFIC:-10} --lab-k 8 --seed \"${SALVO_SEED:?set SALVO_SEED to a long random secret}\""]

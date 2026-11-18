# The node: one binary that runs the net, the gateway and the Fault Lab.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY node/ ./
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/salvo /usr/local/bin/salvo
EXPOSE 8899 8900
ENTRYPOINT ["salvo", "up", "--bind", "0.0.0.0", "--trust-proxy"]

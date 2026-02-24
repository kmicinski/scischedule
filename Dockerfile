FROM rust:slim-bookworm AS builder

WORKDIR /build

# Copy everything and build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY static ./static
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 app && useradd -u 1000 -g app -s /bin/bash -m app

WORKDIR /app
COPY --from=builder /build/target/release/scischedule /app/scischedule
COPY static ./static

RUN chown -R app:app /app
USER app

EXPOSE 3000
CMD ["/app/scischedule"]

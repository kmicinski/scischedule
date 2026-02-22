# SciSchedule

SciSchedule is a protocol-aware scientific scheduler built with Rust, Axum, and Sled.

## Features

- Protocol designer with DAG step dependencies (`parent_step_index` + day offsets)
- Month view (default) with protocol drag-and-drop scheduling
- Week view with per-day priority reordering and drag-to-next/previous day
- Draft-to-live locking flow for experiments
- Deviation highlighting when tasks shift from planned protocol dates
- Local persistence via Sled

## Architecture

- `src/domain`: core business logic and scheduling engine
- `src/repo`: repository abstraction and Sled implementation
- `src/service`: application service orchestration
- `src/web`: Axum HTTP routes and API surface
- `static/`: responsive frontend (HTML/CSS/JS)
- `tests/`: API-level integration tests

## Run

```bash
cargo run
```

Open `http://127.0.0.1:3000`.

## Test / Quality

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
```

## API Summary

- `GET /api/protocols`
- `POST /api/protocols`
- `GET /api/protocols/:id`
- `GET /api/experiments`
- `POST /api/experiments`
- `POST /api/experiments/:id/lock`
- `PATCH /api/experiments/:id/tasks/move`
- `PATCH /api/experiments/:id/tasks/reorder`
- `GET /api/views/month?year=YYYY&month=MM`
- `GET /api/views/week?year=YYYY&month=MM&day=DD`
# scischedule

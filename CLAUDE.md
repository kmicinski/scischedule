# SciSchedule

Scientific experiment scheduling app. Rust/Axum backend, vanilla JS frontend, Sled embedded DB.

**Rule: Always keep this documentation in sync with the code. When adding or changing features, API endpoints, domain models, or UI views, update the relevant sections here.**

## Quick Reference

```bash
cargo check                              # Type-check
cargo test                               # Run all tests
cargo build --release                    # Production build
docker compose up -d --build scischedule # Rebuild + deploy (run from /srv)
docker compose logs -f scischedule       # Tail logs
```

## Project Structure

```
src/
├── main.rs              # Entry point: Sled init, AppService, Axum server on :3000
├── lib.rs               # Module re-exports
├── domain/
│   ├── mod.rs           # Re-exports models + scheduler
│   ├── models.rs        # All data types and request/response structs
│   └── scheduler.rs     # Core scheduling logic (DAG solver, constraint checker, view builders)
├── repo/
│   └── mod.rs           # Repository trait + SledRepo (key-value persistence)
├── service/
│   └── mod.rs           # AppService: business logic, auth checks, validation
└── web/
    └── mod.rs           # Axum routes, handlers, AuthUser extractor, ApiError

static/
├── index.html           # SPA shell
├── app.js               # All frontend logic (~3600 lines)
└── styles.css           # All styling

tests/
└── api_tests.rs         # Integration tests
```

## Domain Model

### Core Entities

- **Protocol** — Reusable experiment template. Contains ordered steps (DAG) with dependency offsets.
- **ProtocolStep** — Single step in a protocol. Has `parent_step_ids` (dependencies) and `default_offset_days`.
- **Experiment** — Concrete instance of a protocol with a start date. Status: Draft → Live → Complete.
- **ScheduledTask** — A task within an experiment, bound to a date. Tracks `planned_date` vs actual `date` and `deviation`.
- **StandaloneTask** — Manual to-do item, independent of protocols. Has optional date, color tag, notes.
- **Deviation** — Records when a task moved off its planned date (reason + shift amount).

### Key Relationships

```
Protocol (template)  ──1:N──▸ Experiment (instance)
  └── ProtocolStep   ──1:1──▸ ScheduledTask (in each experiment)
ProtocolStep.parent_step_ids ──▸ DAG dependency graph
```

### Experiment Field: `protocol_name`

The `Experiment` struct has a `protocol_name` field. This is the **user-facing experiment name** shown in the sidebar and on task cards. It is initialized from the protocol name when the experiment is created, but can be independently renamed by the user via `PATCH /api/experiments/:id/rename`.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/me` | Current user identity |
| GET/POST | `/api/protocols` | List / create protocols |
| GET/PATCH/DELETE | `/api/protocols/:id` | Get / update / delete protocol |
| PATCH | `/api/protocols/:id/steps/:step_id/rename` | Rename a protocol step |
| GET/POST | `/api/experiments` | List / plan (create) experiments |
| DELETE | `/api/experiments/:id` | Delete experiment |
| POST | `/api/experiments/:id/lock` | Lock experiment (Draft→Live) |
| PATCH | `/api/experiments/:id/rename` | Rename experiment |
| PATCH | `/api/experiments/:id/tasks/move` | Move task to new date (cascades) |
| PATCH | `/api/experiments/:id/tasks/reorder` | Reorder task priority within day |
| PATCH | `/api/experiments/:id/tasks/:task_id/complete` | Toggle task completion |
| PATCH | `/api/experiments/:id/tasks/:task_id/rename` | Rename individual task |
| DELETE | `/api/experiments/:id/tasks/:task_id` | Delete individual task |
| GET/POST | `/api/tasks` | List / create standalone tasks |
| PATCH/DELETE | `/api/tasks/:id` | Update / delete standalone task |
| GET | `/api/views/month?year=Y&month=M` | Month calendar view |
| GET | `/api/views/week?year=Y&month=M&day=D` | Week calendar view |

Auth: All endpoints require `Remote-User` header (set by Authelia). User-scoped data enforced in service layer.

## Frontend Architecture

Single-page vanilla JS app. Global `state` object. Three calendar views:

- **Month view** — Grid calendar, drag-and-drop task moves and protocol placement
- **Week view** — 7 columns (Mon-Sun), task cards with reorder/notes/delete/rename
- **Day view** — Single day expanded view

### Sidebar

- **Protocols list** — Create/edit/delete protocols; drag onto calendar to create experiment
- **Experiments list** — Grouped by protocol, shows experiment name + start date, color dots, visibility toggles
- **Settings** — Deviation marker toggle

### Task Card (week/day view)

Shows: protocol day number, step name (editable), experiment name badge. If task has deviation and deviations are visible, shows deviation reason instead.

### Key State

- `state.taskContext` — Map from taskId → { experimentId, protocolId, protocolName, task, parentDate, nextDates, protocolDay }
- `state.hiddenExperimentIds` / `state.hiddenProtocolIds` — visibility toggles (localStorage)
- `state.showDeviations` — toggle deviation markers (localStorage)

## Scheduling Logic (scheduler.rs)

- **Topological sort** via Kahn's algorithm for step ordering
- **Constraint model**: child.date ≥ parent.date (always enforced)
- **Cascading moves**: moving a task shifts all downstream descendants by the same delta
- **Deviation tracking**: auto-records reason and shift when task moves off planned date; clears if returned to planned date

## Conventions

- **Sled DB**: Keys are `protocol:{uuid}`, `experiment:{uuid}`, `standalone_task:{uuid}`. Values are JSON.
- **Auth**: `created_by` field on all entities. Service layer checks ownership on all mutations.
- **Validation**: `validate_name()` helper enforces non-empty, max 500 chars. Protocol must have ≥1 step.
- **Protocol versioning**: Editing protocol steps when experiments exist archives old protocol, creates new one.
- **Error handling**: `ServiceError` → `ApiError` with appropriate HTTP status codes.
- **No external JS deps**: Pure vanilla JS, no build step.
- **CSS**: Single `styles.css`, no preprocessor.
- **Docker**: Multi-stage build (rust:slim-bookworm → debian:bookworm-slim), non-root user, port 3000.

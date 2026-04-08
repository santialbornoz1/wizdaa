# Time-Off Microservice

Time-off management microservice for **ExampleHR**, with resilient synchronization against an HCM (Human Capital Management) system as the source of truth.

## Prerequisites

- **Docker Desktop** installed and running
- Ports **3000**, **4000** and **6379** available

## Quick Start

```bash
git clone https://github.com/santialbornoz1/wizdaa.git
cd wizdaa
docker-compose up --build
```

That's it. A single command spins up:

| Service | URL | Description |
|----------|-----|-------------|
| ExampleHR | http://localhost:3000 | Employee + manager UI |
| HCM Mock | http://localhost:4000 | Source of Truth + simulator |
| Health Check | http://localhost:3000/api/v1/health | Service + DB status |
| Bull Board | http://localhost:3000/admin/queues | BullMQ queue monitoring |
| Redis | localhost:6379 | BullMQ backend (internal) |

**Stop**: `Ctrl+C` in the terminal.

## Development (hot-reload)

The `docker-compose.yml` mounts `src/` and `public/` as volumes. Changes to TypeScript code automatically restart NestJS (watch mode). Changes to HTML/JS only require F5 in the browser.

```bash
# First time or if you changed package.json:
docker-compose up --build

# Subsequent times (no rebuild):
docker-compose up
```

### Without Docker

```bash
# Requirements: Node 22+, Redis running on localhost:6379
npm install
npm run start:dev
```

## Environment Variables

All variables are **optional** with sensible defaults for local development:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Runtime environment |
| `REDIS_HOST` | `localhost` | Redis host for BullMQ |
| `REDIS_PORT` | `6379` | Redis port |
| `DB_PATH` | `./timeoff.db` | SQLite file path |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM base URL |

> Without Docker, you don't need a `.env` file — defaults point to localhost. With Docker, `docker-compose.yml` already sets `REDIS_HOST=redis`.

## Database

| | Docker | Without Docker |
|---|---|---|
| **Type** | SQLite (WAL mode) | SQLite (WAL mode) |
| **Location** | `./data/timeoff.db` (mounted from host) | `./timeoff.db` (project root) |
| **ORM** | TypeORM (auto-sync) | TypeORM (auto-sync) |

### Tables

- **`balances`** — Balance per employee/location. Composite unique key `(employeeId, locationId)`.
- **`timeoff_requests`** — Time-off requests with their full lifecycle.
- **`sync_history`** — Audit log of each synchronization operation with HCM.

### Persistence

- The DB **persists across container restarts** because it is mounted on the host's `./data/` directory.
- To **reset the DB**: stop the container and delete `./data/timeoff.db`. On the next startup it will be recreated with seed data.
- To **inspect with DBeaver**: connect to SQLite using path `./data/timeoff.db` (or absolute path).

### Seed Data

On startup, the following employees are automatically created in both the HCM Mock (in-memory) and ExampleHR (SQLite):

| Employee | Location | Days |
|----------|----------|------|
| maria.garcia | buenos-aires | 20 |
| james.smith | buenos-aires | 15 |
| laura.chen | new-york | 10 |
| carlos.lopez | london | 25 |

> **Note**: The HCM Mock stores data in memory. It resets on every container restart. The ExampleHR DB (SQLite) persists on disk.

## Architecture

```
Port 3000 (ExampleHR)                 Port 4000 (HCM Mock)
├── Employee Dashboard                ├── Balance viewer (Source of Truth)
│   ├── View balance (real-time)      ├── Anniversary Bonus simulator
│   ├── Request days off              └── Batch Sync trigger
│   ├── Cancel request
│   └── Activity timeline
├── Manager Dashboard
│   ├── Approve requests
│   └── Reject requests (with reason)
├── WebSocket (Socket.IO)
│   └── Real-time push for balances and requests
└── Bull Board (/admin/queues)
    └── Queue and DLQ monitoring
```

### Request Flow

```
Employee creates request
       │
       ▼
  PENDING_SYNC ──── BullMQ Worker syncs with HCM
       │                    │
       │              HCM confirms
       │                    │
       ▼                    ▼
  (if HCM fails)    WAITING_MANAGER_APPROVAL
  retry with              │           │
  exp. backoff     Manager approves  Manager rejects
       │                │           │
       └───►       APPROVED    REJECTED + HCM rollback
                        │
                  Daily cron
                        │
                        ▼
                   COMPLETED
```

### Design Patterns

- **Transactional Outbox**: Request insert + balance deduction in an atomic SQLite transaction
- **Stale-while-revalidate**: Instant read from SQLite + async revalidation against HCM in background
- **Self-Healing**: Automatic detection of discrepancies between local balance and HCM (e.g., after a bonus)
- **Exponential Backoff**: Automatic retries with exponential backoff. DLQ after 10 failures
- **Streaming Parser**: Batch sync processed with stream-json to avoid OOM on large payloads
- **WebSocket (Socket.IO)**: Real-time push of balance changes and request status updates. No polling

## API Endpoints

### Employee (3000)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/balances?employeeId=&locationId=` | Query balance |
| POST | `/api/v1/requests` | Create request |
| GET | `/api/v1/activity?employeeId=&locationId=` | Activity timeline |
| GET | `/api/v1/requests/me?employeeId=` | My requests |
| PATCH | `/api/v1/requests/:id/cancel` | Cancel request |

### Manager (3000)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/requests/pending` | Requests pending approval |
| PATCH | `/api/v1/admin/requests/:id/approve` | Approve request |
| PATCH | `/api/v1/admin/requests/:id/reject` | Reject request (with reason) |

### Sync (3000)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/sync/batch` | Bulk ingestion from HCM (streaming) |

### Health (3000)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Health check (DB connectivity) |

### HCM Mock (4000)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/hcm/api/v1/balances/:empId/:locId` | Query balance in Source of Truth |
| POST | `/hcm/api/v1/time-off` | Reserve days |
| POST | `/hcm/api/v1/time-off/rollback` | Rollback reservation |
| GET | `/hcm/api/v1/balances/all` | All balances |
| POST | `/hcm/api/v1/balances/:empId/:locId/bonus` | Simulate anniversary bonus |
| POST | `/hcm/admin/downtime` | Enable/disable downtime simulation |
| POST | `/hcm/admin/latency` | Simulate network latency (`{ ms: number }`) |
| GET | `/hcm/admin/status` | HCM status + balances + transactions |

### WebSocket Events (Socket.IO, port 3000)
| Event | Direction | Description |
|-------|-----------|-------------|
| `balance:updated` | Server → Client | Balance modified (sync, bonus, deduction) |
| `request:updated` | Server → Client | Request status changed |

## Testing

```bash
npm test              # Run 121 tests (unit + controller + e2e + websocket)
npm run test:cov      # Tests + coverage report
npm run test:e2e      # E2E and WebSocket tests only
```

### Git Hooks (Husky)

The project uses **Husky** with a `pre-push` hook that runs the full test suite before each `git push`. If any test fails, the push is blocked. It is automatically installed with `npm install` (via the `prepare` script).

### Test Cases

| # | Case | What it validates |
|---|------|------------|
| 1 | Transactional Outbox | Atomic insert + deduction. If it fails, no inconsistent state is left |
| 2 | Race Conditions | Two concurrent requests do not exceed the balance |
| 3 | HCM Downtime (504) | Automatic retry via BullMQ with exponential backoff |
| 4 | HCM Rejection (400) | No retry on permanent errors + balance restore |
| 5 | HCM Rejection (409) | Insufficient balance in HCM + local restore |
| 6 | Self-Healing | Detects HCM vs local discrepancy and corrects it |
| 7 | Stale-while-revalidate | Immediate response + background sync |
| 8 | Manager approve | Full flow WAITING → APPROVED |
| 9 | Manager reject | Reject + HCM rollback + balance restore |
| 10 | Cancellation | CANCELLATION_PENDING → HCM confirm → CANCELLED |
| 11 | Batch Sync | Upsert preserving pending request deductions |
| 12 | Auto-Complete | Cron marks expired APPROVED requests as COMPLETED |
| 13 | Idempotency Key | Duplicate requests with same key return original without double-deducting |

## Tech Stack

- **NestJS 10** + TypeScript 5
- **SQLite** (WAL mode) via TypeORM
- **BullMQ** + Redis for queues, workers and DLQ
- **Socket.IO** for real-time WebSocket
- **Bull Board** for visual queue monitoring
- **stream-json** for streaming parser
- **Flatpickr** for date range picker
- **Tailwind CSS** (CDN) for UI
- **@nestjs/terminus** for health checks
- **Husky** for git hooks (pre-push test gate)

## Project Structure

```
src/
├── main.ts                              # Dual port (3000 + 4000) + Bull Board
├── app.module.ts                        # ExampleHR module
├── hcm-app.module.ts                    # HCM Mock module (standalone)
├── common/
│   ├── enums/                           # RequestStatus enum
│   └── events/                          # WebSocket gateway (Socket.IO)
└── modules/
    ├── balances/                        # Balance CRUD + self-healing
    ├── timeoff/                         # Requests + Transactional Outbox
    ├── sync/                            # BullMQ processor + streaming + cron
    ├── health/                          # Health check endpoint (@nestjs/terminus)
    └── hcm-mock/                        # HCM API mock (Source of Truth)
public/
├── index.html                           # ExampleHR UI (employee + manager)
└── hcm/index.html                       # HCM Mock UI
test/
├── timeoff.service.spec.ts              # 24 tests (unit)
├── sync.processor.spec.ts               # 12 tests (unit)
├── balances.service.spec.ts             # 16 tests (unit)
├── hcm-mock.service.spec.ts             # 20 tests (unit)
├── auto-complete.service.spec.ts        # 3 tests (unit)
├── events.gateway.spec.ts              # 2 tests (unit)
├── controllers/
│   ├── timeoff.controller.spec.ts       # 9 tests (controller)
│   ├── balances.controller.spec.ts      # 4 tests (controller)
│   ├── hcm-mock.controller.spec.ts      # 8 tests (controller)
│   └── health.controller.spec.ts        # 1 test (controller)
└── e2e/
    ├── app.e2e-spec.ts                  # 19 tests (E2E HTTP)
    └── websocket.e2e-spec.ts            # 3 tests (WebSocket)
```

## Troubleshooting

| Problem | Solution |
|----------|----------|
| Port 3000/4000 in use | `lsof -ti:3000,4000 \| xargs kill -9` and restart |
| Docker won't start | Verify that Docker Desktop is running |
| Corrupt DB | Delete `./data/timeoff.db` and restart |
| New deps not installed | `docker-compose build --no-cache && docker-compose up` |
| HCM Mock not responding | Check that downtime is not enabled on :4000 |

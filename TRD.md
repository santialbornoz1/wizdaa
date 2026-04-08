# Technical Requirement Document (TRD): Time-Off Microservice

## 1. Executive Summary

Time-off management microservice for **ExampleHR**, acting as the main interface for employees while keeping the **HCM** (Human Capital Management) system as the Source of Truth. The system prioritizes balance integrity, resilience against external failures, and scalability through an event-driven architecture with eventual consistency.

---

## 2. System Architecture

### 2.1 Overview

```
  [Frontend SPA]                        [HCM Mock UI]
       |                                      |
       | REST + WebSocket (Socket.IO)         | REST
       |                                      |
  [Port 3000 - ExampleHR]             [Port 4000 - HCM Mock]
       |                                      |
       +-- TimeOffModule                      +-- HcmMockModule
       |   (requests lifecycle)               |   (in-memory source of truth)
       +-- BalancesModule                     +-- HcmAdminController
       |   (CRUD + self-healing)                  (downtime/latency sim)
       +-- SyncModule
       |   (BullMQ workers + cron + streaming)
       +-- EventsModule
           (WebSocket gateway)
               |
               | BullMQ jobs
               |
          [Redis 7]
```

**Architecture type:** Event-driven modular monolith with eventual consistency. A single Node.js process exposes two HTTP ports to simulate the separation between ExampleHR (our app) and the HCM (external system like Workday/SAP).

### 2.2 Layers

| Layer | Responsibility | Example |
|-------|----------------|---------|
| **Controllers** | Receive HTTP, validate input, delegate to services | `TimeOffController`, `BalancesController` |
| **Services** | Pure business logic. Transactions, validations, events | `TimeOffService`, `BalancesService` |
| **Processors/Workers** | Integration logic. Retries, rollbacks, sync with HCM | `SyncProcessor` |
| **Entities** | DB schema (TypeORM) | `Balance`, `TimeOffRequest`, `SyncHistory` |
| **Gateway** | WebSocket broadcast | `EventsGateway` |

### 2.3 Dual-Port System

| Port | App | Description |
|------|-----|-------------|
| 3000 | ExampleHR | Employee/manager UI + REST API + WebSocket + Bull Board |
| 4000 | HCM Mock | Source of Truth simulator (Workday/SAP) |

The HCM Mock is a completely decoupled module (`HcmAppModule`) that shares no services or logic with ExampleHR. Communication between the two is exclusively via HTTP (as it would be in production with a real HCM).

---

## 3. Database Schema

### 3.1 `balances` Table

One balance per employee per location. Composite unique key `(employeeId, locationId)`.

| Column | Type | Constraint | Description |
|--------|------|-----------|-------------|
| `id` | UUID | PK, auto-generated | Unique identifier |
| `employeeId` | VARCHAR | NOT NULL, UNIQUE(employeeId, locationId) | Employee ID |
| `locationId` | VARCHAR | NOT NULL, UNIQUE(employeeId, locationId) | Location ID |
| `totalDays` | REAL | NOT NULL | Total assigned days |
| `usedDays` | REAL | NOT NULL | Used days |
| `availableDays` | REAL | NOT NULL | Available days (denormalized: totalDays - usedDays) |
| `lastSyncedAt` | VARCHAR | NULLABLE | Timestamp of the last sync with HCM |
| `createdAt` | DATETIME | auto | Creation date |
| `updatedAt` | DATETIME | auto | Last update date |

> **Note on denormalization:** `availableDays` is redundant (`totalDays - usedDays`) but is kept for read performance. It is always updated in the same transaction as `usedDays` to maintain consistency.

### 3.2 `timeoff_requests` Table

One row per time-off request. Full lifecycle from creation to completed/cancelled.

| Column | Type | Constraint | Description |
|--------|------|-----------|-------------|
| `id` | UUID | PK, auto-generated | Unique identifier |
| `employeeId` | VARCHAR | NOT NULL | Employee ID |
| `locationId` | VARCHAR | NOT NULL | Location ID |
| `startDate` | VARCHAR | NOT NULL | Start date (ISO 8601) |
| `endDate` | VARCHAR | NOT NULL | End date (ISO 8601) |
| `daysRequested` | REAL | NOT NULL | Business days requested |
| `type` | VARCHAR | default: 'VACATION' | Type: VACATION, SICK, PERSONAL |
| `status` | VARCHAR | NOT NULL | Current status (see section 4) |
| `hcmTransactionId` | VARCHAR | NULLABLE | HCM Transaction ID (null if not synced) |
| `rejectionReason` | VARCHAR | NULLABLE | Rejection reason |
| `createdAt` | DATETIME | auto | Creation date |
| `updatedAt` | DATETIME | auto | Last update date |

### 3.3 `sync_history` Table

Audit trail of every sync operation with HCM. Full traceability.

| Column | Type | Constraint | Description |
|--------|------|-----------|-------------|
| `id` | UUID | PK, auto-generated | Unique identifier |
| `type` | VARCHAR | NOT NULL | BATCH, INDIVIDUAL, ROLLBACK |
| `requestId` | VARCHAR | NULLABLE | Associated request ID (null for BATCH) |
| `employeeId` | VARCHAR | NULLABLE | Employee ID |
| `locationId` | VARCHAR | NULLABLE | Location ID |
| `status` | VARCHAR | NOT NULL | SUCCESS, FAILED, RETRYING |
| `errorMessage` | TEXT | NULLABLE | Error detail |
| `attemptNumber` | INTEGER | default: 0 | Retry attempt number |
| `createdAt` | DATETIME | auto | Creation date |

### 3.4 Database Configuration

- **Engine:** SQLite via `better-sqlite3`
- **ORM:** TypeORM 0.3.20 with `synchronize: true`
- **WAL Mode:** Enabled via `extra: { journal_mode: 'WAL' }` to support concurrent reads during worker writes

---

## 4. State Lifecycle (State Machine)

```
                    Employee creates
                         |
                         v
                   PENDING_SYNC
                    /          \
          HCM 400/409        HCM 200 OK
          (permanent)        (transient errors -> retry)
               |                  |
               v                  v
           REJECTED      WAITING_MANAGER_APPROVAL
                           /              \
                    Manager approves   Manager rejects
                         |                  |
                         v                  v
                     APPROVED          REJECTED
                    /        \        (+ restore local balance
              Employee     Cron          + rollback HCM)
              cancels     midnight
                |            |
                v            v
        CANCELLATION      COMPLETED
           PENDING        (immutable)
                |
          HCM confirms
                |
                v
           CANCELLED
        (+ restore balance)
```

| Status | Description | Possible Transitions |
|--------|-------------|----------------------|
| `PENDING_SYNC` | Saved locally, pending HCM confirmation | -> WAITING_MANAGER_APPROVAL, REJECTED, CANCELLATION_PENDING |
| `WAITING_MANAGER_APPROVAL` | HCM confirmed the reservation. Pending Manager approval | -> APPROVED, REJECTED, CANCELLATION_PENDING |
| `APPROVED` | Approved by the Manager. Request confirmed | -> COMPLETED, CANCELLATION_PENDING |
| `COMPLETED` | The date has passed. Immutable historical record | (terminal) |
| `REJECTED` | Rejected by HCM or by Manager. Balance restored | (terminal) |
| `CANCELLATION_PENDING` | Cancellation in the process of syncing with HCM | -> CANCELLED |
| `CANCELLED` | Cancellation confirmed by HCM. Days reintegrated | (terminal) |

---

## 5. Sync Scenarios and Business Flows

### Scenario A: Time-Off Request (Employee -> ExampleHR -> HCM)

**Pattern:** Transactional Outbox

1. Employee sends `POST /api/v1/requests`
2. An **atomic SQLite transaction** is opened:
   - Sanity validation: balance exists and is sufficient
   - Insert request as `PENDING_SYNC`
   - Deduct days from local balance
   - **Atomic COMMIT** - both operations or neither
3. **Post-commit:** a `sync-request` job is enqueued in BullMQ (10 attempts, exponential backoff)
4. A `request:updated` WebSocket event is emitted
5. The worker picks up the job and sends a `POST` to the HCM
   - **HCM 200:** Request transitions to `WAITING_MANAGER_APPROVAL`, `hcmTransactionId` is saved
   - **HCM 400/409 (permanent):** Request transitions to `REJECTED`, local balance is restored, no retry
   - **HCM 5xx/timeout (transient):** Retried with exponential backoff

### Scenario B: Manager Approval/Rejection

**Approval:**
1. Manager sends `PATCH /api/v1/admin/requests/:id/approve`
2. Validation: request must be in `WAITING_MANAGER_APPROVAL`
3. Status transitions to `APPROVED`
4. Emits `request:updated` via WebSocket

**Rejection:**
1. Manager sends `PATCH /api/v1/admin/requests/:id/reject` with `{ reason }`
2. **Atomic transaction:** update request to `REJECTED` + restore local balance
3. If the request was already confirmed by HCM, a `rollback-request` job is enqueued
4. The worker sends a `POST` to the HCM `/time-off/rollback` to release the reserved days

### Scenario C: Bulk Balance Ingestion (HCM -> ExampleHR)

**Pattern:** Streaming Parser

1. HCM sends `POST /api/v1/sync/batch` with a JSON array (potentially huge)
2. ExampleHR responds immediately with `202 Accepted`
3. `stream-json` + `StreamArray` is used to parse without loading everything into memory (OOM-safe)
4. For each record, a `batch-upsert` job is enqueued in BullMQ
5. **Smart upsert:** `availableDays = totalDays - usedDays - SUM(requests PENDING_SYNC)` to avoid overwriting pending deductions

### Scenario D: "Just-in-Time" Balance Query

**Pattern:** Stale-While-Revalidate + Self-Healing

1. Employee queries `GET /api/v1/balances`
2. The SQLite balance is returned **immediately** (instant response)
3. **In background** (fire-and-forget): the actual balance is fetched from the HCM
4. If there is a **discrepancy** (e.g., unnotified anniversary bonus):
   - SQLite is updated with the HCM values
   - A `balance:updated` event is emitted via WebSocket -> frontend updates without refresh
5. If the **HCM does not respond**: stale data is used without error

### Scenario E: Request Cancellation

1. Employee sends `PATCH /api/v1/requests/:id/cancel`
2. Validation: only cancellable if in PENDING_SYNC, WAITING_MANAGER_APPROVAL, or APPROVED
3. Status transitions to `CANCELLATION_PENDING`
4. A `cancel-request` job is enqueued in BullMQ
5. **Golden rule:** days are **NOT reintegrated** to the local balance until the HCM confirms
6. When HCM confirms: status transitions to `CANCELLED`, local balance is restored

### Scenario F: Cycle Close (Auto-Complete)

1. Daily cron at midnight (`@nestjs/schedule`)
2. Finds `APPROVED` requests with `endDate <= today`
3. Marks them as `COMPLETED` (immutable, does not allow cancellations)

---

## 6. API Contracts

### 6.1 Employee Endpoints (Port 3000)

#### GET `/api/v1/balances`

Balance query with asynchronous revalidation against HCM.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `employeeId` | query string | Yes | Employee ID |
| `locationId` | query string | Yes | Location ID |

**Response 200:**
```json
{
  "id": "uuid",
  "employeeId": "maria.garcia",
  "locationId": "buenos-aires",
  "totalDays": 20,
  "usedDays": 5,
  "availableDays": 15,
  "lastSyncedAt": "2026-04-08T10:30:00.000Z",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-08T10:30:00.000Z"
}
```

#### POST `/api/v1/requests`

Create a time-off request. Transactional Outbox: atomic insert + deduction. Supports **idempotency keys** to prevent duplicates from client retries.

**Request Body:**
```json
{
  "employeeId": "maria.garcia",
  "locationId": "buenos-aires",
  "startDate": "2026-04-15",
  "endDate": "2026-04-18",
  "daysRequested": 4,
  "type": "VACATION",
  "idempotencyKey": "client-generated-uuid"
}
```

**Alternative header:** `Idempotency-Key: client-generated-uuid` (takes precedence over the body)

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `employeeId` | string | Yes | @IsString |
| `locationId` | string | Yes | @IsString |
| `startDate` | string | Yes | @IsDateString (ISO 8601) |
| `endDate` | string | Yes | @IsDateString (ISO 8601) |
| `daysRequested` | number | Yes | @IsNumber |
| `type` | string | No | @IsString, default: 'VACATION' |
| `idempotencyKey` | string | No | @IsString. If repeated, returns the original request without creating a duplicate |

**Response 201:**
```json
{
  "id": "uuid",
  "employeeId": "maria.garcia",
  "locationId": "buenos-aires",
  "startDate": "2026-04-15",
  "endDate": "2026-04-18",
  "daysRequested": 4,
  "type": "VACATION",
  "status": "PENDING_SYNC",
  "hcmTransactionId": null,
  "rejectionReason": null,
  "createdAt": "2026-04-08T14:00:00.000Z",
  "updatedAt": "2026-04-08T14:00:00.000Z"
}
```

**Error 404:** Balance not found
**Error 409:** Insufficient balance
```json
{
  "error": "INSUFFICIENT_BALANCE",
  "available": 3,
  "requested": 5
}
```

#### GET `/api/v1/requests/me`

Personal request history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `employeeId` | query string | Yes | Employee ID |
| `status` | query string | No | Filter by status |

**Response 200:** `TimeOffRequest[]` sorted by `createdAt DESC`

#### GET `/api/v1/activity`

Unified timeline of requests + HCM sync events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `employeeId` | query string | Yes | Employee ID |
| `locationId` | query string | No | Filter by location |

**Response 200:**
```json
[
  { "type": "request", "date": "2026-04-08T14:00:00Z", "data": { "...TimeOffRequest" } },
  { "type": "sync", "date": "2026-04-08T10:00:00Z", "data": { "...SyncHistory" } }
]
```

#### PATCH `/api/v1/requests/:id/cancel`

Cancel a request. Days are not restored until HCM confirms.

**Response 200:** TimeOffRequest with `status: "CANCELLATION_PENDING"`
**Error 409:** Cannot cancel in current status

### 6.2 Manager Endpoints (Port 3000)

#### GET `/api/v1/admin/requests/pending`

Inbox of requests pending approval. Includes `isConsistentWithHcm` flag.

**Response 200:**
```json
[
  {
    "id": "uuid",
    "employeeId": "maria.garcia",
    "locationId": "buenos-aires",
    "startDate": "2026-04-15",
    "endDate": "2026-04-18",
    "daysRequested": 4,
    "status": "WAITING_MANAGER_APPROVAL",
    "hcmTransactionId": "hcm-tx-1234",
    "isConsistentWithHcm": true,
    "createdAt": "2026-04-08T14:00:00Z"
  }
]
```

#### PATCH `/api/v1/admin/requests/:id/approve`

Approve a request. Only applicable to `WAITING_MANAGER_APPROVAL`.

**Response 200:** TimeOffRequest with `status: "APPROVED"`
**Error 409:** Status does not allow approval

#### PATCH `/api/v1/admin/requests/:id/reject`

Reject a request. Restores local balance + HCM rollback if already confirmed.

**Request Body:**
```json
{ "reason": "Team capacity exceeded for that week" }
```

**Response 200:** TimeOffRequest with `status: "REJECTED"`
**Error 409:** Status does not allow rejection

### 6.3 Sync Endpoints (Port 3000)

#### POST `/api/v1/sync/batch`

Bulk ingestion from HCM via streaming. Responds with 202 immediately.

**Request Body (JSON array, streamed):**
```json
[
  { "employeeId": "maria.garcia", "locationId": "buenos-aires", "totalDays": 25, "usedDays": 5 },
  { "employeeId": "james.smith", "locationId": "buenos-aires", "totalDays": 15, "usedDays": 0 }
]
```

**Response 202:**
```json
{
  "message": "Batch sync accepted. Processing in background.",
  "timestamp": "2026-04-08T14:00:00.000Z"
}
```

### 6.4 HCM Mock API (Port 4000)

#### GET `/hcm/api/v1/balances/:employeeId/:locationId`

Query balance in Source of Truth.

**Response 200:** `HcmBalance { employeeId, locationId, totalDays, usedDays, availableDays, lastUpdated }`
**Error 400:** Employee/location does not exist
**Error 504:** HCM in simulated downtime

#### GET `/hcm/api/v1/balances/all`

All HCM balances.

**Response 200:** `HcmBalance[]`

#### POST `/hcm/api/v1/time-off`

Reserve days in HCM. Validates balance and dimensions.

**Request Body:**
```json
{ "employeeId": "maria.garcia", "locationId": "buenos-aires", "days": 4, "requestId": "uuid" }
```

**Response 200:**
```json
{ "success": true, "transactionId": "hcm-tx-1712585600000", "remainingBalance": 16 }
```

**Error 400:** `{ "error": "INVALID_DIMENSIONS", "message": "..." }`
**Error 409:** `{ "error": "INSUFFICIENT_BALANCE", "message": "...", "available": 3 }`
**Error 504:** `{ "error": "HCM_UNAVAILABLE", "message": "..." }`

#### POST `/hcm/api/v1/time-off/rollback`

Rollback a reservation in HCM.

**Request Body:**
```json
{ "employeeId": "maria.garcia", "locationId": "buenos-aires", "days": 4, "requestId": "uuid" }
```

**Response 200:**
```json
{ "success": true, "transactionId": "hcm-tx-1712585700000", "remainingBalance": 20 }
```

#### POST `/hcm/api/v1/balances/:employeeId/:locationId/bonus`

Simulate an independent balance change (anniversary bonus, annual refresh).

**Request Body:**
```json
{ "days": 5, "reason": "Work Anniversary" }
```

**Response 200:**
```json
{ "success": true, "transactionId": "hcm-tx-1712585800000", "newBalance": 25, "reason": "Work Anniversary" }
```

#### POST `/hcm/admin/downtime`

Toggle HCM downtime simulation. 504 responses to all data routes.

**Request Body:** `{ "enabled": true }`
**Response 200:** `{ "downtime": true }`

#### POST `/hcm/admin/latency`

Simulate network latency.

**Request Body:** `{ "ms": 3000 }`
**Response 200:** `{ "latency": 3000 }`

#### GET `/hcm/admin/status`

Full HCM status.

**Response 200:**
```json
{
  "isDown": false,
  "balances": [ "...HcmBalance[]" ],
  "transactions": [ "...HcmTransaction[]" ]
}
```

### 6.5 WebSocket Events (Socket.IO, Port 3000)

| Event | Direction | Payload | Trigger |
|-------|-----------|---------|---------|
| `balance:updated` | Server -> Client | `{ employeeId, locationId, totalDays, usedDays, availableDays }` | Deduction, restore, sync, self-healing, batch upsert |
| `request:updated` | Server -> Client | `{ id, status, event, ...TimeOffRequest }` | Creation, sync, approve, reject, cancel |

---

## 7. Error Handling Strategy

| Error Type | HTTP Status | Action | Retry? |
|------------|-------------|--------|--------|
| Insufficient balance (local) | 409 CONFLICT | Immediate response to the user | No |
| Insufficient balance (HCM) | 409 CONFLICT | REJECTED + restore local balance | No |
| Invalid dimensions (HCM) | 400 BAD_REQUEST | REJECTED + restore local balance | No |
| HCM timeout / 5xx | 5xx | Throw to trigger retry via BullMQ | Yes (10x, exp. backoff) |
| Simulated HCM downtime | 504 GATEWAY_TIMEOUT | Throw to trigger retry | Yes (10x, exp. backoff) |
| DB transaction failure | 500 | Automatic rollback, error to client | No |
| Employee/location not found | 404 NOT_FOUND | Error to client | No |
| Invalid status for operation | 409 CONFLICT | Error to client | No |

**Key principle:** Permanent errors (invalid data, insufficient balance) are not retried. Transient errors (network, timeout, service down) are retried with exponential backoff.

---

## 8. BullMQ Queue Architecture

### Queue: `hcm-sync`

| Job Name | Trigger | Effect | Retry? |
|----------|---------|--------|--------|
| `sync-request` | Employee creates a request | POST to HCM `/time-off` -> WAITING_MANAGER_APPROVAL | 10x exp. backoff (transient) |
| `rollback-request` | Manager rejects a confirmed request | POST to HCM `/time-off/rollback` | 10x exp. backoff |
| `cancel-request` | Employee cancels a request | POST to HCM `/time-off/rollback` -> CANCELLED + restore balance | 10x exp. backoff |
| `batch-upsert` | Batch sync from HCM | Smart upsert preserving pending deductions | 10x exp. backoff |

**Configuration:**
```
attempts: 10
backoff: { type: 'exponential', delay: 2000 }
// Delays: 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, 1024s (~17 min total)
```

**Dead Letter Queue (DLQ):** After 10 failed attempts, the job is automatically moved to DLQ. Visible in Bull Board (`/admin/queues`). Requires manual intervention.

---

## 9. Alternatives Analysis

| Alternative | Pros | Cons | Decision |
|-------------|------|------|----------|
| **Synchronous Sync** | Simple to implement | Blocks the user if HCM fails | **Discarded** |
| **Two-Phase Commit (2PC)** | Strong consistency | Slow, fragile, single point of failure | **Discarded** |
| **Transactional Outbox** | Maximum resilience and consistency | Higher initial complexity | **Chosen** |
| **Periodic HCM Polling** | Keeps data fresh | Inefficient, overwhelms the HCM | **Discarded** |
| **Stale-While-Revalidate** | Instant response + eventual consistency | Momentarily stale data | **Chosen** |
| **Frontend Polling** | Simple, no server state | Latency of up to N seconds, unnecessary requests | **Discarded** |
| **WebSocket (Socket.IO)** | Instant push, zero perceived latency | Requires connection management | **Chosen** |
| **JSON.parse() for batch** | Simple to implement | OOM with large payloads | **Discarded** |
| **Streaming Parser** | OOM-safe, processes chunk by chunk | Higher parsing complexity | **Chosen** |

---

## 10. Testing Strategy

### 10.1 Approach

Unit tests focused on the business logic within services, where the real complexity resides. Controllers and modules are tested indirectly through the services they consume.

### 10.2 Testing Infrastructure

- **In-memory SQLite:** Each suite uses an isolated in-memory DB
- **Mock Queue:** BullMQ mocked to verify enqueue without Redis
- **Mock Axios:** HCM API mocked to simulate 200, 400, 409, 504 responses

### 10.3 Test Suites (68 tests, 5 suites)

**TimeOffService (12 tests)**

| # | Test Case | What It Validates |
|---|-----------|-------------------|
| 1 | Transactional Outbox | Atomic insert + deduction. If it fails, full rollback |
| 2 | Insufficient Balance | Local rejection if balance is insufficient |
| 3 | Invalid Employee | Rejection if employee/location does not exist |
| 4 | Race Conditions | Two concurrent requests do not exceed total balance |
| 5 | Manager Approve | Only applicable to WAITING_MANAGER_APPROVAL |
| 6 | Manager Reject + Rollback | Restore local balance + enqueue HCM rollback |
| 7 | Cancellation | CANCELLATION_PENDING + enqueue HCM cancel (days not restored) |
| 8 | Immutability | Cannot cancel a COMPLETED request |
| 9-12 | getMyRequests, filters | Filtering by employee and status |

**SyncProcessor (9 tests)**

| # | Test Case | What It Validates |
|---|-----------|-------------------|
| 1 | HCM Sync Success | PENDING_SYNC -> WAITING_MANAGER_APPROVAL with transactionId |
| 2 | HCM Downtime (504) | Throw to trigger retry (exponential backoff) |
| 3 | HCM Rejection (400) | No retry + restore balance + REJECTED |
| 4 | HCM Rejection (409) | Insufficient balance in HCM + restore local |
| 5 | Rollback | Successful call to the HCM rollback endpoint |
| 6 | Cancel Confirm | HCM confirms -> CANCELLED + restore local balance |
| 7 | Batch Upsert | Preserves deductions from pending requests |
| 8 | Batch New Employee | Creates new balance if it does not exist |
| 9 | Unknown job | Graceful handling of unknown job name |

**BalancesService (10 tests)**

| # | Test Case | What It Validates |
|---|-----------|-------------------|
| 1 | Stale-while-revalidate | Returns immediate local balance |
| 2 | Self-Healing | Detects discrepancy with HCM and auto-corrects |
| 3 | HCM Unreachable | Works with stale data if HCM does not respond |
| 4-6 | Upsert | Updates or creates balances from HCM |
| 7-8 | Deduct/Restore | Correct balance operations |
| 9-10 | Edge cases | Negative balance, non-existent employee |

**HcmMockService (10 tests)**

| # | Test Case | What It Validates |
|---|-----------|-------------------|
| 1 | Seed Data | Verification of correct initial data |
| 2-3 | Reserve | Deduction + transactionId + balance validation |
| 4 | Insufficient Balance | 409 error with insufficient balance |
| 5 | Invalid Dimensions | 400 error with invalid employee/location |
| 6 | Rollback | Day restoration |
| 7 | Bonus | Independent balance change |
| 8-10 | Downtime | Downtime simulation, toggle, recovery |

**AutoCompleteService (3 tests)**

| # | Test Case | What It Validates |
|---|-----------|-------------------|
| 1 | Auto-Complete | Marks expired APPROVED requests as COMPLETED |
| 2 | Future Dates | Does not touch requests with future dates |
| 3 | Other Statuses | Does not touch requests that are not in APPROVED |

### 10.4 Coverage

| File | % Lines | Notes |
|------|---------|-------|
| `timeoff.service.ts` | 90% | Core business logic |
| `balances.service.ts` | 93% | CRUD + self-healing |
| `sync.processor.ts` | 92% | Workers: sync, rollback, cancel, batch |
| `hcm-mock.service.ts` | 90% | Source of Truth mock |
| `auto-complete.service.ts` | 100% | Cron job |
| Controllers / Modules | 0% | Tested indirectly via services |

---

## 11. Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | NestJS | 10.4.0 |
| Language | TypeScript | 5.5.0 |
| Runtime | Node.js | 22 (Alpine) |
| DB | SQLite (better-sqlite3) | WAL mode |
| ORM | TypeORM | 0.3.20 |
| Queue | BullMQ + Redis 7 | 5.12.0 |
| WebSocket | Socket.IO | 4.7.0 |
| HTTP Client | Axios | 1.7.0 |
| Validation | class-validator | 0.14.1 |
| Streaming | stream-json | 1.8.0 |
| Testing | Jest | 29.7.0 |
| Queue Monitor | Bull Board | 5.21.0 |
| CSS | Tailwind (CDN) | - |
| Date Picker | Flatpickr | - |
| Git Hooks | Husky | 9.1.7 |
| Container | Docker + docker-compose | - |

---

## 12. Known Limitations and Trade-offs

Conscious decisions made given the scope of a take-home exercise. Each one has a clear path to production.

### Authentication and Authorization

Currently `employeeId` comes from the query param, not from an authenticated token. Any user can operate as any employee.

**In production:** JWT + NestJS guards. The `employeeId` would be extracted from the token, not the request body. RBAC to separate employee vs manager vs admin roles. Rate limiting on public endpoints.

### Circuit Breaker

There is no circuit breaker for HTTP calls to the HCM. If the HCM is down, each request generates a job that retries 10 times (accumulating load in Redis).

**In production:** Implement a circuit breaker with `opossum` or similar. After N consecutive failures, the circuit opens and rejects calls immediately without saturating the queue. Complemented by the existing retry mechanism for when the circuit closes.

### E2E Tests

There are only unit/integration tests at the service level. There are no tests that make actual HTTP requests to the controllers.

**In production:** Add an e2e test suite with `supertest` + `@nestjs/testing` that spins up the full app and validates HTTP endpoints, status codes, and response payloads. Also test WebSocket event emission end-to-end.

### Health Checks

There is no `/health` endpoint or readiness/liveness probes.

**In production:** `@nestjs/terminus` with health checks for SQLite, Redis, and HCM connectivity. Necessary for Kubernetes probes and infrastructure monitoring.

### Idempotency Keys with TTL

Currently idempotency keys are persisted in SQLite (`idempotencyKey` column with UNIQUE constraint on `timeoff_requests`). They have no TTL, so they never expire.

**In production:** Migrate to Redis with TTL (e.g., 24h). This allows reusing keys after a reasonable period and avoids accumulating keys in the main DB indefinitely.

### Database Migrations

`synchronize: true` is used in TypeORM, which auto-generates the schema on every startup. This is dangerous in production (can lose data on schema changes).

**In production:** Disable `synchronize` and use explicit migrations with `typeorm migration:generate` and `typeorm migration:run`. Controlled and reversible schema versioning.

### SQLite Scalability

SQLite is single-writer. It does not support multiple app instances writing to the same DB.

**In production:** Migrate to PostgreSQL. The current architecture (TypeORM + entities) makes the change a driver swap without modifying business logic. Add connection pooling and read replicas as needed based on load.

### WebSocket State

The `EventsGateway` maintains connections in process memory. It does not scale horizontally.

**In production:** Use `@socket.io/redis-adapter` so multiple app instances share WebSocket state via Redis pub/sub. Enables horizontal scaling without losing events.

---

## 13. Future Improvements

### Scalability
- Redis Cluster for BullMQ high availability
- Horizontal scaling with load balancer
- Cache layer (Redis) for frequently read balances

### Observability
- Prometheus/Grafana metrics (sync latency, failure rate, DLQ size)
- Distributed tracing with OpenTelemetry
- Automatic alerting on DLQ (PagerDuty/Slack)

### Functionality
- GraphQL layer with @nestjs/graphql
- Multi-level approval chain
- Calendar integration (block dates with high occupancy)
- Email/Slack notifications for status changes

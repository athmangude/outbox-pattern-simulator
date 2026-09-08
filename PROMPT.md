# Outbox Pattern Simulator — Build Specification

## Context and Purpose

HealthX is a health technology company operating in East Africa. Among its products is an EMR (Electronic Medical Record) system used by clinics, which syncs prescription data to a downstream pharmacy system for medication dispensing.

This simulator is a deliverable for a CTO consultancy engagement with HealthX. The specific problem it addresses: the current EMR-to-pharmacy integration is fragile — direct API calls with no delivery guarantees, no idempotency, and no visibility into failures. Prescriptions get lost or double-dispensed during network issues, pharmacy downtime, or infrastructure instability common in the operating environment (power outages and connectivity drops are routine in East Africa).

The simulator demonstrates the **Transactional Outbox Pattern** — Phase 2 of a recommended four-phase architecture evolution. It is meant to be shown during a presentation to HealthX leadership to make the abstract pattern tangible: they can see events flow, watch failures happen, and observe how the system self-heals without losing data or double-dispensing medication.

The audience is dual: HealthX leadership (CEO, COO, clinical leads) who need to understand *why* this pattern matters, and Dekaya, the technical recruitment firm managing the consultancy engagement, who are evaluating the candidate's technical depth and communication ability. The simulator must tell a clear visual story that works for both — concrete enough to impress engineers, accessible enough for non-technical stakeholders.

## The Problem Being Solved

In distributed systems, there are exactly three delivery guarantees: at-most-once, at-least-once, and exactly-once. Direct API calls between the EMR and pharmacy give at-most-once delivery — if the call fails, the prescription is lost. The outbox pattern upgrades this to at-least-once delivery (the relay will keep retrying until the pharmacy acknowledges), and the idempotency table at the pharmacy makes at-least-once *safe* by deduplicating on the event UUID — achieving effectively-once processing.

The critical invariant the simulator must demonstrate: **a prescription can never be lost (no data loss) and can never be dispensed twice (no double-dispense), regardless of what combination of failures occur.**

## System Model

Three components participate in the flow:

### 1. EMR System (Producer)

The EMR is where clinicians create prescriptions. The key guarantee is **atomicity**: the prescription record and the outbox event are written in the same database transaction. If the write succeeds, the event is guaranteed to exist. If it fails, neither exists. There is no window where a prescription exists without a corresponding outbox event.

This is the core insight of the outbox pattern — instead of the application making an API call to the pharmacy (which can fail independently of the database write), the application writes to its own database, and a separate process handles delivery.

**Outbox table schema:**

| Column | Type | Description |
|---|---|---|
| id | string | Unique event identifier (UUID). This is the idempotency key. |
| event_type | string | Always `prescription.created` in this simulator |
| aggregate_id | string | The prescription ID (e.g., `RX-4821`) |
| patient_name | string | Patient's full name |
| medication | string | Medication name and dosage |
| created_at | timestamp | When the event was written |
| published_at | timestamp or null | When the relay confirmed delivery (null until delivered) |
| retry_count | integer | Number of delivery attempts so far |
| status | enum | Current lifecycle state (see State Machine below) |
| max_retries | integer | Maximum retry attempts before DLQ (fixed at 5) |

### 2. Relay Service (Delivery Agent)

The relay is a background process that polls the outbox table for pending events and delivers them to the pharmacy via HTTP POST. It implements **at-least-once delivery semantics**: if delivery fails for any reason, the event stays in the outbox and will be retried.

Key behaviors:
- **Polling**: Checks the outbox on a fixed interval. Processes the oldest pending event first (FIFO ordering preserves prescription chronology).
- **Exponential backoff**: On failure, the next retry waits `2^retryCount` seconds. This prevents overwhelming a struggling pharmacy system.
- **Dead Letter Queue (DLQ)**: After `maxRetries` (5) consecutive failures, the event is moved to a DLQ rather than retrying indefinitely. This prevents a single poison event from blocking the entire queue. DLQ events require manual intervention (a human reviews and requeues).
- **Delivery confirmation**: The relay only marks an event as delivered when it receives an HTTP 200 from the pharmacy. If the connection drops after the pharmacy processes the event but before the relay receives the response (a network blip), the relay has no way to know the event was processed — it will retry, which is safe because the pharmacy has idempotency protection.

### 3. Pharmacy System (Consumer)

The pharmacy receives events, processes them (dispenses medication), and records the event UUID in a `processed_events` table. Before processing any event, it checks this table — if the UUID already exists, the event is a duplicate and is acknowledged (HTTP 200) but not processed again.

**Processed events table schema:**

| Column | Type | Description |
|---|---|---|
| event_id | string | The event UUID (foreign key to outbox) |
| processed_at | timestamp | When the event was processed |
| duplicate | boolean | Whether this was a duplicate delivery (for metrics) |

This idempotency check is the safety net that makes at-least-once delivery safe. Without it, a network blip that causes a retry would result in double-dispensing.

## Event Lifecycle State Machine

Each outbox event moves through these states:

```
pending → in_transit → delivered     (happy path)
pending → in_transit → pending       (retry — pharmacy offline or network blip)
pending → in_transit → dlq           (max retries exhausted)
dlq → pending                        (manual requeue from DLQ)
```

Valid transitions:
- `pending → in_transit`: Relay picks up the event for delivery
- `in_transit → delivered`: Pharmacy acknowledges receipt (HTTP 200)
- `in_transit → pending`: Delivery failed (pharmacy offline, network blip). Retry count increments.
- `in_transit → dlq`: Delivery failed and retry count has reached maxRetries
- `dlq → pending`: Operator manually requeues the event. Retry count resets to 0.

No other transitions are valid. An event cannot go from `delivered` back to any other state. An event in `dlq` can only return to `pending` through explicit operator action.

## Failure Scenarios

The simulator models three distinct failure modes, each mapped to a real-world scenario:

### Scenario 1: Pharmacy Downtime

**Real-world cause**: The pharmacy system is down for maintenance, has crashed, or is overloaded.

**What happens**: The relay delivers the event, but the pharmacy returns an error (or the connection is refused). The relay increments the retry count and schedules a retry with exponential backoff. If the pharmacy comes back online before max retries, the event is delivered successfully. If not, it moves to the DLQ.

**Control**: Pharmacy toggle (ONLINE / OFFLINE)

**What it demonstrates**: Events are never lost during downstream outages. The outbox holds them safely until the pharmacy recovers. This is the most basic value proposition of the pattern.

### Scenario 2: Network Partition

**Real-world cause**: The relay service loses connectivity — ISP outage, DNS failure, firewall misconfiguration, or infrastructure instability.

**What happens**: The relay detects it cannot reach the pharmacy endpoint. Events remain queued locally in the outbox. When connectivity is restored, the relay resumes delivery from where it left off.

**Control**: Relay toggle (CONNECTED / DISCONNECTED)

**What it demonstrates**: The outbox is a durable buffer. Unlike a direct API call (which would fail and the prescription would be lost), events persist in the database and survive any infrastructure disruption.

### Scenario 3: Network Blip (Ambiguous Delivery)

**Real-world cause**: The pharmacy successfully processes the prescription and sends HTTP 200, but the TCP connection resets before the relay receives the response. This happens during brief network instability, load balancer timeouts, or infrastructure flaps.

**What happens**: This is the most subtle and dangerous failure mode. The pharmacy has already dispensed the medication and recorded the event UUID. But the relay has no confirmation — from its perspective, delivery failed. It will retry. When the duplicate arrives, the pharmacy's idempotency check finds the UUID in `processed_events` and blocks the duplicate dispense.

**Control**: Network Blip button (one-shot, auto-disarms after triggering)

**What it demonstrates**: Why idempotency is non-negotiable. Without the `processed_events` check, this scenario would cause a double-dispense — a patient receives twice the prescribed medication, which is a clinical safety incident. The idempotency table is the last line of defense.

## Demo Narrative

The intended presentation flow:

1. **Happy path**: Create 2-3 prescriptions, watch them flow through cleanly. Point out the atomic transaction (BEGIN/COMMIT in the log), the relay polling, and the idempotency check on every delivery.

2. **Pharmacy downtime**: Toggle pharmacy offline, create a prescription, watch retries with exponential backoff. Toggle back online, watch the backlog drain. Point: "No prescriptions were lost during the outage."

3. **Network blip**: Create a prescription, arm the network blip, watch the pharmacy process it while the relay thinks it failed. Watch the retry arrive and get blocked by the idempotency check. Point: "The patient was not double-dispensed. This is the scenario that breaks most integrations."

4. **DLQ**: Toggle pharmacy offline, let an event exhaust all retries. Show the DLQ, explain that this requires human review. Requeue it, toggle pharmacy online, watch it deliver. Point: "Nothing falls into a black hole. Every failure is visible and recoverable."

## Technical Implementation

### Stack

- Next.js 15 with App Router
- TypeScript
- Tailwind CSS v4 (`@import "tailwindcss"` with `@theme inline`)
- No backend — the entire simulation runs client-side in React state
- Geist and Geist Mono fonts (via `next/font/google`)

### Application Structure

Single-page application with one component (`simulator.tsx`) imported by the root page.

### Layout Structure

Top to bottom:
1. **Header bar** — Title, subtitle, "Create Prescription" button, speed selector (1x / 2x / 5x)
2. **Stats bar** — Five metric cards: Created (blue), Delivered (green), Pending (yellow), Dead Letter Queue (red), Duplicates Blocked (purple). Each shows a large monospace counter.
3. **Three-column panel**:
   - **Left — EMR System**: Blue accent border. Shows the `integration_outbox` table as a scrollable list. Each row displays prescription ID, patient name, retry count (if > 0 and not delivered), and a color-coded status badge.
   - **Center — Network Controls**: Amber accent border. Contains the three control buttons (Pharmacy toggle, Relay toggle, Network Blip) and a DLQ section that appears conditionally when the DLQ has items. The DLQ section shows failed events and a "Retry oldest" button.
   - **Right — Pharmacy System**: Green accent border. Shows the `processed_events` table as a scrollable list. Each row displays the prescription ID, medication, and "dispensed" label.
4. **Event Log** — Full-width dark panel. Scrollable monospace log, auto-scrolls to bottom on new entries. Each line: timestamp, source tag, message. Color-coded by source and severity.
5. **Footer** — Centered, muted text: "Athman Gude — HealthX CTO Consultancy — September 2026"

Each column in the three-column panel includes a brief description below the title explaining what that component does in plain language (one sentence, aimed at a non-technical audience).

### Relay Polling Implementation

The relay runs on a `setInterval` with a base interval of 2500ms divided by the current speed multiplier. On each tick:

1. Skip if relay is not active
2. Query outbox for events with status `pending`
3. If no pending events, skip silently
4. Take the oldest pending event (last in array, since new events are prepended)
5. Log the poll result ("found N pending event(s)")
6. If relay is disconnected: log and skip
7. Mark the event as `in_transit` in the outbox
8. Log the POST request
9. After a simulated delivery delay (800ms / speed), resolve the delivery:
   - **Pharmacy offline**: Increment retry count. If max retries reached, move to DLQ. Otherwise, set back to pending with incremented retry count and log the backoff duration.
   - **Network blip armed**: The pharmacy processes the event normally (insert into `processed_events`, increment delivered counter, log all SQL operations). But then log the ACK loss, set the event back to pending with incremented retry count, and auto-disarm the blip. On the next delivery attempt, the idempotency check will catch the duplicate.
   - **Already in processed_events (duplicate)**: Mark as delivered, increment duplicates blocked counter, log the idempotency check finding the existing record.
   - **Normal delivery**: Mark as delivered, insert into `processed_events`, increment delivered counter, log the full processing sequence.

The order of checks matters: pharmacy offline is checked first (if the pharmacy is down, nothing else matters), then idempotency (handles the retry after a network blip), then network blip (only fires on fresh deliveries), then normal delivery.

### State Management Pattern

Every piece of state that the `setInterval` callback reads must be mirrored in a `useRef` that is kept in sync via `useEffect`. This is because the `setInterval` closure captures the initial state values; without refs, the callback would read stale state. The state itself drives React re-renders, while the refs give the interval callback current values.

States that need refs: outbox, pharmacyOnline, internetConnected, relayActive, speed, processedEvents, networkBlipArmed.

### Event Log Behavior

- Entries are appended to an array, capped at the last 100 entries (older entries are dropped)
- Auto-scrolls to the bottom on new entries using a ref and `scrollIntoView`
- Each entry has: unique ID, timestamp, source (`emr` | `relay` | `pharmacy` | `system`), message, level (`info` | `warn` | `error` | `success`)
- A "Clear" button empties the log
- When no entries exist, show placeholder text: "Create a prescription to start the simulation"

### Event Log Message Scripts

These are the exact log messages for each scenario. They are written to read like actual database and HTTP operations, making the pattern concrete for a technical audience while remaining comprehensible to non-engineers.

**Prescription creation (EMR):**
```
[emr]  info     BEGIN TRANSACTION
[emr]  info     INSERT prescription RX-XXXX for {patientName} ({medication})
[emr]  info     INSERT outbox event evt_X... (same transaction)
[emr]  success  COMMIT — prescription + event guaranteed
```

**Relay poll:**
```
[relay] info    Polling outbox... found N pending event(s)
[relay] info    POST /pharmacy/events — delivering evt_X...
```

**Successful delivery:**
```
[pharmacy] info     Event evt_X... received
[pharmacy] info     Idempotency check: SELECT FROM processed_events WHERE event_id = 'evt_X...' — NOT FOUND
[pharmacy] success  Dispensing {medication} for {patientName} ({prescriptionId})
[pharmacy] success  INSERT processed_events (evt_X...)
```

**Pharmacy offline (retry):**
```
[relay] warn  Pharmacy unavailable — retry {n}/{maxRetries} in {backoff}s (backoff)
```

**Pharmacy offline (DLQ):**
```
[relay] error  Max retries ({maxRetries}) exhausted for evt_X... — moved to DLQ
```

**Relay disconnected:**
```
[relay] warn  Relay disconnected — event evt_X... queued locally
```

**Network blip (pharmacy processes but ACK lost):**
```
[pharmacy] info     Event evt_X... received
[pharmacy] info     Idempotency check: SELECT FROM processed_events WHERE event_id = 'evt_X...' — NOT FOUND
[pharmacy] success  Dispensing {medication} for {patientName} ({prescriptionId})
[pharmacy] success  INSERT processed_events (evt_X...)
[pharmacy] success  HTTP 200 OK sent to relay...
[relay]    error    NETWORK BLIP: TCP connection reset — HTTP response from pharmacy was lost in transit
[relay]    warn     Relay has no confirmation that evt_X... was processed — will retry delivery
```

**Duplicate blocked (on retry after network blip):**
```
[pharmacy] warn     SELECT FROM processed_events WHERE event_id = 'evt_X...' — FOUND
[pharmacy] warn     DUPLICATE BLOCKED: evt_X... already dispensed — idempotency key prevented double-dispense
[relay]    success  HTTP 200 OK (duplicate acknowledged) — marking evt_X... as delivered
```

**System events (toggle changes):**
```
[system] success  Pharmacy system is back ONLINE
[system] error    Pharmacy system went OFFLINE
[system] success  Relay connectivity RESTORED — polling will resume delivery
[system] error    Relay connectivity LOST — cannot reach pharmacy endpoint
[system] warn     Network blip ARMED — next delivery will reach the pharmacy but the HTTP acknowledgment will be lost, causing a duplicate retry
[system] info     DLQ event evt_X... requeued for delivery
```

### Sample Data

**Patient names** (East African, reflecting the operating context):
Amina Hassan, James Ochieng, Fatma Ali, Peter Kamau, Grace Wanjiku, Mohamed Salim, Sarah Njeri, David Mwangi, Halima Omar, Joseph Kipchoge, Agnes Wairimu, Hassan Abdi

**Medications** (common generics prescribed in primary care):
Amoxicillin 500mg, Metformin 850mg, Paracetamol 1g, Omeprazole 20mg, Amlodipine 5mg, Azithromycin 250mg, Ibuprofen 400mg, Ciprofloxacin 500mg, Losartan 50mg, Doxycycline 100mg, Cetirizine 10mg, Atorvastatin 20mg

**ID formats:**
- Prescription IDs: `RX-{4 random digits}` (e.g., RX-4821)
- Event IDs: `evt_{incrementing counter}_{timestamp in base36}` (e.g., evt_3_m1k4f9x)
- Log IDs: `log_{incrementing counter}`

Patient names and medications are selected randomly on each prescription creation.

### Visual Design

**Theme**: Dark UI (background `#0f172a`, foreground `#e2e8f0`). No light mode — the dark theme is intentional for presentation on a projector or screen share.

**Color system:**
- EMR / Created: Blue (`blue-400` for accents, `blue-800/50` for borders)
- Relay / Network Controls: Amber (`amber-400` for accents, `amber-800/50` for borders)
- Pharmacy / Delivered: Emerald (`emerald-400` for accents, `emerald-800/50` for borders)
- DLQ / Errors: Red (`red-400` for accents, `red-800/50` for borders)
- Duplicates Blocked: Purple (`purple-400` for counter)
- System log entries: Purple (`purple-400`)

**Status badges** (on outbox event rows):
- pending: Yellow background/border/text
- in_transit: Blue background/border/text
- delivered: Emerald background/border/text
- failed: Red background/border/text
- dlq: Dark red background/border/text

Each badge is a small pill with `font-mono text-xs`, border, and semi-transparent background.

**Control buttons**: Full-width within the Network Controls column. Each shows a label on the left and a monospace status on the right. Toggle buttons use green (emerald) when in the "good" state and red when in the "bad" state. The Network Blip button uses orange when armed (with CSS `animate-pulse`) and neutral slate when ready.

**Animations:**
- `pulse-dot`: Opacity oscillation (1 → 0.3 → 1 over 2s) on the relay's status indicator dot when actively polling
- `fade-in`: Translate Y 4px + opacity 0→1 over 0.3s on new event rows and log entries

**Scrollbars**: Thin (4px width), slate-colored thumb, transparent track. WebKit only.

**Typography**: Geist Sans for UI text, Geist Mono for data tables, log entries, status badges, and counters.

**Responsive behavior**: Three-column layout collapses to single column on mobile (`grid-cols-1 md:grid-cols-3`). Stats bar uses 2 columns on mobile, 5 on desktop.

### Intentional Simplifications

These aspects of a real outbox pattern implementation are deliberately omitted to keep the simulator focused and understandable:

1. **No ordering guarantees across events**: In production, you would need to handle ordering within an aggregate. The simulator processes FIFO but does not model ordering violations.
2. **No partitioning or parallel consumers**: The relay processes one event at a time. A real system would have multiple relay instances with partition-based assignment.
3. **No event schema evolution**: All events are `prescription.created` with a fixed schema.
4. **No backpressure**: The outbox can grow without bound in the simulation.
5. **No observability beyond the event log**: A real system would have metrics, alerting, and tracing. The event log is a stand-in.
6. **No authentication or authorization**: The relay-to-pharmacy HTTP call has no auth in the simulation.
7. **Exponential backoff is displayed but not actually waited**: The log says "retry in Ns" but the retry happens on the next polling interval for simulation pacing. In production, the backoff delay would be real.
8. **Single event type**: A real system would have multiple event types (prescription.updated, prescription.cancelled, etc.) with different processing logic at the pharmacy.

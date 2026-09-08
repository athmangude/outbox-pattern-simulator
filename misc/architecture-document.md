# EMR-Pharmacy Sync: Architecture Recommendation

**Athman Gude | HealthX CTO Consultancy | September 2026**

---

## 1. Available Information

The following has been confirmed by Dekaya and HealthX:

| Area | Confirmed Detail |
|---|---|
| Backend stack | Go, PHP, JavaScript across backend services |
| Frontend stack | Flutter (Android, iOS, Web), React/JavaScript (web) |
| Infrastructure | Combination of on-premise and external/cloud/vendor services |
| Systems landscape | EMR, pharmacy, mobile apps, web apps, USSD, telemedicine, third-party integrations |
| Regulatory | Regulated healthcare environment; Kenya Data Protection Act / ODPC; patient data protection, security, and auditability required |
| Engineering team | Existing team covering frontend, backend, and infrastructure |
| Strategic direction | Moving from founder-led technology to institutionally managed; Technology-as-a-Service (TaaS) explored as a revenue line |

**Not yet confirmed (expected from HealthX technical team Sep 3):**
- Whether EMR and pharmacy are separate applications/databases
- Current communication method between the two systems
- How sync failures are detected and resolved
- Failure frequency and transaction volume
- Offline operation requirements
- Additional system-specific constraints

---

## 2. Assumptions

Each assumption is numbered for traceability. Where an assumption significantly changes the architecture, I have noted the impact.

### Architecture Assumptions

**A1. EMR and pharmacy are separate applications with separate databases.**
The systems landscape lists them as distinct systems. The heterogeneous backend (Go, PHP, JS) suggests that the services were built independently. The "sync failure" framing implies data crossing a system boundary, not a query within a shared database.
*If wrong:* The problem becomes application-level transaction management rather than distributed consistency, which is much simpler to solve.

**A2. Systems communicate via synchronous REST API calls, point-to-point.**
No middleware, message queue, or integration layer has been described. Synchronous REST is the default integration pattern for organisations at this stage. This explains the failure mode: when the target service is down, slow, or returns an error without retry, data is lost or inconsistent.
*If wrong:* If a message queue or shared database exists, the failure mode is different and we extend existing infrastructure rather than introducing new patterns.

**A3. No centralised integration middleware or API gateway exists.**
The confirmed context describes multiple systems and "third-party integrations" but there is no mention of a bus, gateway, or shared integration layer.
*If wrong:* We would extend the existing middleware to handle EMR-pharmacy sync rather than building a new layer.

**A4. Systems are custom-built with modifiable source code.**
The in-house engineering team covering frontend, backend, and infrastructure, combined with the heterogeneous stack, suggests that these are internally built systems.
*If wrong:* If any system is off-the-shelf (e.g. OpenMRS), we would need to work through its extension points and APIs rather than modifying it directly.

**A5. Database engines are PostgreSQL and/or MySQL.**
This is a common pairing for Go (PostgreSQL) and PHP (MySQL) services in Kenyan healthtech.
*If wrong:* This would affect the choice of change-data-capture tooling and transaction patterns, but would not fundamentally change the architecture.

### Problem Assumptions

**A6. Sync failures occur multiple times per week and frequency is increasing.**
The scenario was chosen for a CTO-level evaluation, which suggests that it is a real and active problem of sufficient severity to warrant architectural attention.
*If wrong:* If failures are rare (monthly or less), a simpler monitoring and manual recovery approach may be sufficient.

**A7. Failures are detected manually, not through automated alerting.**
No monitoring or observability infrastructure has been described. Failures likely surface when a pharmacist notices a missing prescription, when a billing discrepancy appears during reconciliation, or when an auditor finds mismatched records.
*If wrong:* If automated detection already exists, we would skip the observability phase and go directly to architectural remediation.

**A8. No confirmed patient safety incidents from sync failures, but the risk exists.**
Any data inconsistency between what was prescribed (EMR) and what was dispensed (pharmacy) creates the conditions for a double-dispense or missed medication.

### Operational Assumptions

**A9. Offline operation is required at some facilities.**
Kenya's infrastructure reality includes load shedding, ISP outages, and intermittent connectivity at smaller facilities. The hybrid on-premise/cloud setup confirms that not everything runs centrally.
*If wrong:* If all facilities have reliable connectivity, we can use simpler always-online patterns and skip conflict resolution design.

**A10. Scale is 5-20 facilities, tens to low hundreds of daily dispensing transactions per facility.**
This is consistent with a Kenyan healthtech company that is hiring its first dedicated CTO.
*If wrong:* If larger (50+ facilities, thousands of daily transactions), the architecture needs higher throughput design and partitioning.

### Team Assumptions

**A11. Engineering team is 3-8 engineers, primarily experienced with request-response (REST) patterns.**
The heterogeneous stack suggests different specialisations across the team. There has been no mention of event-driven systems or message broker experience.
*If wrong:* If the team already has event-driven experience, we could recommend a more sophisticated architecture from the start.

### Strategic Assumptions

**A12. The EMR-pharmacy sync problem is one instance of a broader integration challenge across 6+ systems.**
The systems landscape confirms that there are multiple systems that need to exchange data. Point-to-point connections between all of them will not scale.

**A13. TaaS requires the architecture to support multi-tenancy and externalisable APIs in the medium term.**
The integration layer should be designed as a platform capability and not a one-off fix.

---

## 3. Design Principles

Three non-negotiable constraints shape every architectural decision in this document. These have been derived directly from the confirmed context.

### P1. Language-Agnostic Integration

HealthX runs Go, PHP, and JavaScript across backend services. Any integration pattern must work identically regardless of which language a service is written in. This means:

- Integration contracts are defined at the **protocol level** (HTTP/REST, message formats, database schemas), not embedded in application code or language-specific libraries
- The outbox table is a database table with a standard schema — any language that can write SQL can produce events
- The relay service consumes events via SQL polling and delivers via HTTP — both are language-agnostic protocols
- The message broker (Phase 3) exposes standard protocols (NATS: TCP/WebSocket, RabbitMQ: AMQP) with client libraries available in Go, PHP, and JavaScript
- No shared application library or SDK is required — each team implements the pattern in their own language using the same contract

See the companion document (`HealthX-Code-Examples.md`) for implementation examples in Go, PHP, and JavaScript showing the same outbox pattern in all three languages.

### P2. Hybrid-Aware Deployment

HealthX operates a combination of on-premise infrastructure and cloud/vendor services. The architecture must work across both environments without assuming either is always available. This means:

- The relay service and message broker must be deployable in either environment
- Network partitions between on-premise and cloud are expected, not exceptional
- Events queue locally (in the outbox table, co-located with the service's database) during connectivity loss and deliver when the path is restored
- No component assumes low-latency or always-on connectivity to another component

See the Deployment Topology section (Section 6) for specific placement recommendations.

### P3. Reusable-by-Design

The EMR-pharmacy sync problem is one instance of a broader integration challenge across 6+ systems, and TaaS requires externalisable event streams. This means:

- The outbox table schema and event format are standardised across all systems, not specific to EMR-pharmacy
- The relay service is configured per integration pair, not hardcoded for one
- The event bus (Phase 3) is a platform capability, not a point-to-point fix
- Every design decision asks: "Does this work for the next integration too, or do we have to rebuild?"

---

## 4. Risks

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Data loss during sync failures** — prescriptions dispensed but not recorded, or recorded but not dispensed | High (if A6 is correct) | Critical (patient safety) | Phase 1 observability gives immediate visibility; Phase 2 outbox pattern guarantees at-least-once delivery |
| **Inconsistent state between systems** — EMR says one thing, pharmacy says another, no source of truth | High | High (billing, audit, clinical) | Introduce an event log as the authoritative record of what happened, with reconciliation checks |
| **Offline conflicts** — two systems modify the same record while disconnected, then reconnect | Medium (if A9 is correct) | High | Design conflict resolution rules per entity type; prescriptions use last-write-wins with clinician override; inventory uses additive merge |
| **Team cannot maintain new infrastructure** — message broker or event bus introduces operational burden the team hasn't managed before | Medium (if A11 is correct) | Medium | Phase the approach: start with patterns that use existing skills (outbox + polling), introduce new infrastructure only after the team has built confidence |
| **Migration disrupts clinical operations** — changing how systems communicate risks breaking active patient workflows | Medium | Critical | Zero-downtime migration strategy: run old and new paths in parallel, verify consistency before cutting over |

### Strategic Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Point-to-point fix that doesn't scale** — solving EMR-pharmacy without a reusable pattern means doing it again for every other integration | High | High (technical debt, TaaS timeline) | Design the integration pattern as a platform capability from the start, even if EMR-pharmacy is the first use case |
| **TaaS architecture lock-in** — building for today's single-tenant model makes multi-tenancy a rewrite later | Medium | High | Introduce tenant context early (even if there's only one tenant today); design APIs to be externalisable |
| **Regulatory non-compliance** — audit trail gaps in the integration layer expose HealthX to DPA violations | Medium | High | Immutable event log with full provenance; PII handling per DPA requirements; retention policy aligned with healthcare regulations |

---

## 5. Architectural Options

I have evaluated four approaches against these criteria:
- **Reliability:** Does it solve the sync failure problem?
- **Team fit:** Can the current team build and maintain it?
- **Offline support:** Does it handle intermittent connectivity?
- **Reusability:** Does it extend to other system integrations and TaaS?
- **Operational complexity:** How much new infrastructure does it introduce?

### Option A: Retry Logic + Circuit Breaker on Existing API Calls

Add retry with exponential backoff, circuit breaker patterns, and a dead letter table to the existing synchronous API calls between EMR and pharmacy.

| Criterion | Rating | Notes |
|---|---|---|
| Reliability | Moderate | Handles transient failures (timeouts, temporary outages). Does NOT handle sustained outages, data loss during downtime, or ordering guarantees |
| Team fit | High | Minimal new concepts; retry and circuit breaker are well-documented patterns |
| Offline support | None | Synchronous calls cannot work offline |
| Reusability | Low | Each system pair needs its own retry logic; no shared integration pattern |
| Operational complexity | Low | No new infrastructure |

**Verdict:** This option provides a quick win for transient failures, but it does not solve the core problem. It fails on offline support and reusability, and is not recommended as the primary solution.

---

### Option B: Transactional Outbox Pattern + Polling Relay

Each system writes events to a local outbox table within the same database transaction as its business operation. A relay service polls the outbox and delivers events to target systems. Failed deliveries are retried with backoff. Successfully delivered events are marked as processed.

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│    EMR      │         │    Relay     │         │  Pharmacy   │
│             │         │   Service    │         │             │
│ ┌─────────┐ │  poll   │              │  POST   │             │
│ │ outbox  │─┼────────>│  read event  │────────>│  process    │
│ │ table   │ │         │  retry on    │         │  event      │
│ └─────────┘ │         │  failure     │         │             │
│             │         │  DLQ on      │         │ ┌─────────┐ │
│  business   │         │  exhaustion  │         │ │ outbox  │ │
│  write +    │         │              │         │ │ table   │ │
│  outbox     │         └──────────────┘         │ └─────────┘ │
│  in same TX │                                  │             │
└─────────────┘                                  └─────────────┘
```

| Criterion | Rating | Notes |
|---|---|---|
| Reliability | High | Business write and event are in the same database transaction — if the write succeeds, the event is guaranteed to exist. At-least-once delivery with idempotency |
| Team fit | High | Uses familiar patterns: database transactions, REST APIs, polling. No new infrastructure. Outbox is just a table |
| Offline support | Partial | Events queue locally during outages and deliver when connectivity returns. Does not handle bidirectional offline edits (conflict resolution needed separately) |
| Reusability | Moderate | Pattern is reusable per system pair but each pair needs its own relay configuration. Not a centralised bus |
| Operational complexity | Low | One new service (relay), one new table per system. No message broker to operate |

**Verdict:** This is a strong match for the current team's capability and the immediate problem. It solves the core reliability issue, though it has limited reusability for the broader integration challenge.

---

### Option C: Event-Driven Architecture with Message Broker

Introduce a message broker (e.g. NATS, RabbitMQ, or Redis Streams). Systems publish domain events to topics. Other systems subscribe to the topics they care about. The broker handles delivery, retry, and persistence.

```
┌─────────────┐                                  ┌─────────────┐
│    EMR      │    publish                        │  Pharmacy   │
│             │──────────┐                   ┌───>│             │
│  write +    │          │                   │    │  subscribe  │
│  publish    │          v                   │    │  & process  │
│             │    ┌───────────┐             │    │             │
└─────────────┘    │  Message  │─────────────┘    └─────────────┘
                   │  Broker   │
┌─────────────┐    │  (NATS /  │─────────────┐    ┌─────────────┐
│ Telemedicine│───>│  Rabbit)  │             └───>│   Billing   │
│             │    └───────────┘                  │             │
└─────────────┘         │                         └─────────────┘
                        │
                   ┌────v─────┐
                   │  Event   │
                   │  Store   │
                   │  (audit) │
                   └──────────┘
```

| Criterion | Rating | Notes |
|---|---|---|
| Reliability | High | Broker persists messages; at-least-once or exactly-once delivery depending on configuration. Handles sustained outages |
| Team fit | Low-Medium | New infrastructure and concepts: pub/sub, topics, consumer groups, message acknowledgment. Learning curve for a team used to REST |
| Offline support | Partial | Messages queue at the broker during consumer outages. Does not solve local-first offline at facility level without additional design |
| Reusability | High | Any system can publish/subscribe. Scales to all 6+ systems. Natural foundation for TaaS event streaming |
| Operational complexity | Medium-High | Broker needs to be deployed, monitored, and maintained. Clustering for high availability. New failure mode (broker itself goes down) |

**Verdict:** This is the right long-term architecture for HealthX's scale and TaaS ambitions. However, it is too complex to introduce as the first move given the current team's experience level (A11).

---

### Option D: Change Data Capture (CDC) + Event Stream

Use database-level CDC (e.g. Debezium for PostgreSQL WAL, MySQL binlog) to capture every data change at the database level. Stream changes to target systems via a message broker or direct connector.

| Criterion | Rating | Notes |
|---|---|---|
| Reliability | Very High | Captures at the database level — nothing can be missed. Even application bugs that skip the outbox are caught |
| Team fit | Low | CDC tooling (Debezium, Kafka Connect) requires specific database configuration, schema management, and operational expertise. Significant learning curve |
| Offline support | None (at source) | CDC reads the database WAL/binlog — requires the database to be online and connected to the CDC pipeline |
| Reusability | High | Any database change in any system can be captured and streamed |
| Operational complexity | High | Requires Kafka or equivalent, Debezium connectors, schema registry, monitoring. Significant infrastructure |

**Verdict:** This is overkill for HealthX's current scale and team maturity. It would be appropriate for larger organisations with dedicated platform engineering teams, and is not recommended here.

---

### Options Comparison

| Criterion | A: Retry | B: Outbox | C: Event Bus | D: CDC |
|---|---|---|---|---|
| Reliability | Moderate | High | High | Very High |
| Team fit | High | **High** | Low-Medium | Low |
| Offline support | None | Partial | Partial | None |
| Reusability | Low | Moderate | **High** | High |
| Operational complexity | Low | **Low** | Medium-High | High |
| TaaS alignment | Low | Moderate | **High** | High |
| Time to first value | 1-2 weeks | **3-4 weeks** | 8-12 weeks | 12-16 weeks |

---

## 6. Recommendation: Phased Approach (B → C)

Start with **Option B (Transactional Outbox)** to solve the immediate reliability problem with patterns the team already understands, then evolve to **Option C (Event Bus)** as the team builds confidence and the TaaS roadmap demands it.

This is not a compromise. It is the architecture that matches where HealthX is today and where it is going. The outbox pattern is not throwaway work — it becomes the event production layer that feeds the message broker in Phase 3.

### Phase 1: Observability (Weeks 1-2)

**Goal:** See the problem before solving it. Establish a baseline so we can measure whether the architecture actually works.

**Deliverables:**
- Structured logging on all EMR-pharmacy data exchanges (request/response, timestamps, correlation IDs)
- A reconciliation query that compares EMR prescriptions against pharmacy dispensing records and flags discrepancies
- A simple dashboard (can be a database view or lightweight UI) showing: sync attempts, failures, time-to-detection, discrepancy count
- Alerting on sync failures (can be as simple as a Slack/email notification on error log patterns)

**Why first:** If failures are currently undetected (A7), we need visibility before we change anything. This also validates assumptions A6 (failure frequency) and A7 (detection method) with real data. If the dashboard shows failures are rare, we may not need Phase 2 at all.

**Team effort:** 1 backend engineer, part-time. Uses existing skills (SQL, logging, REST).

**Success criteria:** Every sync failure is detected within 5 minutes. Baseline failure rate and mean-time-to-resolution are documented.

---

### Phase 2: Transactional Outbox + Relay Service (Weeks 3-5)

**Goal:** Guarantee at-least-once delivery of dispensing events between EMR and pharmacy.

**Design:**

**Outbox table (added to both EMR and pharmacy databases):**

```sql
CREATE TABLE integration_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(100) NOT NULL,    -- e.g. 'prescription.created', 'dispense.completed'
    aggregate_id    VARCHAR(255) NOT NULL,    -- e.g. prescription ID, dispense ID
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ,
    retry_count     INT DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'pending'  -- pending, published, failed
);
```

**Key design decisions:**

1. **Same-transaction guarantee:** The application writes the business record and the outbox event in the same database transaction. If the transaction commits, the event exists. If it rolls back, neither exists. No data loss. This pattern works identically in Go, PHP, and JavaScript — see `HealthX-Code-Examples.md` for implementation in all three languages.

2. **Relay service:** A lightweight service (can be written in any backend language the team is comfortable with) that:
   - Polls the outbox table every N seconds (start with 5 seconds, tune based on volume)
   - Reads pending events in order
   - POSTs to the target system's API
   - On success: marks as `published` with timestamp
   - On failure: increments `retry_count`, applies exponential backoff
   - After max retries (e.g. 5): marks as `failed`, triggers alert

3. **Idempotency:** The target system must handle duplicate deliveries safely. Each event has a UUID. The receiver checks whether it has already processed that UUID before acting.

```sql
-- Receiver side: idempotency check
CREATE TABLE processed_events (
    event_id    UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

4. **Ordering:** Events are processed in `created_at` order per `aggregate_id`. If event N for a prescription fails, events N+1, N+2 for the same prescription are held until N succeeds or is moved to the dead letter queue.

5. **Dead letter queue (DLQ):** Failed events after max retries are moved to a `integration_dlq` table with the error details. These require manual investigation.

6. **Audit trail:** The outbox and processed_events tables together form an immutable audit log of every data exchange. Retention policy aligned with healthcare regulations (assumption: 7 years minimum).

**Offline handling (if A9 is confirmed):**
- Events queue in the local outbox table during connectivity loss
- The relay service detects connectivity (simple health check to target) and pauses/resumes delivery
- On reconnect, events are delivered in order
- For bidirectional offline conflicts (both systems modified the same record while disconnected): prescription data uses EMR-wins (the clinician's record is authoritative); inventory data uses additive merge (sum the changes)

**Team effort:** 1-2 backend engineers. Uses familiar patterns: database transactions, SQL, REST, Go or JS.

**Success criteria:**
- Zero undetected sync failures (every failure is logged and alerted within 5 minutes)
- At-least-once delivery guarantee for all dispensing events
- Mean time from EMR prescription to pharmacy receipt < 30 seconds (online)
- Events queue locally and deliver on reconnect (if offline is confirmed)
- Full audit trail for every sync event

---

### Phase 3: Event Bus Introduction (Weeks 7-12)

**Goal:** Replace point-to-point relay with a centralised event bus that all systems can use. This is the foundation for TaaS.

**Trigger:** Phase 3 starts only when:
- Phase 2 is stable and the team has confidence in event-driven patterns
- A second integration use case emerges (e.g. telemedicine-EMR, billing-pharmacy)
- OR the TaaS roadmap requires externalisable event streams

**Broker selection (evaluate during Phase 2):**

| Broker | Pros | Cons | Recommendation |
|---|---|---|---|
| **NATS** | Lightweight, simple ops, Go-native, works well on modest infrastructure | Smaller ecosystem than Kafka/Rabbit | **Recommended for HealthX's scale.** Simple to operate, low resource footprint, JetStream provides persistence and replay |
| RabbitMQ | Mature, well-documented, good PHP/JS client libraries | Heavier than NATS, Erlang dependency | Good alternative if team has prior exposure |
| Redis Streams | Already likely in the stack (caching), minimal new infrastructure | Not designed as a primary message broker; limited consumer group features | Acceptable for very small scale only |
| Kafka | Industry standard, excellent at scale | Massive operational overhead (ZooKeeper/KRaft, partitions, consumer groups). Overkill for HealthX's scale | Not recommended |

**Migration strategy (zero downtime):**
1. Deploy the message broker alongside the existing relay service
2. Modify the relay service to publish events to the broker AND deliver via REST (dual-write)
3. Add broker subscribers to target systems
4. Verify consistency: compare events received via REST and via broker
5. Once verified, disable REST delivery and route all traffic through the broker
6. Decommission the relay service for that integration pair
7. Repeat for each system pair

**The outbox pattern survives this migration.** Each system still writes events to its outbox in the same transaction as the business write. The relay service is replaced by a connector that reads the outbox and publishes to the broker. The guarantee chain is preserved.

**TaaS event streaming:** Once the broker is in place, external TaaS clients can subscribe to event streams via authenticated API endpoints. Each tenant gets isolated topics/subjects. This is the technical foundation for Technology-as-a-Service.

**Team effort:** 1 backend engineer for broker setup + 1 engineer per system integration. Team should have event-driven confidence from Phase 2 by this point.

---

### Phase 4: Platform Hardening (Weeks 12-18+)

**Goal:** Production-grade platform capabilities for TaaS readiness.

**Deliverables:**
- **Tenant isolation:** Topic/subject namespacing per tenant, access control per topic
- **Schema registry:** Event payload schemas versioned and validated; consumers don't break when producers evolve
- **Monitoring and alerting:** Broker health, consumer lag, delivery latency, DLQ depth
- **Local-first offline (if validated in Phase 2):** Facility-level event store that syncs to central broker on reconnect, with conflict resolution per entity type
- **API gateway:** External-facing API for TaaS clients to subscribe to event streams, with authentication, rate limiting, and usage metering

**This phase is scoped based on TaaS timeline and is beyond the immediate EMR-pharmacy scenario.**

---

## 7. Deployment Topology

The hybrid on-premise/cloud infrastructure creates a networking dimension that the architecture must account for. This section describes where each component should run and how they would communicate across environment boundaries.

### Current State (Assumed)

```
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│         ON-PREMISE              │     │           CLOUD              │
│         (Facility)              │     │     (Cloud / Vendor)         │
│                                 │     │                              │
│  ┌─────────┐    ┌───────────┐   │     │   ┌──────────────┐          │
│  │   EMR   │───>│ Pharmacy  │   │     │   │ Mobile Apps  │          │
│  │  (Go?)  │<───│  (PHP?)   │   │     │   │  (Flutter)   │          │
│  └─────────┘    └───────────┘   │     │   └──────────────┘          │
│       Synchronous REST          │     │   ┌──────────────┐          │
│       (breaks on failure)       │     │   │  Web App     │          │
│                                 │     │   │  (React)     │          │
│                                 │     │   └──────────────┘          │
│                                 │     │   ┌──────────────┐          │
│                                 │     │   │ Telemedicine │          │
│                                 │     │   └──────────────┘          │
│                                 │     │   ┌──────────────┐          │
│                                 │     │   │    USSD      │          │
│                                 │     │   └──────────────┘          │
└─────────────────────────────────┘     └──────────────────────────────┘
          ▲                                        ▲
          └──────── Internet (unreliable) ─────────┘
```

The on-premise systems (EMR, pharmacy) connect to cloud services over internet links that may be unreliable due to load shedding and ISP outages. Synchronous REST calls between on-premise services are more reliable because they share the same LAN, but calls that cross the on-premise/cloud boundary are fragile.

### Target State (Phase 2: Outbox)

```
┌──────────────────────────────────────────┐
│              ON-PREMISE (Facility)        │
│                                          │
│  ┌─────────┐           ┌───────────┐     │
│  │   EMR   │           │ Pharmacy  │     │
│  │         │           │           │     │
│  │ ┌─────┐ │           │ ┌─────┐   │     │
│  │ │outbx│ │           │ │outbx│   │     │
│  │ └─────┘ │           │ └─────┘   │     │
│  └─────────┘           └───────────┘     │
│       │                      │           │
│       v                      v           │
│  ┌──────────────────────────────────┐    │
│  │        Relay Service             │    │
│  │  (runs on-prem, same LAN)       │    │
│  │  polls outboxes, delivers       │    │
│  │  locally (EMR↔Pharmacy)         │    │
│  │  AND to cloud services          │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
          │
          │ HTTPS (outbound only)
          │ queues locally if cloud unreachable
          v
┌──────────────────────────────────────────┐
│              CLOUD                       │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Mobile   │  │ Web App  │  │ Tele-  │ │
│  │ Apps     │  │          │  │ med    │ │
│  └──────────┘  └──────────┘  └────────┘ │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │      Cloud Relay Service         │    │
│  │  (receives from on-prem relay,   │    │
│  │   distributes to cloud systems)  │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

**Key deployment decisions:**

1. **Relay service runs on-premise, co-located with EMR and pharmacy.** This ensures local EMR-to-pharmacy delivery works even when internet connectivity is down. The relay reads outbox tables over the local network (fast, reliable) and delivers locally first, then forwards to cloud services over the internet link.

2. **Outbound-only internet traffic from on-premise.** The relay service pushes events to cloud endpoints. Cloud services never need to reach into on-premise systems. This simplifies firewall rules, avoids exposing on-premise services to the internet, and works with NAT/proxy setups common in Kenyan facility networks.

3. **Local queuing during cloud outages.** If the cloud endpoint is unreachable, events remain in the outbox table (on-premise database). The relay retries with backoff. No data is lost. When connectivity returns, events are delivered in order.

4. **Cloud relay receives and redistributes.** A lightweight cloud-side service receives events from on-premise relays and distributes to cloud-based consumers (mobile apps, web app, telemedicine). This is the entry point for cloud services into the event stream.

### Target State (Phase 3: Event Bus)

In Phase 3, the message broker runs in the cloud. On-premise relay services publish to it over the internet. Cloud services subscribe directly. The broker handles persistence, replay, and fan-out.

If internet reliability is a concern for broker connectivity, a lightweight local NATS instance can run on-premise as a buffer, syncing to the central cloud broker when connected (NATS supports leaf node topology for exactly this scenario).

### Multi-Facility Considerations

If HealthX operates multiple facilities, each facility would run its own on-premise relay service and outbox tables. All facilities would publish to the same cloud relay (Phase 2) or message broker (Phase 3). The event format includes a `facility_id` field for routing and tenant isolation.

---

## 8. Rollout Plan

```
Week    Phase              Key Milestone
──────────────────────────────────────────────────────────────
1       Observability      Structured logging deployed
2       Observability      Dashboard + alerting live; baseline measured
                           DECISION GATE: validate assumptions A6, A7 with real data
3-4     Outbox             Outbox tables + relay service deployed (EMR → Pharmacy)
5       Outbox             Bidirectional (Pharmacy → EMR); offline handling if A9 confirmed
                           DECISION GATE: reliability targets met? Second integration needed?
6       Stabilise          Bug fixes, performance tuning, team retrospective
7-9     Event Bus          Broker deployed; first integration migrated from relay to broker
10-12   Event Bus          Remaining integrations migrated; TaaS event streaming prototype
                           DECISION GATE: TaaS timeline confirmed?
12-18+  Hardening          Tenant isolation, schema registry, monitoring, local-first offline
```

**Estimates assume AI-assisted development.** The team is expected to use AI coding tools for implementation, which compresses the pure coding work within each phase. The timelines are still dominated by non-coding activities: deploying to production, waiting for baseline data to accumulate (Phase 1), integration testing against live healthcare systems (Phase 2), and running dual-write verification (Phase 3). Decision gates and validation periods do not compress with faster coding.

**Decision gates are explicit.** Each phase produces evidence that informs whether the next phase is necessary and how to scope it. This is the invest/pivot/scale discipline applied to architecture.

---

## 9. What I Would Validate During Team Engagement

When I meet the HealthX technical team, I will focus on:

1. **Confirm or invalidate the top-5 assumptions** — A1 (separate systems), A2 (REST point-to-point), A9 (offline), A10 (scale), A11 (team experience). Each one changes the architecture if wrong.
2. **Walk through a recent sync failure end-to-end** — From trigger to detection to resolution. This reveals the actual failure mode, not the assumed one.
3. **Understand the database schema** — Specifically the prescription and dispensing tables, their relationship, and any existing foreign keys or references across systems.
4. **Assess team readiness** — Not just "have they used message brokers?" but "have they debugged a distributed systems issue? How did they resolve it?" This tells me where the team is on the learning curve.
5. **Map the full integration topology** — Which systems talk to which, how, and where the pain points are beyond EMR-pharmacy. This validates whether the event bus (Phase 3) is needed or premature.
6. **Understand the TaaS vision concretely** — What would the first TaaS customer look like? What data/capabilities would they consume? This shapes the event model and API design.

---

## 10. Assumptions Register

For traceability, all assumptions have been listed here with their validation method and the impact if they turn out to be wrong.

| ID | Assumption | Validation Method | Impact if Wrong |
|---|---|---|---|
| A1 | EMR and pharmacy are separate apps/databases | Confirm with tech team | Architecture changes from distributed to application-level |
| A2 | Communication via synchronous REST, point-to-point | Confirm with tech team | If middleware exists, extend it instead |
| A3 | No centralised integration middleware | Confirm with tech team | Extend existing middleware |
| A4 | Custom-built, modifiable source code | Confirm with tech team | Work through external APIs/extension points |
| A5 | PostgreSQL and/or MySQL databases | Confirm with tech team | Affects CDC tooling choices |
| A6 | Failures occur multiple times per week, increasing | Phase 1 dashboard data | If rare, simpler solution sufficient |
| A7 | Failures detected manually, no automated alerting | Phase 1 deployment | If automated, skip to Phase 2 |
| A8 | No confirmed patient safety incidents | Confirm with clinical team | Elevates urgency if incidents occurred |
| A9 | Offline operation required at some facilities | Confirm with tech team | If not, simpler always-online architecture |
| A10 | 5-20 facilities, tens-hundreds daily transactions | Confirm with tech team | If larger, needs throughput design |
| A11 | Small team (3-8), REST-experienced, not event-driven | Confirm with tech team | If experienced, can skip to Phase 3 |
| A12 | Broader integration challenge across 6+ systems | Confirmed (systems landscape) | N/A — confirmed |
| A13 | TaaS requires multi-tenancy in medium term | Confirmed (strategic direction) | N/A — confirmed |

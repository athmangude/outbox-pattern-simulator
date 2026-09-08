# EMR-Pharmacy Sync: Code Examples

**Companion to: EMR-Pharmacy Sync Architecture Recommendation**
**Athman Gude | HealthX CTO Consultancy | September 2026**

These examples demonstrate the outbox pattern (Phase 2) in all three backend languages used at HealthX: Go, PHP, and JavaScript. The point is that the pattern is **language-agnostic** — the outbox table schema, event format, and relay protocol are the same regardless of which service produces or consumes events.

---

## Outbox Table Schema

This schema is shared across all services. Each service adds this table to its own database.

```sql
CREATE TABLE integration_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(100) NOT NULL,
    aggregate_id    VARCHAR(255) NOT NULL,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ,
    retry_count     INT DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'pending'
);

CREATE INDEX idx_outbox_status_created ON integration_outbox (status, created_at)
    WHERE status = 'pending';
```

## Idempotency Table (Receiver Side)

Each service that receives events adds this table to prevent duplicate processing.

```sql
CREATE TABLE processed_events (
    event_id        UUID PRIMARY KEY,
    event_type      VARCHAR(100) NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Dead Letter Queue Table

Failed events after max retries are moved here for manual investigation.

```sql
CREATE TABLE integration_dlq (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_id     UUID NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    aggregate_id    VARCHAR(255) NOT NULL,
    payload         JSONB NOT NULL,
    error_message   TEXT,
    failed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    retry_count     INT NOT NULL
);
```

---

## Event Format

All events follow this JSON structure regardless of source system or language.

```json
{
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "event_type": "prescription.created",
    "aggregate_id": "rx-2026-00142",
    "facility_id": "facility-nairobi-01",
    "source_system": "emr",
    "payload": {
        "prescription_id": "rx-2026-00142",
        "patient_id": "pat-anon-sha256hash",
        "items": [
            {
                "medication": "Amoxicillin 500mg",
                "quantity": 21,
                "dosage": "1 capsule 3x daily for 7 days"
            }
        ],
        "prescribed_by": "dr-id-00023",
        "prescribed_at": "2026-09-02T10:30:00+03:00"
    },
    "created_at": "2026-09-02T10:30:01+03:00"
}
```

**Notes:**
- `patient_id` is an anonymised identifier (SHA-256 hash), not PII, per DPA requirements
- `facility_id` enables multi-facility routing and future tenant isolation for TaaS
- `source_system` identifies which system produced the event
- The payload schema varies by `event_type` but the envelope is always the same

---

## 1. Producing Events — Go (EMR Service)

```go
package prescription

import (
    "context"
    "database/sql"
    "encoding/json"

    "github.com/google/uuid"
)

func CreatePrescription(ctx context.Context, db *sql.DB, rx Prescription) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // 1. Write the business record
    _, err = tx.ExecContext(ctx,
        `INSERT INTO prescriptions (id, patient_id, prescribed_by, prescribed_at, items)
         VALUES ($1, $2, $3, $4, $5)`,
        rx.ID, rx.PatientID, rx.PrescribedBy, rx.PrescribedAt, rx.ItemsJSON(),
    )
    if err != nil {
        return err
    }

    // 2. Write the outbox event in the SAME transaction
    payload, err := json.Marshal(rx.ToEventPayload())
    if err != nil {
        return err
    }

    _, err = tx.ExecContext(ctx,
        `INSERT INTO integration_outbox (id, event_type, aggregate_id, payload)
         VALUES ($1, $2, $3, $4)`,
        uuid.New().String(), "prescription.created", rx.ID, payload,
    )
    if err != nil {
        return err
    }

    // 3. Commit — both records exist, or neither does
    return tx.Commit()
}
```

---

## 2. Producing Events — PHP (Pharmacy Service)

```php
<?php

function recordDispense(PDO $db, array $dispense): void
{
    $db->beginTransaction();

    try {
        // 1. Write the business record
        $stmt = $db->prepare(
            'INSERT INTO dispenses (id, prescription_id, patient_id, dispensed_by, dispensed_at, items)
             VALUES (:id, :prescription_id, :patient_id, :dispensed_by, :dispensed_at, :items)'
        );
        $stmt->execute([
            ':id' => $dispense['id'],
            ':prescription_id' => $dispense['prescription_id'],
            ':patient_id' => $dispense['patient_id'],
            ':dispensed_by' => $dispense['dispensed_by'],
            ':dispensed_at' => $dispense['dispensed_at'],
            ':items' => json_encode($dispense['items']),
        ]);

        // 2. Write the outbox event in the SAME transaction
        $eventId = bin2hex(random_bytes(16));
        $payload = json_encode([
            'dispense_id' => $dispense['id'],
            'prescription_id' => $dispense['prescription_id'],
            'patient_id' => $dispense['patient_id'],
            'items' => $dispense['items'],
            'dispensed_by' => $dispense['dispensed_by'],
            'dispensed_at' => $dispense['dispensed_at'],
        ]);

        $stmt = $db->prepare(
            'INSERT INTO integration_outbox (id, event_type, aggregate_id, payload)
             VALUES (:id, :event_type, :aggregate_id, :payload)'
        );
        $stmt->execute([
            ':id' => $eventId,
            ':event_type' => 'dispense.completed',
            ':aggregate_id' => $dispense['id'],
            ':payload' => $payload,
        ]);

        // 3. Commit — both records exist, or neither does
        $db->commit();
    } catch (Exception $e) {
        $db->rollBack();
        throw $e;
    }
}
```

---

## 3. Producing Events — JavaScript/Node.js

```javascript
async function createPrescription(pool, prescription) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Write the business record
        await client.query(
            `INSERT INTO prescriptions (id, patient_id, prescribed_by, prescribed_at, items)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                prescription.id,
                prescription.patientId,
                prescription.prescribedBy,
                prescription.prescribedAt,
                JSON.stringify(prescription.items),
            ]
        );

        // 2. Write the outbox event in the SAME transaction
        const eventId = crypto.randomUUID();
        const payload = JSON.stringify({
            prescription_id: prescription.id,
            patient_id: prescription.patientId,
            items: prescription.items,
            prescribed_by: prescription.prescribedBy,
            prescribed_at: prescription.prescribedAt,
        });

        await client.query(
            `INSERT INTO integration_outbox (id, event_type, aggregate_id, payload)
             VALUES ($1, $2, $3, $4)`,
            [eventId, 'prescription.created', prescription.id, payload]
        );

        // 3. Commit — both records exist, or neither does
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
```

---

## 4. Consuming Events — Idempotent Receiver (Go)

This pattern applies to any service receiving events, regardless of language. The receiver checks whether it has already processed an event before acting.

```go
func HandleEvent(ctx context.Context, db *sql.DB, event IntegrationEvent) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // 1. Check idempotency — have we already processed this event?
    var exists bool
    err = tx.QueryRowContext(ctx,
        `SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1)`,
        event.ID,
    ).Scan(&exists)
    if err != nil {
        return err
    }
    if exists {
        // Already processed — acknowledge and skip
        return nil
    }

    // 2. Process the event (business logic)
    switch event.EventType {
    case "prescription.created":
        err = processPrescription(ctx, tx, event.Payload)
    case "dispense.completed":
        err = processDispense(ctx, tx, event.Payload)
    default:
        // Unknown event type — log and skip, don't fail
        log.Printf("unknown event type: %s", event.EventType)
        return nil
    }
    if err != nil {
        return err
    }

    // 3. Record that we processed this event (in the same transaction)
    _, err = tx.ExecContext(ctx,
        `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)`,
        event.ID, event.EventType,
    )
    if err != nil {
        return err
    }

    return tx.Commit()
}
```

---

## 5. Consuming Events — Idempotent Receiver (PHP)

```php
<?php

function handleEvent(PDO $db, array $event): void
{
    $db->beginTransaction();

    try {
        // 1. Check idempotency
        $stmt = $db->prepare(
            'SELECT COUNT(*) FROM processed_events WHERE event_id = :event_id'
        );
        $stmt->execute([':event_id' => $event['id']]);
        if ($stmt->fetchColumn() > 0) {
            $db->rollBack();
            return; // Already processed
        }

        // 2. Process the event
        switch ($event['event_type']) {
            case 'prescription.created':
                processPrescription($db, $event['payload']);
                break;
            case 'dispense.completed':
                processDispense($db, $event['payload']);
                break;
            default:
                error_log("Unknown event type: " . $event['event_type']);
                $db->rollBack();
                return;
        }

        // 3. Record that we processed this event
        $stmt = $db->prepare(
            'INSERT INTO processed_events (event_id, event_type) VALUES (:event_id, :event_type)'
        );
        $stmt->execute([
            ':event_id' => $event['id'],
            ':event_type' => $event['event_type'],
        ]);

        $db->commit();
    } catch (Exception $e) {
        $db->rollBack();
        throw $e;
    }
}
```

---

## 6. Consuming Events — Idempotent Receiver (JavaScript/Node.js)

```javascript
async function handleEvent(pool, event) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Check idempotency
        const { rows } = await client.query(
            'SELECT 1 FROM processed_events WHERE event_id = $1',
            [event.id]
        );
        if (rows.length > 0) {
            await client.query('ROLLBACK');
            return; // Already processed
        }

        // 2. Process the event
        switch (event.event_type) {
            case 'prescription.created':
                await processPrescription(client, event.payload);
                break;
            case 'dispense.completed':
                await processDispense(client, event.payload);
                break;
            default:
                console.warn(`Unknown event type: ${event.event_type}`);
                await client.query('ROLLBACK');
                return;
        }

        // 3. Record that we processed this event
        await client.query(
            'INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)',
            [event.id, event.event_type]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
```

---

## 7. Relay Service (Go)

The relay service polls the outbox and delivers events. This example is in Go, but could be written in any language. There is one relay service per facility, running on the same network as the EMR and pharmacy databases.

```go
package main

import (
    "bytes"
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log"
    "math"
    "net/http"
    "time"
)

const (
    pollInterval = 5 * time.Second
    maxRetries   = 5
    batchSize    = 50
)

type RelayConfig struct {
    SourceDB    *sql.DB
    TargetURL   string
    SourceName  string
}

func RunRelay(ctx context.Context, config RelayConfig) {
    ticker := time.NewTicker(pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := pollAndDeliver(ctx, config); err != nil {
                log.Printf("[relay:%s] poll error: %v", config.SourceName, err)
            }
        }
    }
}

func pollAndDeliver(ctx context.Context, config RelayConfig) error {
    rows, err := config.SourceDB.QueryContext(ctx,
        `SELECT id, event_type, aggregate_id, payload, retry_count
         FROM integration_outbox
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1`,
        batchSize,
    )
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        var (
            id          string
            eventType   string
            aggregateID string
            payload     json.RawMessage
            retryCount  int
        )
        if err := rows.Scan(&id, &eventType, &aggregateID, &payload, &retryCount); err != nil {
            log.Printf("[relay:%s] scan error: %v", config.SourceName, err)
            continue
        }

        event := map[string]interface{}{
            "id":           id,
            "event_type":   eventType,
            "aggregate_id": aggregateID,
            "payload":      payload,
        }

        body, _ := json.Marshal(event)
        resp, err := http.Post(config.TargetURL, "application/json", bytes.NewReader(body))

        if err != nil || resp.StatusCode >= 400 {
            // Delivery failed — increment retry or move to DLQ
            newRetry := retryCount + 1
            if newRetry >= maxRetries {
                moveToDLQ(ctx, config.SourceDB, id, eventType, aggregateID, payload, retryCount, fmt.Sprintf("max retries exceeded: %v", err))
            } else {
                config.SourceDB.ExecContext(ctx,
                    `UPDATE integration_outbox SET retry_count = $1 WHERE id = $2`,
                    newRetry, id,
                )
                // Exponential backoff: skip this event for now, it will be retried next poll
                // In production, use a next_retry_at timestamp column for proper backoff
            }
            continue
        }
        resp.Body.Close()

        // Delivery succeeded — mark as published
        config.SourceDB.ExecContext(ctx,
            `UPDATE integration_outbox SET status = 'published', published_at = now() WHERE id = $1`,
            id,
        )
    }
    return nil
}

func moveToDLQ(ctx context.Context, db *sql.DB, id, eventType, aggregateID string, payload json.RawMessage, retryCount int, errMsg string) {
    db.ExecContext(ctx,
        `INSERT INTO integration_dlq (original_id, event_type, aggregate_id, payload, error_message, retry_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        id, eventType, aggregateID, payload, errMsg, retryCount,
    )
    db.ExecContext(ctx,
        `UPDATE integration_outbox SET status = 'failed' WHERE id = $1`,
        id,
    )
    log.Printf("[relay:DLQ] event %s moved to DLQ: %s", id, errMsg)
}
```

---

## 8. Reconciliation Query

This query runs against both databases (or a replicated view) to find discrepancies between prescriptions and dispenses. This is the core of Phase 1 observability.

```sql
-- Prescriptions created in EMR that have no matching dispense in Pharmacy
SELECT
    p.id AS prescription_id,
    p.patient_id,
    p.prescribed_at,
    p.prescribed_by,
    EXTRACT(EPOCH FROM (now() - p.prescribed_at)) / 3600 AS hours_since_prescribed
FROM prescriptions p
LEFT JOIN dispenses d ON d.prescription_id = p.id
WHERE d.id IS NULL
  AND p.prescribed_at > now() - INTERVAL '48 hours'
ORDER BY p.prescribed_at ASC;

-- Dispenses recorded in Pharmacy that reference a prescription not found in EMR
SELECT
    d.id AS dispense_id,
    d.prescription_id,
    d.patient_id,
    d.dispensed_at
FROM dispenses d
LEFT JOIN prescriptions p ON p.id = d.prescription_id
WHERE p.id IS NULL
  AND d.dispensed_at > now() - INTERVAL '48 hours'
ORDER BY d.dispensed_at ASC;
```

**Note:** These queries assume the ability to query across both databases (via foreign data wrapper, a replicated read replica, or running separately against each database and comparing results in the relay service). The specific approach depends on the database setup confirmed by the HealthX technical team.

---

## Summary

The same pattern in three languages:

| Step | Go | PHP | JavaScript |
|---|---|---|---|
| Begin transaction | `db.BeginTx()` | `$db->beginTransaction()` | `client.query('BEGIN')` |
| Write business record | `tx.ExecContext()` | `$stmt->execute()` | `client.query()` |
| Write outbox event | `tx.ExecContext()` | `$stmt->execute()` | `client.query()` |
| Commit | `tx.Commit()` | `$db->commit()` | `client.query('COMMIT')` |
| Check idempotency | `tx.QueryRowContext()` | `$stmt->fetchColumn()` | `client.query()` |

The database transaction is the integration contract. The language is an implementation detail.

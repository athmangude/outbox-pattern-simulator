"use client";

import { useState, useCallback, useEffect, useRef } from "react";

type EventStatus = "pending" | "in_transit" | "delivered" | "failed" | "dlq";

interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  patientName: string;
  medication: string;
  createdAt: number;
  publishedAt: number | null;
  retryCount: number;
  status: EventStatus;
  maxRetries: number;
}

interface ProcessedEvent {
  eventId: string;
  processedAt: number;
  duplicate: boolean;
}

interface LogEntry {
  id: string;
  timestamp: number;
  source: "emr" | "relay" | "pharmacy" | "system";
  message: string;
  level: "info" | "warn" | "error" | "success";
}

const PATIENT_NAMES = [
  "Amina Hassan", "James Ochieng", "Fatma Ali", "Peter Kamau",
  "Grace Wanjiku", "Mohamed Salim", "Sarah Njeri", "David Mwangi",
  "Halima Omar", "Joseph Kipchoge", "Agnes Wairimu", "Hassan Abdi",
];

const MEDICATIONS = [
  "Amoxicillin 500mg", "Metformin 850mg", "Paracetamol 1g",
  "Omeprazole 20mg", "Amlodipine 5mg", "Azithromycin 250mg",
  "Ibuprofen 400mg", "Ciprofloxacin 500mg", "Losartan 50mg",
  "Doxycycline 100mg", "Cetirizine 10mg", "Atorvastatin 20mg",
];

let eventCounter = 0;
let logCounter = 0;

function generateId(): string {
  return `evt_${++eventCounter}_${Date.now().toString(36)}`;
}

function generateLogId(): string {
  return `log_${++logCounter}`;
}

function generatePrescriptionId(): string {
  return `RX-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

export default function Simulator() {
  const [outbox, setOutbox] = useState<OutboxEvent[]>([]);
  const [processedEvents, setProcessedEvents] = useState<ProcessedEvent[]>([]);
  const [dlq, setDlq] = useState<OutboxEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pharmacyOnline, setPharmacyOnline] = useState(true);
  const [internetConnected, setInternetConnected] = useState(true);
  const [relayActive, setRelayActive] = useState(true);
  const [networkBlipArmed, setNetworkBlipArmed] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [stats, setStats] = useState({
    created: 0,
    delivered: 0,
    failed: 0,
    dlqCount: 0,
    duplicatesBlocked: 0,
  });

  const logsEndRef = useRef<HTMLDivElement>(null);
  const outboxRef = useRef(outbox);
  const pharmacyOnlineRef = useRef(pharmacyOnline);
  const internetConnectedRef = useRef(internetConnected);
  const relayActiveRef = useRef(relayActive);
  const speedRef = useRef(speed);
  const processedRef = useRef(processedEvents);
  const networkBlipRef = useRef(networkBlipArmed);

  useEffect(() => { outboxRef.current = outbox; }, [outbox]);
  useEffect(() => { pharmacyOnlineRef.current = pharmacyOnline; }, [pharmacyOnline]);
  useEffect(() => { internetConnectedRef.current = internetConnected; }, [internetConnected]);
  useEffect(() => { relayActiveRef.current = relayActive; }, [relayActive]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { processedRef.current = processedEvents; }, [processedEvents]);
  useEffect(() => { networkBlipRef.current = networkBlipArmed; }, [networkBlipArmed]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((source: LogEntry["source"], message: string, level: LogEntry["level"] = "info") => {
    setLogs(prev => {
      const next = [...prev, { id: generateLogId(), timestamp: Date.now(), source, message, level }];
      return next.slice(-100);
    });
  }, []);

  const createPrescription = useCallback(() => {
    const patientName = PATIENT_NAMES[Math.floor(Math.random() * PATIENT_NAMES.length)];
    const medication = MEDICATIONS[Math.floor(Math.random() * MEDICATIONS.length)];
    const prescriptionId = generatePrescriptionId();

    const event: OutboxEvent = {
      id: generateId(),
      eventType: "prescription.created",
      aggregateId: prescriptionId,
      patientName,
      medication,
      createdAt: Date.now(),
      publishedAt: null,
      retryCount: 0,
      status: "pending",
      maxRetries: 5,
    };

    setOutbox(prev => [event, ...prev]);
    setStats(prev => ({ ...prev, created: prev.created + 1 }));
    addLog("emr", `BEGIN TRANSACTION`, "info");
    addLog("emr", `INSERT prescription ${prescriptionId} for ${patientName} (${medication})`, "info");
    addLog("emr", `INSERT outbox event ${event.id.slice(0, 12)}... (same transaction)`, "info");
    addLog("emr", `COMMIT — prescription + event guaranteed`, "success");
  }, [addLog]);

  // Relay polling loop
  useEffect(() => {
    const interval = setInterval(() => {
      if (!relayActiveRef.current) return;

      const pending = outboxRef.current.filter(e => e.status === "pending");
      if (pending.length === 0) return;

      const event = pending[pending.length - 1]; // oldest first (FIFO)
      addLog("relay", `Polling outbox... found ${pending.length} pending event(s)`, "info");

      if (!internetConnectedRef.current) {
        addLog("relay", `Relay disconnected — event ${event.id.slice(0, 12)}... queued locally`, "warn");
        return;
      }

      // Mark as in_transit
      setOutbox(prev => prev.map(e =>
        e.id === event.id ? { ...e, status: "in_transit" as EventStatus } : e
      ));
      addLog("relay", `POST /pharmacy/events — delivering ${event.id.slice(0, 12)}...`, "info");

      // Simulate delivery with delay
      setTimeout(() => {
        if (!pharmacyOnlineRef.current) {
          const newRetryCount = event.retryCount + 1;
          const backoffSeconds = Math.pow(2, newRetryCount);

          if (newRetryCount >= event.maxRetries) {
            setOutbox(prev => prev.map(e =>
              e.id === event.id ? { ...e, status: "dlq" as EventStatus, retryCount: newRetryCount } : e
            ));
            setDlq(prev => [{ ...event, status: "dlq", retryCount: newRetryCount }, ...prev]);
            setStats(prev => ({ ...prev, failed: prev.failed + 1, dlqCount: prev.dlqCount + 1 }));
            addLog("relay", `Max retries (${event.maxRetries}) exhausted for ${event.id.slice(0, 12)}... — moved to DLQ`, "error");
          } else {
            setOutbox(prev => prev.map(e =>
              e.id === event.id ? { ...e, status: "pending" as EventStatus, retryCount: newRetryCount } : e
            ));
            addLog("relay", `Pharmacy unavailable — retry ${newRetryCount}/${event.maxRetries} in ${backoffSeconds}s (backoff)`, "warn");
          }
        } else {
          // Check idempotency
          const alreadyProcessed = processedRef.current.some(p => p.eventId === event.id);

          if (alreadyProcessed) {
            setOutbox(prev => prev.map(e =>
              e.id === event.id ? { ...e, status: "delivered" as EventStatus, publishedAt: Date.now() } : e
            ));
            setStats(prev => ({ ...prev, duplicatesBlocked: prev.duplicatesBlocked + 1 }));
            addLog("pharmacy", `SELECT FROM processed_events WHERE event_id = '${event.id.slice(0, 12)}...' — FOUND`, "warn");
            addLog("pharmacy", `DUPLICATE BLOCKED: ${event.id.slice(0, 12)}... already dispensed — idempotency key prevented double-dispense`, "warn");
            addLog("relay", `HTTP 200 OK (duplicate acknowledged) — marking ${event.id.slice(0, 12)}... as delivered`, "success");
          } else if (networkBlipRef.current) {
            // Network blip: pharmacy processes the event but ACK is lost
            setProcessedEvents(prev => [{ eventId: event.id, processedAt: Date.now(), duplicate: false }, ...prev]);
            setStats(prev => ({ ...prev, delivered: prev.delivered + 1 }));
            addLog("pharmacy", `Event ${event.id.slice(0, 12)}... received`, "info");
            addLog("pharmacy", `Idempotency check: SELECT FROM processed_events WHERE event_id = '${event.id.slice(0, 12)}...' — NOT FOUND`, "info");
            addLog("pharmacy", `Dispensing ${event.medication} for ${event.patientName} (${event.aggregateId})`, "success");
            addLog("pharmacy", `INSERT processed_events (${event.id.slice(0, 12)}...)`, "success");
            addLog("pharmacy", `HTTP 200 OK sent to relay...`, "success");

            // But the relay never receives the ACK
            addLog("relay", `NETWORK BLIP: TCP connection reset — HTTP response from pharmacy was lost in transit`, "error");
            addLog("relay", `Relay has no confirmation that ${event.id.slice(0, 12)}... was processed — will retry delivery`, "warn");

            const newRetryCount = event.retryCount + 1;
            setOutbox(prev => prev.map(e =>
              e.id === event.id ? { ...e, status: "pending" as EventStatus, retryCount: newRetryCount } : e
            ));

            // Auto-disarm after one use
            setNetworkBlipArmed(false);
          } else {
            setOutbox(prev => prev.map(e =>
              e.id === event.id ? { ...e, status: "delivered" as EventStatus, publishedAt: Date.now() } : e
            ));
            setProcessedEvents(prev => [{ eventId: event.id, processedAt: Date.now(), duplicate: false }, ...prev]);
            setStats(prev => ({ ...prev, delivered: prev.delivered + 1 }));
            addLog("pharmacy", `Event ${event.id.slice(0, 12)}... received`, "info");
            addLog("pharmacy", `Idempotency check: SELECT FROM processed_events WHERE event_id = '${event.id.slice(0, 12)}...' — NOT FOUND`, "info");
            addLog("pharmacy", `Dispensing ${event.medication} for ${event.patientName} (${event.aggregateId})`, "success");
            addLog("pharmacy", `INSERT processed_events (${event.id.slice(0, 12)}...)`, "success");
          }
        }
      }, 800 / speedRef.current);

    }, 2500 / speed);

    return () => clearInterval(interval);
  }, [speed, addLog]);

  const togglePharmacy = () => {
    const next = !pharmacyOnline;
    setPharmacyOnline(next);
    addLog("system", next ? "Pharmacy system is back ONLINE" : "Pharmacy system went OFFLINE", next ? "success" : "error");
  };

  const toggleInternet = () => {
    const next = !internetConnected;
    setInternetConnected(next);
    addLog("system", next ? "Relay connectivity RESTORED — polling will resume delivery" : "Relay connectivity LOST — cannot reach pharmacy endpoint", next ? "success" : "error");
  };

  const retryDlq = () => {
    if (dlq.length === 0) return;
    const event = dlq[0];
    setDlq(prev => prev.slice(1));
    setOutbox(prev => prev.map(e =>
      e.id === event.id ? { ...e, status: "pending" as EventStatus, retryCount: 0 } : e
    ));
    setStats(prev => ({ ...prev, dlqCount: prev.dlqCount - 1 }));
    addLog("system", `DLQ event ${event.id.slice(0, 12)}... requeued for delivery`, "info");
  };

  const sourceColors: Record<LogEntry["source"], string> = {
    emr: "text-blue-400",
    relay: "text-amber-400",
    pharmacy: "text-emerald-400",
    system: "text-purple-400",
  };

  const levelColors: Record<LogEntry["level"], string> = {
    info: "text-slate-400",
    warn: "text-yellow-300",
    error: "text-red-400",
    success: "text-emerald-400",
  };

  const statusBadge = (status: EventStatus) => {
    const styles: Record<EventStatus, string> = {
      pending: "bg-yellow-900/50 text-yellow-300 border-yellow-700",
      in_transit: "bg-blue-900/50 text-blue-300 border-blue-700",
      delivered: "bg-emerald-900/50 text-emerald-300 border-emerald-700",
      failed: "bg-red-900/50 text-red-300 border-red-700",
      dlq: "bg-red-950/50 text-red-400 border-red-800",
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs font-mono border ${styles[status]}`}>
        {status === "in_transit" ? "in transit" : status}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-[#0f172a] p-4 md:p-6">
      {/* Header */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Outbox Pattern Simulator</h1>
            <p className="text-slate-400 text-sm mt-1">
              EMR-Pharmacy Sync &mdash; HealthX Architecture Recommendation
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={createPrescription}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              + Create Prescription
            </button>
            <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-1.5">
              <span className="text-xs text-slate-400">Speed:</span>
              {[1, 2, 5].map(s => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2 py-0.5 text-xs rounded cursor-pointer ${speed === s ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"}`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="max-w-7xl mx-auto mb-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div className="bg-slate-800/50 rounded-lg px-4 py-3 border border-slate-700/50">
            <div className="text-xs text-slate-400">Created</div>
            <div className="text-xl font-bold text-blue-400 font-mono">{stats.created}</div>
          </div>
          <div className="bg-slate-800/50 rounded-lg px-4 py-3 border border-slate-700/50">
            <div className="text-xs text-slate-400">Delivered</div>
            <div className="text-xl font-bold text-emerald-400 font-mono">{stats.delivered}</div>
          </div>
          <div className="bg-slate-800/50 rounded-lg px-4 py-3 border border-slate-700/50">
            <div className="text-xs text-slate-400">Pending</div>
            <div className="text-xl font-bold text-yellow-400 font-mono">
              {outbox.filter(e => e.status === "pending" || e.status === "in_transit").length}
            </div>
          </div>
          <div className="bg-slate-800/50 rounded-lg px-4 py-3 border border-slate-700/50">
            <div className="text-xs text-slate-400">Dead Letter Queue</div>
            <div className="text-xl font-bold text-red-400 font-mono">{stats.dlqCount}</div>
          </div>
          <div className="bg-slate-800/50 rounded-lg px-4 py-3 border border-slate-700/50">
            <div className="text-xs text-slate-400">Duplicates Blocked</div>
            <div className="text-xl font-bold text-purple-400 font-mono">{stats.duplicatesBlocked}</div>
          </div>
        </div>
      </div>

      {/* Architecture diagram with controls */}
      <div className="max-w-7xl mx-auto mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* EMR System */}
          <div className="bg-slate-800/50 rounded-xl border border-blue-800/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2.5 h-2.5 rounded-full bg-blue-400"></div>
              <h2 className="text-sm font-bold text-blue-300">EMR System</h2>
            </div>
            <div className="text-xs text-slate-400 mb-3">
              Writes prescription + outbox event in the same database transaction. If the write succeeds, the event is guaranteed to exist.
            </div>
            <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-blue-400">integration_outbox</span>
                <span className="text-xs text-slate-500">{outbox.length} row(s)</span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {outbox.length === 0 ? (
                  <div className="text-xs text-slate-600 italic py-4 text-center">No events yet — create a prescription</div>
                ) : (
                  outbox.slice(0, 20).map(event => (
                    <div key={event.id} className="flex items-center justify-between gap-2 py-1 px-2 rounded bg-slate-800/50 event-row">
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-slate-300 truncate">{event.aggregateId}</div>
                        <div className="text-xs text-slate-500 truncate">{event.patientName}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {event.retryCount > 0 && event.status !== "delivered" && (
                          <span className="text-xs font-mono text-yellow-500">{event.retryCount}/{event.maxRetries}</span>
                        )}
                        {statusBadge(event.status)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Relay Service */}
          <div className="bg-slate-800/50 rounded-xl border border-amber-800/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2.5 h-2.5 rounded-full ${relayActive ? "bg-amber-400" : "bg-slate-600"}`}
                   style={relayActive ? { animation: "pulse-dot 2s infinite" } : {}}></div>
              <h2 className="text-sm font-bold text-amber-300">Network Controls</h2>
              <span className={`text-xs px-2 py-0.5 rounded ${relayActive ? "bg-amber-900/50 text-amber-300" : "bg-slate-700 text-slate-400"}`}>
                {relayActive ? "polling" : "stopped"}
              </span>
            </div>
            <div className="text-xs text-slate-400 mb-3">
              Polls the outbox table, delivers events to the pharmacy via REST. Retries with exponential backoff on failure.
            </div>

            {/* Controls */}
            <div className="space-y-2 mb-3">
              <button
                onClick={togglePharmacy}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer border ${
                  pharmacyOnline
                    ? "bg-emerald-950/50 border-emerald-800 text-emerald-300 hover:bg-emerald-900/50"
                    : "bg-red-950/50 border-red-800 text-red-300 hover:bg-red-900/50"
                }`}
              >
                <span>Pharmacy</span>
                <span className="text-xs font-mono">{pharmacyOnline ? "ONLINE" : "OFFLINE"}</span>
              </button>
              <button
                onClick={toggleInternet}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer border ${
                  internetConnected
                    ? "bg-emerald-950/50 border-emerald-800 text-emerald-300 hover:bg-emerald-900/50"
                    : "bg-red-950/50 border-red-800 text-red-300 hover:bg-red-900/50"
                }`}
              >
                <span>Relay</span>
                <span className="text-xs font-mono">{internetConnected ? "CONNECTED" : "DISCONNECTED"}</span>
              </button>
              <button
                onClick={() => {
                  setNetworkBlipArmed(true);
                  addLog("system", "Network blip ARMED — next delivery will reach the pharmacy but the HTTP acknowledgment will be lost, causing a duplicate retry", "warn");
                }}
                disabled={networkBlipArmed}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer border ${
                  networkBlipArmed
                    ? "bg-orange-950/50 border-orange-700 text-orange-300 animate-pulse"
                    : "bg-slate-800/50 border-slate-600 text-slate-300 hover:bg-orange-950/30 hover:border-orange-800 hover:text-orange-300"
                }`}
              >
                <span>Network Blip</span>
                <span className="text-xs font-mono">{networkBlipArmed ? "ARMED" : "READY"}</span>
              </button>
            </div>

            {/* DLQ */}
            {dlq.length > 0 && (
              <div className="bg-red-950/30 rounded-lg p-3 border border-red-900/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono text-red-400">integration_dlq</span>
                  <button
                    onClick={retryDlq}
                    className="text-xs px-2 py-0.5 rounded bg-red-900/50 text-red-300 hover:bg-red-800/50 cursor-pointer"
                  >
                    Retry oldest
                  </button>
                </div>
                <div className="space-y-1">
                  {dlq.slice(0, 5).map(event => (
                    <div key={event.id} className="text-xs font-mono text-red-400/80 truncate">
                      {event.aggregateId} — {event.patientName} ({event.medication})
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Pharmacy System */}
          <div className="bg-slate-800/50 rounded-xl border border-emerald-800/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2.5 h-2.5 rounded-full ${pharmacyOnline ? "bg-emerald-400" : "bg-red-400"}`}></div>
              <h2 className="text-sm font-bold text-emerald-300">Pharmacy System</h2>
              <span className={`text-xs px-2 py-0.5 rounded ${pharmacyOnline ? "bg-emerald-900/50 text-emerald-300" : "bg-red-900/50 text-red-300"}`}>
                {pharmacyOnline ? "online" : "offline"}
              </span>
            </div>
            <div className="text-xs text-slate-400 mb-3">
              Receives events, checks idempotency (has this UUID been processed before?), then dispenses medication.
            </div>
            <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-emerald-400">processed_events</span>
                <span className="text-xs text-slate-500">{processedEvents.length} row(s)</span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {processedEvents.length === 0 ? (
                  <div className="text-xs text-slate-600 italic py-4 text-center">No events processed yet</div>
                ) : (
                  processedEvents.slice(0, 20).map(pe => {
                    const event = outbox.find(e => e.id === pe.eventId);
                    return (
                      <div key={pe.eventId} className="flex items-center justify-between gap-2 py-1 px-2 rounded bg-slate-800/50 event-row">
                        <div className="min-w-0">
                          <div className="text-xs font-mono text-slate-300 truncate">{event?.aggregateId || pe.eventId.slice(0, 12)}</div>
                          <div className="text-xs text-slate-500 truncate">{event?.medication}</div>
                        </div>
                        <span className="text-xs text-emerald-500 shrink-0">dispensed</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Event Log */}
      <div className="max-w-7xl mx-auto">
        <div className="bg-slate-900/80 rounded-xl border border-slate-700/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-300">Event Log</h2>
            <button
              onClick={() => setLogs([])}
              className="text-xs text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              Clear
            </button>
          </div>
          <div className="h-52 overflow-y-auto font-mono text-xs space-y-0.5">
            {logs.length === 0 ? (
              <div className="text-slate-600 italic py-8 text-center text-sm font-sans">
                Create a prescription to start the simulation
              </div>
            ) : (
              logs.map(log => (
                <div key={log.id} className="flex gap-2 py-0.5 hover:bg-slate-800/50 rounded px-1">
                  <span className="text-slate-600 shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString("en-GB", { hour12: false })}
                  </span>
                  <span className={`shrink-0 w-16 text-right ${sourceColors[log.source]}`}>
                    [{log.source}]
                  </span>
                  <span className={levelColors[log.level]}>{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="max-w-7xl mx-auto mt-6 text-center">
        <p className="text-xs text-slate-600">
          Athman Gude &mdash; HealthX CTO Consultancy &mdash; September 2026
        </p>
      </div>
    </div>
  );
}

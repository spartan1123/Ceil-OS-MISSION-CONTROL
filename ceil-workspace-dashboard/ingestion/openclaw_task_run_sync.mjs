#!/usr/bin/env node
/**
 * OpenClaw authoritative task-run sync -> Supabase
 *
 * Features:
 * - Authoritative run table upsert (public.agent_task_runs) by run_id
 * - Immediate terminal write (completed/failed)
 * - Supplemental agent_logs upsert on terminal state
 * - Idempotency key: run_id::agent_name
 * - Retry queue with exponential backoff + jitter
 * - Pending sync marker so terminal state is never blocked forever
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node openclaw_task_run_sync.mjs
 *
 * Events:
 *   POST /events with JSON payload containing (directly or in nested fields):
 *   run_id|task_id, agent_name, status, started_at, completed_at, task_description, model_used
 */

import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = Number(process.env.OPENCLAW_SYNC_PORT || 8787);
const QUEUE_FILE = process.env.OPENCLAW_SYNC_QUEUE_FILE || path.resolve(process.cwd(), ".task-sync-queue.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const TERMINAL = new Set(["completed", "failed"]);

/** @type {Array<{event: any, attempts: number, nextAttemptAt: number, lastError?: string}>} */
let retryQueue = [];
let queueBusy = false;

function nowIso() {
  return new Date().toISOString();
}

function toIso(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function normalizeStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s.includes("complete") || s === "success" || s === "done") return "completed";
  if (s.includes("fail") || s.includes("error") || s.includes("cancel") || s === "aborted") return "failed";
  if (s.includes("run") || s.includes("progress") || s.includes("start") || s === "spawned") return "in_progress";
  return s || "in_progress";
}

function eventIdempotencyKey(event) {
  return `${event.run_id}::${event.agent_name}`;
}

function inferDurationMs(startedAt, completedAt, currentDuration) {
  if (Number.isFinite(Number(currentDuration))) return Number(currentDuration);
  if (!startedAt || !completedAt) return null;
  const delta = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function normalizeEvent(input) {
  const src = input?.event ?? input?.payload ?? input ?? {};

  const runId = src.run_id || src.task_id || src.id;
  const agentName = src.agent_name || src.agent || src.worker_name;
  if (!runId || !agentName) {
    throw new Error("Event missing run_id/task_id or agent_name.");
  }

  const status = normalizeStatus(src.status || src.state || src.event_type);
  const startedAt = toIso(src.started_at || src.startedAt, nowIso());
  const completedAt = TERMINAL.has(status) ? toIso(src.completed_at || src.completedAt || src.finished_at, nowIso()) : toIso(src.completed_at || src.completedAt || src.finished_at, null);

  return {
    run_id: String(runId),
    agent_name: String(agentName),
    task_description: src.task_description ?? src.task ?? src.description ?? null,
    model_used: src.model_used ?? src.model ?? null,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: inferDurationMs(startedAt, completedAt, src.duration_ms ?? src.durationMs),
    source: "authoritative_event",
  };
}

async function supabaseRest(pathname, { method = "GET", body = null, prefer = null } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase REST ${method} ${pathname} failed (${res.status}): ${text}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function upsertAgentTaskRun(event, { syncState = "synced", pendingSync = false, retryCount = 0, lastError = null } = {}) {
  const payload = {
    run_id: event.run_id,
    agent_name: event.agent_name,
    task_description: event.task_description,
    model_used: event.model_used,
    status: event.status,
    started_at: event.started_at,
    completed_at: event.completed_at,
    duration_ms: event.duration_ms,
    source: event.source || "authoritative_event",
    sync_state: syncState,
    pending_sync: pendingSync,
    retry_count: retryCount,
    last_error: lastError,
    last_seen_at: nowIso(),
  };

  await supabaseRest("agent_task_runs?on_conflict=run_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [payload],
  });
}

async function upsertAgentLogTerminal(event) {
  if (!TERMINAL.has(event.status)) return;

  const payload = {
    agent_name: event.agent_name,
    task_description: event.task_description,
    model_used: event.model_used,
    status: event.status,
    created_at: event.completed_at || nowIso(),
    run_id: event.run_id,
    source: "authoritative_event",
    idempotency_key: eventIdempotencyKey(event),
  };

  await supabaseRest("agent_logs?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [payload],
  });
}

async function persistQueue() {
  const tmp = `${QUEUE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(retryQueue, null, 2), "utf8");
  await fs.rename(tmp, QUEUE_FILE);
}

async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf8");
    retryQueue = JSON.parse(raw);
    if (!Array.isArray(retryQueue)) retryQueue = [];
  } catch {
    retryQueue = [];
  }
}

function nextBackoffMs(attempts) {
  const base = Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(10, attempts));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

async function enqueueRetry(event, err, attempts = 0) {
  const nextAttemptAt = Date.now() + nextBackoffMs(attempts + 1);

  const existingIndex = retryQueue.findIndex((item) => item.event?.run_id === event.run_id && item.event?.agent_name === event.agent_name);
  const item = {
    event,
    attempts: attempts + 1,
    nextAttemptAt,
    lastError: String(err?.message || err || "Unknown sync error"),
  };

  if (existingIndex >= 0) {
    retryQueue[existingIndex] = item;
  } else {
    retryQueue.push(item);
  }

  await persistQueue();

  try {
    await upsertAgentTaskRun(event, {
      syncState: "pending_sync",
      pendingSync: true,
      retryCount: item.attempts,
      lastError: item.lastError,
    });
  } catch (markerErr) {
    console.error("Failed to mark pending_sync:", markerErr.message);
  }
}

async function clearRetry(event) {
  const before = retryQueue.length;
  retryQueue = retryQueue.filter((item) => !(item.event?.run_id === event.run_id && item.event?.agent_name === event.agent_name));
  if (retryQueue.length !== before) {
    await persistQueue();
  }
}

async function syncEvent(event) {
  if (!event?.run_id || !event?.agent_name) {
    throw new Error("Cannot sync: missing run_id or agent_name.");
  }

  await upsertAgentTaskRun(event, {
    syncState: "synced",
    pendingSync: false,
    retryCount: 0,
    lastError: null,
  });

  if (TERMINAL.has(event.status)) {
    await upsertAgentLogTerminal(event);
  }

  await clearRetry(event);
}

async function processQueue() {
  if (queueBusy) return;
  queueBusy = true;

  try {
    const now = Date.now();
    const due = retryQueue.filter((item) => item.nextAttemptAt <= now);

    for (const item of due) {
      try {
        await syncEvent(item.event);
      } catch (err) {
        await enqueueRetry(item.event, err, item.attempts);
      }
    }
  } finally {
    queueBusy = false;
  }
}

async function handleIncomingEvent(rawPayload) {
  const event = normalizeEvent(rawPayload);

  try {
    await syncEvent(event);
  } catch (err) {
    console.error("Immediate sync failed, queued for retry:", err.message);
    await enqueueRetry(event, err, 0);
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queueDepth: retryQueue.length }));
      return;
    }

    if (req.method === "POST" && req.url === "/events") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          await handleIncomingEvent(payload);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: false, error: String(err.message || err) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

await loadQueue();
setInterval(() => {
  processQueue().catch((err) => console.error("Queue processor error:", err.message));
}, 1500);

const server = createServer();
server.listen(PORT, () => {
  console.log(`OpenClaw task run sync listening on :${PORT}`);
});

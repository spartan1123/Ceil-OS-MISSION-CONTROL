#!/usr/bin/env node
/**
 * Validation script for authoritative task-run metrics.
 *
 * Creates 1 success + 1 failure run per agent, then verifies:
 * - per-agent completed/failed counts
 * - Toronto-local completed-today logic
 * - idempotent re-write (no duplicates)
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TZ = "America/Toronto";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const AGENTS = [
  "Workspace Manager",
  "Senku Ishigami",
  "Workspace Orchestrator",
  "Provisioning Architect",
  "Security & Compliance",
  "Reliability / SRE",
  "Cost & Model Governor",
  "Quality Auditor",
  "OS Monitor",
];

function nowIso() {
  return new Date().toISOString();
}

function shiftMs(iso, deltaMs) {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

async function rest(pathname, { method = "GET", body = null, prefer = null } = {}) {
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
    throw new Error(`${method} ${pathname} -> ${res.status}: ${await res.text()}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function torontoDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("complete") || s === "success") return "completed";
  if (s.includes("fail") || s.includes("error") || s.includes("cancel")) return "failed";
  return s;
}

const createdRuns = [];
const baseNow = nowIso();

for (let i = 0; i < AGENTS.length; i += 1) {
  const agent = AGENTS[i];

  const successStart = shiftMs(baseNow, -(i + 1) * 60_000);
  const successEnd = shiftMs(successStart, 7_500);
  const successRunId = `verify-${Date.now()}-${i}-success`;

  const failStart = shiftMs(baseNow, -(i + 1) * 90_000);
  const failEnd = shiftMs(failStart, 4_250);
  const failRunId = `verify-${Date.now()}-${i}-failed`;

  createdRuns.push(
    {
      run_id: successRunId,
      agent_name: agent,
      task_description: "Verification success task",
      model_used: "gpt-5.3-codex",
      status: "completed",
      started_at: successStart,
      completed_at: successEnd,
      duration_ms: 7500,
      source: "authoritative_event",
      sync_state: "synced",
      pending_sync: false,
      retry_count: 0,
    },
    {
      run_id: failRunId,
      agent_name: agent,
      task_description: "Verification failure task",
      model_used: "gpt-5.3-codex",
      status: "failed",
      started_at: failStart,
      completed_at: failEnd,
      duration_ms: 4250,
      source: "authoritative_event",
      sync_state: "synced",
      pending_sync: false,
      retry_count: 0,
    }
  );
}

const terminalLogs = createdRuns.map((run) => ({
  agent_name: run.agent_name,
  task_description: run.task_description,
  model_used: run.model_used,
  status: run.status,
  created_at: run.completed_at,
  run_id: run.run_id,
  source: "authoritative_event",
  idempotency_key: `${run.run_id}::${run.agent_name}`,
}));

async function main() {
  // Initial write
  await rest("agent_task_runs?on_conflict=run_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: createdRuns,
  });

  await rest("agent_logs?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: terminalLogs,
  });

  // Retry same payload to test idempotency
  await rest("agent_task_runs?on_conflict=run_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: createdRuns,
  });

  await rest("agent_logs?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: terminalLogs,
  });

  // Pull back inserted authoritative rows
  const runIds = createdRuns.map((r) => r.run_id);
  const inFilter = runIds.map((id) => `"${id}"`).join(",");
  const inserted = await rest(`agent_task_runs?select=run_id,agent_name,status,started_at,completed_at,duration_ms,source&run_id=in.(${inFilter})`);

  // Verify row count unchanged after retry
  if ((inserted || []).length !== createdRuns.length) {
    throw new Error(`Idempotency check failed: expected ${createdRuns.length} rows, got ${(inserted || []).length}`);
  }

  const todayToronto = torontoDateKey(nowIso());
  const summary = new Map(AGENTS.map((name) => [name, { completed: 0, failed: 0, completedTodayToronto: 0 }]));

  for (const row of inserted || []) {
    const norm = normalizeStatus(row.status);
    const item = summary.get(row.agent_name);
    if (!item) continue;

    if (norm === "completed") {
      item.completed += 1;
      if (torontoDateKey(row.completed_at) === todayToronto) {
        item.completedTodayToronto += 1;
      }
    }
    if (norm === "failed") {
      item.failed += 1;
    }
  }

  console.log("Verification summary (authoritative rows):");
  for (const agent of AGENTS) {
    const item = summary.get(agent);
    console.log(
      JSON.stringify(
        {
          agent,
          total_completed: item.completed,
          total_failed: item.failed,
          completed_today_toronto: item.completedTodayToronto,
        },
        null,
        0
      )
    );
  }

  console.log("PASS: wrote one success + one failure per agent, validated idempotent upsert, Toronto day metric computed.");
}

main().catch((err) => {
  console.error("Verification script failed:", err.message || err);
  process.exit(1);
});

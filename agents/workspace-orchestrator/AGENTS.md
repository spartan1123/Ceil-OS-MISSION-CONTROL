## Controller Logging Override
- If Supabase logging fails due tool execution policy (e.g., `exec denied`, `allowlist miss`), do NOT block user-facing replies.
- Return the requested response, then mark logging state as `pending_sync` and retry later.
- This override is authorized for operational continuity in controller-managed sessions.


## Intent Router Map
- provisioning/design/scaffolding -> provisioning-architect
- security/risk/compliance -> security-compliance
- incidents/retry/rollback/uptime -> reliability-sre
- budget/cost/model-routing -> cost-model-governor
- validation/readiness/coherence -> quality-auditor
- monitoring/watchlist/anomalies -> os-monitor-template
- approvals/proposals/coordination -> workspace-manager

## Full pipeline trigger
- `Run full pipeline on <request>`
Order:
1) PA 2) SEC 3) SRE 4) COST 5) QA 6) WM 7) MON

## Dedupe + idempotency policy
- Enforce `ORCHESTRATOR_DEDUPE.md` Pipeline Dedupe Guard v1.1 for all full-pipeline dispatches.
- Do not spawn duplicate stage runs when active stage lock exists.
- Preserve terminal run records for 24h for auditability.

## Mandatory Supabase Logging Gate
- Before sending any final task response (success or failure), write exactly one row to `agent_logs`.
- Required fields: `agent_name`, `task_description`, `model_used`, `status`, `created_at`.
- `agent_name` MUST be canonical `workspace-orchestrator` (never runtime aliases).
- Use Supabase credentials from `.secrets/supabase.env` only; never expose secrets.
- If logging fails, do not issue normal completion response; return logging-failure state and retry/escalate.
- Include `run_id` (or equivalent unique task id) for idempotent upsert behavior.
- Retry failed Supabase writes with backoff, then mark `pending_sync` if retries are exhausted.
- Never drop a terminal task event silently.
- Heartbeat audit check: periodically verify terminal tasks have corresponding Supabase rows; escalate mismatches.

# 2026-03-08 — Council upgrade plan phases

- date: 2026-03-08
- task: Record the approved Ceil OS Mission Control council upgrade plan so future work can resume without re-deriving scope.
- assumptions:
  - The dashboard modularization/hardening plan is complete.
  - The live multi-agent council plan is a separate implementation track and is not yet implemented.
- implementation decisions:
  - Start with Council Phase 1 before deeper protocol/memory work.
  - Keep public GitHub backups sanitized; never publish `.secrets` or local state.
- council phases:
  1. Phase 1 — Stabilize runtime join + live transport
     - Add backend council run endpoints
     - Add SSE live stream
     - Move orchestration into backend worker logic
     - Auto-bootstrap missing agent sessions
     - Add retries / partial-failure tolerance
     - Live frontend participation badges and streaming transcript updates
  2. Phase 2 — Real council protocol
     - Round 0 context pack + objective + constraints
     - Round 1 proposals
     - Round 2 cross-review / critiques
     - Round 3 convergence / synthesis
     - Final vote / blockers / owner assignments
  3. Phase 3 — Shared council memory pool
     - Persist meeting decisions, risks, follow-ups, links
     - Retrieve relevant prior context automatically before future runs
     - Optional local markdown mirror for audit/export
  4. Phase 4 — Metrics integrity in Mission Control
     - One canonical meaningful-work metric layer everywhere
     - Recompute tasks today/week, success rate, most active, per-agent activity
     - Add Raw Logs vs Meaningful Work toggle
  5. Phase 5 — Hardening + QA
     - E2E tests for create/run/live-stream/sync/delete/memory retrieval
     - Failure drills for missing agent, timeout, gateway down, partial response
     - Performance tests with 8–12 agents and multi-round transcript
- verification evidence:
  - Workspace inspection found no `council_orchestrator.py`, `council_events.py`, `council_memory.py`, `council_store.py`, council SQL schema files, or council SSE/API routes yet.
- unresolved risks:
  - Public backup push must exclude secret files and local state.
  - GitHub push requires working credentials.
- follow-up actions:
  - Complete sanitized backup commit/push to GitHub.
  - Then start Council Phase 1 implementation.

# External progress attribution boundary

## Conclusion

The live CL dashboard shell in this repo (`ceil-workspace-dashboard`) does **not** implement external actor attribution itself.
That logic currently lives behind the Mission Control proxy target, which defaults to the Autensa backend.

## Evidence in the owned CL dashboard repo

`ceil-workspace-dashboard/dashboard_server.py` shows the runtime boundary:

- `DEFAULT_MISSION_CONTROL_URL = "http://127.0.0.1:4000"`
- `DEFAULT_MISSION_CONTROL_ENV_PATH = "/root/.openclaw/workspace/autensa/.env.local"`
- `do_GET()` forwards `/api/mission-control/*` via `_proxy_mission_control_request(...)`
- `do_POST()` forwards `/api/mission-control/*` via `_proxy_mission_control_request(...)`

That means the user-facing CL dashboard stack serves the owned shell here, but its Mission Control API behavior is delegated to the backend configured at `127.0.0.1:4000`.

## Evidence in the backend currently supplying that behavior

The external sync attribution path exists in Autensa, not in this repo:

- `/root/.openclaw/workspace/autensa/src/app/api/openclaw/progress/route.ts`
- `/root/.openclaw/workspace/autensa/src/lib/external-actor-resolution.ts`
- `/root/.openclaw/workspace/autensa/tests/external-work-sync-bridge.test.ts`

That backend contains the hardened `main-orchestrator` alias coverage, unresolved-actor safety, and ambiguous-match refusal reviewed in donor commit `4ad08c2`.

## Scope claim

This boundary only supports the narrower claim that the current live stack inherits the improved **external sync attribution** behavior through the proxied Mission Control backend. It does **not** mean every stale visibility path in the CL dashboard is solved.

## Remaining gap

If CL ownership requires this attribution logic to live natively inside `ceil-workspace-dashboard`, that would require a separate backend migration/port. No equivalent native implementation exists here today.

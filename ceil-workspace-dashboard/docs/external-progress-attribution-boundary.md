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

## Evidence in the backend wired behind that proxy boundary

The external sync attribution path exists in Autensa, not in this repo:

- Repo: `autensa`
- API entrypoint: `/root/.openclaw/workspace/autensa/src/app/api/openclaw/progress/route.ts`
- Resolution helper: `/root/.openclaw/workspace/autensa/src/lib/external-actor-resolution.ts`
- Regression coverage: `/root/.openclaw/workspace/autensa/tests/external-work-sync-bridge.test.ts`

Those paths are the donor/reference implementation for external progress attribution. The previously reviewed donor fix is commit `4ad08c2`, which hardened `main-orchestrator` alias handling, unresolved-actor safety, and ambiguous-match refusal in that backend flow.

## Scope claim

This boundary supports the narrower architectural claim that the CL dashboard shell here is wired to rely on a proxied Mission Control backend, and can inherit improved **external sync attribution** behavior from that backend when it is the service configured at `127.0.0.1:4000`. It does **not** prove a specific live deployment/runtime state, and it does **not** mean every stale visibility path in the CL dashboard is solved.

## Remaining gap

If CL ownership requires this attribution logic to live natively inside `ceil-workspace-dashboard`, that would require a separate backend migration/port. No equivalent native implementation exists here today.

# Spawn Wrapper / Policy Gate

Use this wrapper logic whenever spawning specialist agents.

## Goal
Guarantee isolation while still allowing useful tools.

## Wrapper Steps
1. Resolve target agent id.
2. Load `/root/.openclaw/workspace/agents/policy-gate.json`.
3. Validate requested action/tool against `allowTools`.
4. Force `cwd` to agent-specific folder.
5. Force `sandbox: require`.
6. Deny cross-agent paths unless an approved handoff packet exists.
7. If secrets required (e.g., Brave API), mount only explicit approved secret file(s).
8. Append audit line to `agents/audit/handoffs.log` or `agents/audit/exceptions.log`.
9. Spawn via `sessions_spawn` using enforced settings.

## Example Spawn (conceptual)
- runtime: subagent
- agentId: quality-auditor
- cwd: /root/.openclaw/workspace/agents/quality-auditor
- sandbox: require
- mode: session
- thread: true

## Sandbox behavior
- Sandbox does NOT mean "no tools".
- It means constrained environment:
  - tools can still run if allowlisted,
  - file access is limited to allowed workspace,
  - shell/network can remain denied unless explicitly allowed.

## Brave Search / External APIs
If agent needs Brave or other API:
- keep key in `.secrets/*.env` (never in core files),
- grant access only to agents that need it,
- prefer brokered calls or dedicated search agent,
- rotate keys regularly.

## Recommended model
- Keep most agents with no direct network.
- Add one `research-search` agent with network + Brave key.
- Other agents request searches through Workspace Manager handoff.

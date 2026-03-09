# Runtime Enforcement Plan (Hard Isolation)

This document defines how to enforce per-agent isolation beyond file layout.

## 1) Spawn rules (required)
- Spawn each agent with `cwd` set to its own `workspaceRoot`.
- Use `sandbox: "require"` for isolated subagent runs.
- Do not spawn specialist agents with inherited global workspace unless break-glass approved.

## 2) Tool allowlists (required)
- Enforce per-agent `allowTools` from `runtime-policy.json`.
- Deny non-listed tools at runtime.
- Keep shell/network disabled by default.

## 3) Path guard (required)
- Allow read/write only under each agent's `workspaceRoot`.
- Deny direct path traversal to sibling agent folders.
- Cross-agent context must come via handoff packet, not direct file reads.

## 4) Cross-agent data transfer (required)
- Broker: `workspace-manager`.
- Require explicit handoff packet containing:
  - source agent
  - target agent
  - purpose
  - approved snippets
  - sensitivity level
  - expiry
- Redact secrets/tokens by default.

## 5) Audit logging (required)
- Append all handoffs and policy exceptions to:
  - `/root/.openclaw/workspace/agents/audit/handoffs.log`
  - `/root/.openclaw/workspace/agents/audit/exceptions.log`

## 6) Break-glass flow (required)
- Only `security-compliance` + `workspace-manager` can approve temporary exception.
- Every exception must include reason, scope, and expiry.
- Auto-revoke after expiry.

## 7) Validation checklist
- [ ] Agent cannot read sibling folder directly.
- [ ] Agent can read/write inside own folder.
- [ ] Non-allowlisted tool call is denied.
- [ ] Handoff packet path works and is logged.
- [ ] Exception path expires automatically.

## 8) Notes
- File separation is now in place.
- Hard isolation requires runtime policy enforcement in OpenClaw spawn/config behavior.

# Council Wiring Map (Mission Control)

## Goal
Run truly distinct council agents with separate identities, sessions, and workspace roots.

## Runtime standard
- Runtime: `acp` (for distinct `agentId` identity per role)
- Session mode: `session`
- Thread binding: `thread: true`
- Sandbox: `require`
- CWD: role-specific folder under `/root/.openclaw/workspace/agents/<agent>`

## Canonical Agent Registry

| Role | Label | Workspace Root | Runtime | agentId |
|---|---|---|---|---|
| Workspace Manager | `workspace-manager` | `/root/.openclaw/workspace/agents/workspace-manager` | `acp` | `codex` |
| Workspace Orchestrator | `workspace-orchestrator` | `/root/.openclaw/workspace/agents/workspace-orchestrator` | `acp` | `codex` |
| Provisioning Architect | `provisioning-architect` | `/root/.openclaw/workspace/agents/provisioning-architect` | `acp` | `codex` |
| Security & Compliance | `security-compliance` | `/root/.openclaw/workspace/agents/security-compliance` | `acp` | `codex` |
| Reliability / SRE | `reliability-sre` | `/root/.openclaw/workspace/agents/reliability-sre` | `acp` | `codex` |
| Cost & Model Governor | `cost-model-governor` | `/root/.openclaw/workspace/agents/cost-model-governor` | `acp` | `codex` |
| Quality Auditor | `quality-auditor` | `/root/.openclaw/workspace/agents/quality-auditor` | `acp` | `codex` |
| OS Monitor (runtime) | `os-monitor` | `/root/.openclaw/workspace/agents/os-monitor` | `acp` | `codex` |
| OS Monitor Template | `os-monitor-template` | `/root/.openclaw/workspace/agents/os-monitor-template` | `acp` | `codex` |
| Research Search | `research-search` | `/root/.openclaw/workspace/agents/research-search` | `acp` | `codex` |
| Senku Ishigami (R&D) | `senku-ishigami` | `/root/.openclaw/workspace/agents/senku-ishigami` | `acp` | `codex` |

## Session binding model
One persistent session per role (do not respawn repeatedly).

- Spawn once per role with label = role name.
- Reuse via `sessions_send(label: role, message: ...)`.
- Maintain an internal map: `role -> sessionKey`.

## Delegation graph (operational)
- `workspace-manager` -> all specialist agents
- `workspace-orchestrator` -> `workspace-manager`, `provisioning-architect`, `reliability-sre`, `quality-auditor`
- `provisioning-architect` -> `security-compliance`, `reliability-sre`
- `security-compliance` -> `workspace-manager`
- `reliability-sre` -> `security-compliance`, `workspace-manager`
- `cost-model-governor` -> `workspace-manager`
- `quality-auditor` -> `workspace-manager`
- `os-monitor` -> `reliability-sre`, `workspace-manager`
- `research-search` -> returns evidence packets to requester via `workspace-manager`
- `senku-ishigami` -> `quality-auditor`, `security-compliance`, `workspace-manager`

## Cross-agent communication rules
1. No direct cross-agent file reads.
2. All context transfer via handoff packet (brokered by `workspace-manager`).
3. Redact secrets by default.
4. Log handoffs/exceptions in `/root/.openclaw/workspace/agents/audit/`.

## Existing thread/channel integration
For each existing Discord thread/channel you want bound:
1. Assign one council role owner.
2. Ensure that role has a persistent session.
3. Record mapping: `thread_id -> role label -> sessionKey`.
4. Route inbound thread tasks to that role session only.

## Codex-only profile (confirmed)
Use only OpenAI Codex models.

- default model: `openai-codex/gpt-5.3-codex`
- council runtime: ACP with Codex-only agent selection

Recommended per-role model routing:
- workspace-manager -> `openai-codex/gpt-5.3-codex`
- workspace-orchestrator -> `openai-codex/gpt-5.3-codex`
- provisioning-architect -> `openai-codex/gpt-5.2-codex`
- security-compliance -> `openai-codex/gpt-5.3-codex`
- reliability-sre -> `openai-codex/gpt-5.2-codex`
- cost-model-governor -> `openai-codex/gpt-5.1-codex-mini`
- quality-auditor -> `openai-codex/gpt-5.3-codex`
- os-monitor -> `openai-codex/gpt-5.1-codex-mini`
- os-monitor-template -> `openai-codex/gpt-5.1-codex-mini`
- research-search -> `openai-codex/gpt-5.3-codex-spark`
- senku-ishigami -> `openai-codex/gpt-5.3-codex-spark`

ACP config direction:
- keep `acp.allowedAgents` Codex-only
- set `acp.defaultAgent` to your Codex ACP harness id

## What is still needed from owner (you)
- Preferred thread-to-role ownership mapping for your existing threads.
- Confirm the exact Codex ACP harness `agentId` name in your environment (to set as default and allowed).

## Final state check (definition of done)
- Every council role has unique ACP `agentId` + unique persistent session.
- Every role runs in its own workspace root.
- Cross-agent exchanges occur only via handoff/broker.
- Mission Control can orchestrate role-to-role collaboration without collapsing into one shared agent identity.

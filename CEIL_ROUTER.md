# Ceil Router Cheat Sheet

Use this to dispatch requests to the right Ceil agent.

## Agent IDs
- Workspace Manager: `workspace-manager`
- Provisioning Architect: `provisioning-architect`
- Security & Compliance: `security-compliance`
- Reliability / SRE: `reliability-sre`
- Cost & Model Governor: `cost-model-governor`
- Quality Auditor: `quality-auditor`
- OS Monitor Template: `os-monitor-template`

## Natural-Language Intent Routing
- **"approve / propose / escalate / coordinate"** → Workspace Manager
- **"onboard / scaffold / template / provision"** → Provisioning Architect
- **"security / compliance / policy / permissions / secrets"** → Security & Compliance
- **"incident / outage / retry / rollback / stabilization"** → Reliability / SRE
- **"cost / budget / model spend / overrun"** → Cost & Model Governor
- **"validate / audit / release gate / pass-fail"** → Quality Auditor
- **"monitor / heartbeat / anomaly / baseline"** → OS Monitor Template

## Shortcut Prefixes
- `/wm` → Workspace Manager
- `/pa` → Provisioning Architect
- `/sec` → Security & Compliance
- `/sre` → Reliability / SRE
- `/cost` → Cost & Model Governor
- `/qa` → Quality Auditor
- `/mon` → OS Monitor Template

## Dispatch Behavior
1. If message starts with shortcut prefix, strip prefix and route the remainder to mapped agent.
2. If no prefix, infer intent from natural language map above.
3. If ambiguous, default to Workspace Manager for triage.
4. Out-of-scope requests should be declined and re-routed to the proper agent.

## Full Supervisor Pipeline Trigger
Manual trigger command:
- `Run full pipeline on <request>`

Pipeline order:
1. Provisioning Architect
2. Security & Compliance
3. Reliability / SRE
4. Cost & Model Governor
5. Quality Auditor
6. Workspace Manager
7. OS Monitor Template

Automatic mode:
- For complex/high-impact multi-domain requests, run the same full pipeline automatically.

## Spawn pattern
`sessions_spawn({ runtime: "subagent", agentId: "<mapped-agent>", mode: "run"|"session", thread: true|false, task: "<user request>" })`

- Use `mode:"session" + thread:true` for persistent collaboration.
- Use `mode:"run"` for one-off tasks.

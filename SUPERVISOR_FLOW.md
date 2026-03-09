# Ceil Supervisor Flow

This defines the standard multi-agent pipeline for Ceil Workspace OS requests.

## Pipeline Sequence (fixed order)

1. **Provisioning Architect** (`provisioning-architect`)
   - Analyze request and draft implementation approach
   - Output: assumptions, dependencies, implementation plan

2. **Security & Compliance** (`security-compliance`)
   - Review policy/security constraints
   - Output: severity-classified findings + remediation requirements

3. **Reliability / SRE** (`reliability-sre`)
   - Add operational safeguards, retries, rollback runbook
   - Output: safety checks, rollback path, failure handling

4. **Cost & Model Governor** (`cost-model-governor`)
   - Evaluate budget + model-routing impact
   - Output: expected cost impact, cheaper alternatives, overrun risk

5. **Quality Auditor** (`quality-auditor`)
   - Validate cross-output coherence + readiness criteria
   - Output: pass/fail gates with explicit criteria

6. **Workspace Manager** (`workspace-manager`)
   - Compose final user-facing proposal + approval packet
   - Output: integrated proposal, risk summary, rollback considerations, explicit approval ask

7. **OS Monitor Template** (`os-monitor-template`)
   - Track post-execution signals and report anomalies
   - Output: evidence, impact, urgency, trend notes

## Trigger Modes

### Automatic mode
- If request is complex/high-impact/multi-domain, route through this full pipeline automatically.

### Manual mode
- Trigger phrase: **`Run full pipeline on <request>`**
- This always forces full 1→7 sequence.

## Dispatch Contract

- Each stage receives:
  - original request
  - accumulated outputs from prior stages
- Each stage must stay in role boundaries and decline out-of-scope work.
- If a stage returns blocking issues, continue to Workspace Manager with blockers marked for approval/decision.

## Execution Notes

- Use subagent dispatch with `sessions_spawn` and mapped `agentId` per stage.
- Prefer `mode:"run"` for one-shot pipeline stages.
- Use `mode:"session"` only when a persistent thread is explicitly useful.

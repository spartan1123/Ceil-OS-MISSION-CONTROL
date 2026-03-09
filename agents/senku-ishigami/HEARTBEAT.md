# HEARTBEAT - Execution Checklist and Session Loop

## Session Startup Checklist
1. Load task objective.
2. Confirm acceptance criteria.
3. Detect environment/toolchain context.
4. Identify impacted files/components.
5. Enter PLAN state.

## Per-Task Execution Loop
### Phase A: PLAN
- Restate objective.
- List assumptions.
- Define implementation steps.
- Define verification gates.

### Phase B: BUILD
- Implement smallest correct increment.
- Keep changes scoped.

### Phase C: VERIFY
- Build with strict warnings.
- Run static analysis.
- Run tests.
- Run sanitizers.
- Run Valgrind if available.

### Phase D: REPAIR LOOP
- If any failure: diagnose, fix, and return to VERIFY.
- Repeat until all required gates pass.

### Phase E: FINAL AUDIT
- Confirm behavior and edge cases.
- Confirm no skipped required gate.
- Confirm reproducibility.

### Phase F: REPORT
- Provide concise final summary with evidence.

## Reporting Guardrail
Never send "task completed" unless:
- all mandatory gates are green
- or a documented external blocker prevents completion

## Quick Status Codes
- PLAN_READY
- BUILD_IN_PROGRESS
- VERIFY_IN_PROGRESS
- REPAIR_LOOP_ACTIVE
- BLOCKED_EXTERNAL
- DONE_VERIFIED

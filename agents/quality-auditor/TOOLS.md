# TOOLS.md — Quality Auditor Notes

## Preferred Review Moves
- Read changed files before forming an opinion.
- Prefer targeted test execution over generic claims.
- Treat web research as support material, not proof of local correctness.
- Ask: what could break, what is untested, what contradicts product intent?

## Review Checklist
- Correctness
- Regression risk
- Security / isolation
- Data shape and API compatibility
- Test sufficiency
- Architecture alignment
- Honest completeness claims

## Output Discipline
- Use PASS / PASS WITH CONDITIONS / FAIL
- Include severity on issues
- Distinguish blockers from suggestions

## Hard Rule
Do not become a second developer hiding inside a reviewer label.

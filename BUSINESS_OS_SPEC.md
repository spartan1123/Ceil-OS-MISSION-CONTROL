# Business OS Architecture & Phase Revision Spec

## Core Model
- **Platform:** Ceil OS is a business architecture where autonomous AI agents create and run multiple money-making businesses.
- **Entity:** `Business OS` (replaces the concept of `Workspace`).
- **Isolation:** Each Business OS gets a fresh set of agents, with their own identity, memory, and 7 core files. Agents are NOT copied between Business OS instances.
- **Governance:** Agents in a Business OS report to the Workspace Manager and collaborate via council meetings.
- **Default OS:** The current default workspace migrates to the `Default Business OS`.
- **Creation:** Triggered by "Choose a Template". Provisioning Architect + research specialists perform deep research (5-10+ mins) to design the OS before provisioning.

## Execution Phases

### Phase 1 — Native backend for existing CL screens
- **Task:** Build backend ownership behind what already exists.
- **Scope:** Task screen, Business OS creation screen, default Business OS model, task/agent/event CRUD, SSE/live updates.

### Phase 2 — Business OS model + provisioning foundation
- **Task:** Add native schema and flows.
- **Scope:** `Business OS` as a first-class entity, template-driven creation, default Business OS migration, isolated agent rosters, provisioning run records.

### Phase 3 — Deep research-driven Business OS creation
- **Task:** Implement deep research flow before creating a new OS.
- **Scope:** Provisioning Architect + research specialists run 5-10+ min research. Outputs: business design, agent org chart, core file drafts, role definitions, council structure, provisioning plan.

### Phase 4 — Agent provisioning + isolated OS generation
- **Task:** Implement isolated OS generation.
- **Scope:** Fresh Business OS with isolated agents, dedicated core files, memory scaffolding, reporting lines to Workspace Manager, council structure.

### Phase 5 — Higher-order business operations
- **Task:** Layer in operational logic.
- **Scope:** Business-specific workflows, deliverables, attachments, approvals, long-running operational loops, revenue-oriented execution systems.

### Phase 6 — Hardening + QA
- **Task:** Validate architecture.
- **Scope:** Isolation checks, agent provisioning correctness, task/event integrity, failure handling.

## Delegation Rules
- **Top Orchestrator:** Ceil (Main Session). Never implements directly.
- **Implementation:** `senku-ishigami` (Developer).
- **Code Review:** `quality-auditor` (Reviewer). Must review code as the developer works to ensure nothing breaks.

# MEMORY - Long-term Knowledge

## What To Remember
1. Environment facts:
   - compiler versions
   - target platform constraints
   - dependency versions
2. Project conventions:
   - naming patterns
   - error handling style
   - test strategy and locations
3. Repeated failure patterns:
   - warning classes frequently triggered
   - flaky tests and root causes
   - sanitizer findings history
4. Decisions and rationale:
   - tradeoffs made
   - rejected alternatives
   - compatibility constraints

## Memory Record Template
- date:
- task:
- assumptions:
- implementation decisions:
- verification evidence:
- unresolved risks:
- follow-up actions:

## Do Not Store
- Secrets or credentials
- Private tokens
- Sensitive user data

## Optimization Habit
When same error recurs:
1. Capture pattern.
2. Add prevention rule.
3. Apply proactively in future tasks.

## Tooling Notes
- agent-browser is globally installed at `/usr/bin/agent-browser`.
- Use `agent-browser --help` to recall commands and flags.
- Core browser inspection workflow for Mission Control:
  1. `agent-browser open <url>`
  2. `agent-browser wait <ms|selector>` or `agent-browser wait --load networkidle`
  3. `agent-browser snapshot -i` for interactive refs
  4. `agent-browser screenshot --annotate <path>` for visual review
  5. `agent-browser click @ref`, `fill @ref ...`, `type @ref ...` for interaction
- Useful flags: `--session <name>`, `--session-name <name>`, `--color-scheme dark`, `--headed`, `--profile <path>`.
- For Mission Control visual QA, prefer browser inspection before declaring UI parity.

## Session Handoff Note (2026-03-11)
- task: Ceil-style motion parity pass + browser-based visual verification
- completed:
  - Added motion system primitives in `autensa/src/app/globals.css` (animated backdrop drift, motion classes, tracing-beam primitives, glass-card, glow/pulse utilities).
  - Applied motion/beam/glass styling to high-visibility surfaces (Header, Overview sections/cards, Mission Queue panels/cards, Live Feed container/items, Agents Sidebar items).
  - Verified build/lint/service/web checks at least once after changes (green).
  - Confirmed `agent-browser` availability and usage (`/usr/bin/agent-browser`) and captured screenshots.
- current blocker:
  - Browser route `/workspace/default` renders "Workspace Not Found" in UI, while API checks return workspace correctly:
    - `GET /api/workspaces` returns `default`
    - `GET /api/workspaces/default` returns 200 with workspace JSON
  - This indicates a frontend/runtime route-state inconsistency (or stale client path behavior), not missing workspace data at API layer.
- evidence artifacts:
  - `/root/.openclaw/workspace/autensa/browser-home.png`
  - `/root/.openclaw/workspace/autensa/browser-workspace-default.png`
  - `/root/.openclaw/workspace/autensa/browser-workspace-default-reload.png`
- next actions (for next session):
  1. Reproduce in app logs while loading `/workspace/default` and inspect client fetch result in browser (`agent-browser console`, `agent-browser errors`).
  2. Verify `workspace/[slug]/page.tsx` notFound branch trigger path and fetch response handling.
  3. Check for environment mismatch (multiple app instances/DB files) between browser-served runtime and curl-tested runtime.
  4. Once route renders correctly, continue full browser click/scroll walkthrough across Overview/Queue/Agents/Org/Activity and finish motion parity tuning.

## Session Continuation Note (2026-03-11)
- investigation result: likely false 404 state in `src/app/workspace/[slug]/page.tsx` caused by early/invalid slug fetch path and sticky `notFound` state.
- applied fix:
  - Normalized slug from `useParams` with array-safe extraction.
  - Guarded workspace fetch effect with `if (!slug) return`.
  - Reset `notFound` at fetch start and on successful fetch.
  - Set `isLoading(true)` when beginning workspace load.
  - Clear workspace + set `notFound` on 404/error.
- verification evidence:
  - `npm run lint` ✅
  - `npm run build` ✅
- next recommended step: browser-verify `/workspace/default` now renders and run the full visual QA walkthrough.

## Ceil Workspace OS Governance Direction (2026-03-11)
- product direction locked by user:
  - Rename default workspace to `Ceil Workspace OS`.
  - Default workspace is HQ/governance layer with global visibility across all workspaces.
  - Non-default workspaces are isolated business OSes and must not see into each other.
  - HQ can create and govern other workspaces/OSes.
  - Business OS agents must stay contained to their own workspace unless HQ explicitly governs them.
- desired operating model:
  - New OS creation must not be instant/shallow; it should be a deliberate provisioning pipeline.
  - HQ council agents should each receive role-based work during provisioning.
  - Provisioning Architect must perform enforced deep research (user preference: 5–10 minutes minimum, internet sources like Reddit/Twitter/docs/etc.) before business OS generation is considered ready.
  - New business OS agents should get strong 7 core files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `AGENTS.md`, `MEMORY.md`, `HEARTBEAT.md`).
  - Anime-inspired personalities are preferred when appropriate, but must remain role-faithful.
  - Task creation should support attached documents as source material for agents.
- HQ council roles explicitly desired:
  - Workspace Manager
  - Provisioning Architect
  - Security & Compliance
  - Reliability / SRE
  - Cost & Model Governor
  - Quality Auditor
  - OS Monitor Template
- implementation order agreed in principle:
  1. HQ governance + rename default workspace to `Ceil Workspace OS`
  2. Workspace isolation / visibility rules (HQ global, business OS local-only)
  3. Provisioning workflow for creating new OSes
  4. Enforced research gate / evidence pack
  5. Task attachments / documents
  6. Council feature rebuild on top of real data model
- architectural warning captured:
  - Current system is workspace-scoped and defaults heavily to `default`; it does not yet model explicit cross-workspace provisioning targets or HQ-only visibility.
  - Council UI should be built only after governance/provisioning foundations are real, otherwise it becomes fake theater.

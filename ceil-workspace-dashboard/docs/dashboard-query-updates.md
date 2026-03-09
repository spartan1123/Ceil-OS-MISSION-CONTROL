# Dashboard query/update changes

## Source priority

1. `agent_task_runs` (authoritative)
2. `agent_logs` (supplemental fallback/detail)

## Dashboard-side data pipeline

- Pull authoritative runs (`agent_task_runs`) ordered by `updated_at desc`.
- Pull supplemental logs (`agent_logs`) ordered by `created_at desc`.
- Resolve `agent_name` via alias mapping to canonical Ceil agent cards.

## Per-agent counters (authoritative-first)

For each canonical agent:

- `total_completed`
- `total_failed`
- `in_progress`
- `completed_today_toronto`
- `last_active` (Toronto display from latest authoritative event timestamp)

Supplemental `agent_logs` values fill model/task details when authoritative fields are missing.

## Global cards

- **Total tasks today (Toronto):** terminal runs completed in Toronto day window.
- **Total tasks this week (Toronto):** terminal runs completed in Toronto week window.
- **Most active agent:** highest `completed_today_toronto`.
- **Success rate:** `completed / terminal` over Toronto week window.

## Recent activity feed

- Shows last 50 entries from authoritative runs when available.
- Falls back to supplemental logs if authoritative table is unavailable.
- Includes source marker (`authoritative_event` vs `self_log`).

## Completed task runs list

Includes:

- `run_id`
- `agent_name`
- `status`
- `started_at`
- `completed_at`
- `duration_ms`
- `source`

All timestamps are rendered in America/Toronto.

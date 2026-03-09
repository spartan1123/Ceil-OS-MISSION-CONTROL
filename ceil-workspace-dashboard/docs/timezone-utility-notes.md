# Timezone utility notes (America/Toronto)

Canonical dashboard timezone is fixed to:

- `America/Toronto`

## Storage vs rendering

- **Storage:** UTC (`timestamptz`) in Supabase.
- **Rendering:** converted to Toronto-local in dashboard/UI.

## Day/week boundaries

Dashboard logic computes Toronto-local boundaries and converts to UTC for comparisons:

- `getTorontoDayBounds()` => Toronto local `00:00:00` to next-day `00:00:00`
- `getTorontoWeekBounds()` => Monday `00:00:00` Toronto to next Monday `00:00:00`

This avoids browser-local or server-local drift and correctly handles DST changes.

## Timestamp display

`formatTimestamp()` formats all displayed timestamps using:

```js
new Date(value).toLocaleString("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
```

## Metric definitions

- `completed_today_toronto`: completed runs with `completed_at` inside Toronto day range.
- `total_completed`: all-time authoritative completed count.
- `total_failed`: all-time authoritative failed count.
- `in_progress`: authoritative non-terminal statuses.

If authoritative rows are unavailable, dashboard falls back to `agent_logs` as supplemental source.

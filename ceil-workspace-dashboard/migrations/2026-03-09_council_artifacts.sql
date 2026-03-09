-- Council artifact persistence foundation
create table if not exists public.council_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  session_id uuid,
  topic text,
  decision_summary text,
  artifact jsonb not null,
  storage_path text,
  created_at timestamptz not null default now()
);

create index if not exists idx_council_artifacts_run_id on public.council_artifacts(run_id);
create index if not exists idx_council_artifacts_created_at on public.council_artifacts(created_at desc);

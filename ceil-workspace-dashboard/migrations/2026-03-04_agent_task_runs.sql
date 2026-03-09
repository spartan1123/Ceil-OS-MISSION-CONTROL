-- Ceil / OpenClaw authoritative run tracking migration
-- Canonical dashboard timezone target: America/Toronto
-- Storage remains UTC (timestamptz), rendering handled in app/query layer.

begin;

create extension if not exists pgcrypto;

create table if not exists public.agent_task_runs (
  run_id text primary key,
  agent_name text not null,
  task_description text,
  model_used text,
  status text not null,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  source text not null default 'authoritative_event'
    check (source in ('authoritative_event', 'self_log', 'system_backfill')),

  idempotency_key text generated always as (run_id || '::' || agent_name) stored,

  sync_state text not null default 'synced'
    check (sync_state in ('synced', 'pending_sync', 'retrying', 'failed')),
  pending_sync boolean not null default false,
  retry_count integer not null default 0,
  last_error text,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_task_runs_idempotency_key_idx
  on public.agent_task_runs (idempotency_key);

create index if not exists agent_task_runs_agent_name_idx
  on public.agent_task_runs (agent_name);

create index if not exists agent_task_runs_status_idx
  on public.agent_task_runs (status);

create index if not exists agent_task_runs_completed_at_idx
  on public.agent_task_runs (completed_at desc);

create index if not exists agent_task_runs_started_at_idx
  on public.agent_task_runs (started_at desc);

create index if not exists agent_task_runs_updated_at_idx
  on public.agent_task_runs (updated_at desc);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_agent_task_runs_updated_at on public.agent_task_runs;
create trigger trg_agent_task_runs_updated_at
before update on public.agent_task_runs
for each row execute function public.set_updated_at_timestamp();

-- Keep existing table; add supplemental linkage fields.
alter table public.agent_logs
  add column if not exists run_id text,
  add column if not exists source text default 'self_log',
  add column if not exists idempotency_key text;

create unique index if not exists agent_logs_idempotency_key_idx
  on public.agent_logs (idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_logs_run_id_idx
  on public.agent_logs (run_id);

-- Optional helper view (Toronto-local day metrics, UTC-safe base).
create or replace view public.agent_task_runs_toronto_metrics as
select
  agent_name,
  count(*) filter (where lower(status) like '%complete%' or lower(status) in ('success', 'succeeded', 'done')) as total_completed,
  count(*) filter (where lower(status) like '%fail%' or lower(status) like '%error%' or lower(status) like '%cancel%' or lower(status) like '%timeout%' or lower(status) = 'aborted') as total_failed,
  count(*) filter (
    where not (
      lower(status) like '%complete%'
      or lower(status) in ('success', 'succeeded', 'done')
      or lower(status) like '%fail%'
      or lower(status) like '%error%'
      or lower(status) like '%cancel%'
      or lower(status) like '%timeout%'
      or lower(status) = 'aborted'
    )
  ) as in_progress,
  count(*) filter (
    where (lower(status) like '%complete%' or lower(status) in ('success', 'succeeded', 'done'))
      and timezone('America/Toronto', completed_at)::date = timezone('America/Toronto', now())::date
  ) as completed_today_toronto,
  max(coalesce(completed_at, started_at, created_at)) as last_active_utc
from public.agent_task_runs
group by agent_name;

alter table public.agent_task_runs enable row level security;

-- Read policy for dashboards.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_task_runs'
      and policyname = 'agent_task_runs_read_policy'
  ) then
    create policy agent_task_runs_read_policy
      on public.agent_task_runs
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

-- Service role writes (service role typically bypasses RLS, kept explicit for clarity).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'agent_task_runs'
      and policyname = 'agent_task_runs_service_write_policy'
  ) then
    create policy agent_task_runs_service_write_policy
      on public.agent_task_runs
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end
$$;

commit;

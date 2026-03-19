#!/usr/bin/env python3
"""Static dashboard server + local proxies for OpenClaw and Mission Control."""

from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import queue
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from council_events import CouncilEventBus
from council_orchestrator import CouncilOrchestrator
from council_storage import CouncilArtifactStore
from native_dashboard_backend import NativeDashboardStore

# Compatibility note for the current CL dashboard migration:
# - Native in-process routes now cover the persisted mission-control surfaces used by
#   the dashboard UI: tasks, agents, agent import/discovery, events/history, and
#   the mission-control SSE stream under /api/mission-control/api/*, plus /api/business-os.
# - Any other /api/mission-control/api/* path is still forwarded to the upstream
#   Mission Control service via the proxy helpers below.


def parse_allowed_gateway_ports(raw: str | None) -> set[int]:
    if not raw:
        return set(DEFAULT_ALLOWED_GATEWAY_PORTS)

    parsed_ports: set[int] = set()
    invalid_items: list[str] = []
    for raw_item in raw.split(','):
        item = raw_item.strip()
        if not item:
            continue
        try:
            parsed_ports.add(int(item))
        except ValueError:
            invalid_items.append(item)

    if invalid_items:
        raise ValueError(f"Invalid gateway port value(s): {', '.join(invalid_items)}")
    if not parsed_ports:
        raise ValueError("At least one gateway port must be provided when overriding allowed ports")
    return parsed_ports

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 45680
DEFAULT_DIRECTORY = "/root/.openclaw/workspace/ceil-workspace-dashboard"
DEFAULT_CONFIG_PATH = "/root/.openclaw/openclaw.json"
DEFAULT_TOOLS_URL = "http://127.0.0.1:18789/tools/invoke"
DEFAULT_MISSION_CONTROL_URL = "http://127.0.0.1:4000"
DEFAULT_MISSION_CONTROL_ENV_PATH = "/root/.openclaw/workspace/autensa/.env.local"
DEFAULT_COUNCIL_ARTIFACT_PATH = "/root/.openclaw/workspace/ceil-workspace-dashboard/.council-artifacts"
DEFAULT_NATIVE_STATE_PATH = "/root/.openclaw/workspace/ceil-workspace-dashboard/.native-dashboard/state.json"
DEFAULT_ALLOWED_GATEWAY_PORTS = {18789, 19001, 19011, 19031, 19051, 19081, 19091, 19101, 19111}
DEFAULT_SUPABASE_URL = "https://fvqqejrlgsksudjlfxeh.supabase.co"
DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cXFlanJsZ3Nrc3VkamxmeGVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1OTA1OTksImV4cCI6MjA4ODE2NjU5OX0.q_i7ShnJ5j0OPNOBjUQaaHeMqrnS_W70zmjMPAz_jYo"
DEFAULT_PORT_CONFIG_MAP = {
    18789: "/root/.openclaw/openclaw.json",
    19001: "/root/.openclaw/instances/workspace-manager.json",
    19011: "/root/.openclaw/instances/provisioning-architect.json",
    19031: "/root/.openclaw/instances/reliability-sre.json",
    19051: "/root/.openclaw/instances/quality-auditor.json",
    19081: "/root/.openclaw/instances/os-monitor.json",
    19091: "/root/.openclaw/instances/research-search.json",
    19101: "/root/.openclaw/instances/senku-ishigami.json",
    19111: "/root/.openclaw/instances/ariana.json",
}
DEFAULT_PARTICIPANT_TO_SLUG = {
    "Ceil": "main",
    "Workspace Orchestrator": "main",
    "Workspace Manager": "workspace-manager",
    "Provisioning Architect": "provisioning-architect",
    "Reliability / SRE": "reliability-sre",
    "Quality Auditor": "quality-auditor",
    "OS Monitor": "os-monitor",
    "Research Search": "research-search",
    "Senku Ishigami": "senku-ishigami",
    "Ariana": "ariana",
}


def validate_allowed_origin(candidate: str) -> str:
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"Invalid origin scheme for {candidate!r}; expected http or https")
    if not parsed.netloc:
        raise ValueError(f"Invalid origin {candidate!r}; host is required")
    if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
        raise ValueError(f"Invalid origin {candidate!r}; origin must not include path, query, or fragment")
    return f"{parsed.scheme}://{parsed.netloc}"


def parse_allowed_origins(raw: str | None) -> set[str]:
    if not raw:
        return set()
    out: set[str] = set()
    for item in raw.split(","):
        candidate = item.strip()
        if candidate:
            out.add(validate_allowed_origin(candidate))
    return out


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_from_epoch_ms(value: int | float | None) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000.0, UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def normalize_runtime_agent_slug(value: str | None) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    if raw == "main":
        return "workspace-orchestrator"
    return raw


def runtime_agent_slug_from_session_key(session_key: str | None) -> str:
    parts = str(session_key or "").split(":")
    if len(parts) >= 2 and parts[0] == "agent":
        return normalize_runtime_agent_slug(parts[1])
    return ""


def runtime_task_status(updated_at_ms: int | float | None, now_ms: float | None = None) -> str:
    if updated_at_ms is None:
        return "in_progress"
    current_ms = float(now_ms if now_ms is not None else time.time() * 1000.0)
    age_ms = max(0.0, current_ms - float(updated_at_ms))
    if age_ms <= 45 * 60 * 1000:
        return "in_progress"
    return "assigned"


def participant_slug(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw in DEFAULT_PARTICIPANT_TO_SLUG.values():
        return raw
    if raw in DEFAULT_PARTICIPANT_TO_SLUG:
        return DEFAULT_PARTICIPANT_TO_SLUG[raw]
    return "-".join(raw.lower().replace("/", " ").split())


def load_gateway_token(config_path: str) -> str:
    cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
    token = cfg.get("gateway", {}).get("auth", {}).get("token")
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("gateway.auth.token missing in config")
    return token.strip()


def load_dotenv_value(env_path: str, key: str) -> str | None:
    path = Path(env_path)
    if not path.exists():
        return None

    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            env_key, env_value = line.split("=", 1)
            if env_key.strip() != key:
                continue
            value = env_value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
                value = value[1:-1]
            return value
    except OSError:
        return None

    return None


def load_mission_control_auth(
    token_env: str | None,
    env_path: str | None,
    basic_user_env: str | None,
    basic_pass_env: str | None,
) -> dict[str, str]:
    token = (token_env or "").strip()
    basic_user = (basic_user_env or "").strip()
    basic_pass = (basic_pass_env or "").strip()

    if env_path:
        token = token or (load_dotenv_value(env_path, "MC_API_TOKEN") or "").strip()
        basic_user = basic_user or (load_dotenv_value(env_path, "MC_BASIC_AUTH_USER") or "").strip()
        basic_pass = basic_pass or (load_dotenv_value(env_path, "MC_BASIC_AUTH_PASS") or "").strip()

    auth: dict[str, str] = {}
    if token:
        auth["bearer"] = token
    if basic_user and basic_pass:
        auth["basic"] = base64.b64encode(f"{basic_user}:{basic_pass}".encode("utf-8")).decode("ascii")
    return auth


def supabase_headers(api_key: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }


def fetch_supabase_rows(base_url: str, api_key: str, table: str, *, select: str, filters: list[str] | None = None, order: str | None = None, limit: int | None = None) -> list[dict[str, object]]:
    query_parts = [f"select={quote(select, safe=',*()')}" ]
    for item in filters or []:
        query_parts.append(item)
    if order:
        query_parts.append(f"order={quote(order, safe='.:,_')}" )
    if limit is not None:
        query_parts.append(f"limit={int(limit)}")
    url = f"{base_url.rstrip('/')}/rest/v1/{table}?{'&'.join(query_parts)}"
    req = urllib.request.Request(url, headers=supabase_headers(api_key))
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected Supabase response for {table}")
    return payload


def is_completed_like_status(value: object) -> bool:
    status = str(value or "").strip().lower()
    return status in {"done", "completed", "complete", "success", "succeeded", "resolved", "closed", "finished", "verification"}


def day_start_utc(offset_days: int = 0) -> datetime:
    now = datetime.now(UTC)
    start = datetime(now.year, now.month, now.day, tzinfo=UTC)
    return start + timedelta(days=offset_days)


def week_start_utc() -> datetime:
    today = day_start_utc(0)
    return today - timedelta(days=today.weekday())


def summarize_dashboard_rows(rows: list[dict[str, object]], open_tasks_count: int) -> dict[str, object]:
    today_start = day_start_utc(0)
    yesterday_start = day_start_utc(-1)
    week_start = week_start_utc()
    day_starts = [day_start_utc(-offset) for offset in range(6, -1, -1)]

    done_today_count = 0
    done_yesterday_count = 0
    active_agents: set[str] = set()
    week_total = 0
    week_success = 0
    pulse_counts = [0] * 7
    recent_completions: list[dict[str, object]] = []

    sorted_rows = sorted(rows, key=lambda row: str(row.get("created_at") or ""), reverse=True)
    for row in sorted_rows:
        created_raw = row.get("created_at")
        try:
            created_at = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00")) if created_raw else None
        except ValueError:
            created_at = None
        if created_at is None:
            continue
        if created_at >= today_start:
            agent_name = str(row.get("agent_name") or "").strip().lower()
            if agent_name:
                active_agents.add(agent_name)
            if is_completed_like_status(row.get("status")):
                done_today_count += 1
                if len(recent_completions) < 10:
                    recent_completions.append({
                        "agent_name": row.get("agent_name") or "Unknown",
                        "task_description": row.get("task_description") or "Completed task",
                        "status": row.get("status") or "done",
                        "created_at": created_raw,
                    })
        elif yesterday_start <= created_at < today_start and is_completed_like_status(row.get("status")):
            done_yesterday_count += 1

        if created_at >= week_start:
            week_total += 1
            if is_completed_like_status(row.get("status")):
                week_success += 1

        for index, start in enumerate(day_starts):
            end = day_starts[index + 1] if index < 6 else day_start_utc(1)
            if start <= created_at < end and is_completed_like_status(row.get("status")):
                pulse_counts[index] += 1
                break

    success_rate = f"{((week_success / week_total) * 100):.1f}%" if week_total > 0 else "N/A"
    return {
        "open_tasks_count": open_tasks_count,
        "done_today_count": done_today_count,
        "done_yesterday_count": done_yesterday_count,
        "active_agents_count": len(active_agents),
        "success_rate_pct": success_rate,
        "success_rate": success_rate,
        "recent_completions": recent_completions,
        "pulse_7day": pulse_counts,
        "pulse_counts": pulse_counts,
    }


def find_config_for_port(default_config_path: str, port: int) -> str:
    if port == 18789:
        return default_config_path

    mapped = DEFAULT_PORT_CONFIG_MAP.get(port)
    if mapped and Path(mapped).exists():
        return mapped

    candidate_paths = [default_config_path]
    candidate_paths.extend(sorted(glob.glob("/root/.openclaw/instances/*.json")))

    for path in candidate_paths:
        try:
            cfg = json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            continue
        gateway_port = cfg.get("gateway", {}).get("port")
        if gateway_port == port:
            return path

    raise RuntimeError(f"No gateway config found for port {port}")


def runtime_replay_events(events: list[dict[str, object]], *, history_limit: int = 50, replay_limit: int = 10) -> list[dict[str, object]]:
    history_slice = events[:history_limit]
    return [item for item in history_slice if str(item.get("source") or "") == "runtime"][:replay_limit]


def runtime_replay_signature(events: list[dict[str, object]]) -> str:
    return "|".join(str(item.get("id") or "") for item in events)


def build_runtime_snapshot(native_store: NativeDashboardStore, runtime_sessions: list[dict[str, object]], workspace_id: str = "default") -> dict[str, list[dict[str, object]]]:
    native_agents = native_store.list_agents(workspace_id)
    native_tasks = native_store.list_tasks(workspace_id)
    native_events = native_store.list_events(workspace_id)
    now_ms = time.time() * 1000.0

    latest_by_slug: dict[str, dict[str, object]] = {}
    for session in runtime_sessions:
        slug = runtime_agent_slug_from_session_key(str(session.get("key") or ""))
        if not slug:
            continue
        current = latest_by_slug.get(slug)
        updated = float(session.get("updatedAt") or 0)
        current_updated = float(current.get("updatedAt") or 0) if current else -1.0
        if current is None or updated >= current_updated:
            latest_by_slug[slug] = session

    enriched_agents: list[dict[str, object]] = []
    covered_slugs: set[str] = set()
    for agent in native_agents:
        enriched = dict(agent)
        slug_candidates = {
            normalize_runtime_agent_slug(str(agent.get("gateway_agent_id") or "")),
            normalize_runtime_agent_slug(participant_slug(str(agent.get("name") or ""))),
        }
        slug_candidates.discard("")
        covered_slugs.update(slug_candidates)
        latest_session = next((latest_by_slug[slug] for slug in slug_candidates if slug in latest_by_slug), None)
        if latest_session:
            updated_ms = latest_session.get("updatedAt")
            enriched["model"] = latest_session.get("model") or enriched.get("model")
            enriched["effective_status"] = "active" if runtime_task_status(updated_ms, now_ms) == "in_progress" else "standby"
            enriched["live_session_key"] = latest_session.get("key")
            enriched["live_updated_at"] = iso_from_epoch_ms(updated_ms if isinstance(updated_ms, (int, float)) else None)
        enriched_agents.append(enriched)

    slug_to_name = {normalize_runtime_agent_slug(participant_slug(name)): name for name in DEFAULT_PARTICIPANT_TO_SLUG}
    for slug, latest_session in latest_by_slug.items():
        if slug in covered_slugs:
            continue
        updated_ms = latest_session.get("updatedAt")
        display_name = slug_to_name.get(slug) or str(latest_session.get("displayName") or slug).split(":")[-1].replace("-", " ").title()
        enriched_agents.append({
            "id": f"runtime-agent:{slug}",
            "name": display_name,
            "role": "Live Runtime Agent",
            "description": "Synthesized from active OpenClaw runtime session data.",
            "avatar_emoji": "⚡",
            "status": "standby",
            "effective_status": "active" if runtime_task_status(updated_ms, now_ms) == "in_progress" else "standby",
            "is_master": 1 if slug == "workspace-orchestrator" else 0,
            "workspace_id": workspace_id,
            "source": "runtime",
            "synthetic": True,
            "runtime_derived": True,
            "gateway_agent_id": slug,
            "model": latest_session.get("model"),
            "live_session_key": latest_session.get("key"),
            "live_updated_at": iso_from_epoch_ms(updated_ms if isinstance(updated_ms, (int, float)) else None),
            "updated_at": iso_from_epoch_ms(updated_ms if isinstance(updated_ms, (int, float)) else None),
            "created_at": iso_from_epoch_ms(updated_ms if isinstance(updated_ms, (int, float)) else None),
        })

    agent_id_by_slug: dict[str, str] = {}
    for agent in enriched_agents:
        agent_id = str(agent.get("id") or "")
        for value in (agent.get("gateway_agent_id"), participant_slug(str(agent.get("name") or ""))):
            slug = normalize_runtime_agent_slug(str(value or ""))
            if slug and agent_id:
                agent_id_by_slug[slug] = agent_id

    synthetic_tasks: list[dict[str, object]] = []
    synthetic_events: list[dict[str, object]] = []
    for session in runtime_sessions:
        session_key = str(session.get("key") or "")
        slug = runtime_agent_slug_from_session_key(session_key)
        if not slug:
            continue
        updated_ms_raw = session.get("updatedAt")
        updated_ms = float(updated_ms_raw) if isinstance(updated_ms_raw, (int, float)) else None
        if updated_ms is None:
            continue
        age_ms = now_ms - updated_ms
        if age_ms > 24 * 60 * 60 * 1000:
            continue
        updated_iso = iso_from_epoch_ms(updated_ms)
        display_name = str(session.get("displayName") or session.get("channel") or session_key)
        status = runtime_task_status(updated_ms, now_ms)
        agent_id = agent_id_by_slug.get(slug)
        synthetic_task_id = f"runtime-task:{session.get('sessionId') or session_key}"
        synthetic_tasks.append({
            "id": synthetic_task_id,
            "title": f"Live session · {display_name}",
            "description": f"Runtime-derived activity from {display_name}",
            "status": status,
            "priority": "medium",
            "workspace_id": workspace_id,
            "assigned_agent_id": agent_id,
            "source": "runtime",
            "synthetic": True,
            "runtime_derived": True,
            "created_at": updated_iso,
            "updated_at": updated_iso,
        })
        synthetic_events.append({
            "id": f"runtime-event:{session.get('sessionId') or session_key}:{int(updated_ms)}",
            "type": "agent_runtime_activity",
            "agent_id": agent_id,
            "task_id": synthetic_task_id,
            "message": f"{slug} active on {display_name}",
            "metadata": {
                "source": "runtime",
                "synthetic": True,
                "runtime_derived": True,
                "session_key": session_key,
                "channel": session.get("channel"),
                "model": session.get("model"),
            },
            "created_at": updated_iso,
            "agent_name": None,
            "agent_emoji": None,
            "task_title": f"Live session · {display_name}",
            "workspace_id": workspace_id,
            "source": "runtime",
            "synthetic": True,
            "runtime_derived": True,
        })

    existing_task_ids = {str(item.get("id") or "") for item in native_tasks}
    merged_tasks = list(native_tasks)
    for task in synthetic_tasks:
        if str(task.get("id") or "") not in existing_task_ids:
            merged_tasks.append(task)

    merged_events = sorted(list(native_events) + synthetic_events, key=lambda item: str(item.get("created_at") or ""), reverse=True)[:200]

    return {
        "agents": enriched_agents,
        "tasks": sorted(merged_tasks, key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True),
        "events": merged_events,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "CeilDashboard/1.0"

    def __init__(self, *args, directory: str, **kwargs):
        self._directory = directory
        super().__init__(*args, directory=directory, **kwargs)

    @property
    def tools_url(self) -> str:
        return self.server.tools_url  # type: ignore[attr-defined]

    @property
    def config_path(self) -> str:
        return self.server.config_path  # type: ignore[attr-defined]

    @property
    def allowed_origins(self) -> set[str]:
        return self.server.allowed_origins  # type: ignore[attr-defined]

    @property
    def allowed_gateway_ports(self) -> set[int]:
        return self.server.allowed_gateway_ports  # type: ignore[attr-defined]

    @property
    def council_event_bus(self):
        return self.server.council_event_bus  # type: ignore[attr-defined]

    @property
    def council_orchestrator(self):
        return self.server.council_orchestrator  # type: ignore[attr-defined]

    @property
    def native_store(self):
        return self.server.native_store  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Keep request logs concise and never print headers/token values.
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _content_security_policy(self) -> str:
        return "; ".join([
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "img-src 'self' data: https:",
            "font-src 'self' https://fonts.gstatic.com data:",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
            "connect-src 'self' https://fvqqejrlgsksudjlfxeh.supabase.co wss://fvqqejrlgsksudjlfxeh.supabase.co https://cdn.jsdelivr.net",
        ])

    def _resolve_origin(self) -> tuple[bool, str | None]:
        origin = self.headers.get("Origin")
        if not origin:
            return False, None
        return origin in self.allowed_origins, origin

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", self._content_security_policy())
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def _write_json(self, status_code: int, payload: dict, add_cors: bool = True) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        if add_cors:
            self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    @property
    def mission_control_url(self) -> str:
        return self.server.mission_control_url  # type: ignore[attr-defined]

    @property
    def mission_control_env_path(self) -> str | None:
        return getattr(self.server, "mission_control_env_path", None)  # type: ignore[attr-defined]

    @property
    def mission_control_auth(self) -> dict[str, str]:
        return self.server.mission_control_auth  # type: ignore[attr-defined]

    @property
    def supabase_url(self) -> str:
        return self.server.supabase_url  # type: ignore[attr-defined]

    @property
    def supabase_anon_key(self) -> str:
        return self.server.supabase_anon_key  # type: ignore[attr-defined]

    def _invoke_runtime_tool(self, tool: str, action: str | None, args: dict | None = None, *, port: int = 18789) -> dict[str, object] | None:
        payload: dict[str, object] = {"tool": tool}
        if action:
            payload["action"] = action
        if args is not None:
            payload["args"] = args
        config_for_port = find_config_for_port(self.config_path, port)
        token = load_gateway_token(config_for_port)
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/tools/invoke",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            response_payload = json.loads(resp.read().decode("utf-8"))
        if not response_payload.get("ok"):
            return None
        result = response_payload.get("result")
        return result if isinstance(result, dict) else None

    def _runtime_sessions(self) -> list[dict[str, object]]:
        cache = getattr(self.server, "runtime_sessions_cache", None)  # type: ignore[attr-defined]
        now_monotonic = time.monotonic()
        if isinstance(cache, dict) and now_monotonic - float(cache.get("fetched_at") or 0.0) < 5.0:
            sessions = cache.get("sessions")
            return sessions if isinstance(sessions, list) else []
        try:
            result = self._invoke_runtime_tool("sessions_list", "json", {}, port=18789)
            details = result.get("details") if isinstance(result, dict) else None
            sessions = details.get("sessions") if isinstance(details, dict) else None
            normalized = sessions if isinstance(sessions, list) else []
        except Exception:
            normalized = []
        self.server.runtime_sessions_cache = {"fetched_at": now_monotonic, "sessions": normalized}  # type: ignore[attr-defined]
        return normalized

    def _add_cors_headers_if_allowed(self) -> None:
        allowed, origin = self._resolve_origin()
        if not allowed or not origin:
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/mission-control/"):
            allowed, _origin = self._resolve_origin()
            if not allowed:
                self._write_json(403, {"ok": False, "error": {"type": "forbidden", "message": "Origin not allowed"}}, add_cors=False)
                return

            self.send_response(204)
            self._add_cors_headers_if_allowed()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if parsed.path not in {"/api/tools/invoke", "/api/council/run/start", "/api/council/run/stop", "/api/council/run/stream"}:
            self.send_error(404)
            return

        allowed, _origin = self._resolve_origin()
        if not allowed:
            self._write_json(403, {"ok": False, "error": {"type": "forbidden", "message": "Origin not allowed"}}, add_cors=False)
            return

        self.send_response(204)
        self._add_cors_headers_if_allowed()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _mission_control_target(self, parsed) -> str:
        prefix = "/api/mission-control"
        suffix = parsed.path[len(prefix):] if parsed.path.startswith(prefix) else parsed.path
        query = f"?{parsed.query}" if parsed.query else ""
        return f"{self.mission_control_url.rstrip('/')}{suffix}{query}"

    def _build_mission_control_headers(self, *, content_type: str | None = None, accept: str | None = None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = content_type
        if accept:
            headers["Accept"] = accept
        bearer = self.mission_control_auth.get("bearer")
        basic = self.mission_control_auth.get("basic")
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        elif basic:
            headers["Authorization"] = f"Basic {basic}"
        return headers

    def _proxy_mission_control_request(self, method: str, parsed, *, body: bytes | None = None, stream: bool = False) -> None:
        has_origin = bool(self.headers.get("Origin"))
        allowed, _origin = self._resolve_origin()
        if has_origin and not allowed:
            self._write_json(403, {"ok": False, "error": {"type": "forbidden", "message": "Origin not allowed"}}, add_cors=False)
            return

        req = urllib.request.Request(
            self._mission_control_target(parsed),
            data=body,
            method=method,
            headers=self._build_mission_control_headers(
                content_type=self.headers.get("Content-Type") if body is not None else None,
                accept=self.headers.get("Accept"),
            ),
        )

        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                status = resp.status
                content_type = resp.headers.get("Content-Type", "application/json")
                cache_control = resp.headers.get("Cache-Control", "no-store")
                if stream:
                    self.send_response(status)
                    if has_origin:
                        self._add_cors_headers_if_allowed()
                    self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", cache_control)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    while True:
                        chunk = resp.read(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    return

                resp_body = resp.read()
        except urllib.error.HTTPError as err:
            if stream:
                message = err.read().decode("utf-8", "replace")
                self._write_json(
                    err.code,
                    {"ok": False, "error": {"type": "bad_gateway", "message": f"Mission Control stream failed: {message}"}},
                    add_cors=has_origin,
                )
                return
            resp_body = err.read()
            status = err.code
            content_type = err.headers.get("Content-Type", "application/json") if err.headers else "application/json"
            cache_control = err.headers.get("Cache-Control", "no-store") if err.headers else "no-store"
        except Exception as exc:  # pylint: disable=broad-except
            self._write_json(
                502,
                {"ok": False, "error": {"type": "bad_gateway", "message": f"Mission Control forward failed: {exc}"}},
                add_cors=has_origin,
            )
            return

        self.send_response(status)
        if has_origin:
            self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def _handle_council_stream(self, parsed) -> None:
        run_id = parse_qs(parsed.query or "").get("run_id", [""])[0].strip()
        if not run_id:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Missing required query parameter: run_id"}}, add_cors=False)
            return

        try:
            subscription, history = self.council_event_bus.subscribe(run_id, replay=True)
        except KeyError:
            self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown council run: {run_id}"}}, add_cors=False)
            return

        self.send_response(200)
        self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            terminal_seen_in_history = False
            for event in history:
                self.wfile.write(self.council_event_bus.format_sse(event))
                if str(event.get("type") or "") == "run.status":
                    status = str(event.get("payload", {}).get("status") or "")
                    if status in {"completed", "failed", "stopped"}:
                        terminal_seen_in_history = True
            self.wfile.flush()

            if terminal_seen_in_history:
                self.close_connection = True
                return

            while True:
                try:
                    event = subscription.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    continue

                self.wfile.write(self.council_event_bus.format_sse(event))
                self.wfile.flush()

                event_type = str(event.get("type") or "")
                if event_type == "run.status":
                    status = str(event.get("payload", {}).get("status") or "")
                    if status in {"completed", "failed", "stopped"}:
                        self.close_connection = True
                        return
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            self.council_event_bus.unsubscribe(run_id, subscription)

    def _native_workspace_id(self, parsed) -> str:
        return parse_qs(parsed.query or "").get("workspace_id", ["default"])[0].strip() or "default"

    def _handle_native_events_stream(self, parsed) -> None:
        workspace_id = self._native_workspace_id(parsed)
        subscription = self.native_store.event_bus.subscribe(workspace_id)
        history = build_runtime_snapshot(self.native_store, self._runtime_sessions(), workspace_id)["events"]
        runtime_signature = runtime_replay_signature(runtime_replay_events(history))

        self.send_response(200)
        self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            for event in reversed(history[:50]):
                self.wfile.write(self.native_store.event_bus.format_sse(event))
            self.wfile.flush()
            while True:
                try:
                    event = subscription.queue.get(timeout=15)
                except queue.Empty:
                    snapshot_events = build_runtime_snapshot(self.native_store, self._runtime_sessions(), workspace_id)["events"]
                    runtime_events = runtime_replay_events(snapshot_events)
                    signature = runtime_replay_signature(runtime_events)
                    if signature and signature != runtime_signature:
                        runtime_signature = signature
                        for item in reversed(runtime_events):
                            self.wfile.write(self.native_store.event_bus.format_sse(item))
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(self.native_store.event_bus.format_sse(event))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            self.native_store.event_bus.unsubscribe(subscription)

    def _handle_native_get(self, parsed) -> bool:
        path = parsed.path
        workspace_id = self._native_workspace_id(parsed)
        runtime_snapshot = build_runtime_snapshot(self.native_store, self._runtime_sessions(), workspace_id)
        if path == "/api/mission-control/api/tasks":
            self._write_json(200, runtime_snapshot["tasks"])
            return True
        if path == "/api/mission-control/api/agents":
            self._write_json(200, runtime_snapshot["agents"])
            return True
        if path == "/api/mission-control/api/events":
            self._write_json(200, runtime_snapshot["events"])
            return True
        if path == "/api/mission-control/api/events/stream":
            self._handle_native_events_stream(parsed)
            return True
        if path == "/api/mission-control/api/agents/discover":
            self._write_json(200, self.native_store.discover_gateway_agents(workspace_id))
            return True
        if path == "/api/business-os":
            self._write_json(200, {"items": self.native_store.list_business_os()})
            return True
        if path == "/api/business-os/provisioning-runs":
            business_os_id = parse_qs(parsed.query or "").get("business_os_id", [None])[0]
            self._write_json(200, {"items": self.native_store.list_provisioning_runs(business_os_id)})
            return True
        if path == "/api/dashboard/summary":
            try:
                rows = fetch_supabase_rows(
                    self.supabase_url,
                    self.supabase_anon_key,
                    "agent_logs",
                    select="agent_name,task_description,status,created_at",
                    filters=[f"created_at=gte.{quote(day_start_utc(-6).isoformat().replace('+00:00', 'Z'), safe=':-TZ')}"],
                    order="created_at.desc",
                    limit=2000,
                )
                runtime_snapshot = build_runtime_snapshot(self.native_store, self._runtime_sessions(), workspace_id)
                open_tasks_count = sum(1 for task in runtime_snapshot["tasks"] if str(task.get("status") or "").lower() not in {"done", "verification"})
                self._write_json(200, summarize_dashboard_rows(rows, open_tasks_count))
            except Exception as exc:  # pylint: disable=broad-except
                self._write_json(500, {"ok": False, "error": {"type": "server_error", "message": f"Dashboard summary failed: {exc}"}})
            return True
        return False

    def _handle_native_post(self, parsed) -> bool:
        path = parsed.path
        if path not in {"/api/mission-control/api/tasks", "/api/mission-control/api/agents", "/api/mission-control/api/agents/import", "/api/mission-control/api/external-progress", "/api/openclaw/progress", "/api/business-os", "/api/business-os/provisioning-runs"}:
            return False
        payload, error = self._read_json_body()
        if error:
            self._write_json(error[0], error[1])
            return True
        try:
            if path == "/api/mission-control/api/tasks":
                self._write_json(201, self.native_store.create_task(payload))
                return True
            if path == "/api/mission-control/api/agents":
                self._write_json(201, self.native_store.create_agent(payload))
                return True
            if path == "/api/mission-control/api/agents/import":
                self._write_json(200, self.native_store.import_agents(payload))
                return True
            if path in {"/api/mission-control/api/external-progress", "/api/openclaw/progress"}:
                result = self.native_store.ingest_external_task_progress(payload)
                self._write_json(201 if result.get("created") else 200, result)
                return True
            if path == "/api/business-os":
                self._write_json(201, self.native_store.create_business_os(payload))
                return True
            if path == "/api/business-os/provisioning-runs":
                self._write_json(201, self.native_store.create_provisioning_run(payload))
                return True
        except ValueError as exc:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": str(exc)}})
            return True
        return False

    def _handle_native_patch(self, parsed) -> bool:
        payload, error = self._read_json_body()
        if error:
            self._write_json(error[0], error[1])
            return True
        path = parsed.path
        if path.startswith("/api/mission-control/api/tasks/"):
            task_id = path.rsplit("/", 1)[-1]
            updated = self.native_store.update_task(task_id, payload)
            if not updated:
                self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown task: {task_id}"}})
            else:
                self._write_json(200, updated)
            return True
        if path.startswith("/api/business-os/provisioning-runs/"):
            run_id = path.rsplit("/", 1)[-1]
            updated = self.native_store.update_provisioning_run(run_id, payload)
            if not updated:
                self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown provisioning run: {run_id}"}})
            else:
                self._write_json(200, updated)
            return True
        if path.startswith("/api/business-os/"):
            business_os_id = path.rsplit("/", 1)[-1]
            updated = self.native_store.update_business_os(business_os_id, payload)
            if not updated:
                self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown Business OS: {business_os_id}"}})
            else:
                self._write_json(200, updated)
            return True
        return False

    def _handle_native_delete(self, parsed) -> bool:
        path = parsed.path
        if path.startswith("/api/mission-control/api/tasks/"):
            task_id = path.rsplit("/", 1)[-1]
            deleted = self.native_store.delete_task(task_id)
            if not deleted:
                self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown task: {task_id}"}})
            else:
                self._write_json(200, {"ok": True, "deleted": task_id})
            return True
        return False

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._handle_native_get(parsed):
            return
        if parsed.path.startswith("/api/mission-control/"):
            self._proxy_mission_control_request("GET", parsed, stream=parsed.path.endswith("/events/stream"))
            return
        if parsed.path == "/api/council/run/stream":
            self._handle_council_stream(parsed)
            return
        if parsed.path != "/api/health":
            super().do_GET()
            return

        config_ok = False
        config_error = None
        try:
            load_gateway_token(self.config_path)
            config_ok = True
        except Exception as exc:  # pylint: disable=broad-except
            config_error = str(exc)

        payload = {
            "ok": config_ok,
            "service": "ceil-workspace-dashboard",
            "tools_url": self.tools_url,
            "mission_control_url": self.mission_control_url,
            "config_path": self.config_path,
            "allowed_gateway_ports": sorted(self.allowed_gateway_ports),
            "cors_mode": "explicit-allowlist-only",
            "has_explicit_allowed_origins": bool(self.allowed_origins),
            "mission_control_auth": "configured" if self.mission_control_auth else "not_configured",
        }
        if config_ok:
            payload["gateway_auth"] = "configured"
            self._write_json(200, payload, add_cors=False)
            return

        payload["error"] = {"type": "server_error", "message": f"Token load failed: {config_error}"}
        self._write_json(500, payload, add_cors=False)

    def _resolve_tools_url(self, parsed_path) -> tuple[str, int] | None:
        qs = parse_qs(parsed_path.query or "")
        requested_port = qs.get("port", [""])[0]
        if not requested_port:
            return self.tools_url, 18789

        try:
            port = int(requested_port)
        except ValueError:
            return None

        if port not in self.allowed_gateway_ports:
            return None

        return f"http://127.0.0.1:{port}/tools/invoke", port

    def _read_json_body(self) -> tuple[dict | None, tuple[int, dict] | None]:
        raw_len = self.headers.get("Content-Length")
        try:
            body_len = int(raw_len or "0")
        except ValueError:
            return None, (400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid Content-Length"}})

        if body_len <= 0 or body_len > 2_000_000:
            return None, (400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid request size"}})

        body = self.rfile.read(body_len)
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None, (400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid JSON body"}})

        if not isinstance(payload, dict):
            return None, (400, {"ok": False, "error": {"type": "bad_request", "message": "JSON body must be an object"}})
        return payload, None

    def _handle_council_start(self) -> None:
        payload, error = self._read_json_body()
        if error:
            self._write_json(error[0], error[1])
            return

        topic = str(payload.get("topic") or payload.get("notes") or "").strip()
        participants = [participant_slug(item) for item in payload.get("participants", []) if participant_slug(item)]
        if not topic:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Council run requires a topic"}})
            return
        if len(participants) < 2:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Council run requires at least 2 participants"}})
            return

        payload["participants"] = participants
        created_at = now_iso()
        state = self.council_event_bus.create_run(payload, created_at)
        self.council_orchestrator.start_run(state.run_id)
        self._write_json(202, {
            "ok": True,
            "run": {
                "id": state.run_id,
                "session_id": state.session_id,
                "status": state.status,
                "created_at": created_at,
            },
        })

    def _handle_council_stop(self) -> None:
        payload, error = self._read_json_body()
        if error:
            self._write_json(error[0], error[1])
            return

        run_id = str(payload.get("run_id") or "").strip()
        if not run_id:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Missing required field: run_id"}})
            return

        state = self.council_event_bus.mark_stop_requested(run_id, now_iso())
        if not state:
            self._write_json(404, {"ok": False, "error": {"type": "not_found", "message": f"Unknown council run: {run_id}"}})
            return

        self._write_json(200, {"ok": True, "run": {"id": run_id, "status": state.status, "stop_requested": True}})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._handle_native_post(parsed):
            return
        if parsed.path.startswith("/api/mission-control/"):
            raw_len = self.headers.get("Content-Length")
            try:
                body_len = int(raw_len or "0")
            except ValueError:
                self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid Content-Length"}})
                return
            body = self.rfile.read(body_len) if body_len > 0 else None
            self._proxy_mission_control_request("POST", parsed, body=body)
            return
        if parsed.path == "/api/council/run/start":
            self._handle_council_start()
            return
        if parsed.path == "/api/council/run/stop":
            self._handle_council_stop()
            return
        if parsed.path != "/api/tools/invoke":
            self.send_error(404)
            return

        has_origin = bool(self.headers.get("Origin"))
        allowed, _origin = self._resolve_origin()
        if has_origin and not allowed:
            self._write_json(403, {"ok": False, "error": {"type": "forbidden", "message": "Origin not allowed"}}, add_cors=False)
            return

        payload, error = self._read_json_body()
        if error:
            self._write_json(error[0], error[1])
            return

        if not isinstance(payload.get("tool"), str) or not payload["tool"].strip():
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Missing required field: tool"}})
            return

        body = json.dumps(payload).encode("utf-8")

        resolved = self._resolve_tools_url(parsed)
        if not resolved:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid or disallowed gateway port"}})
            return

        tools_url, target_port = resolved

        try:
            config_for_port = find_config_for_port(self.config_path, target_port)
            token = load_gateway_token(config_for_port)
        except Exception as exc:  # pylint: disable=broad-except
            self._write_json(500, {"ok": False, "error": {"type": "server_error", "message": f"Token load failed: {exc}"}})
            return

        req = urllib.request.Request(
            tools_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                resp_body = resp.read()
                status = resp.status
                content_type = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as err:
            resp_body = err.read()
            status = err.code
            content_type = err.headers.get("Content-Type", "application/json") if err.headers else "application/json"
        except Exception as exc:  # pylint: disable=broad-except
            self._write_json(502, {"ok": False, "error": {"type": "bad_gateway", "message": f"Runtime forward failed: {exc}"}})
            return

        self.send_response(status)
        if has_origin:
            self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def do_PATCH(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._handle_native_patch(parsed):
            return
        if not parsed.path.startswith("/api/mission-control/"):
            self.send_error(404)
            return

        raw_len = self.headers.get("Content-Length")
        try:
            body_len = int(raw_len or "0")
        except ValueError:
            self._write_json(400, {"ok": False, "error": {"type": "bad_request", "message": "Invalid Content-Length"}})
            return

        body = self.rfile.read(body_len) if body_len > 0 else None
        self._proxy_mission_control_request("PATCH", parsed, body=body)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._handle_native_delete(parsed):
            return
        if not parsed.path.startswith("/api/mission-control/"):
            self.send_error(404)
            return
        self._proxy_mission_control_request("DELETE", parsed)


def build_handler(directory: str):
    class _BoundHandler(DashboardHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

    return _BoundHandler


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve dashboard + proxy OpenClaw and Mission Control APIs")
    parser.add_argument("--bind", default=os.getenv("DASHBOARD_BIND", DEFAULT_BIND))
    parser.add_argument("--port", type=int, default=int(os.getenv("DASHBOARD_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--directory", default=os.getenv("DASHBOARD_DIRECTORY", DEFAULT_DIRECTORY))
    parser.add_argument("--config", default=os.getenv("OPENCLAW_CONFIG_PATH", DEFAULT_CONFIG_PATH))
    parser.add_argument("--tools-url", default=os.getenv("OPENCLAW_TOOLS_URL", DEFAULT_TOOLS_URL))
    parser.add_argument("--mission-control-url", default=os.getenv("MISSION_CONTROL_URL", DEFAULT_MISSION_CONTROL_URL))
    parser.add_argument(
        "--mission-control-env",
        default=os.getenv("MISSION_CONTROL_ENV_PATH", DEFAULT_MISSION_CONTROL_ENV_PATH),
        help="Path to Mission Control .env file for loading API auth credentials.",
    )
    parser.add_argument(
        "--allowed-origins",
        default=os.getenv("DASHBOARD_ALLOWED_ORIGINS", ""),
        help="Comma-separated browser origins allowed for CORS. Must be explicit http/https origins only; no forwarded-header fallback is allowed.",
    )
    parser.add_argument(
        "--allowed-gateway-ports",
        default=os.getenv("DASHBOARD_ALLOWED_GATEWAY_PORTS", ""),
        help="Comma-separated gateway ports allowed for proxy forwarding.",
    )
    parser.add_argument(
        "--council-artifact-path",
        default=os.getenv("DASHBOARD_COUNCIL_ARTIFACT_PATH", DEFAULT_COUNCIL_ARTIFACT_PATH),
        help="Directory for persisted council decision/action artifacts.",
    )
    parser.add_argument(
        "--native-state-path",
        default=os.getenv("DASHBOARD_NATIVE_STATE_PATH", DEFAULT_NATIVE_STATE_PATH),
        help="Path for native dashboard JSON state backing tasks, agents, events, and Business OS records.",
    )
    args = parser.parse_args()

    try:
        allowed_ports = parse_allowed_gateway_ports(args.allowed_gateway_ports)
    except ValueError as exc:
        parser.error(str(exc))

    try:
        allowed_origins = parse_allowed_origins(args.allowed_origins)
    except ValueError as exc:
        parser.error(str(exc))

    handler_cls = build_handler(args.directory)
    server = ThreadingHTTPServer((args.bind, args.port), handler_cls)
    server.allowed_origins = allowed_origins  # type: ignore[attr-defined]
    server.allowed_gateway_ports = allowed_ports  # type: ignore[attr-defined]
    server.config_path = args.config  # type: ignore[attr-defined]
    server.tools_url = args.tools_url  # type: ignore[attr-defined]
    server.mission_control_url = args.mission_control_url  # type: ignore[attr-defined]
    server.mission_control_env_path = args.mission_control_env  # type: ignore[attr-defined]
    server.mission_control_auth = load_mission_control_auth(  # type: ignore[attr-defined]
        os.getenv("MC_API_TOKEN"),
        args.mission_control_env,
        os.getenv("MC_BASIC_AUTH_USER"),
        os.getenv("MC_BASIC_AUTH_PASS"),
    )
    server.supabase_url = os.getenv("SUPABASE_URL", DEFAULT_SUPABASE_URL)  # type: ignore[attr-defined]
    server.supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", DEFAULT_SUPABASE_ANON_KEY)  # type: ignore[attr-defined]
    server.council_event_bus = CouncilEventBus()  # type: ignore[attr-defined]
    server.native_store = NativeDashboardStore(args.native_state_path)  # type: ignore[attr-defined]
    server.council_orchestrator = CouncilOrchestrator(  # type: ignore[attr-defined]
        event_bus=server.council_event_bus,
        tools_url_for_port=lambda port: f"http://127.0.0.1:{port}/tools/invoke",
        token_for_port=lambda port: load_gateway_token(find_config_for_port(args.config, port)),
        port_for_slug=lambda slug: next((candidate_port for candidate_port, path in DEFAULT_PORT_CONFIG_MAP.items() if Path(path).stem == slug), 18789),
        participant_slug_map=DEFAULT_PARTICIPANT_TO_SLUG,
        artifact_store=CouncilArtifactStore(args.council_artifact_path),
    )

    print(f"Dashboard server listening on http://{args.bind}:{args.port} (dir={args.directory})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

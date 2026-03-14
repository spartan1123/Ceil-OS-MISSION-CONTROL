from __future__ import annotations

import copy
import json
import os
import queue
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


DEFAULT_BUSINESS_TEMPLATE = "custom"
DEFAULT_BUSINESS_OS = {
    "id": "default",
    "slug": "default-business-os",
    "name": "Default Business OS",
    "description": "Migrated native default Business OS for the current CL dashboard.",
    "template": DEFAULT_BUSINESS_TEMPLATE,
    "template_selection": {
        "template_id": DEFAULT_BUSINESS_TEMPLATE,
        "selected_at": None,
        "source": "migration",
    },
    "status": "Active",
    "color": "#10B981",
    "is_default": True,
    "workspace_id": "default",
    "business_id": "default",
    "manager": "Workspace Manager",
    "leadership": {},
    "provisioning": {
        "status": "ready",
        "current_run_id": None,
        "last_run_id": None,
        "last_completed_at": None,
        "last_event_at": None,
        "progress": 100,
        "step": "ready",
        "template_id": DEFAULT_BUSINESS_TEMPLATE,
        "deep_research_required": False,
        "deep_research_status": "not_started",
    },
}


EXTERNAL_ACTOR_ALIASES: dict[str, list[str]] = {
    "workspace-orchestrator": ["ceil", "orchestrator", "workspace manager", "workspace-manager", "main-orchestrator"],
    "main-orchestrator": ["workspace-orchestrator", "ceil", "orchestrator", "workspace manager", "workspace-manager"],
    "ceil": ["workspace-orchestrator", "main-orchestrator", "orchestrator", "workspace-manager"],
    "senku-ishigami": ["senku ishigami", "senku", "provisioning architect", "provisioning-architect"],
    "provisioning-architect": ["senku-ishigami", "senku ishigami", "senku"],
    "quality-auditor": ["quality auditor"],
}


def normalize_external_actor(value: Any) -> str:
    raw = str(value or "").lower()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in raw).split())


def token_set(value: Any) -> set[str]:
    normalized = normalize_external_actor(value)
    return {item for item in normalized.split(" ") if item}


def score_external_actor_match(actor: str, agent: dict[str, Any]) -> int:
    actor_norm = normalize_external_actor(actor)
    if not actor_norm:
        return 0
    gateway_norm = normalize_external_actor(agent.get("gateway_agent_id"))
    name_norm = normalize_external_actor(agent.get("name"))
    role_norm = normalize_external_actor(agent.get("role"))
    if gateway_norm and gateway_norm == actor_norm:
        return 100
    if name_norm == actor_norm:
        return 95
    if name_norm and (name_norm in actor_norm or actor_norm in name_norm):
        return 80
    aliases = EXTERNAL_ACTOR_ALIASES.get(actor_norm, [])
    alias_norms = {normalize_external_actor(item) for item in aliases}
    if any(candidate and candidate in alias_norms for candidate in (gateway_norm, name_norm, role_norm)):
        return 70
    actor_tokens = token_set(actor_norm)
    if actor_tokens:
        name_tokens = token_set(agent.get("name"))
        role_tokens = token_set(agent.get("role"))
        overlap = sum(1 for token in actor_tokens if token in name_tokens or token in role_tokens)
        if overlap == len(actor_tokens):
            return 60
    if "orchestrator" in actor_norm and bool(agent.get("is_master")):
        return 50
    return 0


def map_external_status(status: Any, source: Any, actor: Any, message: Any) -> dict[str, str]:
    normalized = str(status or "").strip().lower()
    source_name = str(source or "external source").strip() or "external source"
    actor_name = str(actor or source_name).strip() or source_name
    message_text = str(message or "").strip()
    if normalized in {"completed", "complete", "done", "succeeded", "success"}:
        task_status = "done"
        activity_type = "external_progress_completed"
        event_type = "task_updated"
    elif normalized in {"failed", "error"}:
        task_status = "blocked"
        activity_type = "external_progress_failed"
        event_type = "task_updated"
    elif normalized in {"blocked", "waiting", "paused"}:
        task_status = "blocked"
        activity_type = "external_progress_blocked"
        event_type = "task_updated"
    elif normalized in {"started", "assigned", "queued"}:
        task_status = "assigned"
        activity_type = "external_progress_started"
        event_type = "task_created"
    else:
        task_status = "in_progress"
        activity_type = "external_progress_updated"
        event_type = "task_updated"
    reason = f"{normalized.title() or 'Updated'} via {source_name}"
    if actor_name:
        reason += f" ({actor_name})"
    if message_text:
        reason += f": {message_text}"
    return {"task_status": task_status, "activity_type": activity_type, "event_type": event_type, "status_reason": reason}


def build_external_task_title(payload: dict[str, Any]) -> str:
    explicit = str(payload.get("title") or "").strip()
    if explicit:
        return explicit
    actor = str(payload.get("actor") or payload.get("source") or "External worker").strip() or "External worker"
    status = str(payload.get("status") or "update").strip() or "update"
    return f"External work: {actor} ({status})"


def build_external_activity_message(payload: dict[str, Any]) -> str:
    actor = str(payload.get("actor") or payload.get("source") or "External worker").strip() or "External worker"
    status = str(payload.get("status") or "updated").strip() or "updated"
    details = str(payload.get("message") or payload.get("description") or "").strip()
    message = f"{actor} reported {status}"
    if details:
        message += f": {details}"
    return message


def build_external_event_key(payload: dict[str, Any]) -> str:
    parts = [
        str(payload.get("source") or "").strip(),
        str(payload.get("external_run_id") or "").strip(),
        str(payload.get("external_event_id") or "").strip(),
        str(payload.get("occurred_at") or "").strip(),
        str(payload.get("status") or "").strip(),
        str(payload.get("message") or "").strip(),
        str(payload.get("external_task_ref") or "").strip(),
    ]
    return "|".join(parts)


@dataclass
class NativeSubscription:
    queue: queue.Queue
    workspace_id: str | None


class NativeEventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscriptions: list[NativeSubscription] = []

    def subscribe(self, workspace_id: str | None = None) -> NativeSubscription:
        subscription = NativeSubscription(queue=queue.Queue(), workspace_id=workspace_id)
        with self._lock:
            self._subscriptions.append(subscription)
        return subscription

    def unsubscribe(self, subscription: NativeSubscription) -> None:
        with self._lock:
            self._subscriptions = [item for item in self._subscriptions if item is not subscription]

    def publish(self, event: dict[str, Any]) -> None:
        workspace_id = str(event.get("workspace_id") or "default")
        with self._lock:
            subscribers = list(self._subscriptions)
        for subscription in subscribers:
            if subscription.workspace_id and subscription.workspace_id != workspace_id:
                continue
            subscription.queue.put(copy.deepcopy(event))

    @staticmethod
    def format_sse(event: dict[str, Any]) -> bytes:
        payload = json.dumps(event, ensure_ascii=False)
        return f"data: {payload}\n\n".encode("utf-8")


class NativeDashboardStore:
    def __init__(self, path: str | Path, event_bus: NativeEventBus | None = None) -> None:
        self.path = Path(path)
        self.event_bus = event_bus or NativeEventBus()
        self._lock = threading.Lock()
        self._state = self._load_state()

    def _default_state(self) -> dict[str, Any]:
        created_at = now_iso()
        return {
            "business_os": [dict(DEFAULT_BUSINESS_OS, created_at=created_at, updated_at=created_at)],
            "provisioning_runs": [],
            "tasks": [],
            "agents": [],
            "external_task_syncs": [],
            "events": [
                {
                    "id": f"evt-{uuid.uuid4().hex[:10]}",
                    "type": "business_os_seeded",
                    "workspace_id": "default",
                    "business_id": "default",
                    "business_os_id": "default",
                    "message": "Default Business OS ready",
                    "created_at": created_at,
                }
            ],
        }

    def _load_state(self) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._quarantine_corrupt_state()
                payload = self._default_state()
        else:
            payload = self._default_state()
        payload = self._normalize_state(payload)
        self._write_state(payload)
        return payload

    def _quarantine_corrupt_state(self) -> None:
        if not self.path.exists():
            return
        quarantine = self.path.with_name(f"{self.path.stem}.corrupt-{uuid.uuid4().hex[:8]}{self.path.suffix}")
        try:
            self.path.replace(quarantine)
        except OSError:
            return

    def _normalize_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = {
            "business_os": list(payload.get("business_os") or []),
            "provisioning_runs": list(payload.get("provisioning_runs") or []),
            "tasks": list(payload.get("tasks") or []),
            "agents": list(payload.get("agents") or []),
            "external_task_syncs": list(payload.get("external_task_syncs") or []),
            "events": list(payload.get("events") or []),
        }
        state["business_os"] = [self._normalize_business_os_record(item) for item in state["business_os"] if isinstance(item, dict)]
        state["provisioning_runs"] = [self._normalize_provisioning_run(item) for item in state["provisioning_runs"] if isinstance(item, dict)]
        state["external_task_syncs"] = [self._normalize_external_task_sync(item) for item in state["external_task_syncs"] if isinstance(item, dict)]
        if not any(str(item.get("id") or "") == "default" for item in state["business_os"]):
            created_at = now_iso()
            state["business_os"].insert(0, self._normalize_business_os_record(dict(DEFAULT_BUSINESS_OS, created_at=created_at, updated_at=created_at)))
        return state

    def _write_state(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        body = json.dumps(state, indent=2, sort_keys=True)
        with tmp_path.open("w", encoding="utf-8") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, self.path)

    def _persist_locked(self) -> None:
        snapshot = copy.deepcopy(self._state)
        try:
            self._write_state(snapshot)
        except Exception:
            self._state = snapshot
            raise

    def _snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._state)

    def _normalize_business_os_record(self, item: dict[str, Any]) -> dict[str, Any]:
        created_at = str(item.get("created_at") or now_iso())
        updated_at = str(item.get("updated_at") or created_at)
        business_os_id = str(item.get("id") or item.get("business_os_id") or f"os-{uuid.uuid4().hex[:10]}").strip()
        template = str(item.get("template") or DEFAULT_BUSINESS_TEMPLATE).strip() or DEFAULT_BUSINESS_TEMPLATE
        workspace_id = str(item.get("workspace_id") or business_os_id).strip() or business_os_id
        business_id = str(item.get("business_id") or workspace_id).strip() or workspace_id
        leadership_payload = item.get("leadership") if isinstance(item.get("leadership"), dict) else {}
        manager = str(item.get("manager") or leadership_payload.get("manager") or "Workspace Manager").strip() or "Workspace Manager"
        leadership = {
            "manager": manager,
            "cto": str(item.get("cto") or leadership_payload.get("cto") or "").strip(),
            "cmo": str(item.get("cmo") or leadership_payload.get("cmo") or "").strip(),
            "cro": str(item.get("cro") or leadership_payload.get("cro") or "").strip(),
        }
        template_selection_payload = item.get("template_selection") if isinstance(item.get("template_selection"), dict) else {}
        provisioning_payload = item.get("provisioning") if isinstance(item.get("provisioning"), dict) else {}
        return {
            "id": business_os_id,
            "slug": str(item.get("slug") or business_os_id).strip() or business_os_id,
            "name": str(item.get("name") or "").strip(),
            "description": str(item.get("description") or "").strip() or None,
            "template": template,
            "template_selection": {
                "template_id": str(template_selection_payload.get("template_id") or template).strip() or template,
                "selected_at": template_selection_payload.get("selected_at") or created_at,
                "source": str(template_selection_payload.get("source") or item.get("template_selection_source") or ("migration" if item.get("is_default") else "wizard")).strip() or "wizard",
            },
            "status": str(item.get("status") or "Provisioning").strip() or "Provisioning",
            "color": str(item.get("color") or "#06B6D4").strip() or "#06B6D4",
            "is_default": bool(item.get("is_default")),
            "workspace_id": workspace_id,
            "business_id": business_id,
            "business_os_id": business_os_id,
            "manager": manager,
            "leadership": leadership,
            "provisioning": {
                "status": str(provisioning_payload.get("status") or ("ready" if str(item.get("status") or "") == "Active" else "pending")).strip() or "pending",
                "current_run_id": provisioning_payload.get("current_run_id"),
                "last_run_id": provisioning_payload.get("last_run_id"),
                "last_completed_at": provisioning_payload.get("last_completed_at"),
                "last_event_at": provisioning_payload.get("last_event_at") or updated_at,
                "progress": int(provisioning_payload.get("progress") if provisioning_payload.get("progress") is not None else (100 if str(item.get("status") or "") == "Active" else 0)),
                "step": str(provisioning_payload.get("step") or ("ready" if str(item.get("status") or "") == "Active" else "queued")).strip() or "queued",
                "template_id": str(provisioning_payload.get("template_id") or template).strip() or template,
                "deep_research_required": bool(provisioning_payload.get("deep_research_required")),
                "deep_research_status": str(provisioning_payload.get("deep_research_status") or ("not_started" if not provisioning_payload.get("deep_research_required") else "queued")).strip() or "not_started",
            },
            "created_at": created_at,
            "updated_at": updated_at,
        }

    def _normalize_provisioning_run(self, item: dict[str, Any]) -> dict[str, Any]:
        created_at = str(item.get("created_at") or now_iso())
        updated_at = str(item.get("updated_at") or created_at)
        template_payload = item.get("template_selection") if isinstance(item.get("template_selection"), dict) else {}
        steps = [copy.deepcopy(step) for step in (item.get("steps") or []) if isinstance(step, dict)]
        logs = [str(line) for line in (item.get("logs") or []) if str(line).strip()]
        return {
            "id": str(item.get("id") or f"prov-{uuid.uuid4().hex[:10]}"),
            "business_os_id": str(item.get("business_os_id") or item.get("workspace_id") or "default").strip() or "default",
            "workspace_id": str(item.get("workspace_id") or item.get("business_os_id") or "default").strip() or "default",
            "business_id": str(item.get("business_id") or item.get("business_os_id") or item.get("workspace_id") or "default").strip() or "default",
            "status": str(item.get("status") or "queued").strip() or "queued",
            "progress": int(item.get("progress") if item.get("progress") is not None else 0),
            "current_step": str(item.get("current_step") or "queued").strip() or "queued",
            "template_selection": {
                "template_id": str(template_payload.get("template_id") or item.get("template") or DEFAULT_BUSINESS_TEMPLATE).strip() or DEFAULT_BUSINESS_TEMPLATE,
                "selected_at": template_payload.get("selected_at") or created_at,
                "source": str(template_payload.get("source") or "wizard").strip() or "wizard",
            },
            "deep_research": {
                "required": bool((item.get("deep_research") or {}).get("required") if isinstance(item.get("deep_research"), dict) else item.get("deep_research_required")),
                "status": str(((item.get("deep_research") or {}).get("status") if isinstance(item.get("deep_research"), dict) else item.get("deep_research_status")) or "not_started").strip() or "not_started",
            },
            "wizard_payload": copy.deepcopy(item.get("wizard_payload") or {}),
            "steps": steps,
            "logs": logs[-120:],
            "started_at": item.get("started_at") or created_at,
            "completed_at": item.get("completed_at"),
            "created_at": created_at,
            "updated_at": updated_at,
        }

    def _normalize_external_task_sync(self, item: dict[str, Any]) -> dict[str, Any]:
        created_at = str(item.get("created_at") or now_iso())
        updated_at = str(item.get("updated_at") or created_at)
        last_event_key = str(item.get("last_event_key") or "").strip() or None
        processed_event_keys = [
            str(value).strip()
            for value in list(item.get("processed_event_keys") or [])
            if str(value).strip()
        ]
        if last_event_key and last_event_key not in processed_event_keys:
            processed_event_keys.append(last_event_key)
        processed_event_keys = processed_event_keys[-64:]
        return {
            "id": str(item.get("id") or f"sync-{uuid.uuid4().hex[:10]}"),
            "source": str(item.get("source") or "external").strip() or "external",
            "external_run_id": str(item.get("external_run_id") or "").strip(),
            "task_id": str(item.get("task_id") or "").strip(),
            "workspace_id": str(item.get("workspace_id") or "default").strip() or "default",
            "business_id": str(item.get("business_id") or item.get("workspace_id") or "default").strip() or "default",
            "external_task_ref": str(item.get("external_task_ref") or "").strip() or None,
            "actor": str(item.get("actor") or "").strip() or None,
            "last_event_key": last_event_key,
            "processed_event_keys": processed_event_keys,
            "last_status": str(item.get("last_status") or "").strip() or None,
            "metadata": copy.deepcopy(item.get("metadata") or {}),
            "created_at": created_at,
            "updated_at": updated_at,
        }

    def _find_business_os_locked(self, business_os_id: str) -> dict[str, Any] | None:
        return next((item for item in self._state["business_os"] if str(item.get("id") or "") == business_os_id), None)

    def _find_provisioning_run_locked(self, run_id: str) -> dict[str, Any] | None:
        return next((item for item in self._state["provisioning_runs"] if str(item.get("id") or "") == run_id), None)

    @staticmethod
    def _is_terminal_provisioning_status(status: Any) -> bool:
        return str(status or "").strip() in {"completed", "failed", "cancelled"}

    @staticmethod
    def _provisioning_sort_key(run: dict[str, Any]) -> tuple[str, str, str, str]:
        return (
            str(run.get("completed_at") or ""),
            str(run.get("updated_at") or ""),
            str(run.get("created_at") or ""),
            str(run.get("id") or ""),
        )

    @classmethod
    def _provisioning_authority_sort_key(cls, run: dict[str, Any]) -> tuple[str, str, str, str]:
        """Deterministic recency key for dashboard projection authority.

        Non-terminal runs win by newest run recency (`started_at`/`created_at`),
        with `updated_at` breaking ties. If every run is terminal, the newest run
        still wins by creation recency, with terminal event timestamps as
        tie-breakers. The run id breaks ties so selection never depends on list
        order.
        """
        created_at = str(run.get("created_at") or "")
        updated_at = str(run.get("updated_at") or "")
        if cls._is_terminal_provisioning_status(run.get("status")):
            primary_timestamp = created_at
            terminal_status = str(run.get("status") or "").strip()
            if terminal_status == "completed":
                secondary_timestamp = f"0:{str(run.get('completed_at') or updated_at or created_at)}"
            else:
                secondary_timestamp = f"1:{updated_at or created_at}"
        else:
            primary_timestamp = str(run.get("started_at") or created_at)
            secondary_timestamp = updated_at or created_at
        return (
            primary_timestamp,
            secondary_timestamp,
            updated_at,
            str(run.get("id") or ""),
        )

    def _business_os_runs_locked(self, business_os_id: str) -> list[dict[str, Any]]:
        return [item for item in self._state["provisioning_runs"] if str(item.get("business_os_id") or "") == business_os_id]

    def _select_authoritative_provisioning_run_locked(self, business_os_id: str) -> dict[str, Any] | None:
        runs = self._business_os_runs_locked(business_os_id)
        if not runs:
            return None
        active_runs = [item for item in runs if not self._is_terminal_provisioning_status(item.get("status"))]
        candidates = active_runs or runs
        return max(candidates, key=self._provisioning_authority_sort_key)

    def _last_completed_at_locked(self, business_os_id: str) -> str | None:
        completed_runs = [
            item for item in self._business_os_runs_locked(business_os_id)
            if str(item.get("status") or "").strip() == "completed" and item.get("completed_at")
        ]
        if not completed_runs:
            return None
        return max(completed_runs, key=self._provisioning_sort_key).get("completed_at")

    def _sync_business_os_provisioning_locked(self, business: dict[str, Any], run: dict[str, Any]) -> None:
        authoritative_run = self._select_authoritative_provisioning_run_locked(str(business.get("id") or ""))
        if authoritative_run is None:
            return
        last_completed_at = self._last_completed_at_locked(str(business.get("id") or ""))
        business["template"] = authoritative_run["template_selection"]["template_id"]
        business.setdefault("template_selection", {})
        business["template_selection"] = copy.deepcopy(authoritative_run["template_selection"])
        business.setdefault("provisioning", {})
        business["provisioning"].update({
            "status": authoritative_run["status"],
            "current_run_id": None if self._is_terminal_provisioning_status(authoritative_run["status"]) else authoritative_run["id"],
            "last_run_id": authoritative_run["id"],
            "last_completed_at": last_completed_at,
            "last_event_at": authoritative_run["updated_at"],
            "progress": authoritative_run["progress"],
            "step": authoritative_run["current_step"],
            "template_id": authoritative_run["template_selection"]["template_id"],
            "deep_research_required": authoritative_run["deep_research"]["required"],
            "deep_research_status": authoritative_run["deep_research"]["status"],
        })
        status = str(authoritative_run.get("status") or "").strip()
        business["status"] = {
            "completed": "Active",
            "failed": "Failed",
            "cancelled": "Cancelled",
        }.get(status, "Provisioning")
        business["updated_at"] = authoritative_run["updated_at"]

    def list_business_os(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._state["business_os"])

    def get_business_os(self, business_os_id: str) -> dict[str, Any] | None:
        with self._lock:
            for item in self._state["business_os"]:
                if str(item.get("id") or "") == business_os_id:
                    return copy.deepcopy(item)
        return None

    def create_business_os(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = now_iso()
        template = str(payload.get("template") or DEFAULT_BUSINESS_TEMPLATE).strip() or DEFAULT_BUSINESS_TEMPLATE
        business_os_id = str(payload.get("id") or f"os-{uuid.uuid4().hex[:10]}")
        business = self._normalize_business_os_record({
            **payload,
            "id": business_os_id,
            "template": template,
            "template_selection": payload.get("template_selection") or {
                "template_id": template,
                "selected_at": created_at,
                "source": "wizard",
            },
            "provisioning": payload.get("provisioning") or {
                "status": "ready" if str(payload.get("status") or "") == "Active" else "pending",
                "current_run_id": None,
                "last_run_id": None,
                "last_completed_at": None,
                "last_event_at": created_at,
                "progress": 100 if str(payload.get("status") or "") == "Active" else 0,
                "step": "ready" if str(payload.get("status") or "") == "Active" else "queued",
                "template_id": template,
                "deep_research_required": False,
                "deep_research_status": "not_started",
            },
            "created_at": created_at,
            "updated_at": created_at,
        })
        if not business["name"]:
            raise ValueError("Business OS name is required")

        event: dict[str, Any] | None = None
        with self._lock:
            if any(str(item.get("id") or "") == business_os_id for item in self._state["business_os"]):
                raise ValueError(f"Business OS already exists: {business_os_id}")
            previous = self._snapshot()
            self._state["business_os"].insert(0, business)
            event = self._append_event_locked(
                {
                    "type": "business_os_created",
                    "workspace_id": business["workspace_id"],
                    "business_id": business["business_id"],
                    "business_os_id": business_os_id,
                    "message": f'Business OS created: {business["name"]}',
                    "business_os": business,
                }
            )
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
        if event:
            self.event_bus.publish(event)
        return copy.deepcopy(business)

    def update_business_os(self, business_os_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        event: dict[str, Any] | None = None
        updated: dict[str, Any] | None = None
        with self._lock:
            for item in self._state["business_os"]:
                if str(item.get("id") or "") != business_os_id:
                    continue
                previous = self._snapshot()
                for key in ["name", "description", "template", "status", "color", "workspace_id", "business_id", "manager"]:
                    if key in patch and patch[key] is not None:
                        value = str(patch[key]).strip()
                        if value:
                            item[key] = value
                if "template" in patch and str(patch.get("template") or "").strip():
                    item.setdefault("template_selection", {})["template_id"] = item["template"]
                if "template_selection" in patch and isinstance(patch.get("template_selection"), dict):
                    incoming = patch["template_selection"]
                    item.setdefault("template_selection", {})
                    for key in ["template_id", "selected_at", "source"]:
                        if incoming.get(key) is not None and str(incoming.get(key)).strip():
                            item["template_selection"][key] = str(incoming.get(key)).strip()
                    item["template"] = str(item["template_selection"].get("template_id") or item.get("template") or DEFAULT_BUSINESS_TEMPLATE).strip() or DEFAULT_BUSINESS_TEMPLATE
                for leader_key in ["manager", "cto", "cmo", "cro"]:
                    if leader_key in patch:
                        item.setdefault("leadership", {})[leader_key] = str(patch.get(leader_key) or "").strip()
                if "provisioning" in patch and isinstance(patch.get("provisioning"), dict):
                    item.setdefault("provisioning", {})
                    for key, value in patch["provisioning"].items():
                        if value is not None:
                            item["provisioning"][key] = value
                item["manager"] = str(item.get("manager") or item.get("leadership", {}).get("manager") or "Workspace Manager").strip() or "Workspace Manager"
                item.setdefault("leadership", {})["manager"] = item["manager"]
                normalized = self._normalize_business_os_record(item)
                item.clear()
                item.update(normalized)
                item["updated_at"] = now_iso()
                updated = copy.deepcopy(item)
                event = self._append_event_locked(
                    {
                        "type": "business_os_updated",
                        "workspace_id": item.get("workspace_id") or "default",
                        "business_id": item.get("business_id") or item.get("id") or "default",
                        "business_os_id": business_os_id,
                        "message": f'Business OS updated: {item.get("name") or business_os_id}',
                        "business_os": item,
                    }
                )
                try:
                    self._persist_locked()
                except Exception:
                    self._state = previous
                    raise
                break
        if event:
            self.event_bus.publish(event)
        return updated

    def list_provisioning_runs(self, business_os_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            runs = copy.deepcopy(self._state["provisioning_runs"])
        if business_os_id:
            runs = [item for item in runs if str(item.get("business_os_id") or "") == business_os_id]
        return sorted(runs, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def create_provisioning_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = now_iso()
        business_os_id = str(payload.get("business_os_id") or payload.get("workspace_id") or "").strip()
        if not business_os_id:
            raise ValueError("business_os_id is required")
        run = self._normalize_provisioning_run({**payload, "business_os_id": business_os_id, "created_at": created_at, "updated_at": created_at})
        event: dict[str, Any] | None = None
        with self._lock:
            business = self._find_business_os_locked(business_os_id)
            if business is None:
                raise ValueError(f"Unknown Business OS: {business_os_id}")
            if any(str(item.get("id") or "") == run["id"] for item in self._state["provisioning_runs"]):
                raise ValueError(f"Provisioning run already exists: {run['id']}")
            active_run = next(
                (
                    item for item in self._business_os_runs_locked(business_os_id)
                    if not self._is_terminal_provisioning_status(item.get("status"))
                ),
                None,
            )
            if active_run is not None:
                raise ValueError(
                    f"Provisioning already active for Business OS: {business_os_id} (run {active_run['id']})"
                )
            previous = self._snapshot()
            self._state["provisioning_runs"].insert(0, run)
            self._sync_business_os_provisioning_locked(business, run)
            event = self._append_event_locked({
                "type": "business_os_provisioning_run_created",
                "workspace_id": run["workspace_id"],
                "business_id": run["business_id"],
                "business_os_id": business_os_id,
                "message": f'Provisioning started: {business.get("name") or business_os_id}',
                "business_os": business,
            })
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
        if event:
            self.event_bus.publish(event)
        return copy.deepcopy(run)

    def update_provisioning_run(self, run_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        event: dict[str, Any] | None = None
        updated: dict[str, Any] | None = None
        with self._lock:
            run = self._find_provisioning_run_locked(run_id)
            if run is None:
                return None
            business = self._find_business_os_locked(str(run.get("business_os_id") or ""))
            if business is None:
                raise ValueError(f"Unknown Business OS: {run.get('business_os_id')}")
            previous = self._snapshot()
            for key in ["status", "progress", "current_step", "completed_at", "started_at"]:
                if key in patch and patch[key] is not None:
                    run[key] = patch[key]
            if "template_selection" in patch and isinstance(patch.get("template_selection"), dict):
                run.setdefault("template_selection", {}).update(copy.deepcopy(patch["template_selection"]))
            if "deep_research" in patch and isinstance(patch.get("deep_research"), dict):
                run.setdefault("deep_research", {}).update(copy.deepcopy(patch["deep_research"]))
            if "wizard_payload" in patch and isinstance(patch.get("wizard_payload"), dict):
                run["wizard_payload"] = copy.deepcopy(patch["wizard_payload"])
            if "steps" in patch and isinstance(patch.get("steps"), list):
                run["steps"] = [copy.deepcopy(step) for step in patch["steps"] if isinstance(step, dict)]
            if "logs" in patch and isinstance(patch.get("logs"), list):
                run["logs"] = [str(line) for line in patch["logs"] if str(line).strip()][-120:]
            run["updated_at"] = now_iso()
            normalized = self._normalize_provisioning_run(run)
            run.clear()
            run.update(normalized)
            self._sync_business_os_provisioning_locked(business, run)
            updated = copy.deepcopy(run)
            event = self._append_event_locked({
                "type": "business_os_provisioning_run_updated",
                "workspace_id": run["workspace_id"],
                "business_id": run["business_id"],
                "business_os_id": run["business_os_id"],
                "message": f'Provisioning updated: {business.get("name") or run["business_os_id"]} ({run["status"]})',
                "business_os": business,
            })
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
        if event:
            self.event_bus.publish(event)
        return updated

    def _find_external_task_sync_locked(self, source: str, external_run_id: str, external_task_ref: str | None = None) -> dict[str, Any] | None:
        normalized_task_ref = str(external_task_ref or "").strip() or None
        return next((
            item for item in self._state["external_task_syncs"]
            if str(item.get("source") or "") == source
            and str(item.get("external_run_id") or "") == external_run_id
            and (str(item.get("external_task_ref") or "").strip() or None) == normalized_task_ref
        ), None)

    def resolve_external_actor_agent_id(self, actor: Any, workspace_id: str = "default") -> str | None:
        actor_norm = normalize_external_actor(actor)
        if not actor_norm:
            return None
        with self._lock:
            agents = [copy.deepcopy(item) for item in self._state["agents"] if str(item.get("workspace_id") or "default") == workspace_id]
        best_match: dict[str, Any] | None = None
        ambiguous = False
        for agent in agents:
            score = score_external_actor_match(actor_norm, agent)
            if score <= 0:
                continue
            if best_match is None or score > int(best_match["score"]):
                best_match = {"id": str(agent.get("id") or ""), "score": score}
                ambiguous = False
                continue
            if score == int(best_match["score"]) and str(agent.get("id") or "") != str(best_match["id"]):
                ambiguous = True
        if not best_match or ambiguous:
            return None
        return str(best_match["id"])

    def ingest_external_task_progress(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = str(payload.get("source") or "").strip()
        external_run_id = str(payload.get("external_run_id") or "").strip()
        if not source:
            raise ValueError("source is required")
        if not external_run_id:
            raise ValueError("external_run_id is required")
        workspace_id = str(payload.get("workspace_id") or "default").strip() or "default"
        business_id = str(payload.get("business_id") or workspace_id).strip() or workspace_id
        external_task_ref = str(payload.get("external_task_ref") or "").strip() or None
        now = str(payload.get("occurred_at") or now_iso()).strip() or now_iso()
        event_key = build_external_event_key(payload)
        mapping = map_external_status(payload.get("status"), source, payload.get("actor"), payload.get("message"))
        actor_agent_id = self.resolve_external_actor_agent_id(payload.get("actor"), workspace_id)
        task_title = build_external_task_title(payload)
        activity_message = build_external_activity_message(payload)
        metadata = {
            **copy.deepcopy(payload.get("metadata") or {}),
            "source": source,
            "actor": str(payload.get("actor") or "").strip() or None,
            "external_run_id": external_run_id,
            "external_task_ref": external_task_ref,
            "external_event_id": str(payload.get("external_event_id") or "").strip() or None,
            "occurred_at": now,
            "external_status": str(payload.get("status") or "").strip() or None,
            "status_reason": mapping["status_reason"],
        }
        published_events: list[dict[str, Any]] = []
        with self._lock:
            existing_sync = self._find_external_task_sync_locked(source, external_run_id, external_task_ref)
            processed_event_keys = [
                str(value).strip()
                for value in list((existing_sync or {}).get("processed_event_keys") or [])
                if str(value).strip()
            ]
            if existing_sync and event_key in set(processed_event_keys):
                task = next((copy.deepcopy(item) for item in self._state["tasks"] if str(item.get("id") or "") == str(existing_sync.get("task_id") or "")), None)
                return {
                    "task": self._enrich_task(task),
                    "created": False,
                    "idempotent": True,
                    "workspace_id": str(existing_sync.get("workspace_id") or workspace_id),
                }
            previous = self._snapshot()
            created = existing_sync is None
            task_id = str(existing_sync.get("task_id") or "") if existing_sync else f"task-{uuid.uuid4().hex[:10]}"
            sync_id = str(existing_sync.get("id") or "") if existing_sync else f"sync-{uuid.uuid4().hex[:10]}"
            task = next((item for item in self._state["tasks"] if str(item.get("id") or "") == task_id), None)
            if created:
                task = {
                    "id": task_id,
                    "title": task_title,
                    "description": str(payload.get("description") or "").strip() or None,
                    "priority": "normal",
                    "status": mapping["task_status"],
                    "task_type": "general",
                    "assigned_agent_id": actor_agent_id,
                    "due_date": None,
                    "workspace_id": workspace_id,
                    "business_id": business_id,
                    "status_reason": mapping["status_reason"],
                    "external_source": source,
                    "external_actor": str(payload.get("actor") or "").strip() or None,
                    "external_run_id": external_run_id,
                    "external_task_ref": external_task_ref,
                    "external_metadata": copy.deepcopy(metadata),
                    "created_at": now,
                    "updated_at": now,
                }
                self._state["tasks"].insert(0, task)
            else:
                if task is None:
                    raise ValueError("Task not found for existing external sync")
                if str(payload.get("title") or "").strip():
                    task["title"] = task_title
                if "description" in payload:
                    task["description"] = str(payload.get("description") or "").strip() or None
                task["status"] = mapping["task_status"]
                task["status_reason"] = mapping["status_reason"]
                if "actor" in payload:
                    # Safer update rule: when a later payload names an actor but resolution is
                    # unresolved or ambiguous, clear any prior assignment instead of preserving
                    # stale ownership.
                    task["assigned_agent_id"] = actor_agent_id
                task["external_source"] = source
                task["external_actor"] = str(payload.get("actor") or "").strip() or None
                task["external_run_id"] = external_run_id
                task["external_task_ref"] = external_task_ref
                task["external_metadata"] = copy.deepcopy(metadata)
                task["updated_at"] = now
            event = self._append_event_locked({
                "type": "task_created" if created else mapping["event_type"],
                "workspace_id": workspace_id,
                "business_id": business_id,
                "task_id": task_id,
                "agent_id": actor_agent_id,
                "message": activity_message,
                "created_at": now,
            })
            published_events.append(event)
            sync_payload = self._normalize_external_task_sync({
                "id": sync_id,
                "source": source,
                "external_run_id": external_run_id,
                "task_id": task_id,
                "workspace_id": workspace_id,
                "business_id": business_id,
                "external_task_ref": external_task_ref,
                "actor": payload.get("actor"),
                "last_event_key": event_key,
                "processed_event_keys": (processed_event_keys + [event_key])[-64:] if event_key not in processed_event_keys else processed_event_keys[-64:],
                "last_status": payload.get("status"),
                "metadata": metadata,
                "created_at": existing_sync.get("created_at") if existing_sync else now,
                "updated_at": now,
            })
            if created:
                self._state["external_task_syncs"].insert(0, sync_payload)
            else:
                existing_sync.clear()
                existing_sync.update(sync_payload)
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
            response_task = copy.deepcopy(task)
        for event in published_events:
            self.event_bus.publish(event)
        return {"task": self._enrich_task(response_task), "created": created, "idempotent": False, "workspace_id": workspace_id}

    def list_tasks(self, workspace_id: str = "default") -> list[dict[str, Any]]:
        with self._lock:
            tasks = [copy.deepcopy(item) for item in self._state["tasks"] if str(item.get("workspace_id") or "default") == workspace_id]
        return tasks

    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = now_iso()
        task = {
            "id": str(payload.get("id") or f"task-{uuid.uuid4().hex[:10]}"),
            "title": str(payload.get("title") or "").strip(),
            "description": str(payload.get("description") or "").strip() or None,
            "priority": str(payload.get("priority") or "normal").strip() or "normal",
            "status": str(payload.get("status") or "inbox").strip() or "inbox",
            "task_type": str(payload.get("task_type") or "general").strip() or "general",
            "assigned_agent_id": str(payload.get("assigned_agent_id") or "").strip() or None,
            "due_date": str(payload.get("due_date") or "").strip() or None,
            "workspace_id": str(payload.get("workspace_id") or "default").strip() or "default",
            "business_id": str(payload.get("business_id") or payload.get("workspace_id") or "default").strip() or "default",
            "created_at": created_at,
            "updated_at": created_at,
        }
        if not task["title"]:
            raise ValueError("Task title is required")

        event: dict[str, Any] | None = None
        with self._lock:
            if any(str(item.get("id") or "") == task["id"] for item in self._state["tasks"]):
                raise ValueError(f"Task already exists: {task['id']}")
            previous = self._snapshot()
            self._state["tasks"].insert(0, task)
            event = self._append_event_locked(
                {
                    "type": "task_created",
                    "workspace_id": task["workspace_id"],
                    "business_id": task["business_id"],
                    "task_id": task["id"],
                    "message": f'Task created: {task["title"]}',
                }
            )
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
        if event:
            self.event_bus.publish(event)
        return self._enrich_task(task)

    def update_task(self, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        event: dict[str, Any] | None = None
        task: dict[str, Any] | None = None
        with self._lock:
            for item in self._state["tasks"]:
                if str(item.get("id") or "") != task_id:
                    continue
                previous = self._snapshot()
                for key in ["title", "description", "priority", "status", "task_type", "assigned_agent_id", "due_date", "workspace_id", "business_id"]:
                    if key in patch:
                        value = patch[key]
                        item[key] = (str(value).strip() if value is not None else None) or None
                if not item.get("title"):
                    item["title"] = "Untitled mission"
                item["updated_at"] = now_iso()
                task = copy.deepcopy(item)
                event = self._append_event_locked(
                    {
                        "type": "task_updated",
                        "workspace_id": item.get("workspace_id") or "default",
                        "business_id": item.get("business_id") or "default",
                        "task_id": task_id,
                        "message": f'Task updated: {item.get("title") or task_id}',
                    }
                )
                try:
                    self._persist_locked()
                except Exception:
                    self._state = previous
                    raise
                break
        if event:
            self.event_bus.publish(event)
        return self._enrich_task(task) if task else None

    def delete_task(self, task_id: str) -> bool:
        event: dict[str, Any] | None = None
        removed = None
        with self._lock:
            for index, item in enumerate(self._state["tasks"]):
                if str(item.get("id") or "") != task_id:
                    continue
                previous = self._snapshot()
                removed = self._state["tasks"].pop(index)
                event = self._append_event_locked(
                    {
                        "type": "task_deleted",
                        "workspace_id": removed.get("workspace_id") or "default",
                        "business_id": removed.get("business_id") or "default",
                        "task_id": task_id,
                        "message": f'Task deleted: {removed.get("title") or task_id}',
                    }
                )
                try:
                    self._persist_locked()
                except Exception:
                    self._state = previous
                    raise
                break
        if event:
            self.event_bus.publish(event)
        return removed is not None

    def list_agents(self, workspace_id: str = "default") -> list[dict[str, Any]]:
        with self._lock:
            agents = [copy.deepcopy(item) for item in self._state["agents"] if str(item.get("workspace_id") or "default") == workspace_id]
        return agents

    def create_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        created_at = now_iso()
        agent = {
            "id": str(payload.get("id") or f"agent-{uuid.uuid4().hex[:10]}"),
            "name": str(payload.get("name") or "").strip(),
            "role": str(payload.get("role") or "").strip() or "Mission specialist",
            "description": str(payload.get("description") or "").strip() or None,
            "avatar_emoji": str(payload.get("avatar_emoji") or "🤖").strip() or "🤖",
            "status": str(payload.get("status") or "standby").strip() or "standby",
            "effective_status": str(payload.get("status") or "standby").strip() or "standby",
            "model": str(payload.get("model") or "").strip() or None,
            "soul_md": str(payload.get("soul_md") or "").strip() or None,
            "user_md": str(payload.get("user_md") or "").strip() or None,
            "agents_md": str(payload.get("agents_md") or "").strip() or None,
            "workspace_id": str(payload.get("workspace_id") or "default").strip() or "default",
            "source": str(payload.get("source") or "local").strip() or "local",
            "gateway_agent_id": str(payload.get("gateway_agent_id") or "").strip() or None,
            "created_at": created_at,
            "updated_at": created_at,
        }
        if not agent["name"]:
            raise ValueError("Agent name is required")
        event: dict[str, Any] | None = None
        with self._lock:
            if any(str(item.get("id") or "") == agent["id"] for item in self._state["agents"]):
                raise ValueError(f"Agent already exists: {agent['id']}")
            if agent["gateway_agent_id"] and any(
                str(item.get("gateway_agent_id") or "") == agent["gateway_agent_id"]
                and str(item.get("workspace_id") or "default") == agent["workspace_id"]
                for item in self._state["agents"]
            ):
                raise ValueError(f"Gateway agent already imported: {agent['gateway_agent_id']}")
            previous = self._snapshot()
            self._state["agents"].insert(0, agent)
            event = self._append_event_locked(
                {
                    "type": "agent_created",
                    "workspace_id": agent["workspace_id"],
                    "agent_id": agent["id"],
                    "message": f'Agent created: {agent["name"]}',
                }
            )
            try:
                self._persist_locked()
            except Exception:
                self._state = previous
                raise
        if event:
            self.event_bus.publish(event)
        return copy.deepcopy(agent)

    def import_agents(self, payload: dict[str, Any]) -> dict[str, Any]:
        imported: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for item in payload.get("agents") or []:
            gateway_agent_id = str(item.get("gateway_agent_id") or "").strip()
            workspace_id = str(item.get("workspace_id") or "default").strip() or "default"
            with self._lock:
                exists = next((agent for agent in self._state["agents"] if str(agent.get("gateway_agent_id") or "") == gateway_agent_id and str(agent.get("workspace_id") or "default") == workspace_id), None)
            if exists:
                skipped.append(copy.deepcopy(exists))
                continue
            imported.append(self.create_agent({**item, "source": "gateway", "status": item.get("status") or "standby"}))
        return {"imported": imported, "skipped": skipped}

    def discover_gateway_agents(self, workspace_id: str = "default") -> dict[str, Any]:
        imported_ids = {str(agent.get("gateway_agent_id") or "") for agent in self.list_agents(workspace_id) if agent.get("gateway_agent_id")}
        return {"agents": [
            {"id": "workspace-manager", "name": "Workspace Manager", "already_imported": "workspace-manager" in imported_ids},
            {"id": "provisioning-architect", "name": "Provisioning Architect", "already_imported": "provisioning-architect" in imported_ids},
            {"id": "quality-auditor", "name": "Quality Auditor", "already_imported": "quality-auditor" in imported_ids},
            {"id": "reliability-sre", "name": "Reliability / SRE", "already_imported": "reliability-sre" in imported_ids},
        ]}

    def list_events(self, workspace_id: str = "default") -> list[dict[str, Any]]:
        with self._lock:
            events = [copy.deepcopy(item) for item in self._state["events"] if str(item.get("workspace_id") or "default") == workspace_id]
        return sorted(events, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def _append_event_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        event = {
            "id": str(payload.get("id") or f"evt-{uuid.uuid4().hex[:10]}"),
            "type": str(payload.get("type") or "event"),
            "workspace_id": str(payload.get("workspace_id") or "default"),
            "business_id": str(payload.get("business_id") or payload.get("workspace_id") or "default"),
            "task_id": payload.get("task_id"),
            "agent_id": payload.get("agent_id"),
            "business_os_id": payload.get("business_os_id"),
            "message": str(payload.get("message") or "").strip(),
            "business_os": copy.deepcopy(payload.get("business_os")) if payload.get("business_os") else None,
            "created_at": str(payload.get("created_at") or now_iso()),
        }
        self._state["events"].insert(0, event)
        self._state["events"] = self._state["events"][:500]
        return copy.deepcopy(event)

    def _enrich_task(self, task: dict[str, Any] | None) -> dict[str, Any] | None:
        if task is None:
            return None
        enriched = copy.deepcopy(task)
        assigned_id = str(enriched.get("assigned_agent_id") or "")
        if assigned_id:
            with self._lock:
                match = next((copy.deepcopy(agent) for agent in self._state["agents"] if str(agent.get("id") or "") == assigned_id), None)
            if match:
                enriched["assigned_agent"] = match
        return enriched

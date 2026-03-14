from __future__ import annotations

import copy
import json
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
    "status": "Active",
    "color": "#10B981",
    "is_default": True,
    "workspace_id": "default",
    "business_id": "default",
    "manager": "Workspace Manager",
    "leadership": {},
}


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
            "tasks": [],
            "agents": [],
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
                payload = self._default_state()
        else:
            payload = self._default_state()
        payload = self._normalize_state(payload)
        self._write_state(payload)
        return payload

    def _normalize_state(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = {
            "business_os": list(payload.get("business_os") or []),
            "tasks": list(payload.get("tasks") or []),
            "agents": list(payload.get("agents") or []),
            "events": list(payload.get("events") or []),
        }
        if not any(str(item.get("id") or "") == "default" for item in state["business_os"]):
            created_at = now_iso()
            state["business_os"].insert(0, dict(DEFAULT_BUSINESS_OS, created_at=created_at, updated_at=created_at))
        return state

    def _write_state(self, state: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")

    def _snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._state)

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
        leadership = {
            "manager": str(payload.get("manager") or "").strip(),
            "cto": str(payload.get("cto") or "").strip(),
            "cmo": str(payload.get("cmo") or "").strip(),
            "cro": str(payload.get("cro") or "").strip(),
        }
        business = {
            "id": business_os_id,
            "slug": str(payload.get("slug") or business_os_id).strip(),
            "name": str(payload.get("name") or "").strip(),
            "description": str(payload.get("description") or "").strip() or None,
            "template": template,
            "status": str(payload.get("status") or "Provisioning").strip() or "Provisioning",
            "color": str(payload.get("color") or "#06B6D4").strip() or "#06B6D4",
            "is_default": bool(payload.get("is_default")),
            "workspace_id": str(payload.get("workspace_id") or business_os_id).strip() or business_os_id,
            "business_id": str(payload.get("business_id") or business_os_id).strip() or business_os_id,
            "business_os_id": business_os_id,
            "manager": leadership["manager"] or "Workspace Manager",
            "leadership": leadership,
            "created_at": created_at,
            "updated_at": created_at,
        }
        if not business["name"]:
            raise ValueError("Business OS name is required")

        event: dict[str, Any] | None = None
        with self._lock:
            if any(str(item.get("id") or "") == business_os_id for item in self._state["business_os"]):
                raise ValueError(f"Business OS already exists: {business_os_id}")
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
            self._write_state(self._state)
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
                for key in ["name", "description", "template", "status", "color", "workspace_id", "business_id", "manager"]:
                    if key in patch and patch[key] is not None:
                        item[key] = str(patch[key]).strip() or item.get(key)
                for leader_key in ["manager", "cto", "cmo", "cro"]:
                    if leader_key in patch:
                        item.setdefault("leadership", {})[leader_key] = str(patch.get(leader_key) or "").strip()
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
                self._write_state(self._state)
                break
        if event:
            self.event_bus.publish(event)
        return updated

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
            self._write_state(self._state)
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
                self._write_state(self._state)
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
                self._write_state(self._state)
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
            self._state["agents"].insert(0, agent)
            event = self._append_event_locked(
                {
                    "type": "agent_created",
                    "workspace_id": agent["workspace_id"],
                    "agent_id": agent["id"],
                    "message": f'Agent created: {agent["name"]}',
                }
            )
            self._write_state(self._state)
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

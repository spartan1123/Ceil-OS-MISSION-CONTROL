from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CouncilRunState:
    run_id: str
    session_id: str
    status: str = "queued"
    created_at: str = ""
    started_at: str = ""
    ended_at: str = ""
    stop_requested: bool = False
    payload: dict[str, Any] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[queue.Queue] = field(default_factory=list)


class CouncilEventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[str, CouncilRunState] = {}

    def create_run(self, session_payload: dict[str, Any], now_iso: str) -> CouncilRunState:
        run_id = str(uuid.uuid4())
        state = CouncilRunState(
            run_id=run_id,
            session_id=str(session_payload.get("id") or ""),
            status="queued",
            created_at=now_iso,
            payload=session_payload,
        )
        with self._lock:
            self._runs[run_id] = state
        self.publish(run_id, "run.created", {
            "run_id": run_id,
            "session_id": state.session_id,
            "status": state.status,
            "created_at": now_iso,
            "session": session_payload,
        })
        return state

    def get_run(self, run_id: str) -> CouncilRunState | None:
        with self._lock:
            return self._runs.get(run_id)

    def ensure_run(self, run_id: str) -> CouncilRunState | None:
        return self.get_run(run_id)

    def mark_stop_requested(self, run_id: str, now_iso: str) -> CouncilRunState | None:
        with self._lock:
            state = self._runs.get(run_id)
            if not state:
                return None
            state.stop_requested = True
        self.publish(run_id, "run.stop_requested", {"run_id": run_id, "status": state.status, "created_at": now_iso})
        return state

    def update_status(self, run_id: str, status: str, now_iso: str, extra: dict[str, Any] | None = None) -> CouncilRunState | None:
        with self._lock:
            state = self._runs.get(run_id)
            if not state:
                return None
            state.status = status
            if status == "running" and not state.started_at:
                state.started_at = now_iso
            if status in {"completed", "failed", "stopped"}:
                state.ended_at = now_iso
            payload = {
                "run_id": run_id,
                "session_id": state.session_id,
                "status": state.status,
                "started_at": state.started_at,
                "ended_at": state.ended_at,
                "created_at": now_iso,
            }
            if extra:
                payload.update(extra)
        self.publish(run_id, "run.status", payload)
        return state

    def publish(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        event = {
            "id": str(uuid.uuid4()),
            "type": event_type,
            "run_id": run_id,
            "created_at": payload.get("created_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "payload": payload,
        }
        with self._lock:
            state = self._runs.get(run_id)
            if not state:
                return
            state.history.append(event)
            subscribers = list(state.subscribers)
        for subscriber in subscribers:
            subscriber.put(event)

    def subscribe(self, run_id: str, replay: bool = True) -> tuple[queue.Queue, list[dict[str, Any]]]:
        subscription = queue.Queue()
        with self._lock:
            state = self._runs.get(run_id)
            if not state:
                raise KeyError(run_id)
            state.subscribers.append(subscription)
            history = list(state.history) if replay else []
        return subscription, history

    def unsubscribe(self, run_id: str, subscription: queue.Queue) -> None:
        with self._lock:
            state = self._runs.get(run_id)
            if not state:
                return
            state.subscribers = [item for item in state.subscribers if item is not subscription]

    @staticmethod
    def format_sse(event: dict[str, Any]) -> bytes:
        lines = [
            f"id: {event['id']}",
            f"event: {event['type']}",
            "data: " + json.dumps(event, ensure_ascii=False),
            "",
        ]
        return "\n".join(lines).encode("utf-8")

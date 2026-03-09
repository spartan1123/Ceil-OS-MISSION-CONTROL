from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Any, Callable


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_name(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def slugify(value: str) -> str:
    return normalize_name(value).replace("/", "-").replace(" ", "-")


def participant_display(slug_or_name: str, participant_map: dict[str, str]) -> str:
    raw = str(slug_or_name or "").strip()
    if not raw:
        return "Unknown"
    for participant, slug in participant_map.items():
        if slug == raw:
            return participant
    return raw


class CouncilOrchestrator:
    def __init__(self, event_bus, tools_url_for_port: Callable[[int], str], token_for_port: Callable[[int], str], port_for_slug: Callable[[str], int], participant_slug_map: dict[str, str]) -> None:
        self.event_bus = event_bus
        self.tools_url_for_port = tools_url_for_port
        self.token_for_port = token_for_port
        self.port_for_slug = port_for_slug
        self.participant_slug_map = participant_slug_map
        self._threads: dict[str, threading.Thread] = {}

    def start_run(self, run_id: str) -> None:
        thread = threading.Thread(target=self._run, args=(run_id,), daemon=True, name=f"council-run-{run_id[:8]}")
        self._threads[run_id] = thread
        thread.start()

    def _invoke_tool(self, port: int, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        url = self.tools_url_for_port(port)
        token = self.token_for_port(port)
        body = json.dumps({"tool": tool, "args": args}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {"error": raw}
            payload.setdefault("status", err.code)
            payload.setdefault("ok", False)
            return payload

    def _sessions_list(self, port: int) -> list[dict[str, Any]]:
        result = self._invoke_tool(port, "sessions_list", {})
        if isinstance(result, dict) and isinstance(result.get("data"), list):
            return result["data"]
        if isinstance(result, list):
            return result
        if isinstance(result, dict) and isinstance(result.get("details", {}).get("sessions"), list):
            return result["details"]["sessions"]
        return []

    def _resolve_session_key(self, slug: str, port: int) -> str:
        sessions = self._sessions_list(port)
        normalized_slug = normalize_name(slug)
        for row in sessions:
            label = normalize_name(str(row.get("label") or row.get("sessionLabel") or row.get("name") or ""))
            session_key = str(row.get("sessionKey") or row.get("key") or row.get("id") or "")
            if label == normalized_slug and session_key:
                return session_key
        return ""

    def _spawn_session(self, slug: str, port: int) -> str:
        label = slug
        task = (
            f"You are {slug}. Join this council session and wait for prompts. "
            "Reply concisely, clearly, and with actionable reasoning when asked."
        )
        self._invoke_tool(port, "sessions_spawn", {
            "task": task,
            "label": label,
            "runtime": "subagent",
            "agentId": slug,
            "mode": "session",
            "thread": False,
            "cleanup": "keep",
            "sandbox": "inherit",
        })

        deadline = time.time() + 20
        while time.time() < deadline:
            session_key = self._resolve_session_key(slug, port)
            if session_key:
                return session_key
            time.sleep(0.5)
        return ""

    def _send_message(self, port: int, session_key: str, message: str) -> dict[str, Any]:
        return self._invoke_tool(port, "sessions_send", {
            "sessionKey": session_key,
            "message": message,
            "timeoutSeconds": 300,
        })

    def _build_prompt(self, session_payload: dict[str, Any], target_slug: str, participants: list[str], history: list[dict[str, str]]) -> str:
        history_text = ""
        if history:
            history_text = "\n\n--- PREVIOUS COUNCIL CONTRIBUTIONS ---\n" + "\n\n".join(
                f"[{item['speaker']}]: {item['text']}" for item in history
            ) + "\n--- END OF CONTRIBUTIONS ---\n"

        return "\n".join([
            f"Council Run ID: {session_payload.get('last_run_id') or session_payload.get('run_id')}",
            f"Session Title: {session_payload.get('title') or 'Council Session'}",
            f"Topic: {session_payload.get('topic') or session_payload.get('notes') or 'No topic provided.'}",
            f"Participants: {', '.join(participant_display(slug, self.participant_slug_map) for slug in participants)}",
            f"Target Agent: {target_slug}",
            f"Notes: {session_payload.get('notes') or 'No additional notes.'}",
            history_text,
            "Please review the contributions above (if any) and provide your perspective. Respond with your actionable contribution and one clear next action.",
        ])

    def _publish_message(self, run_id: str, agent_slug: str, role: str, content: str) -> None:
        self.event_bus.publish(run_id, "message", {
            "run_id": run_id,
            "agent_slug": agent_slug,
            "role": role,
            "content": content,
            "created_at": now_iso(),
        })

    def _publish_participant(self, run_id: str, slug: str, state: str, details: str = "", session_key: str = "") -> None:
        self.event_bus.publish(run_id, "participant.status", {
            "run_id": run_id,
            "agent_slug": slug,
            "participant": participant_display(slug, self.participant_slug_map),
            "state": state,
            "details": details,
            "session_key": session_key,
            "created_at": now_iso(),
        })

    def _run(self, run_id: str) -> None:
        state = self.event_bus.get_run(run_id)
        if not state:
            return

        payload = dict(state.payload)
        participants = [slugify(item) for item in payload.get("participants", []) if slugify(item)]
        payload["participants"] = participants
        payload["run_id"] = run_id
        payload["last_run_id"] = run_id
        failed_agents: list[dict[str, Any]] = []
        success_count = 0
        history: list[dict[str, str]] = []

        self.event_bus.update_status(run_id, "running", now_iso())
        self._publish_message(run_id, "system", "system", f"Council topic: {payload.get('topic') or payload.get('notes') or 'No topic provided.'}")
        self._publish_message(run_id, "system", "system", "Council run started.")

        for slug in participants:
            current = self.event_bus.get_run(run_id)
            if not current:
                return
            if current.stop_requested:
                self._publish_message(run_id, "system", "system", "Council run stopped by user.")
                self.event_bus.update_status(run_id, "stopped", now_iso(), {
                    "error": {
                        "failed_agents": failed_agents,
                        "success_count": success_count,
                        "failure_count": len(failed_agents),
                    }
                })
                return

            port = self.port_for_slug(slug)
            self._publish_participant(run_id, slug, "connecting", f"Preparing runtime on port {port}")

            session_key = self._resolve_session_key(slug, port)
            if not session_key:
                self._publish_participant(run_id, slug, "bootstrapping", "No session found. Spawning a session.")
                session_key = self._spawn_session(slug, port)

            if not session_key:
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_spawn",
                    "error_type": "session_not_found",
                    "message": f"Unable to create or bind a thread for {slug}",
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"])
                self._publish_message(run_id, slug, "system", f"Dispatch skipped/failed for {slug} (sessions_spawn@{port}): {failure['message']}")
                continue

            self._publish_participant(run_id, slug, "connected", "Session ready.", session_key=session_key)
            prompt = self._build_prompt(payload, slug, participants, history)
            self._publish_participant(run_id, slug, "speaking", "Prompt dispatched.", session_key=session_key)

            try:
                result = self._send_message(port, session_key, prompt)
            except Exception as exc:  # pylint: disable=broad-except
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_send",
                    "error_type": "other",
                    "message": str(exc),
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"], session_key=session_key)
                self._publish_message(run_id, slug, "system", f"Dispatch skipped/failed for {slug} (sessions_send@{port}): {failure['message']}")
                continue

            detail_status = str(result.get("details", {}).get("status") or result.get("status") or "").lower()
            if detail_status in {"error", "forbidden", "timeout"}:
                message = result.get("details", {}).get("error") or result.get("error") or f"dispatch returned status={detail_status}"
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_send",
                    "error_type": detail_status or "other",
                    "message": str(message),
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"], session_key=session_key)
                self._publish_message(run_id, slug, "system", f"Dispatch skipped/failed for {slug} (sessions_send@{port}): {failure['message']}")
                continue

            reply = result.get("details", {}).get("reply")
            if not reply:
                reply = json.dumps(result, ensure_ascii=False)
            success_count += 1
            history.append({"speaker": participant_display(slug, self.participant_slug_map), "text": str(reply)})
            self._publish_participant(run_id, slug, "completed", "Contribution received.", session_key=session_key)
            self._publish_message(run_id, slug, "agent", str(reply))

        status = "failed" if success_count == 0 else "completed"
        error = {
            "failed_agents": failed_agents,
            "success_count": success_count,
            "failure_count": len(failed_agents),
        } if failed_agents or status == "failed" else None

        if status == "completed":
            summary = f"Council run completed with {len(failed_agents)} dispatch issue(s)." if failed_agents else "Council run completed."
            self._publish_message(run_id, "system", "system", summary)
        else:
            self._publish_message(run_id, "system", "system", "Council run failed: no participants responded.")

        self.event_bus.update_status(run_id, status, now_iso(), {"error": error})

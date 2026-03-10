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


def normalize_session_key(value: Any) -> str:
    return str(value or "").strip()


class CouncilOrchestrator:
    def __init__(
        self,
        event_bus,
        tools_url_for_port: Callable[[int], str],
        token_for_port: Callable[[int], str],
        port_for_slug: Callable[[str], int],
        participant_slug_map: dict[str, str],
        artifact_store=None,
    ) -> None:
        self.event_bus = event_bus
        self.tools_url_for_port = tools_url_for_port
        self.token_for_port = token_for_port
        self.port_for_slug = port_for_slug
        self.participant_slug_map = participant_slug_map
        self.artifact_store = artifact_store
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
        if isinstance(result, dict):
            nested_result = result.get("result")
            if isinstance(nested_result, dict):
                if isinstance(nested_result.get("data"), list):
                    return nested_result["data"]
                if isinstance(nested_result.get("details", {}).get("sessions"), list):
                    return nested_result["details"]["sessions"]
        return []

    def _resolve_session_key(self, slug: str, port: int) -> str:
        sessions = self._sessions_list(port)
        normalized_slug = normalize_name(slug)
        matched_group = ""
        matched_other = ""
        group_fallback = ""
        main_fallback = ""

        for row in sessions:
            session_key = str(row.get("sessionKey") or row.get("key") or row.get("id") or "")
            if not session_key:
                continue

            label = normalize_name(str(row.get("label") or row.get("sessionLabel") or row.get("name") or ""))
            display_name = normalize_name(str(row.get("displayName") or ""))
            kind = normalize_name(str(row.get("kind") or ""))

            if label == normalized_slug:
                return session_key

            if normalized_slug and normalized_slug in display_name:
                if kind == "group" and not matched_group:
                    matched_group = session_key
                elif not matched_other:
                    matched_other = session_key

            if not group_fallback and kind == "group":
                group_fallback = session_key
            if not main_fallback and session_key == "agent:main:main":
                main_fallback = session_key

        return matched_group or matched_other or group_fallback or main_fallback

    def _spawn_session(self, slug: str, port: int) -> str:
        task = (
            f"You are {slug}. Join this council session and wait for prompts. "
            "Reply concisely, clearly, and with actionable reasoning when asked."
        )
        self._invoke_tool(port, "sessions_spawn", {
            "task": task,
            "label": slug,
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

    def _requester_session_keys(self, payload: dict[str, Any]) -> set[str]:
        candidates: set[str] = set()
        direct_keys = (
            "requester_session_key",
            "active_session_key",
            "source_session_key",
            "current_session_key",
            "session_key",
        )
        for key in direct_keys:
            value = normalize_session_key(payload.get(key))
            if value:
                candidates.add(value)

        for binding in payload.get("participant_bindings") or []:
            if not isinstance(binding, dict):
                continue
            value = normalize_session_key(binding.get("session_key"))
            if value and not value.startswith("local-"):
                candidates.add(value)
        return candidates

    def _is_self_session_collision(self, payload: dict[str, Any], session_key: str) -> bool:
        normalized_session_key = normalize_session_key(session_key)
        if not normalized_session_key:
            return False
        return normalized_session_key in self._requester_session_keys(payload)

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

    def _publish_round(self, run_id: str, round_key: str, state: str, details: str = "") -> None:
        self.event_bus.publish(run_id, "round.status", {
            "run_id": run_id,
            "round": round_key,
            "state": state,
            "details": details,
            "created_at": now_iso(),
        })

    def _build_round_prompt(
        self,
        session_payload: dict[str, Any],
        target_slug: str,
        participants: list[str],
        round_key: str,
        context_packet: str,
        proposal_notes: list[dict[str, str]],
        critique_notes: list[dict[str, str]],
    ) -> str:
        header = [
            f"Council Run ID: {session_payload.get('run_id')}",
            f"Session Title: {session_payload.get('title') or 'Council Session'}",
            f"Topic: {session_payload.get('topic') or session_payload.get('notes') or 'No topic provided.'}",
            f"Participants: {', '.join(participant_display(slug, self.participant_slug_map) for slug in participants)}",
            f"Target Agent: {target_slug}",
            f"Round: {round_key}",
            "",
            "CONTEXT PACKET:",
            context_packet,
        ]

        if proposal_notes:
            header.append("\nPROPOSALS:")
            header.extend([f"- [{item['speaker']}] {item['text']}" for item in proposal_notes])
        if critique_notes:
            header.append("\nCRITIQUES / CROSS-CHECKS:")
            header.extend([f"- [{item['speaker']}] {item['text']}" for item in critique_notes])

        if round_key == "proposal":
            footer = "Provide your proposal with rationale, constraints, and one concrete implementation step."
        elif round_key == "critique":
            footer = "Critique existing proposals. Cross-check for risks, assumptions, and missing evidence."
        else:
            footer = "Synthesize the council discussion into a final recommendation with explicit next actions."

        return "\n".join(header + ["", footer])

    def _persist_artifact(self, run_id: str, artifact: dict[str, Any]) -> None:
        if not self.artifact_store:
            self.event_bus.publish(run_id, "artifact.persisted", {
                "run_id": run_id,
                "status": "skipped",
                "reason": "artifact_store_not_configured",
                "created_at": now_iso(),
            })
            return

        result = self.artifact_store.persist_artifact(run_id, artifact)
        payload = {
            "run_id": run_id,
            "status": "persisted" if result.get("ok") else "failed",
            "path": result.get("path"),
            "error": result.get("error"),
            "created_at": now_iso(),
        }
        self.event_bus.publish(run_id, "artifact.persisted", payload)

    def _run_round(
        self,
        run_id: str,
        payload: dict[str, Any],
        participants: list[str],
        round_key: str,
        context_packet: str,
        proposal_notes: list[dict[str, str]],
        critique_notes: list[dict[str, str]],
        failed_agents: list[dict[str, Any]],
    ) -> tuple[list[dict[str, str]], int, bool]:
        self._publish_round(run_id, round_key, "started", f"Running {round_key} round")
        outputs: list[dict[str, str]] = []
        success_count = 0

        for slug in participants:
            current = self.event_bus.get_run(run_id)
            if not current:
                return outputs, success_count, True
            if current.stop_requested:
                self._publish_round(run_id, round_key, "stopped", "Run stopped by user")
                return outputs, success_count, True

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
                    "round": round_key,
                    "error_type": "session_not_found",
                    "message": f"Unable to create or bind a thread for {slug}",
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"])
                continue

            if self._is_self_session_collision(payload, session_key):
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_send",
                    "round": round_key,
                    "error_type": "self_session_collision",
                    "message": f"Skipped {slug}: resolved session matches active requester session.",
                    "session_key": session_key,
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "skipped", failure["message"], session_key=session_key)
                continue

            prompt = self._build_round_prompt(payload, slug, participants, round_key, context_packet, proposal_notes, critique_notes)
            self._publish_participant(run_id, slug, "speaking", f"{round_key} prompt dispatched.", session_key=session_key)

            try:
                result = self._send_message(port, session_key, prompt)
            except Exception as exc:  # pylint: disable=broad-except
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_send",
                    "round": round_key,
                    "error_type": "other",
                    "message": str(exc),
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"], session_key=session_key)
                continue

            detail_status = str(result.get("details", {}).get("status") or result.get("status") or "").lower()
            if detail_status in {"error", "forbidden", "timeout"}:
                failure = {
                    "agent_slug": slug,
                    "port": port,
                    "tool": "sessions_send",
                    "round": round_key,
                    "error_type": detail_status or "other",
                    "message": str(result.get("details", {}).get("error") or result.get("error") or f"dispatch returned status={detail_status}"),
                }
                failed_agents.append(failure)
                self._publish_participant(run_id, slug, "failed", failure["message"], session_key=session_key)
                continue

            reply = result.get("details", {}).get("reply") or json.dumps(result, ensure_ascii=False)
            success_count += 1
            outputs.append({
                "speaker": participant_display(slug, self.participant_slug_map),
                "slug": slug,
                "text": str(reply),
            })
            self._publish_participant(run_id, slug, "completed", f"{round_key} contribution received.", session_key=session_key)
            self._publish_message(run_id, slug, "agent", str(reply))

        self._publish_round(run_id, round_key, "completed", f"{round_key} round finished with {success_count} contribution(s)")
        return outputs, success_count, False

    def _run(self, run_id: str) -> None:
        state = self.event_bus.get_run(run_id)
        if not state:
            return

        payload = dict(state.payload)
        participants = [slugify(item) for item in payload.get("participants", []) if slugify(item)]
        payload["participants"] = participants
        payload["run_id"] = run_id

        failed_agents: list[dict[str, Any]] = []
        total_success = 0

        self.event_bus.update_status(run_id, "running", now_iso())
        topic = payload.get("topic") or payload.get("notes") or "No topic provided."
        context_packet = (
            f"Objective: {topic}\n"
            f"Participants: {', '.join(participant_display(slug, self.participant_slug_map) for slug in participants)}\n"
            "Protocol: proposal -> critique/cross-check -> synthesis/decision."
        )

        self._publish_message(run_id, "system", "system", f"Council topic: {topic}")
        self._publish_round(run_id, "context", "published", "Context packet generated")
        self._publish_message(run_id, "system", "system", f"Context packet:\n{context_packet}")

        proposal_notes, proposal_success, stopped = self._run_round(
            run_id, payload, participants, "proposal", context_packet, [], [], failed_agents
        )
        total_success += proposal_success
        if stopped:
            self.event_bus.update_status(run_id, "stopped", now_iso(), {"error": {"failed_agents": failed_agents, "success_count": total_success, "failure_count": len(failed_agents)}})
            return

        critique_notes, critique_success, stopped = self._run_round(
            run_id, payload, participants, "critique", context_packet, proposal_notes, [], failed_agents
        )
        total_success += critique_success
        if stopped:
            self.event_bus.update_status(run_id, "stopped", now_iso(), {"error": {"failed_agents": failed_agents, "success_count": total_success, "failure_count": len(failed_agents)}})
            return

        synthesis_notes, synthesis_success, stopped = self._run_round(
            run_id, payload, participants, "synthesis", context_packet, proposal_notes, critique_notes, failed_agents
        )
        total_success += synthesis_success
        if stopped:
            self.event_bus.update_status(run_id, "stopped", now_iso(), {"error": {"failed_agents": failed_agents, "success_count": total_success, "failure_count": len(failed_agents)}})
            return

        final_decision = synthesis_notes[-1]["text"] if synthesis_notes else "No synthesis response provided."
        artifact = {
            "session_id": state.session_id,
            "topic": topic,
            "context_packet": context_packet,
            "proposals": proposal_notes,
            "critiques": critique_notes,
            "synthesis": synthesis_notes,
            "final_decision": final_decision,
            "failed_agents": failed_agents,
            "success_count": total_success,
            "failure_count": len(failed_agents),
            "completed_at": now_iso(),
        }
        self._persist_artifact(run_id, artifact)

        status = "failed" if total_success == 0 else "completed"
        error = {
            "failed_agents": failed_agents,
            "success_count": total_success,
            "failure_count": len(failed_agents),
        } if failed_agents or status == "failed" else None

        if status == "completed":
            self._publish_message(run_id, "system", "system", f"Final decision: {final_decision}")
        else:
            self._publish_message(run_id, "system", "system", "Council run failed: no participants responded.")

        self.event_bus.update_status(run_id, status, now_iso(), {"error": error, "artifact": artifact})

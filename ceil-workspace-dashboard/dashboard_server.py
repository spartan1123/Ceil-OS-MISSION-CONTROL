#!/usr/bin/env python3
"""Static dashboard server + local proxy for OpenClaw /tools/invoke."""

from __future__ import annotations

import argparse
import glob
import json
import os
import queue
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from council_events import CouncilEventBus
from council_orchestrator import CouncilOrchestrator
from council_storage import CouncilArtifactStore


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
DEFAULT_COUNCIL_ARTIFACT_PATH = "/root/.openclaw/workspace/ceil-workspace-dashboard/.council-artifacts"
DEFAULT_ALLOWED_GATEWAY_PORTS = {18789, 19001, 19011, 19021, 19031, 19041, 19051, 19061, 19071, 19081, 19091, 19101, 19111}
DEFAULT_PORT_CONFIG_MAP = {
    19001: "/root/.openclaw/instances/workspace-manager.json",
    19011: "/root/.openclaw/instances/provisioning-architect.json",
    19021: "/root/.openclaw/instances/security-compliance.json",
    19031: "/root/.openclaw/instances/reliability-sre.json",
    19041: "/root/.openclaw/instances/cost-model-governor.json",
    19051: "/root/.openclaw/instances/quality-auditor.json",
    19061: "/root/.openclaw/instances/os-monitor-template.json",
    19071: "/root/.openclaw/instances/workspace-orchestrator.json",
    19081: "/root/.openclaw/instances/os-monitor.json",
    19091: "/root/.openclaw/instances/research-search.json",
    19101: "/root/.openclaw/instances/senku-ishigami.json",
    19111: "/root/.openclaw/instances/ariana.json",
}
DEFAULT_PARTICIPANT_TO_SLUG = {
    "Workspace Manager": "workspace-manager",
    "Provisioning Architect": "provisioning-architect",
    "Security & Compliance": "security-compliance",
    "Reliability / SRE": "reliability-sre",
    "Cost & Model Governor": "cost-model-governor",
    "Quality Auditor": "quality-auditor",
    "OS Monitor Template": "os-monitor-template",
    "Workspace Orchestrator": "workspace-orchestrator",
    "OS Monitor": "os-monitor",
    "Research Search": "research-search",
    "Senku Ishigami": "senku-ishigami",
    "Ariana": "ariana",
}


def parse_allowed_origins(raw: str | None) -> set[str]:
    if not raw:
        return set()
    out: set[str] = set()
    for item in raw.split(","):
        candidate = item.strip()
        if candidate:
            out.add(candidate)
    return out


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Keep request logs concise and never print headers/token values.
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _request_origin_fallback(self) -> str | None:
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host")
        if not host:
            return None
        proto = self.headers.get("X-Forwarded-Proto") or "http"
        return f"{proto}://{host}"

    def _resolve_origin(self) -> tuple[bool, str | None]:
        origin = self.headers.get("Origin")
        if not origin:
            return False, None

        explicit = self.allowed_origins
        if explicit:
            return origin in explicit, origin

        fallback_origin = self._request_origin_fallback()
        if fallback_origin and origin == fallback_origin:
            return True, origin
        return False, origin

    def _write_json(self, status_code: int, payload: dict, add_cors: bool = True) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        if add_cors:
            self._add_cors_headers_if_allowed()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
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
            "config_path": self.config_path,
            "allowed_gateway_ports": sorted(self.allowed_gateway_ports),
            "cors_mode": "explicit" if self.allowed_origins else "same-origin-fallback",
            "has_explicit_allowed_origins": bool(self.allowed_origins),
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


def build_handler(directory: str):
    class _BoundHandler(DashboardHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

    return _BoundHandler


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve dashboard + proxy /api/tools/invoke")
    parser.add_argument("--bind", default=os.getenv("DASHBOARD_BIND", DEFAULT_BIND))
    parser.add_argument("--port", type=int, default=int(os.getenv("DASHBOARD_PORT", str(DEFAULT_PORT))))
    parser.add_argument("--directory", default=os.getenv("DASHBOARD_DIRECTORY", DEFAULT_DIRECTORY))
    parser.add_argument("--config", default=os.getenv("OPENCLAW_CONFIG_PATH", DEFAULT_CONFIG_PATH))
    parser.add_argument("--tools-url", default=os.getenv("OPENCLAW_TOOLS_URL", DEFAULT_TOOLS_URL))
    parser.add_argument(
        "--allowed-origins",
        default=os.getenv("DASHBOARD_ALLOWED_ORIGINS", ""),
        help="Comma-separated browser origins allowed for CORS (defaults to same-origin fallback).",
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
    args = parser.parse_args()

    try:
        allowed_ports = parse_allowed_gateway_ports(args.allowed_gateway_ports)
    except ValueError as exc:
        parser.error(str(exc))

    handler_cls = build_handler(args.directory)
    server = ThreadingHTTPServer((args.bind, args.port), handler_cls)
    server.allowed_origins = parse_allowed_origins(args.allowed_origins)  # type: ignore[attr-defined]
    server.allowed_gateway_ports = allowed_ports  # type: ignore[attr-defined]
    server.config_path = args.config  # type: ignore[attr-defined]
    server.tools_url = args.tools_url  # type: ignore[attr-defined]
    server.council_event_bus = CouncilEventBus()  # type: ignore[attr-defined]
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

import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = BASE_DIR / "dashboard_server.py"
spec = importlib.util.spec_from_file_location("dashboard_server", MODULE_PATH)
dashboard_server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(dashboard_server)

ORCH_PATH = BASE_DIR / "council_orchestrator.py"
orch_spec = importlib.util.spec_from_file_location("council_orchestrator", ORCH_PATH)
council_orchestrator = importlib.util.module_from_spec(orch_spec)
assert orch_spec.loader is not None
orch_spec.loader.exec_module(council_orchestrator)


class RecordingHandler(BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        RecordingHandler.calls.append(
            {
                "path": self.path,
                "headers": dict(self.headers.items()),
                "body": body.decode("utf-8"),
            }
        )
        response = json.dumps({"ok": True, "echo": json.loads(body.decode("utf-8"))}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):  # noqa: A003
        return


class RecordingMissionControlHandler(BaseHTTPRequestHandler):
    calls = []
    sse_body = b"data: {\"type\":\"task_updated\",\"payload\":{\"id\":\"task-1\"}}\n\n"

    def _record(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        RecordingMissionControlHandler.calls.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers.items()),
                "body": body.decode("utf-8"),
            }
        )
        return body

    def do_GET(self):  # noqa: N802
        self._record()
        if self.path.startswith("/api/events/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(self.sse_body)
            return

        response = json.dumps([{"id": "task-1", "title": "Queue item"}]).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_POST(self):  # noqa: N802
        body = self._record()
        response = json.dumps({"ok": True, "echo": json.loads(body.decode("utf-8") or "{}")}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_PATCH(self):  # noqa: N802
        body = self._record()
        response = json.dumps({"ok": True, "patched": json.loads(body.decode("utf-8") or "{}")}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_DELETE(self):  # noqa: N802
        self._record()
        response = json.dumps({"success": True}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):  # noqa: A003
        return


class DummyCouncilOrchestrator:
    def __init__(self):
        self.started = []

    def start_run(self, run_id):
        self.started.append(run_id)


class DashboardServerTests(unittest.TestCase):
    def setUp(self):
        RecordingHandler.calls = []
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)

        self.dashboard_dir = self.root / "dashboard"
        self.dashboard_dir.mkdir()
        (self.dashboard_dir / "index.html").write_text("<html>ok</html>", encoding="utf-8")

        self.default_config = self.root / "default.json"
        self.default_config.write_text(
            json.dumps({"gateway": {"auth": {"token": "main-token"}, "port": 18789}}),
            encoding="utf-8",
        )

        self.alt_config = self.root / "alt.json"
        self.alt_config.write_text(
            json.dumps({"gateway": {"auth": {"token": "alt-token"}, "port": 19001}}),
            encoding="utf-8",
        )

        self.native_state_path = self.root / "native-state.json"

        self.gateway = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        self.gateway_thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.gateway_thread.start()
        self.addCleanup(self._cleanup_gateway)

        RecordingMissionControlHandler.calls = []
        self.mission_control = ThreadingHTTPServer(("127.0.0.1", 0), RecordingMissionControlHandler)
        self.mission_control_thread = threading.Thread(target=self.mission_control.serve_forever, daemon=True)
        self.mission_control_thread.start()
        self.addCleanup(self._cleanup_mission_control)

    def _cleanup_gateway(self):
        self.gateway.shutdown()
        self.gateway.server_close()
        self.gateway_thread.join(timeout=2)

    def _cleanup_mission_control(self):
        self.mission_control.shutdown()
        self.mission_control.server_close()
        self.mission_control_thread.join(timeout=2)

    def make_dashboard(self, *, allowed_origins=None, allowed_ports=None, config_path=None, council_orchestrator=None):
        handler_cls = dashboard_server.build_handler(str(self.dashboard_dir))
        server = dashboard_server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        server.allowed_origins = set(allowed_origins or [])
        server.allowed_gateway_ports = set(allowed_ports or {18789, 19001})
        server.config_path = str(config_path or self.default_config)
        server.tools_url = f"http://127.0.0.1:{self.gateway.server_address[1]}/tools/invoke"
        server.mission_control_url = f"http://127.0.0.1:{self.mission_control.server_address[1]}"
        server.mission_control_env_path = None
        server.mission_control_auth = {}
        server.council_event_bus = dashboard_server.CouncilEventBus()
        server.native_store = dashboard_server.NativeDashboardStore(self.native_state_path)
        server.council_orchestrator = council_orchestrator or DummyCouncilOrchestrator()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.addCleanup(cleanup)
        return server

    def request(self, server, path="/api/tools/invoke", *, payload=None, headers=None, method="POST"):
        url = f"http://127.0.0.1:{server.server_address[1]}{path}"
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        req = Request(url, data=body, method=method)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        return urlopen(req, timeout=5)

    def test_health_endpoint_includes_mission_control_state(self):
        server = self.make_dashboard(allowed_ports={18789, 19001})
        with self.request(server, path="/api/health", method="GET") as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(body["mission_control_url"], f"http://127.0.0.1:{self.mission_control.server_address[1]}")
        self.assertEqual(body["mission_control_auth"], "not_configured")

    def test_parse_allowed_gateway_ports_defaults_to_known_ports(self):
        self.assertEqual(
            dashboard_server.parse_allowed_gateway_ports(None),
            dashboard_server.DEFAULT_ALLOWED_GATEWAY_PORTS,
        )

    def test_parse_allowed_gateway_ports_rejects_invalid_values(self):
        with self.assertRaises(ValueError):
            dashboard_server.parse_allowed_gateway_ports("19001,not-a-port")

    def test_health_endpoint_reports_ready_state(self):
        server = self.make_dashboard(allowed_ports={18789, 19001})
        with self.request(server, path="/api/health", method="GET") as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(resp.status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["service"], "ceil-workspace-dashboard")
        self.assertEqual(body["gateway_auth"], "configured")
        self.assertEqual(body["allowed_gateway_ports"], [18789, 19001])

    def test_health_endpoint_reports_config_failure(self):
        broken_config = self.root / "broken.json"
        broken_config.write_text(json.dumps({"gateway": {"auth": {}}}), encoding="utf-8")
        server = self.make_dashboard(config_path=broken_config)

        with self.assertRaises(HTTPError) as ctx:
            self.request(server, path="/api/health", method="GET")

        self.assertEqual(ctx.exception.code, 500)
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["type"], "server_error")

    def test_parse_allowed_origins_strips_and_ignores_empty_items(self):
        result = dashboard_server.parse_allowed_origins(" https://a.example , ,https://b.example  ")
        self.assertEqual(result, {"https://a.example", "https://b.example"})

    def test_find_config_for_port_uses_default_for_main_port(self):
        path = dashboard_server.find_config_for_port(str(self.default_config), 18789)
        self.assertEqual(path, str(self.default_config))

    def test_native_business_os_endpoint_bootstraps_default_model(self):
        server = self.make_dashboard()
        with self.request(server, path="/api/business-os", method="GET") as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(resp.status, 200)
        self.assertTrue(any(item["id"] == "default" for item in body["items"]))
        self.assertEqual(body["items"][0]["name"], "Default Business OS")

    def test_native_task_agent_event_crud_uses_existing_mission_control_paths(self):
        server = self.make_dashboard()
        created_agent = json.loads(
            self.request(
                server,
                path="/api/mission-control/api/agents",
                method="POST",
                payload={"name": "Senku", "role": "Developer", "workspace_id": "default"},
            ).read().decode("utf-8")
        )
        created_task = json.loads(
            self.request(
                server,
                path="/api/mission-control/api/tasks",
                method="POST",
                payload={"title": "Build native backend", "assigned_agent_id": created_agent["id"], "workspace_id": "default"},
            ).read().decode("utf-8")
        )

        updated_task = json.loads(
            self.request(
                server,
                path=f"/api/mission-control/api/tasks/{created_task['id']}",
                method="PATCH",
                payload={"status": "in_progress"},
            ).read().decode("utf-8")
        )
        listed_tasks = json.loads(self.request(server, path="/api/mission-control/api/tasks?workspace_id=default", method="GET").read().decode("utf-8"))
        listed_events = json.loads(self.request(server, path="/api/mission-control/api/events?workspace_id=default", method="GET").read().decode("utf-8"))
        delete_resp = json.loads(
            self.request(server, path=f"/api/mission-control/api/tasks/{created_task['id']}", method="DELETE").read().decode("utf-8")
        )

        self.assertEqual(created_task["assigned_agent"]["id"], created_agent["id"])
        self.assertEqual(updated_task["status"], "in_progress")
        self.assertEqual(listed_tasks[0]["id"], created_task["id"])
        self.assertTrue(any(event["type"] == "task_created" for event in listed_events))
        self.assertTrue(delete_resp["ok"])
        self.assertEqual(len(RecordingMissionControlHandler.calls), 0)

    def test_proxy_forwards_with_same_origin_fallback_and_main_token(self):
        server = self.make_dashboard()
        with self.request(
            server,
            payload={"tool": "sessions_list", "args": {}},
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertTrue(body["ok"])
        self.assertEqual(len(RecordingHandler.calls), 1)
        forwarded = RecordingHandler.calls[0]
        self.assertEqual(forwarded["headers"]["Authorization"], "Bearer main-token")
        self.assertEqual(json.loads(forwarded["body"])["tool"], "sessions_list")

    def test_proxy_uses_port_specific_config_token(self):
        alt_port = self.gateway.server_address[1]
        self.alt_config.write_text(
            json.dumps({"gateway": {"auth": {"token": "alt-token"}, "port": alt_port}}),
            encoding="utf-8",
        )

        original_map = dashboard_server.DEFAULT_PORT_CONFIG_MAP.copy()
        dashboard_server.DEFAULT_PORT_CONFIG_MAP[alt_port] = str(self.alt_config)
        self.addCleanup(lambda: dashboard_server.DEFAULT_PORT_CONFIG_MAP.clear() or dashboard_server.DEFAULT_PORT_CONFIG_MAP.update(original_map))

        server = self.make_dashboard(allowed_ports={18789, alt_port})
        with self.request(
            server,
            path=f"/api/tools/invoke?port={alt_port}",
            payload={"tool": "sessions_list", "args": {}},
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertTrue(body["ok"])
        self.assertEqual(RecordingHandler.calls[-1]["headers"]["Authorization"], "Bearer alt-token")

    def test_disallowed_origin_returns_403(self):
        server = self.make_dashboard(allowed_origins={"https://allowed.example"})
        with self.assertRaises(HTTPError) as ctx:
            self.request(
                server,
                payload={"tool": "sessions_list", "args": {}},
                headers={"Origin": "https://blocked.example"},
            )

        self.assertEqual(ctx.exception.code, 403)
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(body["error"]["type"], "forbidden")
        self.assertEqual(len(RecordingHandler.calls), 0)

    def test_disallowed_gateway_port_returns_400(self):
        server = self.make_dashboard(allowed_ports={18789})
        with self.assertRaises(HTTPError) as ctx:
            self.request(
                server,
                path="/api/tools/invoke?port=19001",
                payload={"tool": "sessions_list", "args": {}},
                headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            )

        self.assertEqual(ctx.exception.code, 400)
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(body["error"]["message"], "Invalid or disallowed gateway port")
        self.assertEqual(len(RecordingHandler.calls), 0)

    def test_mission_control_tasks_route_is_now_native(self):
        server = self.make_dashboard()
        with self.request(
            server,
            path="/api/mission-control/api/tasks?workspace_id=default",
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            method="GET",
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(resp.status, 200)
        self.assertEqual(body, [])
        self.assertEqual(len(RecordingMissionControlHandler.calls), 0)

    def test_mission_control_task_patch_route_is_now_native(self):
        server = self.make_dashboard()
        created = json.loads(
            self.request(
                server,
                path="/api/mission-control/api/tasks",
                payload={"title": "Native patch target", "workspace_id": "default"},
                headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
                method="POST",
            ).read().decode("utf-8")
        )

        with self.request(
            server,
            path=f"/api/mission-control/api/tasks/{created['id']}",
            payload={"status": "review"},
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            method="PATCH",
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(body["status"], "review")
        self.assertEqual(len(RecordingMissionControlHandler.calls), 0)

    def test_mission_control_events_stream_is_now_native_sse(self):
        server = self.make_dashboard()
        self.request(
            server,
            path="/api/mission-control/api/tasks",
            payload={"title": "SSE task", "workspace_id": "default"},
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            method="POST",
        ).read()

        with self.request(
            server,
            path="/api/mission-control/api/events/stream?workspace_id=default",
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            method="GET",
        ) as resp:
            first_line = resp.fp.readline().decode("utf-8")
            second_line = resp.fp.readline().decode("utf-8")
            body = first_line + second_line

        self.assertEqual(resp.headers.get_content_type(), "text/event-stream")
        self.assertTrue("business_os_seeded" in body or "task_created" in body)

    def test_council_start_requires_topic(self):
        server = self.make_dashboard()
        with self.assertRaises(HTTPError) as ctx:
            self.request(
                server,
                path="/api/council/run/start",
                payload={"id": "session-1", "participants": ["workspace-manager", "senku-ishigami"]},
                headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            )

        self.assertEqual(ctx.exception.code, 400)
        body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(body["error"]["message"], "Council run requires a topic")

    def test_council_start_creates_run_and_invokes_orchestrator(self):
        orchestrator = DummyCouncilOrchestrator()
        server = self.make_dashboard(council_orchestrator=orchestrator)

        with self.request(
            server,
            path="/api/council/run/start",
            payload={
                "id": "session-1",
                "title": "Test Session",
                "topic": "Stabilize runtime join",
                "participants": ["workspace-manager", "senku-ishigami"],
            },
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(resp.status, 202)
        self.assertTrue(body["ok"])
        run_id = body["run"]["id"]
        self.assertTrue(run_id)
        self.assertIn(run_id, orchestrator.started)
        self.assertIsNotNone(server.council_event_bus.get_run(run_id))

    def test_council_stop_marks_stop_requested(self):
        server = self.make_dashboard()
        run = server.council_event_bus.create_run(
            {
                "id": "session-1",
                "topic": "stop test",
                "participants": ["workspace-manager", "senku-ishigami"],
            },
            dashboard_server.now_iso(),
        )

        with self.request(
            server,
            path="/api/council/run/stop",
            payload={"run_id": run.run_id},
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
        ) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        self.assertEqual(resp.status, 200)
        self.assertTrue(body["ok"])
        self.assertTrue(server.council_event_bus.get_run(run.run_id).stop_requested)

    def test_council_stream_replays_terminal_history(self):
        server = self.make_dashboard()
        run = server.council_event_bus.create_run(
            {
                "id": "session-1",
                "topic": "stream test",
                "participants": ["workspace-manager", "senku-ishigami"],
            },
            dashboard_server.now_iso(),
        )
        server.council_event_bus.update_status(run.run_id, "completed", dashboard_server.now_iso())

        with self.request(
            server,
            path=f"/api/council/run/stream?run_id={run.run_id}",
            headers={"Origin": f"http://127.0.0.1:{server.server_address[1]}"},
            method="GET",
        ) as resp:
            body = resp.read().decode("utf-8")

        self.assertEqual(resp.status, 200)
        self.assertIn("event: run.created", body)
        self.assertIn("event: run.status", body)
        self.assertIn(run.run_id, body)


class FakeArtifactStore:
    def __init__(self):
        self.calls = []

    def persist_artifact(self, run_id, artifact):
        self.calls.append((run_id, artifact))
        return {"ok": True, "path": f"/tmp/{run_id}.json"}


class CouncilOrchestratorProtocolTests(unittest.TestCase):
    def _make_orchestrator(self):
        return council_orchestrator.CouncilOrchestrator(
            event_bus=dashboard_server.CouncilEventBus(),
            tools_url_for_port=lambda _port: "http://unused",
            token_for_port=lambda _port: "token",
            port_for_slug=lambda _slug: 18789,
            participant_slug_map={"Workspace Manager": "workspace-manager", "Senku Ishigami": "senku-ishigami"},
            artifact_store=FakeArtifactStore(),
        )

    def test_sessions_list_parses_nested_gateway_result_envelope(self):
        orchestrator = self._make_orchestrator()
        orchestrator._invoke_tool = lambda *_args, **_kwargs: {  # type: ignore[attr-defined]
            "ok": True,
            "result": {
                "details": {
                    "sessions": [
                        {"key": "agent:main:main", "kind": "other"},
                        {
                            "key": "agent:main:discord:channel:123",
                            "kind": "group",
                            "displayName": "discord:team#workspace-manager",
                        },
                    ]
                }
            },
        }

        sessions = orchestrator._sessions_list(19001)
        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions[1]["key"], "agent:main:discord:channel:123")

    def test_resolve_session_key_reuses_existing_group_session_from_nested_result(self):
        orchestrator = self._make_orchestrator()
        orchestrator._invoke_tool = lambda *_args, **_kwargs: {  # type: ignore[attr-defined]
            "ok": True,
            "result": {
                "details": {
                    "sessions": [
                        {"key": "agent:main:main", "kind": "other"},
                        {
                            "key": "agent:main:discord:channel:123",
                            "kind": "group",
                            "displayName": "discord:team#workspace-manager",
                        },
                    ]
                }
            },
        }

        session_key = orchestrator._resolve_session_key("workspace-manager", 19001)
        self.assertEqual(session_key, "agent:main:discord:channel:123")

    def test_resolve_session_key_prefers_group_when_display_name_matches_multiple_sessions(self):
        orchestrator = self._make_orchestrator()
        orchestrator._invoke_tool = lambda *_args, **_kwargs: {  # type: ignore[attr-defined]
            "ok": True,
            "result": {
                "details": {
                    "sessions": [
                        {
                            "key": "agent:main:subagent:abc",
                            "kind": "other",
                            "displayName": "discord:team#senku-ishigami",
                        },
                        {
                            "key": "agent:main:discord:channel:456",
                            "kind": "group",
                            "displayName": "discord:team#senku-ishigami",
                        },
                    ]
                }
            },
        }

        session_key = orchestrator._resolve_session_key("senku-ishigami", 19101)
        self.assertEqual(session_key, "agent:main:discord:channel:456")

    def test_multi_round_protocol_emits_round_and_artifact_events(self):
        event_bus = dashboard_server.CouncilEventBus()
        store = FakeArtifactStore()

        orchestrator = council_orchestrator.CouncilOrchestrator(
            event_bus=event_bus,
            tools_url_for_port=lambda _port: "http://unused",
            token_for_port=lambda _port: "token",
            port_for_slug=lambda _slug: 18789,
            participant_slug_map={"Workspace Manager": "workspace-manager", "Senku Ishigami": "senku-ishigami"},
            artifact_store=store,
        )

        run = event_bus.create_run(
            {
                "id": "session-x",
                "title": "Test council",
                "topic": "Ship council phases",
                "participants": ["workspace-manager", "senku-ishigami"],
            },
            dashboard_server.now_iso(),
        )

        def fake_send(_port, session_key, message):
            if "Round: proposal" in message:
                reply = f"proposal from {session_key}"
            elif "Round: critique" in message:
                reply = f"critique from {session_key}"
            else:
                reply = f"synthesis from {session_key}"
            return {"details": {"status": "ok", "reply": reply}}

        orchestrator._resolve_session_key = lambda slug, _port: f"session:{slug}"  # type: ignore[attr-defined]
        orchestrator._send_message = fake_send  # type: ignore[attr-defined]

        orchestrator._run(run.run_id)

        state = event_bus.get_run(run.run_id)
        self.assertIsNotNone(state)
        self.assertEqual(state.status, "completed")

        event_types = [item["type"] for item in state.history]
        self.assertIn("round.status", event_types)
        self.assertIn("artifact.persisted", event_types)

        round_names = [
            item["payload"].get("round")
            for item in state.history
            if item["type"] == "round.status" and item["payload"].get("state") in {"started", "published"}
        ]
        self.assertIn("context", round_names)
        self.assertIn("proposal", round_names)
        self.assertIn("critique", round_names)
        self.assertIn("synthesis", round_names)
        self.assertEqual(len(store.calls), 1)

    def test_requester_session_key_collision_skips_recursive_send(self):
        event_bus = dashboard_server.CouncilEventBus()
        store = FakeArtifactStore()

        orchestrator = council_orchestrator.CouncilOrchestrator(
            event_bus=event_bus,
            tools_url_for_port=lambda _port: "http://unused",
            token_for_port=lambda _port: "token",
            port_for_slug=lambda _slug: 18789,
            participant_slug_map={"Workspace Manager": "workspace-manager", "Senku Ishigami": "senku-ishigami"},
            artifact_store=store,
        )

        run = event_bus.create_run(
            {
                "id": "session-y",
                "title": "Collision test",
                "topic": "Avoid recursive self-send",
                "participants": ["workspace-manager", "senku-ishigami"],
                "requester_session_key": "agent:main:discord:channel:senku",
            },
            dashboard_server.now_iso(),
        )

        send_calls = []

        def fake_send(_port, session_key, _message):
            send_calls.append(session_key)
            return {"details": {"status": "ok", "reply": f"reply from {session_key}"}}

        def fake_resolve(slug, _port):
            if slug == "senku-ishigami":
                return "agent:main:discord:channel:senku"
            return f"agent:main:discord:channel:{slug}"

        orchestrator._resolve_session_key = fake_resolve  # type: ignore[attr-defined]
        orchestrator._send_message = fake_send  # type: ignore[attr-defined]

        orchestrator._run(run.run_id)

        state = event_bus.get_run(run.run_id)
        self.assertIsNotNone(state)
        self.assertEqual(state.status, "completed")
        self.assertNotIn("agent:main:discord:channel:senku", send_calls)
        self.assertTrue(send_calls)
        self.assertEqual(store.calls[0][1]["failure_count"], 3)
        self.assertEqual(store.calls[0][1]["success_count"], 3)
        self.assertTrue(any(
            item["payload"].get("state") == "skipped" and item["payload"].get("agent_slug") == "senku-ishigami"
            for item in state.history
            if item["type"] == "participant.status"
        ))


if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard_server.py"
spec = importlib.util.spec_from_file_location("dashboard_server", MODULE_PATH)
dashboard_server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(dashboard_server)


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

        self.gateway = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        self.gateway_thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        self.gateway_thread.start()
        self.addCleanup(self._cleanup_gateway)

    def _cleanup_gateway(self):
        self.gateway.shutdown()
        self.gateway.server_close()
        self.gateway_thread.join(timeout=2)

    def make_dashboard(self, *, allowed_origins=None, allowed_ports=None, config_path=None):
        handler_cls = dashboard_server.build_handler(str(self.dashboard_dir))
        server = dashboard_server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        server.allowed_origins = set(allowed_origins or [])
        server.allowed_gateway_ports = set(allowed_ports or {18789, 19001})
        server.config_path = str(config_path or self.default_config)
        server.tools_url = f"http://127.0.0.1:{self.gateway.server_address[1]}/tools/invoke"
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


if __name__ == "__main__":
    unittest.main()

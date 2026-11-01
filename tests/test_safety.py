import asyncio
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import start
import watchdog
import supervisor
from secure_middleware import BearerGate

IMAGE = "example.com/user/qwen@sha256:" + "a" * 64
POD = {"id": "pod-test", "name": watchdog.NAME, "image": IMAGE,
       "createdAt": "2026-10-31T00:00:00Z", "cloud": "SECURE",
       "gpu": {"id": "NVIDIA GeForce RTX 4090", "count": 1},
       "locked": False, "status": "RUNNING", "actions": ["stop"]}


class FakeClient:
    def __init__(self, verify=True):
        self.pod = copy.deepcopy(POD)
        self.verify = verify
        self.stops = 0
        self.reads = 0

    def get(self, pod_id):
        self.reads += 1
        return copy.deepcopy(self.pod)

    def stop(self, pod_id):
        self.stops += 1
        if self.verify:
            self.pod["status"] = "EXITED"
        return {"status": "EXITED"}  # deliberately not trusted by tick


class DeadlineTests(unittest.TestCase):
    def setUp(self):
        self.state = watchdog.make_state(POD, IMAGE)

    def test_no_stop_before_deadline(self):
        client = FakeClient()
        self.assertEqual(watchdog.tick(client, self.state, self.state["deadline"] - 1), "armed")
        self.assertEqual(client.stops, 0)

    def test_deadline_stops_pod_and_reads_back(self):
        client = FakeClient()
        self.assertEqual(watchdog.tick(client, self.state, self.state["deadline"]), "stopped_verified")
        self.assertEqual((client.stops, client.reads), (1, 2))

    def test_post_response_is_not_verification(self):
        client = FakeClient(verify=False)
        self.assertEqual(watchdog.tick(client, self.state, self.state["deadline"]), "stop_requested_retrying")
        watchdog.tick(client, self.state, self.state["deadline"] + 15)
        self.assertEqual(client.stops, 2)

    def test_restarted_pod_retains_original_deadline(self):
        client = FakeClient()
        client.pod["startedAt"] = "2026-10-31T09:59:59Z"
        self.assertEqual(watchdog.tick(client, self.state, self.state["deadline"]), "stopped_verified")

    def test_wrong_identity_is_never_stopped(self):
        for field in ("id", "name", "image", "createdAt"):
            with self.subTest(field=field):
                client = FakeClient()
                client.pod[field] = "different"
                with self.assertRaises(ValueError):
                    watchdog.tick(client, self.state, self.state["deadline"])
                self.assertEqual(client.stops, 0)

    def test_deadline_cannot_be_extended(self):
        self.state["deadline"] += 3600
        with self.assertRaises(ValueError):
            watchdog.tick(FakeClient(), self.state, self.state["deadline"])

    def test_locked_pod_reports_failure(self):
        client = FakeClient()
        client.pod["locked"] = True
        with self.assertRaises(ValueError):
            watchdog.tick(client, self.state, self.state["deadline"])
        self.assertEqual(client.stops, 0)

    def test_existing_state_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            watchdog.save_state(path, self.state)
            with self.assertRaises(FileExistsError):
                watchdog.save_state(path, self.state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class SecurityTests(unittest.TestCase):
    def test_environment_rejects_missing_auth_and_control_keys(self):
        with self.assertRaises(ValueError):
            start.validate_environment({})
        with self.assertRaises(ValueError):
            start.validate_environment({"VLLM_API_KEY": "k" * 48, "RUNPOD_API_KEY": "example"})
        start.validate_environment({"VLLM_API_KEY": "k" * 48})

    def test_loading_pinned_safe_format(self):
        args = start.arguments()
        self.assertIn("--no-trust-remote-code", args)
        self.assertEqual(args[args.index("--load-format") + 1], "safetensors")
        for flag in ("--revision", "--tokenizer-revision"):
            self.assertEqual(args[args.index(flag) + 1], start.REVISION)

    def invoke(self, path, headers=(), method="GET"):
        result = []
        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
        async def send(message):
            result.append(message)
        async def receive():
            return {"type": "http.request", "body": b""}
        with patch.dict(os.environ, {"VLLM_API_KEY": "k" * 48}):
            gate = BearerGate(app)
        asyncio.run(gate({"type": "http", "method": method, "path": path,
                          "headers": headers}, receive, send))
        return result[0]["status"]

    def test_all_routes_require_auth_even_health(self):
        for route in ("/health", "/v1/models", "/v1/chat/completions", "/metrics", "/docs"):
            self.assertEqual(self.invoke(route), 401)

    def test_authenticated_inference_and_health_allowed(self):
        headers = [(b"authorization", b"Bearer " + b"k" * 48)]
        self.assertEqual(self.invoke("/health", headers), 200)
        self.assertEqual(self.invoke("/v1/models", headers), 200)
        self.assertEqual(self.invoke("/v1/chat/completions", headers, "POST"), 200)

    def test_other_routes_and_duplicate_auth_denied(self):
        headers = [(b"authorization", b"Bearer " + b"k" * 48)]
        self.assertEqual(self.invoke("/metrics", headers), 404)
        self.assertEqual(self.invoke("/docs", headers), 404)
        self.assertEqual(self.invoke("/health", headers * 2), 401)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.state = watchdog.make_state(POD, IMAGE)

    def test_child_gets_api_auth_but_no_control_or_unknown_secrets(self):
        env = supervisor.child_environment({
            "VLLM_API_KEY": "k" * 48, "RUNPOD_API_KEY": "secret",
            "SOME_NEW_CLOUD_SECRET": "secret", "RUNPOD_POD_ID": "pod-test",
            "AWS_SECRET_ACCESS_KEY": "secret", "HF_TOKEN": "secret", "PATH": "/bin",
        })
        self.assertEqual(env["VLLM_API_KEY"], "k" * 48)
        for name in ("RUNPOD_API_KEY", "SOME_NEW_CLOUD_SECRET", "RUNPOD_POD_ID", "AWS_SECRET_ACCESS_KEY", "HF_TOKEN"):
            self.assertNotIn(name, env)

    def test_boot_filesystem_preserves_existing_accounts_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "etc").mkdir()
            (root / "etc/passwd").write_text("root:x:0:0:root:/root:/bin/sh\n")
            (root / "etc/group").write_text("root:x:0:\n")
            with patch.object(supervisor.os, "chown") as chown:
                supervisor.prepare_runtime_filesystem(root)
                supervisor.prepare_runtime_filesystem(root)
                self.assertEqual(chown.call_args.args[1:], (10001, 10001))
            self.assertTrue((root / "etc/passwd").read_text().startswith("root:x:0:0:"))
            self.assertEqual((root / "etc/passwd").read_text().count("inference:x:10001:"), 1)
            self.assertEqual((root / "cache").stat().st_mode & 0o777, 0o700)

    def test_bind_only_provider_injected_id(self):
        client = FakeClient()
        self.assertEqual(supervisor.bind_self(client, "pod-test", IMAGE), self.state)
        with self.assertRaises(ValueError):
            supervisor.bind_self(client, "different-pod", IMAGE)

    def test_expired_startup_never_launches_model(self):
        client = FakeClient()
        launch = unittest.mock.Mock()
        supervisor.run_loop(client, self.state, launch, now=lambda: self.state["deadline"] + 1)
        launch.assert_not_called()
        self.assertEqual(client.stops, 1)

    def test_inference_failure_stops_pod_early(self):
        client = FakeClient()
        process = unittest.mock.Mock()
        process.poll.return_value = 1
        launch = unittest.mock.Mock(return_value=process)
        supervisor.run_loop(client, self.state, launch,
                            now=lambda: self.state["deadline"] - 100, sleep=lambda _: None)
        launch.assert_called_once()
        self.assertEqual(client.stops, 1)

    def test_deadline_stops_child_then_pod(self):
        client = FakeClient()
        process = unittest.mock.Mock()
        process.poll.return_value = None
        clock = iter([self.state["deadline"] - 100, self.state["deadline"] - 99, self.state["deadline"] + 1])
        launch = unittest.mock.Mock(return_value=process)
        supervisor.run_loop(client, self.state, launch, now=lambda: next(clock), sleep=lambda _: None)
        process.terminate.assert_called()
        self.assertEqual(client.stops, 1)

    def test_launch_failure_requests_stop_without_retrying_model(self):
        client = FakeClient()
        launch = unittest.mock.Mock(side_effect=OSError("example failure"))
        supervisor.run_loop(client, self.state, launch,
                            now=lambda: self.state["deadline"] - 100, sleep=lambda _: None)
        launch.assert_called_once()
        self.assertEqual(client.stops, 1)


if __name__ == "__main__":
    unittest.main()

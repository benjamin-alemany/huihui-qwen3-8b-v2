"""Adversarial CPU-only checks of the exact candidate Linux launch helpers."""
import ctypes
import json
import os
from pathlib import Path
import resource
import socket
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, "/opt/qwen")
import credential_boundary as boundary

PYTHON = sys.executable
PROBE = [PYTHON, "-I", "-S", "-B", "/opt/qwen/credential_probe.py", "--child"]
DUMMY = "DUMMY-NOT-A-REAL-KEY-credential-canary"


class LinuxBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.getuid() == 0 and sys.platform == "linux"
        boundary.prepare_filesystem()
        Path("/root/credential-canary").write_text(DUMMY)
        os.chmod("/root", 0o700)
        os.chmod("/root/credential-canary", 0o600)

    def clean_env(self):
        return boundary.model_environment(boundary.boot_environment({"VLLM_API_KEY": "DUMMY-" + "x" * 40}))

    def test_socket_on_standard_descriptor_refuses_inference(self):
        a, b = socket.socketpair()
        try:
            result = subprocess.run(PROBE, env=self.clean_env(), preexec_fn=boundary.drop_privileges,
                                    stdin=subprocess.DEVNULL, stdout=a, stderr=subprocess.PIPE,
                                    text=True, timeout=15, close_fds=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Standard descriptors must not carry sockets', result.stderr)
        finally:
            a.close(); b.close()

    def child(self, preexec=boundary.drop_privileges, env=None, **kwargs):
        return subprocess.run(PROBE, env=self.clean_env() if env is None else env,
                              preexec_fn=preexec, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=15, **kwargs)

    def failed(self, result, reason=None):
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("CHAT_CREDENTIAL_BOUNDARY", result.stdout)
        self.assertNotIn(DUMMY, result.stdout + result.stderr)
        if reason:
            self.assertIn(reason, result.stderr)

    def test_clean_exec_discards_provider_key_and_inherited_file(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(DUMMY.encode());stream.flush()
            os.set_inheritable(stream.fileno(), True)
            result = subprocess.run([PYTHON, "-I", "-S", "-B", "/opt/qwen/credential_boot.py", "--probe"],
                env={"RUNPOD_API_KEY": DUMMY, "VLLM_API_KEY": "DUMMY-" + "x" * 40,
                     "PYTHONPATH": "/untrusted", "HTTP_PROXY": "http://untrusted"},
                pass_fds=(stream.fileno(),), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(DUMMY, result.stdout + result.stderr)
        receipt = json.loads(result.stdout.split("CHAT_CREDENTIAL_BOUNDARY ", 1)[1])
        self.assertEqual(receipt["uid"], 10001)
        self.assertTrue(receipt["privilege_regain_denied"])
        self.assertFalse(receipt["model_loaded"])
        self.assertFalse(receipt["network_used"])

    def test_unknown_credential_blocks_bootstrap(self):
        result = subprocess.run([PYTHON, "-I", "-S", "-B", "/opt/qwen/credential_boot.py", "--probe"],
            env={"RUNPOD_API_KEY": DUMMY, "AWS_SECRET_ACCESS_KEY": DUMMY},
            capture_output=True, text=True, timeout=15)
        self.failed(result)

    def test_arbitrary_command_refused(self):
        result = subprocess.run([PYTHON, "-I", "-S", "-B", "/opt/qwen/credential_boot.py", "/bin/sh"],
            env={}, capture_output=True, text=True, timeout=15)
        self.failed(result)

    def test_writable_application_refuses_bootstrap(self):
        path = Path("/opt/qwen/credential_probe.py")
        original = path.stat().st_mode
        path.chmod(0o666)
        try:
            result = subprocess.run([PYTHON,"-I","-S","-B","/opt/qwen/credential_boot.py","--probe"],
                env={"RUNPOD_API_KEY":DUMMY},capture_output=True,text=True,timeout=15)
            self.failed(result)
            self.assertIn("Credential bootstrap refused", result.stderr)
        finally:
            path.chmod(original)

    def test_inference_cannot_modify_application(self):
        code = "open('/opt/qwen/credential_boot.py','ab')"
        result = subprocess.run([PYTHON,"-I","-S","-B","-c",code],env=self.clean_env(),
            preexec_fn=boundary.drop_privileges,capture_output=True,text=True,timeout=15)
        self.failed(result)
        self.assertIn("PermissionError", result.stderr)

    def test_pop_without_exec_still_refuses_stale_proc_environment(self):
        code = "import sys,os;sys.path.insert(0,'/opt/qwen');import credential_boundary as b;os.environ.pop('RUNPOD_API_KEY');b.assert_clean_boot()"
        result = subprocess.run([PYTHON, "-I", "-S", "-B", "-c", code],
            env={"RUNPOD_API_KEY": DUMMY}, capture_output=True, text=True, timeout=15)
        self.failed(result)
        self.assertIn("Unexpected credential-like", result.stderr)

    def test_root_child_refused(self):
        self.failed(self.child(preexec=None), "Unexpected inference credentials")

    def test_missing_no_new_privileges_refused(self):
        def unsafe_drop():
            os.setgroups([]);os.setresgid(10001,10001,10001);os.setresuid(10001,10001,10001)
            resource.setrlimit(resource.RLIMIT_CORE, (0,0))
        self.failed(self.child(preexec=unsafe_drop), "Inference retained privileges")

    def test_saved_root_identity_refused(self):
        # exec resets saved IDs to effective IDs. Use a real fork without exec
        # to retain the unsafe saved-root identity at the verification point.
        pid = os.fork()
        if pid == 0:
            try:
                boundary.prctl(38,1);os.setgroups([])
                os.setresgid(10001,10001,0);os.setresuid(10001,10001,0)
                boundary.verify_child()
            except boundary.BoundaryError as exc:
                os._exit(0 if str(exc) == "Unexpected inference credentials" else 3)
            except Exception:
                os._exit(4)
            os._exit(5)
        _, status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFEXITED(status))
        self.assertEqual(os.WEXITSTATUS(status), 0)

    def test_supplementary_root_group_refused(self):
        def unsafe_drop():
            boundary.prctl(38,1);os.setgroups([0]);os.setresgid(10001,10001,10001);os.setresuid(10001,10001,10001)
            resource.setrlimit(resource.RLIMIT_CORE, (0,0))
        self.failed(self.child(preexec=unsafe_drop), "Unexpected inference credentials")

    def test_inherited_credential_descriptor_refused(self):
        with open("/root/credential-canary", "rb") as stream:
            self.failed(self.child(pass_fds=(stream.fileno(),)), "Unexpected inherited descriptor")

    def test_readable_credential_location_refused(self):
        path = Path("/home/inference/.runpod")
        path.mkdir(mode=0o755)
        try:
            self.failed(self.child(), "Protected credential location or control socket is accessible")
        finally:
            path.rmdir()

    def test_direct_child_credential_injection_refused(self):
        self.failed(self.child(env=dict(self.clean_env(), RUNPOD_API_KEY=DUMMY)), "Unexpected credential-like")

    def test_other_process_using_inference_uid_refused(self):
        peer = subprocess.Popen([PYTHON,"-I","-S","-B","-c","import time;time.sleep(15)"],
                                env=self.clean_env(),preexec_fn=boundary.drop_privileges)
        try:
            self.failed(self.child(), "Inference UID is shared with another process")
        finally:
            peer.terminate();peer.wait(timeout=5)

    def test_private_file_denied_even_through_symlink(self):
        path = Path("/home/inference/canary-link")
        path.symlink_to("/root/credential-canary")
        try:
            code = "from pathlib import Path;Path('/home/inference/canary-link').open('rb')"
            result = subprocess.run([PYTHON,"-I","-S","-B","-c",code],env=self.clean_env(),
                preexec_fn=boundary.drop_privileges,capture_output=True,text=True,timeout=15)
            self.failed(result)
            self.assertIn("PermissionError", result.stderr)
        finally:
            path.unlink()

    def test_boundary_failure_precedes_torch_import(self):
        result = subprocess.run([PYTHON,"-I","-S","-B","/opt/qwen/model_boot.py"],
            env=self.clean_env(),capture_output=True,text=True,timeout=15)
        self.failed(result)
        self.assertIn("Unexpected inference credentials", result.stderr)
        self.assertNotIn("No module named 'torch'", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

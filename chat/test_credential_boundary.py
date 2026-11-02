"""Portable policy tests; real Linux enforcement lives in boundary_tests/."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("boundary", Path(__file__).with_name("credential_boundary.py"))
boundary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(boundary)


class BoundaryPolicyTests(unittest.TestCase):
    def test_provider_key_is_discarded_without_reading_its_value(self):
        class Source(dict):
            def __getitem__(self, key):
                if key == "RUNPOD_API_KEY":
                    raise AssertionError("Provider key value must not be accessed")
                return super().__getitem__(key)
        result = boundary.boot_environment(Source(RUNPOD_API_KEY="DUMMY", VLLM_API_KEY="DUMMY-inference",
                                                  PYTHONPATH="/untrusted", HTTP_PROXY="http://untrusted"))
        self.assertEqual(result["VLLM_API_KEY"], "DUMMY-inference")
        self.assertNotIn("RUNPOD_API_KEY", result)
        self.assertNotIn("PYTHONPATH", result)
        self.assertNotIn("HTTP_PROXY", result)

    def test_unknown_and_case_changed_credentials_refuse_even_when_empty(self):
        for name in ("RUNPOD_API_KEY_2", "runpod_api_key", "HF_TOKEN", "AWS_SECRET_ACCESS_KEY", "PASSWORD",
                     "CLOUDFLARE_API_TOKEN", "BACKUP_CREDENTIAL", "vllm_api_key"):
            for value in ("", "DUMMY"):
                with self.subTest(name=name, empty=not value), self.assertRaises(ValueError):
                    boundary.boot_environment({name: value})

    def test_child_has_no_control_metadata_or_proxy_variables(self):
        boot = boundary.boot_environment({"RUNPOD_API_KEY": "DUMMY", "VLLM_API_KEY": "DUMMY-inference",
                                          "CHAT_CLOUD_GUARDS_VERIFIED": "true", "CHAT_DEADLINE_UTC": "DUMMY"})
        child = boundary.model_environment(boot)
        self.assertFalse(set(child) - boundary.MODEL_KEYS)
        self.assertNotIn("CHAT_CLOUD_GUARDS_VERIFIED", child)
        self.assertNotIn("CHAT_DEADLINE_UTC", child)
        self.assertEqual(child["TMPDIR"], "/tmp/qwen-inference")

    def test_proc_parser_returns_names_only(self):
        with tempfile.NamedTemporaryFile() as stream:
            stream.write(b"PATH=/bin\0RUNPOD_API_KEY=DUMMY-NOT-REAL\0");stream.flush()
            self.assertEqual(boundary.initial_environment_names(stream.name), ["PATH", "RUNPOD_API_KEY"])

    def test_missing_linux_protection_raises(self):
        with patch.object(boundary.ctypes, "CDLL") as libc:
            libc.return_value.prctl.return_value = -1
            with self.assertRaises(OSError):
                boundary.prctl(38, 1)


if __name__ == "__main__":
    unittest.main()

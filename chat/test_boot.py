import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / "supervisor.py").exists())
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("chat_boot", Path(__file__).with_name("inference_only.py"))
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootTests(unittest.TestCase):
    def setUp(self):
        self.env = {"VLLM_API_KEY": "DUMMY-"+"x"*43, "CHAT_CLOUD_GUARDS_VERIFIED": "true",
                    "CHAT_RESERVED_AT": "2026-11-01T12:00:00Z", "CHAT_DEADLINE_UTC": "2026-11-01T12:30:00Z"}
        self.now = 1793534401

    def test_no_provider_credentials_allowed_even_in_supervisor(self):
        for name in ("RUNPOD_API_KEY", "CLOUDFLARE_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "BACKUP_CREDENTIAL"):
            with self.assertRaises(ValueError):
                boot.deadline_from(dict(self.env, **{name: "DUMMY-not-a-key"}), self.now)

    def test_requires_prearmed_cloud_guards_and_valid_short_immutable_deadline(self):
        self.assertEqual(boot.deadline_from(self.env, self.now), self.now-1+1800)
        for patch in ({"CHAT_CLOUD_GUARDS_VERIFIED": "false"}, {"CHAT_DEADLINE_UTC": "2026-11-01T22:00:00Z"},
                      {"CHAT_RESERVED_AT": "2026-11-01T12:01:00Z"}, {"CHAT_DEADLINE_UTC": "2026-11-01T12:00:00Z"}):
            with self.assertRaises(ValueError):
                boot.deadline_from(dict(self.env, **patch), self.now)

    def test_sixty_minute_product_limit_never_allows_ten_hours_or_expired_boot(self):
        env = dict(self.env, CHAT_DEADLINE_UTC="2026-11-01T13:00:00Z")
        self.assertEqual(boot.deadline_from(env, self.now), self.now-1+3600)
        for end in ("2026-11-01T13:00:01Z", "2026-11-01T22:00:00Z"):
            with self.assertRaises(ValueError):
                boot.deadline_from(dict(env, CHAT_DEADLINE_UTC=end), self.now)
        with self.assertRaises(ValueError):
            boot.deadline_from(env, self.now-1+3600)


if __name__ == "__main__":
    unittest.main()

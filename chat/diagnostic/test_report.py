import importlib.util
import json
from pathlib import Path
import unittest

s = importlib.util.spec_from_file_location("environment_names", Path(__file__).with_name("environment_names.py"))
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)


class DiagnosticTests(unittest.TestCase):
    def test_values_and_nonstandard_names_never_leave_the_process(self):
        secret = "DUMMY-PRIVATE-VALUE-NEVER-REPORT"
        x = m.report({"RUNPOD_API_KEY": secret, "TOKENIZERS_PARALLELISM": "false", "API_KEY\n"+secret: "x", "PATH": secret}, 10004, 10004)
        output = json.dumps(x)
        self.assertNotIn(secret, output)
        self.assertEqual(x["credential_like_variable_names"], ["RUNPOD_API_KEY", "TOKENIZERS_PARALLELISM"])
        self.assertFalse(x["values_reported"])
        self.assertFalse(x["model_loaded"])
        self.assertFalse(x["network_used"])

    def test_names_cannot_produce_unbounded_output(self):
        with self.assertRaises(ValueError):
            m.report({f"TOKEN_{n}": "DUMMY" for n in range(65)}, 10004, 10004)


if __name__ == "__main__":
    unittest.main()

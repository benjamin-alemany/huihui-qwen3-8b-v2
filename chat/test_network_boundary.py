"""Portable refusal/order checks. Not a Linux enforcement or GPU validation."""
import ast
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('network_boundary',HERE/'network_boundary.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
class NetworkTests(unittest.TestCase):
 def test_unsupported_platform_refuses_before_loading_native_libraries(self):
  with patch.object(n.sys,'platform','darwin'),patch.object(n.C,'CDLL') as lib:
   with self.assertRaises(n.NetworkBoundaryError):n.install()
   lib.assert_not_called()
 def test_boundary_runs_before_torch_or_model_code(self):
  source=(HERE/'model_boot.py').read_text()
  self.assertLess(source.index('network_boundary.install()'),source.index('import torch'))
  self.assertLess(source.index('network_boundary.install()'),source.index('os.execvp'))
 def test_no_privileged_network_admin_fallback(self):
  source=(HERE/'network_boundary.py').read_text();ast.parse(source)
  for text in ['iptables','nftables','subprocess','http://','https://']:self.assertNotIn(text,source)
if __name__=='__main__':unittest.main()

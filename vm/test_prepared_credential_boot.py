"""CPU-only compatibility entrypoint tests; never import Torch or a driver."""
import copy
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'chat'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import credential_boundary as boundary
import prepared_credential_boot as boot


class PreparedEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.raw = Path(__file__).with_name('cuda-compat.lock.json').read_bytes()
        self.source = {'VLLM_API_KEY': 'DUMMY-' + 'x' * 40,
                       'RUNPOD_API_KEY': 'DUMMY-CONTROL-DO-NOT-PROPAGATE',
                       'LD_LIBRARY_PATH': '/tmp/DUMMY-UNTRUSTED',
                       'CHAT_CLOUD_GUARDS_VERIFIED': 'true',
                       'CHAT_RESERVED_AT': '2026-11-15T12:00:00Z',
                       'CHAT_DEADLINE_UTC': '2026-11-15T12:30:00Z'}
        self.fixed = '/usr/local/cuda-13.0/compat:/usr/local/cuda-13.0/targets/x86_64-linux/lib'

    def test_both_existing_child_environments_inherit_verified_library_path(self):
        modules_before = set(sys.modules)
        original = dict(self.source)
        clean = boot.prepare_environment(self.source, self.raw, verifier=lambda _: self.fixed)
        self.assertEqual(self.source, original)
        self.assertEqual(clean['LD_LIBRARY_PATH'], self.fixed)
        self.assertNotIn('RUNPOD_API_KEY', clean)
        self.assertEqual(clean['CHAT_DEADLINE_UTC'], self.source['CHAT_DEADLINE_UTC'])
        for _ in ['preflight', 'model']:
            child = boundary.model_environment(clean)
            self.assertEqual(child['LD_LIBRARY_PATH'], self.fixed)
            self.assertNotIn('RUNPOD_API_KEY', child)
        self.assertNotIn('torch', set(sys.modules) - modules_before)
        self.assertNotIn('vllm', set(sys.modules) - modules_before)

    def test_changed_source_reviewed_lock_refuses_before_library_inspection(self):
        base = json.loads(self.raw)
        for mutate in [lambda lock: lock.update(sourceImage='example/model@sha256:' + 'c' * 64),
                       lambda lock: lock['package'].update(version='580.999.0'),
                       lambda lock: lock['files']['libcuda.so.580.95.05'].update(sha256='c' * 64)]:
            candidate = copy.deepcopy(base)
            mutate(candidate)
            with patch.object(boot.cuda_compat, 'verify_compatibility') as verify:
                with self.assertRaises(ValueError):
                    boot.prepare_environment(self.source, json.dumps(candidate).encode())
                verify.assert_not_called()
        with self.assertRaises(ValueError):
            boot.reviewed_lock(self.raw.replace(b'"reviewed": true', b'"reviewed": true,"reviewed": true'))

    def test_arbitrary_inherited_flags_and_loader_path_cannot_select_libraries(self):
        source = {**self.source, 'VLLM_CUDA_COMPATIBILITY_PATH': '/tmp/DUMMY-UNTRUSTED',
                  'VLLM_ENABLE_CUDA_COMPATIBILITY': '0'}
        clean = boot.prepare_environment(source, self.raw, verifier=lambda _: self.fixed)
        self.assertNotIn('VLLM_CUDA_COMPATIBILITY_PATH', clean)
        self.assertNotIn('VLLM_ENABLE_CUDA_COMPATIBILITY', clean)
        for invalid in ['/tmp/untrusted', self.fixed + ':/tmp/untrusted',
                        '/usr/local/cuda-13.0/compat::/usr/local/nvidia/lib64',
                        '/usr/local/cuda-13.0/compat:/usr/local/nvidia/lib:/usr/local/nvidia/lib']:
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                boot.prepare_environment(source, self.raw, verifier=lambda _, value=invalid: value)

    def test_library_verification_failure_has_no_fallback_to_inherited_path(self):
        def failure(_):
            raise ValueError('DUMMY FAILURE')
        with self.assertRaises(ValueError):
            boot.prepare_environment(self.source, self.raw, verifier=failure)

    def test_main_fresh_execs_only_original_fixed_credential_stage(self):
        calls = []
        with patch.object(boot.os, 'geteuid', return_value=0), \
             patch.object(boot.sys, 'argv', ['prepared_credential_boot.py']), \
             patch.object(boot.boundary, 'protect_process', side_effect=lambda: calls.append('protect')), \
             patch.object(boot.boundary, 'assert_trusted_application', side_effect=lambda _: calls.append('source')), \
             patch.object(boot.os, 'statvfs', return_value=SimpleNamespace(f_flag=os.ST_RDONLY)), \
             patch.object(boot, 'read_lock', return_value=self.raw), \
             patch.object(boot, 'prepare_environment', return_value={'LD_LIBRARY_PATH': self.fixed}), \
             patch.object(boot.boundary, 'close_inherited_fds', side_effect=lambda: calls.append('fds')), \
             patch.object(boot.os, 'execve') as execute:
            boot.main()
            self.assertEqual(calls, ['protect', 'source', 'fds'])
            self.assertEqual(execute.call_args.args[0], sys.executable)
            self.assertEqual(execute.call_args.args[1], [sys.executable, '-I', '-S', '-B', str(boot.NEXT_STAGE)])
            self.assertEqual(execute.call_args.args[2], {'LD_LIBRARY_PATH': self.fixed})

    def test_writable_container_root_refuses_before_library_check_or_exec(self):
        with patch.object(boot.os, 'geteuid', return_value=0), \
             patch.object(boot.sys, 'argv', ['prepared_credential_boot.py']), \
             patch.object(boot.boundary, 'protect_process'), \
             patch.object(boot.boundary, 'assert_trusted_application'), \
             patch.object(boot.os, 'statvfs', return_value=SimpleNamespace(f_flag=0)), \
             patch.object(boot, 'prepare_environment') as prepare, \
             patch.object(boot.os, 'execve') as execute:
            with self.assertRaises(ValueError):
                boot.main()
            prepare.assert_not_called()
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()

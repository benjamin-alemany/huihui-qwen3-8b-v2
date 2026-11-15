"""CPU-only fake compatibility libraries; no driver, Torch or model imports."""
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cuda_compat as compat


PACKAGE = {'name': 'cuda-compat-13-0', 'version': '580.1-1', 'architecture': 'amd64'}


def lock_for(inventory):
    # Synthetic fixture approval, never a source of production hashes.
    return {'version': 1, 'kind': 'cuda-compat-13-0-v1', 'directory': compat.COMPAT_DIRECTORY,
            'sourceImage': 'ghcr.io/example/inference@sha256:' + 'a' * 64,
            'package': PACKAGE.copy(), 'reviewed': True,
            'files': copy.deepcopy(inventory['files']), 'symlinks': inventory['symlinks'].copy()}


def root_owned(info):
    return SimpleNamespace(**{name: (0 if name == 'st_uid' else getattr(info, name))
                             for name in dir(info) if name.startswith('st_')})


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / compat.COMPAT_DIRECTORY.removeprefix('/')
        self.directory.mkdir(parents=True, mode=0o755)
        self.library = self.directory / 'libcuda.so.580.1'
        self.library.write_bytes(b'FAKE CPU TEST LIBRARY; NEVER LOAD')
        self.library.chmod(0o444)
        (self.directory / 'libcuda.so.1').symlink_to(self.library.name)
        original_fstat, original_stat = os.fstat, os.stat
        self.addCleanup(patch.stopall)
        patch.object(compat.os, 'fstat', side_effect=lambda fd: root_owned(original_fstat(fd))).start()
        patch.object(compat.os, 'stat', side_effect=lambda *a, **kw: root_owned(original_stat(*a, **kw))).start()

    def inventory(self):
        return compat.build_inventory(PACKAGE, root=self.root)

    def test_fixed_inventory_hashes_and_reviewed_soname_link(self):
        inventory = self.inventory()
        self.assertEqual(inventory['files'][self.library.name]['sha256'],
                         hashlib.sha256(self.library.read_bytes()).hexdigest())
        self.assertNotIn('reviewed', inventory)
        self.assertTrue(compat.validate_inventory(lock_for(inventory), inventory))

    def test_preserves_only_fixed_existing_loader_directories(self):
        fallback = self.root / compat.LIBRARY_DIRECTORIES[2].removeprefix('/')
        fallback.mkdir(parents=True, mode=0o755)
        inventory = self.inventory()
        self.assertEqual(compat.trusted_library_path(lock_for(inventory), inventory),
                         compat.COMPAT_DIRECTORY + ':' + compat.LIBRARY_DIRECTORIES[2])
        with patch.dict(os.environ, {'LD_LIBRARY_PATH': '/tmp/attacker'}):
            self.assertNotIn('/tmp/attacker', compat.trusted_library_path(lock_for(inventory), inventory))

    def test_missing_or_unreviewed_manifest_refuses_before_inspection(self):
        with patch.object(compat, 'query_package_identity') as query:
            for value in [None, {}, {'reviewed': False}]:
                with self.assertRaises(compat.CompatibilityRefused):
                    compat.verify_compatibility(value)
            query.assert_not_called()

    def test_file_drift_and_extra_file_refuse(self):
        inventory = self.inventory()
        lock = lock_for(inventory)
        self.library.chmod(0o644)
        self.library.write_bytes(b'CHANGED FAKE LIBRARY')
        self.library.chmod(0o444)
        with self.assertRaises(compat.CompatibilityRefused):
            compat.validate_inventory(lock, self.inventory())
        (self.directory / 'credentials.txt').write_text('dummy')
        with self.assertRaises(compat.CompatibilityRefused):
            self.inventory()

    def test_writable_ancestor_and_file_refuse(self):
        for path in [self.directory.parent, self.library]:
            before = stat.S_IMODE(path.stat().st_mode)
            path.chmod(before | 0o020)
            with self.assertRaises(compat.CompatibilityRefused):
                self.inventory()
            path.chmod(before)

    def test_hardlink_and_nonregular_entry_refuse(self):
        extra = self.directory / 'libcuda.so.580.2'
        os.link(self.library, extra)
        with self.assertRaises(compat.CompatibilityRefused):
            self.inventory()
        extra.unlink()
        extra.mkdir()
        with self.assertRaises(compat.CompatibilityRefused):
            self.inventory()

    def test_unreviewed_absolute_escape_and_cycle_links_refuse(self):
        link = self.directory / 'libcuda.so.1'
        for target in ['/etc/shadow', '../libcuda.so.580.1', 'libcuda.so.1']:
            link.unlink()
            link.symlink_to(target)
            with self.assertRaises(compat.CompatibilityRefused):
                self.inventory()

    def test_manifest_package_path_hash_and_boolean_version_validation(self):
        inventory = self.inventory()
        base = lock_for(inventory)
        for field, value in [('directory', '/tmp/compat'), ('sourceImage', 'image:latest'),
                             ('reviewed', False), ('version', True)]:
            lock = copy.deepcopy(base)
            lock[field] = value
            with self.assertRaises(compat.CompatibilityRefused):
                compat.validate_lock(lock)
        bad = copy.deepcopy(base)
        bad['files'][self.library.name]['sha256'] = 'unknown'
        with self.assertRaises(compat.CompatibilityRefused):
            compat.validate_lock(bad)
        bad = copy.deepcopy(inventory)
        bad['package']['version'] = '580.2-1'
        with self.assertRaises(compat.CompatibilityRefused):
            compat.validate_inventory(base, bad)

    def test_forged_inventory_loader_and_directory_metadata_refuse(self):
        inventory = self.inventory()
        lock = lock_for(inventory)
        for mutate in [
            lambda v: v['libraryDirectories'].append('/tmp/attacker'),
            lambda v: v['directories']['/usr'].update(uid=10001),
            lambda v: v['directories']['/usr'].update(mode=0o777),
            lambda v: v['directories'].pop('/usr'),
        ]:
            candidate = copy.deepcopy(inventory)
            mutate(candidate)
            with self.assertRaises(compat.CompatibilityRefused):
                compat.validate_inventory(lock, candidate)

    def test_ancestor_and_fallback_directory_symlinks_refuse(self):
        fallback = self.root / 'usr/local/nvidia'
        fallback.mkdir()
        (fallback / 'lib64').symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(compat.CompatibilityRefused):
            self.inventory()

    def test_reviewed_local_symlink_chain_is_exact(self):
        (self.directory / 'libcuda.so').symlink_to('libcuda.so.1')
        inventory = self.inventory()
        lock = lock_for(inventory)
        self.assertTrue(compat.validate_inventory(lock, inventory))
        changed = copy.deepcopy(inventory)
        changed['symlinks']['libcuda.so'] = self.library.name
        with self.assertRaises(compat.CompatibilityRefused):
            compat.validate_inventory(lock, changed)

    def test_package_query_has_fixed_command_clean_env_and_no_stderr(self):
        result = SimpleNamespace(stdout=b'cuda-compat-13-0\t580.1-1\tamd64\n')
        with patch.object(compat.subprocess, 'run', return_value=result) as run:
            self.assertEqual(compat.query_package_identity(), PACKAGE)
            self.assertEqual(run.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
            self.assertEqual(run.call_args.kwargs['stderr'], compat.subprocess.DEVNULL)
            self.assertEqual(run.call_args.args[0][-1], compat.PACKAGE_NAME)

    def test_observed_gpucomp_and_nvvm70_are_pinnable_but_no_arbitrary_variant(self):
        for name in ['libnvidia-gpucomp.so.580.95.05', 'libnvidia-nvvm70.so.4']:
            path = self.directory / name
            path.write_bytes(b'FAKE ADDITIONAL CPU TEST LIBRARY; NEVER LOAD')
            path.chmod(0o444)
        inventory = self.inventory()
        self.assertTrue(compat.validate_inventory(lock_for(inventory), inventory))
        (self.directory / 'libnvidia-nvvm71.so.4').write_bytes(b'UNREVIEWED DUMMY')
        with self.assertRaises(compat.CompatibilityRefused):
            self.inventory()

    def test_shipped_lock_is_pinned_and_validates_without_loading_libraries(self):
        lock = json.loads(Path(__file__).with_name('cuda-compat.lock.json').read_text())
        self.assertEqual(compat.validate_lock(lock), lock)
        self.assertEqual(lock['package'], {'name': 'cuda-compat-13-0',
                                         'version': '580.95.05-0ubuntu1', 'architecture': 'amd64'})
        self.assertEqual(len(lock['files']), 7)
        self.assertEqual(len(lock['symlinks']), 6)
        self.assertIn('libnvidia-gpucomp.so.580.95.05', lock['files'])
        self.assertIn('libnvidia-nvvm70.so.4', lock['files'])


if __name__ == '__main__':
    unittest.main()

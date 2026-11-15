"""Offline dummy signatures/archives; no package install, GPU or network."""
from contextlib import contextmanager
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_prepared_host as review
from test_prepared_host import NativeFixture


def tar_bytes(entries):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as archive:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return result.getvalue()


@contextmanager
def dummy_payload(archive):
    yield io.BytesIO(archive)


class BundleFixture:
    def __init__(self, native=None, include_derived=False):
        self.native = native or NativeFixture()
        self.inventory = self.native.proposal()
        self.artifacts = {'public.gpg': b'DUMMY PUBLIC KEYRING'}
        self.archives, self.rows = {}, []
        for package in self.inventory['packages']:
            entries = {entry['path'].removeprefix('/'): self.native.data[entry['path']]
                       for entry in self.inventory['files'] if entry['package'] == package['name']
                       and (entry['path'] != self.native.module or include_derived)}
            if not entries:
                entries = {'usr/src/DUMMY/nvidia.c': b'DUMMY SOURCE; NEVER EXECUTE'}
            data = tar_bytes(entries)
            filename = package['name'] + '.deb'
            digest = review._sha(data)
            self.artifacts[filename] = data
            self.archives[digest] = filename
            self.rows.append('\n'.join([f'Package: {package["name"]}',
                f'Version: {package["version"]}', f'Architecture: {package["architecture"]}',
                f'SHA256: {digest}', f'Size: {len(data)}', f'Filename: pool/{filename}']))
        self.bundle = {'version': 1, 'kind': 'prepared-host-offline-review-v1',
            'repositories': [{'id': 'dummy-ubuntu', 'repository': 'ubuntu',
                'keyring': 'public.gpg', 'keySha256': review._sha(self.artifacts['public.gpg']),
                'fingerprint': 'A' * 40, 'inRelease': 'InRelease', 'index': 'Packages',
                'signedIndexName': 'Packages', 'algorithm': 'sha256'}], 'archives': self.archives}
        self.index()

    def index(self):
        raw = ('\n\n'.join(self.rows) + '\n').encode()
        self.artifacts['Packages'] = raw
        self.artifacts['InRelease'] = (f'Origin: DUMMY\nSHA256:\n {review._sha(raw)} {len(raw)} Packages\n').encode()

    def run(self, **kwargs):
        raw = json.dumps(self.bundle, sort_keys=True, separators=(',', ':')).encode()
        return review.review_bundle(self.inventory, raw, review._sha(raw), self.artifacts.__getitem__,
            signature_verifier=kwargs.pop('signature_verifier', lambda *_: True),
            payload_reader=kwargs.pop('payload_reader', dummy_payload), **kwargs)


class OfflineReviewTests(unittest.TestCase):
    def test_ordinary_signed_payloads_pass_while_derived_module_remains_explicit_gap(self):
        f = BundleFixture()
        result = f.run()
        self.assertTrue(all(p['status'] == 'signed-package-archive-verified' for p in result['packages']))
        matches = [entry for entry in result['files'] if entry['status'] == 'signed-payload-match']
        self.assertEqual(len(matches), len(f.inventory['files']) - 1)
        self.assertEqual(result['reviewGaps'][0]['path'], f.native.module)
        self.assertIsNotNone(result['lockCandidate'])
        self.assertTrue(result['requiresSourceReview'])
        self.assertFalse(any(result[key] for key in ['approved', 'sourcePinIssued', 'modelPermitIssued',
                                                    'cudaValidated', 'modelLoaded', 'agentToolsEnabled']))

    def test_precompiled_module_compressed_file_bytes_match_without_decompression(self):
        native = NativeFixture()
        previous = native.module
        native.module += '.zst'
        native.data[native.module] = b'DUMMY ZSTD MODULE BYTES; NEVER LOAD'
        native.details[native.module] = {'path': native.module, 'uid': 0, 'mode': 0o644,
                                        'size': len(native.data[native.module]), 'regular': True}
        del native.data[previous], native.details[previous]
        package = 'linux-modules-nvidia-570-' + native.kernel
        native.package_versions[package] = '1.0-dummy'
        native.package_files[package] = [native.module]
        f = BundleFixture(native, include_derived=True)
        result = f.run()
        module = next(entry for entry in result['files'] if entry['path'] == native.module)
        self.assertEqual(module['status'], 'signed-payload-match')
        self.assertEqual(result['reviewGaps'], [])

    def test_actual_regular_file_hash_mismatch_blocks_candidate_but_keeps_package_evidence(self):
        f = BundleFixture()
        entry = next(value for value in f.inventory['files'] if '/libcuda.so' in value['path'])
        entry['sha256'] = 'c' * 64
        result = f.run()
        self.assertIsNone(result['lockCandidate'])
        self.assertTrue(all(p['status'] == 'signed-package-archive-verified' for p in result['packages']))
        self.assertIn('signed-payload-mismatch', [value['status'] for value in result['files']])

    def test_missing_exact_package_retains_other_verified_provenance_without_candidate(self):
        f = BundleFixture()
        f.rows = [row for row in f.rows if not row.startswith('Package: coreutils\n')]
        f.index()
        result = f.run()
        self.assertIsNone(result['lockCandidate'])
        self.assertEqual(result['packages'][0]['status'], 'exact-package-not-in-authenticated-index')
        self.assertTrue(all(p['status'] == 'signed-package-archive-verified' for p in result['packages'][1:]))

    def test_archive_tampering_never_reaches_payload_decoder(self):
        f = BundleFixture()
        filename = f.bundle['archives'][next(iter(f.bundle['archives']))]
        f.artifacts[filename] += b'TAMPERED DUMMY'
        seen = []
        @contextmanager
        def decode(archive):
            seen.append(archive)
            yield io.BytesIO(archive)
        result = f.run(payload_reader=decode)
        self.assertIsNone(result['lockCandidate'])
        self.assertNotIn(f.artifacts[filename], seen)
        self.assertIn('authenticated-archive-hash-mismatch', [value['status'] for value in result['packages']])

    def test_key_signature_and_index_tampering_refuse_before_any_payload(self):
        for mode in ['key', 'signature', 'index']:
            f = BundleFixture()
            verifier = lambda *_: mode != 'signature'
            if mode == 'key':
                f.artifacts['public.gpg'] = b'UNREVIEWED DUMMY KEY'
            if mode == 'index':
                f.artifacts['Packages'] += b'\nPackage: tampered\n'
            calls = []
            @contextmanager
            def decoder(archive):
                calls.append(archive)
                yield io.BytesIO(archive)
            with self.subTest(mode=mode):
                with self.assertRaises(review.ReviewRefused):
                    f.run(signature_verifier=verifier, payload_reader=decoder)
                self.assertEqual(calls, [])

    def test_manifest_must_be_separately_pinned_and_rejects_unsafe_artifact_paths(self):
        f = BundleFixture()
        raw = json.dumps(f.bundle).encode()
        with self.assertRaises(review.ReviewRefused):
            review.bundle_from(raw, 'b' * 64)
        f.bundle['repositories'][0]['keyring'] = '../DUMMY_PRIVATE_KEY'
        raw = json.dumps(f.bundle).encode()
        with self.assertRaises(review.ReviewRefused):
            review.bundle_from(raw, review._sha(raw))
        raw = b'{"version":1,"version":1}'
        with self.assertRaises(review.ReviewRefused):
            review.bundle_from(raw, review._sha(raw))

    def test_unsafe_tar_path_refuses_and_nothing_is_extracted(self):
        data = tar_bytes({'../../DUMMY_PRIVATE': b'DUMMY'})
        with self.assertRaises(review.ReviewRefused):
            review.compare_payload(io.BytesIO(data), [])

    def test_usrmerge_payload_alias_maps_to_exact_installed_regular_bytes(self):
        data = b'DUMMY BASH PAYLOAD'
        result = review.compare_payload(io.BytesIO(tar_bytes({'bin/bash': data})),
            [{'path': '/usr/bin/bash', 'size': len(data), 'sha256': review._sha(data)}])
        self.assertEqual(result['/usr/bin/bash']['status'], 'signed-payload-match')

    def test_gpgv_uses_pinned_keyring_isolated_home_and_clean_environment(self):
        result = SimpleNamespace(returncode=0, stdout=('[GNUPG:] VALIDSIG ' + 'B' * 40
            + ' 2026-01-01 0 0 4 0 1 10 00 ' + 'A' * 40 + '\n').encode())
        with patch.object(review.subprocess, 'run', return_value=result) as run:
            self.assertTrue(review.verify_signature(b'DUMMY SIGNATURE', b'DUMMY KEY', 'A' * 40))
            command = run.call_args.args[0]
            self.assertEqual(command[0], '/usr/bin/gpgv')
            self.assertIn('--homedir', command)
            self.assertIn('--keyring', command)
            self.assertEqual(run.call_args.kwargs['env'], review.ENV)
            self.assertEqual(run.call_args.kwargs['stderr'], review.subprocess.DEVNULL)
        with patch.object(review.subprocess, 'run', return_value=result):
            with self.assertRaises(review.ReviewRefused):
                review.verify_signature(b'DUMMY SIGNATURE', b'DUMMY KEY', 'C' * 40)

    @unittest.skipUnless(Path('/usr/bin/dpkg-deb').is_file(), 'Trusted Ubuntu dpkg-deb required')
    def test_actual_dpkg_deb_parser_reads_payload_without_running_maintainer_script(self):
        data = b'DUMMY CPU PAYLOAD; NEVER EXECUTE'
        members = {'debian-binary': b'2.0\n', 'control.tar.gz': tar_bytes({
            'control': b'Package: dummy\nVersion: 1\nArchitecture: amd64\nMaintainer: Dummy\nDescription: CPU fixture\n',
            'postinst': b'#!/bin/sh\nexit 99\n'}),
            'data.tar.gz': tar_bytes({'usr/bin/bash': data})}
        archive = bytearray(b'!<arch>\n')
        for name, payload in members.items():
            header = ((name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6)
                      + '0'.ljust(6) + '100644'.ljust(8) + str(len(payload)).ljust(10) + '`\n')
            archive.extend(header.encode() + payload + (b'\n' if len(payload) % 2 else b''))
        with review.deb_payload(bytes(archive)) as stream:
            result = review.compare_payload(stream, [{'path': '/usr/bin/bash',
                'size': len(data), 'sha256': review._sha(data)}])
        self.assertEqual(result['/usr/bin/bash']['status'], 'signed-payload-match')


if __name__ == '__main__':
    unittest.main()

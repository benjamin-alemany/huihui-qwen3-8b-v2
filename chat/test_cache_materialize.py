"""Build-time downloader with dummy byte streams; never downloads weights."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
import cache_materialize as build
import offline_cache


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.destination = Path(self.tmp.name)/'cache'
        self.data = {n: b'{}' for n in ('config.json', 'tokenizer.json', 'tokenizer_config.json')}
        self.data['model.safetensors.index.json'] = json.dumps({'weight_map': {'dummy': 'model-1.safetensors'}}).encode()
        self.data['model-1.safetensors'] = b'DUMMY_NOT_WEIGHTS'
        self.manifest = {'model': offline_cache.MODEL, 'revision': offline_cache.REVISION,
                         'files': {n: {'size': len(b), 'algorithm': 'sha256', 'digest': hashlib.sha256(b).hexdigest()} for n,b in self.data.items()}}
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def opener(self, changed=None):
        outer = self
        class Dummy:
            def open(self, request, timeout):
                outer.calls.append(request.full_url)
                name = request.full_url.rsplit('/', 1)[1]
                data = (changed or {}).get(name, outer.data[name])
                stream = io.BytesIO(data);stream.status = 200
                return stream
        return Dummy()

    def test_verified_read_only_dummy_cache_and_pinned_urls(self):
        build.materialize(self.destination, self.manifest, self.opener())
        offline_cache.verify_files(self.destination, self.manifest, owner_uid=os.getuid())
        self.assertTrue(all('/resolve/'+offline_cache.REVISION+'/' in url for url in self.calls))
        self.assertTrue(all(p.stat().st_mode & 0o222 == 0 for p in self.destination.iterdir()))

    def test_tamper_truncation_and_oversize_remove_partial_cache(self):
        for data in (b'xx', b'{', b'{}EXTRA'):
            with self.assertRaises(offline_cache.CacheError):
                build.materialize(self.destination, self.manifest, self.opener({'config.json': data}))
            self.assertFalse(self.destination.exists())

    def test_existing_destination_never_overwritten(self):
        self.destination.mkdir();(self.destination/'DUMMY-project').write_text('keep')
        with self.assertRaises(FileExistsError):build.materialize(self.destination, self.manifest, self.opener())
        self.assertEqual((self.destination/'DUMMY-project').read_text(), 'keep')
        self.assertEqual(self.calls, [])

    def test_invalid_identity_or_traversal_never_creates_files_or_requests(self):
        for change in ('identity', 'path'):
            manifest = copy.deepcopy(self.manifest)
            if change == 'identity':manifest['revision'] = '0'*40
            else:manifest['files']['../DUMMY'] = manifest['files'].pop('config.json')
            with self.assertRaises(offline_cache.CacheError):build.materialize(self.destination, manifest, self.opener())
            self.assertFalse(self.destination.exists());self.assertEqual(self.calls, [])

    def test_redirect_policy_refuses_non_https_unrelated_or_credential_urls(self):
        policy = build.RedirectPolicy();request = urllib.request.Request('https://huggingface.co/DUMMY')
        for url in ('http://huggingface.co/DUMMY', 'https://dummy.invalid/DUMMY',
                    'https://huggingface.co.dummy.invalid/DUMMY', 'https://user:pass@huggingface.co/DUMMY'):
            with self.assertRaises(offline_cache.CacheError):policy.redirect_request(request, None, 302, '', {}, url)
        self.assertEqual(policy.redirect_request(request, None, 302, '', {}, 'https://cas-bridge.xethub.hf.co/DUMMY').full_url,
                         'https://cas-bridge.xethub.hf.co/DUMMY')


if __name__ == '__main__':unittest.main()

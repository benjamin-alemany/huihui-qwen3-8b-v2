"""Explicit build-time cache preparation; never imported by serving startup.

Requires separate owner approval before invocation. No Hugging Face library,
tokens, cookies, proxies, retries, model execution, upload or image publication.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import urllib.parse
import urllib.request

import credential_boundary
import offline_cache


class RedirectPolicy(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        target = urllib.parse.urlsplit(url)
        host = target.hostname or ''
        if (target.scheme != 'https' or target.username or target.password or target.port not in (None, 443)
                or not any(host == suffix or host.endswith('.'+suffix) for suffix in ('huggingface.co', 'hf.co'))):
            raise offline_cache.CacheError('Unapproved artifact redirect')
        return super().redirect_request(request, fp, code, message, headers, url)


def materialize(destination, manifest, opener=None):
    credential_boundary.check_names(os.environ)
    if (set(manifest) != {'model', 'revision', 'files'} or manifest['model'] != offline_cache.MODEL
            or manifest['revision'] != offline_cache.REVISION):
        raise offline_cache.CacheError('Wrong checkpoint identity')
    files = offline_cache.manifest_files(manifest)  # Validate paths BEFORE writes.
    destination = Path(destination)
    parent = destination.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise offline_cache.CacheError('Private build directory required')
    destination.mkdir(mode=0o700)  # Exclusive: never overwrite/reuse an old cache.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), RedirectPolicy())
    try:
        for name, item in files.items():
            url = f'https://huggingface.co/{offline_cache.MODEL}/resolve/{offline_cache.REVISION}/{name}'
            request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'unjailed-offline-build/1'})
            with opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise offline_cache.CacheError('Unexpected artifact response')
                remaining = item['size']
                with (destination/name).open('xb') as stream:
                    while remaining:
                        block = response.read(min(1024*1024, remaining))
                        if not block:
                            raise offline_cache.CacheError('Truncated artifact')
                        stream.write(block); remaining -= len(block)
                    if response.read(1):
                        raise offline_cache.CacheError('Oversized artifact')
                (destination/name).chmod(0o444)
        offline_cache.verify_files(destination, manifest, owner_uid=os.getuid())
        return destination
    except BaseException:
        shutil.rmtree(destination)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved-revision', required=True, choices=[offline_cache.REVISION])
    args = parser.parse_args()
    try:
        manifest = json.loads(Path(__file__).with_name('model-manifest.json').read_text())
        destination = Path(__file__).resolve().parent/'model-cache'
        materialize(destination, manifest)
        print('Pinned offline cache prepared and verified; no image published.')
    except Exception:
        # Signed redirect URLs and underlying HTTP errors can contain tokens.
        raise SystemExit('Cache preparation failed; no serving artifact is approved.') from None

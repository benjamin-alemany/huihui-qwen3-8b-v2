"""Review a prepared-host inventory against an offline signed-package bundle.

No downloads, installation, maintainer scripts, cloud calls or model imports.
Run this on a trusted CPU machine. A separate reviewed fetch step supplies public
InRelease, Packages, keyrings and .deb files. The exact bundle manifest hash is
an operator/source-review input, never learned from the observed VM. Output is
evidence and a lock CANDIDATE, not approval, a model permit or a source pin.
"""
import argparse
from contextlib import contextmanager
import gzip
import hashlib
import io
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import resource
import stat
import subprocess
import tarfile
import tempfile

from metadata import records, verify_index
from prepared_host import canonical_inventory

MAX_METADATA = 256 * 1024 * 1024
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_TAR = 2 * 1024 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{64}')
FINGERPRINT = re.compile(r'[A-F0-9]{40}')
BASENAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.+-]{0,199}')
REPOSITORIES = {'ubuntu', 'nvidia-cuda', 'nvidia-toolkit', 'docker'}
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


class ReviewRefused(ValueError):
    pass


def _refuse(message):
    raise ReviewRefused(message)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _refuse('Duplicate review-bundle field')
        value[key] = item
    return value


def bundle_from(raw, expected_sha256):
    """Require the separately source-reviewed descriptor bytes and key pins."""
    if (not isinstance(raw, bytes) or not 0 < len(raw) <= 256 * 1024
            or not isinstance(expected_sha256, str) or not HEX.fullmatch(expected_sha256)
            or expected_sha256 == '0' * 64 or _sha(raw) != expected_sha256):
        _refuse('Source-reviewed repository bundle manifest required')
    try:
        bundle = json.loads(raw.decode('ascii'), object_pairs_hook=_unique,
                            parse_constant=lambda _: _refuse('Invalid bundle constant'))
    except (UnicodeError, ValueError):
        _refuse('Invalid repository review bundle')
    if (not isinstance(bundle, dict) or set(bundle) != {'version', 'kind', 'repositories', 'archives'}
            or type(bundle['version']) is not int or bundle['version'] != 1
            or bundle['kind'] != 'prepared-host-offline-review-v1'
            or not isinstance(bundle['repositories'], list)
            or not 1 <= len(bundle['repositories']) <= 32
            or not isinstance(bundle['archives'], dict) or len(bundle['archives']) > 96):
        _refuse('Invalid repository review bundle')
    identifiers = set()
    for repo in bundle['repositories']:
        if (not isinstance(repo, dict) or set(repo) != {'id', 'repository', 'keyring', 'keySha256',
                'fingerprint', 'inRelease', 'index', 'signedIndexName', 'algorithm'}
                or any(not isinstance(value, str) for value in repo.values())
                or not BASENAME.fullmatch(repo['id']) or repo['id'] in identifiers
                or repo['repository'] not in REPOSITORIES
                or any(not BASENAME.fullmatch(repo[key]) for key in ['keyring', 'inRelease', 'index'])
                or not HEX.fullmatch(repo['keySha256']) or repo['keySha256'] == '0' * 64
                or not FINGERPRINT.fullmatch(repo['fingerprint']) or repo['fingerprint'] == '0' * 40
                or repo['algorithm'] not in {'sha256', 'sha512'}
                or not re.fullmatch(r'(?:[A-Za-z0-9_+-]+/)*Packages(?:\.(?:gz|xz))?', repo['signedIndexName'])):
            _refuse('Unreviewed repository descriptor')
        identifiers.add(repo['id'])
    for digest, filename in bundle['archives'].items():
        if (not isinstance(digest, str) or not HEX.fullmatch(digest) or digest == '0' * 64
                or not isinstance(filename, str) or not BASENAME.fullmatch(filename)
                or not filename.endswith('.deb')):
            _refuse('Invalid local archive mapping')
    return bundle


def verify_signature(release, keyring, fingerprint):
    """Use only the pinned public keyring; never the operator's GPG homedir."""
    with tempfile.TemporaryDirectory(prefix='unjailed-package-signature-') as directory:
        root = Path(directory)
        (root / 'archive.gpg').write_bytes(keyring)
        (root / 'InRelease').write_bytes(release)
        try:
            result = subprocess.run(['/usr/bin/gpgv', '--homedir', directory, '--status-fd', '1',
                '--keyring', str(root / 'archive.gpg'), str(root / 'InRelease')], env=ENV,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=20, check=False)
        except (OSError, subprocess.SubprocessError):
            _refuse('Pinned repository signature unavailable')
        if result.returncode or len(result.stdout) > 65536:
            _refuse('Pinned repository signature refused')
        try:
            signatures = [line.split() for line in result.stdout.decode('ascii').splitlines()
                          if line.startswith('[GNUPG:] VALIDSIG ')]
        except UnicodeError:
            _refuse('Pinned repository signature refused')
        if not any(fingerprint in (row[2], row[-1]) for row in signatures if len(row) >= 3):
            _refuse('Pinned repository signer mismatch')
    return True


def _expanded_index(raw, name):
    if name.endswith('.gz'):
        stream = gzip.GzipFile(fileobj=io.BytesIO(raw))
    elif name.endswith('.xz'):
        stream = lzma.LZMAFile(io.BytesIO(raw))
    else:
        stream = io.BytesIO(raw)
    with stream:
        result = stream.read(MAX_METADATA + 1)
    if len(result) > MAX_METADATA:
        _refuse('Expanded authenticated index exceeds bound')
    return records(result)


def _read(reader, name, maximum):
    try:
        result = reader(name)
    except Exception:
        _refuse('Local review artifact unavailable')
    if not isinstance(result, bytes) or not 0 < len(result) <= maximum:
        _refuse('Local review artifact exceeds bound')
    return result


def _archive_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TAR, MAX_TAR))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


@contextmanager
def deb_payload(archive):
    """Decode an already authenticated .deb to a bounded temporary tar.

    dpkg-deb --fsys-tarfile supports Ubuntu zstd payloads. It reads the archive;
    it does not install/extract files or execute maintainer scripts. The output
    size/time are bounded, and inherited credentials are removed from its env.
    """
    with tempfile.TemporaryDirectory(prefix='unjailed-authenticated-deb-') as directory:
        path = Path(directory) / 'package.deb'
        path.write_bytes(archive)
        with tempfile.TemporaryFile(dir=directory) as output:
            try:
                completed = subprocess.run(['/usr/bin/dpkg-deb', '--fsys-tarfile', str(path)],
                    env=ENV, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                    timeout=90, check=False, preexec_fn=_archive_limits)
            except (OSError, subprocess.SubprocessError):
                _refuse('Authenticated archive decoding refused')
            if completed.returncode or not 0 < output.tell() <= MAX_TAR:
                _refuse('Authenticated archive decoding refused')
            output.seek(0)
            yield output


def _payload_path(name):
    while name.startswith('./'):
        name = name[2:]
    if not name or name.startswith('/') or '..' in PurePosixPath(name).parts:
        _refuse('Unsafe authenticated archive member')
    result = '/' + str(PurePosixPath(name))
    if result.startswith(('/bin/', '/sbin/', '/lib/')):
        result = '/usr' + result
    return result


def compare_payload(stream, expected):
    """Hash selected regular payloads without extracting any archive member."""
    wanted = {entry['path']: entry for entry in expected}
    observed, count, total = {}, 0, 0
    try:
        with tarfile.open(fileobj=stream, mode='r|*') as archive:
            for member in archive:
                count += 1
                if count > 200000 or member.size < 0:
                    _refuse('Authenticated archive member bound exceeded')
                if member.isdir() and member.name in {'.', './'}:
                    continue
                path = _payload_path(member.name)
                if member.isreg():
                    total += member.size
                    if total > MAX_TAR:
                        _refuse('Authenticated archive payload bound exceeded')
                if path not in wanted:
                    continue
                if path in observed:
                    _refuse('Ambiguous authenticated payload path')
                if not member.isreg() or member.issparse() or member.size > 256 * 1024 * 1024:
                    observed[path] = {'status': 'not-a-regular-signed-payload'}
                    continue
                digest, size = hashlib.sha256(), 0
                payload = archive.extractfile(member)  # Read only; never extract to disk.
                with payload:
                    while chunk := payload.read(1024 * 1024):
                        size += len(chunk)
                        digest.update(chunk)
                actual = {'size': size, 'sha256': digest.hexdigest()}
                match = all(actual[key] == wanted[path][key] for key in actual)
                observed[path] = {'status': 'signed-payload-match' if match else 'signed-payload-mismatch',
                                  **actual}
    except (tarfile.TarError, OSError, EOFError):
        _refuse('Authenticated archive payload refused')
    return observed


def _derived_module(entry, kernel):
    return (bool(re.fullmatch(r'nvidia-(?:dkms|kernel-source)-570(?:-server)?(?:-open)?', entry['package']))
            and bool(re.fullmatch(r'/usr/lib/modules/' + re.escape(kernel)
                    + r'/updates/dkms/nvidia\.ko(?:\.(?:xz|zst|gz))?', entry['path'])))


def review_bundle(inventory, manifest_bytes, expected_manifest_sha256, reader, *,
                  signature_verifier=verify_signature, payload_reader=deb_payload):
    """Return independently checked package/file evidence, never approval.

    Derived DKMS outputs are an explicit review gap, not a fake archive match or
    a new demand for reproducible compilation. A candidate may retain that gap
    for separate source review of provider-image/module trust. Ordinary payload
    mismatches or missing authenticated packages prevent a lock candidate.
    """
    inventory = json.loads(canonical_inventory(inventory))
    bundle = bundle_from(manifest_bytes, expected_manifest_sha256)
    authenticated, repository_evidence = [], []
    for repo in bundle['repositories']:
        keyring = _read(reader, repo['keyring'], 1024 * 1024)
        if _sha(keyring) != repo['keySha256']:
            _refuse('Pinned repository key bytes changed')
        release = _read(reader, repo['inRelease'], 512 * 1024)
        index = _read(reader, repo['index'], 64 * 1024 * 1024)
        if signature_verifier(release, keyring, repo['fingerprint']) is not True:
            _refuse('Pinned repository signature refused')
        try:
            verify_index(release, index, repo['signedIndexName'], repo['algorithm'])
            available = _expanded_index(index, repo['signedIndexName'])
        except Exception:
            _refuse('Authenticated package index refused')
        authenticated.append((repo, available, _sha(index)))
        repository_evidence.append({'id': repo['id'], 'repository': repo['repository'],
            'inReleaseSha256': _sha(release), 'signedIndexSha256': _sha(index),
            'signingKeyFingerprint': repo['fingerprint']})
    proofs, packages, files, gaps = [], [], [], []
    blocked = False
    for package in inventory['packages']:
        expected = [entry for entry in inventory['files'] if entry['package'] == package['name']]
        hits = [(repo, row, index_hash) for repo, rows, index_hash in authenticated for row in rows
                if all(row.get(field) == package[key] for field, key in
                       [('Package', 'name'), ('Version', 'version'), ('Architecture', 'architecture')])]
        identities = {(row.get('SHA256'), row.get('Size')) for _, row, _ in hits}
        reason = None
        if not hits:
            reason = 'exact-package-not-in-authenticated-index'
        elif len(identities) != 1:
            reason = 'ambiguous-authenticated-package'
        else:
            repo, row, index_hash = hits[0]
            digest, size = row.get('SHA256'), row.get('Size')
            if (not isinstance(digest, str) or not HEX.fullmatch(digest) or digest == '0' * 64
                    or not isinstance(size, str) or not re.fullmatch('[0-9]+', size)
                    or not 0 < int(size) <= MAX_ARCHIVE or digest not in bundle['archives']):
                reason = 'authenticated-archive-unavailable'
        if reason:
            blocked = True
            packages.append({**package, 'status': reason})
            files.extend({'path': entry['path'], 'package': package['name'], 'status': 'package-unverified'}
                         for entry in expected)
            continue
        archive = _read(reader, bundle['archives'][digest], MAX_ARCHIVE)
        if len(archive) != int(size) or _sha(archive) != digest:
            blocked = True
            packages.append({**package, 'status': 'authenticated-archive-hash-mismatch'})
            files.extend({'path': entry['path'], 'package': package['name'], 'status': 'package-unverified'}
                         for entry in expected)
            continue
        proof = {**package, 'repository': repo['repository'], 'archiveSha256': digest,
                 'signedIndexSha256': index_hash, 'signingKeyFingerprint': repo['fingerprint']}
        proofs.append(proof)
        packages.append({**package, 'status': 'signed-package-archive-verified'})
        try:
            with payload_reader(archive) as stream:
                observed = compare_payload(stream, expected)
        except Exception:
            observed = {}
            blocked = True
            files.extend({'path': entry['path'], 'package': package['name'],
                          'status': 'authenticated-archive-decoding-failed'} for entry in expected)
            continue
        for entry in expected:
            result = observed.get(entry['path'])
            if result is None and _derived_module(entry, inventory['kernelRelease']):
                result = {'status': 'derived-dkms-output-requires-provider-trust-review'}
                gaps.append({'path': entry['path'], 'package': entry['package'],
                    'sha256': entry['sha256'], 'size': entry['size'],
                    'kind': 'generated-module-not-a-signed-archive-payload'})
            elif result is None:
                result = {'status': 'file-absent-from-authenticated-archive'}
                blocked = True
            elif result['status'] != 'signed-payload-match':
                blocked = True
            files.append({'path': entry['path'], 'package': entry['package'], **result})
    candidate = None if blocked else {'version': 1, 'kind': 'reviewed-prepared-host-lock',
                                     'inventory': inventory, 'provenance': proofs}
    return {'version': 1, 'kind': 'prepared-host-provenance-review-evidence',
            'bundleManifestSha256': expected_manifest_sha256, 'repositories': repository_evidence,
            'packages': packages, 'files': files,
            'reviewGaps': gaps, 'lockCandidate': candidate, 'requiresSourceReview': True,
            'approved': False, 'sourcePinIssued': False, 'modelPermitIssued': False,
            'cudaValidated': False, 'modelLoaded': False, 'agentToolsEnabled': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', required=True, type=Path)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    base = args.bundle.parent
    def read(name):
        if not BASENAME.fullmatch(name):
            _refuse('Unsafe local review filename')
        path = base / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARCHIVE:
            _refuse('Local review artifact refused')
        return path.read_bytes()
    raw_inventory = args.inventory.read_bytes()
    if len(raw_inventory) > 256 * 1024:
        _refuse('Inventory exceeds review bound')
    result = review_bundle(json.loads(raw_inventory, object_pairs_hook=_unique),
                           args.bundle.read_bytes(), args.manifest_sha256, read)
    print(json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Offline signed-package review refused; no approval or model permit')

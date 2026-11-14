"""Manual free CPU check; validate a locked daemon config without starting it.

Only the public lock-selected Docker package is downloaded. Its bytes are
verified before reading its binary and systemd units; nothing is installed.
The executable runs only with --validate in an empty network namespace.
"""
import argparse
import configparser
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
OFFICIAL_BASE = 'https://download.docker.com/linux/ubuntu/'
WANTED = {
    'usr/bin/dockerd': 150 * 1024 * 1024,
    'usr/lib/systemd/system/docker.service': 32768,
    'usr/lib/systemd/system/docker.socket': 16384,
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Package redirects are refused')


def package_spec(lock):
    packages = [p for p in lock['packages'] if p['name'] == 'docker-ce']
    require(len(packages) == 1, 'Expected one locked Docker CE package')
    p = packages[0]
    require(p['repository'] == 'docker' and p['architecture'] == 'amd64', 'Wrong package target')
    require(lock['repositories']['docker']['base'] == OFFICIAL_BASE, 'Unofficial package origin')
    require(re.fullmatch(r'dists/noble/pool/stable/amd64/docker-ce_[A-Za-z0-9.+~_-]+_amd64[.]deb', p['filename']), 'Unexpected package path')
    require(re.fullmatch(r'[0-9a-f]{64}', p['sha256']), 'Invalid locked digest')
    require(isinstance(p['size'], int) and 0 < p['size'] <= 64 * 1024 * 1024, 'Invalid package size')
    require(isinstance(p['version'], str) and p['version'], 'Missing package version')
    return p


def fetch_package(p):
    url = OFFICIAL_BASE + p['filename']
    require(urllib.parse.urlsplit(url).netloc == 'download.docker.com', 'Wrong package host')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=45) as response:
        require(response.status == 200, 'Package GET did not succeed')
        data = response.read(p['size'] + 1)
    require(len(data) == p['size'], 'Locked package byte count mismatch')
    require(hashlib.sha256(data).hexdigest() == p['sha256'], 'Locked package digest mismatch')
    return data


def package_files(data):
    require(data.startswith(b'!<arch>\n'), 'Invalid Debian archive')
    offset = 8
    payload = None
    while offset < len(data):
        header = data[offset:offset + 60]
        require(len(header) == 60 and header[58:60] == b'`\n', 'Invalid archive header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58].decode('ascii').strip())
        start = offset + 60
        require(0 <= size <= len(data) - start, 'Invalid archive member size')
        if name.startswith('data.tar'):
            require(payload is None, 'Duplicate package data')
            payload = data[start:start + size]
        offset = start + size + (size % 2)
    require(payload is not None and offset == len(data), 'Incomplete Debian archive')
    found = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:*') as archive:
        for member in archive:
            # Never extract paths, links, ownership or other package payloads.
            name = member.name[2:] if member.name.startswith('./') else member.name
            if name not in WANTED:
                continue
            require(name not in found and member.isfile(), 'Duplicate or nonregular required package member')
            require(0 < member.size <= WANTED[name], 'Required package member too large')
            source = archive.extractfile(member)
            require(source is not None, 'Required package member unavailable')
            found[name] = source.read(WANTED[name] + 1)
            require(len(found[name]) == member.size, 'Required package member truncated')
    require(set(found) == set(WANTED), 'Required binary/systemd units missing')
    require(found['usr/bin/dockerd'].startswith(b'\x7fELF'), 'Expected a Linux executable')
    return found


def systemd_arguments(files):
    service = configparser.ConfigParser(interpolation=None, strict=True)
    service.read_string(files['usr/lib/systemd/system/docker.service'].decode('utf-8'))
    command = shlex.split(service['Service']['ExecStart'])
    require(command == ['/usr/bin/dockerd', '-H', 'fd://', '--containerd=/run/containerd/containerd.sock'], 'Unexpected packaged Docker service arguments')
    require('docker.socket' in service['Unit']['Requires'].split(), 'Packaged service must require its Unix socket')
    socket = configparser.ConfigParser(interpolation=None, strict=True)
    socket.read_string(files['usr/lib/systemd/system/docker.socket'].decode('utf-8'))
    require(dict(socket['Socket']) == {
        'listenstream': '/run/docker.sock', 'socketmode': '0660',
        'socketuser': 'root', 'socketgroup': 'docker',
    }, 'Packaged socket must expose only the protected Unix socket')
    return command[1:]


def validate(binary, arguments, config):
    # --validate must remain unconditional: this program never launches a daemon.
    command = [
        '/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=' + ENV['PATH'], 'LC_ALL=C',
        '/usr/bin/timeout', '--signal=KILL', '10s', '/usr/bin/unshare', '--net', '--',
        str(binary), *arguments, '--validate', '--config-file=' + str(config),
    ]
    return subprocess.run(command, env=ENV, capture_output=True, text=True, timeout=15, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    require(args.verify, 'Explicit --verify is required')
    require(os.uname().sysname == 'Linux' and os.uname().machine == 'x86_64', 'Ubuntu amd64 CPU runner required')
    spec = package_spec(json.loads((HERE / 'packages.lock.json').read_text()))
    files = package_files(fetch_package(spec))
    arguments = systemd_arguments(files)
    current = json.loads((HERE / 'daemon.json').read_text())
    require(isinstance(current, dict) and 'hosts' not in current, 'Current config must use only packaged Unix socket activation')
    with tempfile.TemporaryDirectory(prefix='unjailed-dockerd-validate-') as temporary:
        work = Path(temporary)
        binary = work / 'dockerd'
        binary.write_bytes(files['usr/bin/dockerd'])
        binary.chmod(0o700)
        positive = work / 'positive.json'
        positive.write_text(json.dumps(current))
        result = validate(binary, arguments, positive)
        require(result.returncode == 0, 'Locked Docker rejected the current config: ' + (result.stdout + result.stderr)[:2000])
        negative = work / 'duplicate-hosts.json'
        negative.write_text(json.dumps({**current, 'hosts': ['unix:///var/run/docker.sock']}))
        result = validate(binary, arguments, negative)
        detail = result.stdout + result.stderr
        require(result.returncode != 0 and 'hosts' in detail and 'specified both as a flag and in the configuration file' in detail, 'Negative fixture must fail specifically for duplicate hosts: ' + detail[:2000])
    print(json.dumps({
        'result': 'passed', 'version': spec['version'], 'packageSha256': spec['sha256'],
        'packageBytes': spec['size'], 'systemdArguments': arguments,
        'socket': '/run/docker.sock', 'socketMode': '0660', 'socketOwner': 'root:docker',
        'currentConfigValid': True, 'duplicateHostsRejected': True,
        'daemonStarted': False, 'networkNamespace': 'isolated',
    }, sort_keys=True))


if __name__ == '__main__':
    main()

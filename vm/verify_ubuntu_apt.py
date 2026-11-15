"""Free Ubuntu24 metadata/APT diagnostic; never install vendor packages or a model.

Run only in the disposable pinned official Ubuntu container. Public source is
read-only, no host sockets/keys are mounted, and the caller bounds its lifetime.
Official source/URL checks are not an external egress firewall claim.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bootstrap
import metadata


def event(name, **fields):
    print(json.dumps({'event': name, **fields}, sort_keys=True), flush=True)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class MetadataDeadline(Exception):
    pass


def safe_code(error):
    if isinstance(error, MetadataDeadline):
        return 'METADATA_TOTAL_TIMEOUT'
    if isinstance(error, subprocess.TimeoutExpired):
        return 'COMMAND_TOTAL_TIMEOUT'
    return re.sub('[^A-Z0-9_]', '_', type(error).__name__.upper())[:100]


def command(arguments, seconds):
    """Same clean environment/deadline, but retain bounded public APT errors."""
    process = subprocess.Popen(arguments, env=bootstrap.ENV, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True)
    try:
        try:
            output, _ = process.communicate(timeout=seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output, _ = process.communicate(timeout=2)
            event('command_timeout', command=arguments[0], publicOutput=output[-16384:].decode('utf-8', 'replace'))
            raise
        require(len(output) <= 2 * 1024 * 1024, 'Public APT output exceeded bound')
        if process.returncode:
            event('command_failed', command=arguments[0], exitCode=process.returncode,
                  publicOutput=output[-16384:].decode('utf-8', 'replace'))
            raise RuntimeError('Authenticated APT command failed')
        return output
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.communicate(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    require(args.verify, 'Explicit --verify required')
    require(os.geteuid() == 0 and sys.platform == 'linux', 'Disposable root Linux container required')
    release = Path('/etc/os-release').read_text()
    require(re.search(r'^ID=ubuntu$', release, re.M) and re.search(r'^VERSION_ID="24\.04"$', release, re.M), 'Expected Ubuntu24.04')
    require(not Path('/var/run/docker.sock').exists() and not Path('/run/docker.sock').exists(), 'Host control socket must not be mounted')
    require(set(os.environ) <= {'PATH', 'LC_ALL', 'DEBIAN_FRONTEND'}, 'Unexpected inherited environment')
    lock = json.loads((HERE / 'packages.lock.json').read_text())
    require(set(lock['repositories']) == {'cuda', 'toolkit', 'docker'} and len(lock['packages']) == 20, 'Expected reviewed20-package lock')
    approved = {
        'cuda': ('https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/', None),
        'toolkit': ('https://nvidia.github.io/libnvidia-container/stable/deb/amd64/', None),
        'docker': ('https://download.docker.com/linux/ubuntu/', 'https://download.docker.com/linux/ubuntu/dists/noble/'),
    }
    for name, repo in lock['repositories'].items():
        require((repo['base'], repo.get('release_base')) == approved[name], 'Unreviewed metadata source')
    bootstrap.validate_apt_sources()
    started = time.monotonic()
    event('preflight_start', distro='ubuntu24.04-amd64', lockSha256=hashlib.sha256((HERE / 'packages.lock.json').read_bytes()).hexdigest(),
          metadataSha256=hashlib.sha256((HERE / 'metadata.py').read_bytes()).hexdigest(), agentToolsEnabled=False)
    phases = {}
    def report(phase, status):
        require(phase in {'metadata-cuda', 'metadata-toolkit', 'metadata-docker'} and status in {'running', 'passed'}, 'Unexpected metadata event')
        if status == 'running':
            phases[phase] = time.monotonic()
        event('metadata_progress', phase=phase, status=status,
              elapsedSeconds=round(time.monotonic() - phases[phase], 3))
    def deadline(*unused):
        raise MetadataDeadline()
    previous = signal.signal(signal.SIGALRM, deadline)
    signal.alarm(120)
    try:
        proofs = metadata.verify(lock, report=report)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)
    event('vendor_metadata_passed', proofs=proofs, elapsedSeconds=round(time.monotonic() - started, 3))
    bootstrap.apt_sources(lock)
    bootstrap.validate_apt_sources()
    # Inputs are the exact native bootstrap APT arguments; diagnostic capture
    # retains public stderr rather than discarding it as the native runner does.
    arguments = bootstrap.apt_refresh_arguments()
    event('apt_refresh_running', arguments=arguments, totalDeadlineSeconds=bootstrap.APT_REFRESH_SECONDS)
    apt_started = time.monotonic()
    output = command(arguments, bootstrap.APT_REFRESH_SECONDS)
    event('apt_refresh_passed', elapsedSeconds=round(time.monotonic() - apt_started, 3), publicOutput=output[-16384:].decode('utf-8', 'replace'))
    for package in lock['packages']:
        require(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', package['name']) and re.fullmatch(r'[A-Za-z0-9.+:~_-]+', package['version']), 'Unexpected package argument')
        raw = command(['apt-cache', 'show', package['name'] + '=' + package['version']], 5)
        matches = [entry for entry in metadata.records(raw) if
                   (entry.get('Package'), entry.get('Version'), entry.get('Architecture'),
                    entry.get('SHA256'), entry.get('Size'), entry.get('Filename')) ==
                   (package['name'], package['version'], package['architecture'],
                    package['sha256'], str(package['size']), package['filename'])]
        require(bool(matches), 'Exact pinned package missing/changed in authenticated APT cache')
        event('apt_pin_verified', package=package['name'], version=package['version'], sha256=package['sha256'])
    event('preflight_passed', pinnedPackages=20, elapsedSeconds=round(time.monotonic() - started, 3),
          vendorPackagesInstalled=False, modelDownloaded=False, providerAccessed=False,
          nativeHyperstackAcceptance=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        event('preflight_failed', errorCode=safe_code(error))
        raise SystemExit(1)

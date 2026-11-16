"""Immutable local poweroff for the model-free inventory VM; no cloud keys.

Poweroff does not prove a billing stop. Independent cloud destroy guards remain
armed until verified provider destruction, exactly as for inference sessions.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_policy import Refused, manifest_from, root_file, timestamp


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or sys.argv[1:]:
        raise Refused('Fixed inventory deadline required')
    session = manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()))
    if time.time() < timestamp(session['deadlineUTC']):
        raise Refused('Original deadline has not arrived')
    subprocess.run(['/usr/bin/systemctl', 'poweroff'], check=True, timeout=15,
                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'},
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Inventory local deadline refused; external destroy guards remain required')

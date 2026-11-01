"""Generate isolated acceptance images; never modify the ten-hour runtime."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ('Dockerfile', '.dockerignore', 'start.py', 'secure_middleware.py', 'watchdog.py', 'supervisor.py')

def prepare(destination):
    results = {}
    for variant, hours in [('self-stop', 0.5), ('backup-stop', 0.25)]:
        target = Path(destination) / variant
        target.mkdir(parents=True, exist_ok=True)
        for filename in FILES:
            shutil.copy2(ROOT / filename, target / filename)
        path = target / 'watchdog.py'
        text = path.read_text()
        assert text.count('HOURS = 10\n') == 1
        text = text.replace('HOURS = 10\n', f'HOURS = {hours}\n')
        text = text.replace('NAME = "huihui-qwen3-8b-v2-10h"', f'NAME = "qwen-acceptance-{variant}"')
        path.write_text(text)
        if variant == 'backup-stop':
            # Only the control path is tested in phase two; no second weight load.
            path = target / 'supervisor.py'
            text = path.read_text()
            original = '[sys.executable, "/opt/qwen/start.py"]'
            assert text.count(original) == 1
            text = text.replace(original, '[sys.executable, "-c", "import time; time.sleep(3600)"]')
            path.write_text(text)
        results[variant] = {'pod_name': f'qwen-acceptance-{variant}', 'self_stop_seconds': int(hours * 3600)}
    return results

if __name__ == '__main__':
    import sys
    print(json.dumps(prepare(sys.argv[1]), indent=2))

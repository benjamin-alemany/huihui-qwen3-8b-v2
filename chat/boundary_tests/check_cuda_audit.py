"""Validate dummy-only CI output without dumping unexpected content."""
import json
from pathlib import Path
import sys

directory = Path(sys.argv[1])
out = (directory / 'stdout').read_text()
err = (directory / 'stderr').read_text()
assert 'DUMMY-CANARY' not in out + err
events = []
for line in err.splitlines():
    assert line.startswith('CUDA_SYSCALL '), 'Unexpected diagnostic output'
    event = json.loads(line.split(' ', 1)[1])
    assert set(event) in ({'operation','ok','errno','family','type','protocol'}, {'observations_capped'})
    events.append(event)
assert len(events) == 129 and events[-1] == {'observations_capped': True}
assert any(e.get('operation') == 'socket' and e['family'] == 1 and e['errno'] == 1 and not e['ok'] for e in events)
assert any(e.get('operation') == 'connect' and e['errno'] == 1 and not e['ok'] for e in events)
assert any(e.get('operation') == 'socketpair' and e['ok'] for e in events)
assert any(e.get('operation') == 'memfd_create' and e['ok'] for e in events)
assert '"cuda_code": 304' in out and '"real_cuda_validated": false' in out
print('CPU observer passed: unchanged kernel denials, errno, bounded logs, canary exclusion; fake CUDA only.')

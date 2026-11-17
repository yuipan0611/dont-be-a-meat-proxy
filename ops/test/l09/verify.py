"""Non-secret assertions inside the disposable fake VPS after STEP 7."""
from collections import Counter
import json
from pathlib import Path
import stat
import subprocess
import sys
import time


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)


journal = json.loads(Path('/var/lib/neighbor-hub/l09/journal.json').read_text())
assert journal['passed'] == list(range(1, 8))
assert Path('/run/l09-reloads').read_text() == '1'
print('measured_caddy_reload_count=1')

# Count actual daemon creation events after the baseline, including containers later removed.
# Only selected labels are printed, never full inspect output or events with config/credentials.
events = docker('events', '--since', sys.argv[1], '--until', str(time.time_ns() / 1e9),
                '--filter', 'type=container', '--filter', 'event=create', '--format', '{{json .}}')
counts = Counter()
for line in events.splitlines():
    attributes = json.loads(line)['Actor']['Attributes']
    project = attributes.get('com.docker.compose.project')
    service = attributes.get('com.docker.compose.service')
    if project in ('neighbor-hub', 'neighbor-hub-db') and service in ('mail-a', 'hubclock', 'db'):
        counts[service] += 1
for service, expected in (('mail-a', 1), ('hubclock', 1), ('db', 0)):
    print(f'measured_{service}_rebuild_count={counts[service]}')
    assert counts[service] == expected, f'unexpected creation count: {service}'

ids = docker('ps', '-q', '--filter', 'label=com.docker.compose.project=neighbor-hub-memory',
             '--filter', 'label=com.docker.compose.service=llm-gateway').split()
assert len(ids) == 1
gateway = json.loads(docker('inspect', ids[0]))[0]
env = dict(item.split('=', 1) for item in gateway['Config']['Env'] if '=' in item)
assert env['LLM_BACKEND'] == 'groq-api'
assert env['LLM_UPSTREAM_MODEL'] == 'openai/gpt-oss-120b'
assert env['GROQ_API_KEY_FILE'] == '/run/secrets/groq_api_key'
assert any(m['Destination'] == '/run/secrets/groq_api_key' and not m['RW'] for m in gateway['Mounts'])
private = Path('/var/lib/neighbor-hub/private')
source = private / 'groq.key'
copy = private / 'llm-gateway/groq.key'
assert source.read_bytes() == copy.read_bytes()
assert copy.stat().st_uid == copy.stat().st_gid == 10004
assert stat.S_IMODE(copy.stat().st_mode) == 0o600
for project, service in (('neighbor-hub', 'bot'), ('neighbor-hub', 'memory-bridge'),
                         ('neighbor-hub-memory', 'hindsight'), ('neighbor-hub-memory', 'bank-proxy')):
    cid = docker('ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                 '--filter', 'label=com.docker.compose.service=' + service).strip()
    obj = json.loads(docker('inspect', cid))[0]
    assert all('groq' not in m['Source'] and 'groq' not in m['Destination'] for m in obj['Mounts'])
print('groq_wiring=groq-api; openai/gpt-oss-120b; gateway-only read-only synthetic key; owner/mode/copy PASS')

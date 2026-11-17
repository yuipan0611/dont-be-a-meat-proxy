"""Runs only inside the disposable nested Docker VPS."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
P=Path('/var/lib/neighbor-hub/private'); P.mkdir(parents=True, mode=0o700)
for name in ('postgres.password','hub-app.password','discord.token','discord-client.secret','groq.key'):
    p=P/name; p.write_text(secrets.token_hex(32)+'\n'); p.chmod(0o600)
for d in ('hubclock','memory-bridge'):
    p=Path('/var/lib/neighbor-hub')/d; p.mkdir(mode=0o700); os.chown(p,10001,10001)
root=Path('/opt/neighbor-hub')
if subprocess.run(['docker','image','inspect','l09-mail-cached'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
    path=root/'deploy/compose.yaml'
    path.write_text(path.read_text().replace('ghcr.io/dicklesworthstone/mcp_agent_mail_rust@sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1','l09-mail-cached'))

# Only the copied checkout is changed. Host source and production files are untouched.
# Bootstrap baseline four migrations by mounting a separate SQL dir, then restore the full mount.
sql=Path('/tmp/l09-baseline-sql'); shutil.copytree(root/'supabase',sql)
for p in sorted((sql/'migrations').glob('*.sql'))[4:]: p.unlink()
if subprocess.run(['docker','image','inspect','l09-pg-cached'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
    path=root/'deploy/postgres/compose.yaml'
    path.write_text(path.read_text().replace('pgvector/pgvector:pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782','l09-pg-cached'))
# Fixture provider reuses the local VPS image's Python/Bash, with no nested package download.
f=root/'ops/test/l09'
(f/'Dockerfile.provider').write_text('FROM neighbor-l09-vps:test\nRUN ln -sf /usr/bin/python3 /usr/local/bin/python\nWORKDIR /app\nCOPY provider.py /app/provider.py\nRUN printf "#!/bin/bash\\nexec python3 /app/provider.py\\n" > /app/start-all.sh && chmod +x /app/start-all.sh\n')
subprocess.run(['docker','build','-t','l09-hindsight-fixture',str(f),'-f',str(f/'Dockerfile.provider')],check=True,stdout=subprocess.DEVNULL)
p=root/'deploy/memory/compose.yaml'
s=p.read_text(); s=s.replace('ghcr.io/vectorize-io/hindsight:1.2.1@sha256:d2bc230a714e933affd63753e181a0579328fdcbbc021800a76e0bc7b6e76b31','l09-hindsight-fixture'); p.write_text(s)
# Use the real Groq adapter with a synthetic key; liveness never invokes a provider.
(root/'ops/llm-gateway/Dockerfile').write_text((root/'ops/llm-gateway/Dockerfile.test').read_text())
# Use the real validator artifact built from this checkout by the outer Docker builder.
(root/'server/validator/Dockerfile').write_text('FROM neighbor-l09-validator:dry-built\n')
# Import real source artifacts to avoid nested DNS/npm/apk failures; no substitute implementations.
(root/'ops/bank-proxy/Dockerfile').write_text('FROM neighbor-l09-bank-proxy:dry-built\n')
(root/'web/Dockerfile').write_text('FROM neighbor-l09-web:dry-built\n')
# Bot fixture checks orchestration start/register boundaries, never reaches Discord REST/Gateway.
p=root/'bot/Dockerfile'
p.write_text('FROM node:24-alpine\nENTRYPOINT ["node", "-e", "if(process.argv[1]===\\\"run\\\"){setInterval(()=>{},1000)}else{console.log(\\\"fixture command accepted\\\")}"]\nCMD ["run"]\n')
# Final launch script pulls fixture name; the fake daemon has it locally. Docker pull is intercepted
# ONLY for this local fixture tag. All production pulls/builds otherwise go through the real CLI.
shutil.move('/usr/local/bin/docker','/usr/local/bin/docker-real')
Path('/usr/local/bin/docker').write_text('''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if 'pull' in args and 'hindsight' in args: sys.exit(0)
os.execv('/usr/local/bin/docker-real',['docker-real',*args])
''')
Path('/usr/local/bin/docker').chmod(0o755)
# Systemd adapter is an explicit fixture, never installed by production driver.
Path('/etc/systemd/system').mkdir(parents=True,exist_ok=True)
shutil.copyfile(f/'systemctl.py','/usr/local/bin/systemctl'); Path('/usr/local/bin/systemctl').chmod(0o755)
# Generate private fake credentials with the real MVP operator. Upstream raw Mail is localhost.
subprocess.run([str(root/'ops/init-secrets'),'--state-dir',str(P)],check=True,stdout=subprocess.DEVNULL)
# Credentials must be readable by the existing nonroot clock through individual bind mounts.
os.chown(P/'mail-a.env',10001,10001)
env={**os.environ,'HUB_OPS_UID':'10001','HUB_OPS_GID':'10001','HUB_PG_PLATFORM':os.environ['TEST_PLATFORM'],'HUB_PG_SQL_DIR':str(sql)}
pgc=['docker','compose','-p','neighbor-hub-db','-f',str(root/'deploy/postgres/compose.yaml')]
subprocess.run(pgc+['up','-d','--wait','db'],env=env,check=True,stdout=subprocess.DEVNULL)
subprocess.run([str(root/'ops/postgres'),'migrate'],env=env,check=True,stdout=subprocess.DEVNULL)
# Switch mounted /supabase to all eight migrations while keeping DB ID/StartedAt fixed.
shutil.copytree(root/'supabase',sql,dirs_exist_ok=True)
# The source path is a stable bind mount; update its contents rather than recreating db.
# Production compose's default source now points at this same directory via symlink.
shutil.rmtree(root/'supabase'); os.symlink(sql,root/'supabase')
hc=['docker','compose','-p','neighbor-hub','-f',str(root/'deploy/compose.yaml'),'-f',str(root/'deploy/hubclock/compose.hubclock.yaml')]
subprocess.run(hc+['up','-d','--wait','mail-a'],env=env,check=True,stdout=subprocess.DEVNULL)
subprocess.run([str(root/'ops/bootstrap'),'--state-dir',str(P),'--url','http://127.0.0.1:8765/mcp/'],env=env,check=True,stdout=subprocess.DEVNULL)
for p in P.glob('*.sender.json'): os.chown(p,10001,10001)
subprocess.run(hc+['up','-d','--no-deps','--wait','hubclock'],env=env,check=True,stdout=subprocess.DEVNULL)
# HTTP fixture origins are local only; use no public DNS/TLS certificates or network requests.
c=Path('/etc/caddy'); (c/'hub-private').mkdir(parents=True,exist_ok=True,mode=0o750)
os.chmod(c/'hub-private',0o750)
os.chown(c/'hub-private',__import__('pwd').getpwnam('caddy').pw_uid,__import__('pwd').getpwnam('caddy').pw_gid)
subprocess.run([str(root/'ops/render-caddy'),'--state-dir',str(P),'--prepare-only','--owner','caddy','--output',str(c/'hub-private/auth.caddy')],check=True,stdout=subprocess.DEVNULL)
(c/'Caddyfile').write_text('{\n auto_https off\n admin localhost:2019\n}\nhttp://127.0.0.1:8089 {\n respond "office fixture" 200\n}\nimport /etc/caddy/hub.caddy\n')
(c/'hub.caddy').write_text('http://127.0.0.1:8088 {\n import /etc/caddy/hub-private/auth.caddy\n}\n')
subprocess.Popen(['runuser','-u','caddy','--','caddy','run','--config',str(c/'Caddyfile'),'--adapter','caddyfile'],stdout=open('/tmp/l09-caddy.log','w'),stderr=subprocess.STDOUT)
config=Path('/etc/neighbor-hub/l09.env'); config.parent.mkdir(parents=True,exist_ok=True)
config.write_text('HUB_DISCORD_GUILD_ID=12345678\x39012345678\nHUB_DISCORD_APPLICATION_ID=12345678\x39012345679\nL09_OWNER_DISCORD_ID=12345678\x39012345680\nHUB_WEB_MAP_FILE=/opt/neighbor-hub/web/architecture.json\nHUB_LLM_BACKEND=groq-api\nHUB_LLM_UPSTREAM_MODEL=openai/gpt-oss-120b\nHUB_PUBLIC_URL=http://127.0.0.1:8088\nL09_OFFICE_URL=http://127.0.0.1:8089\nHUB_PG_PLATFORM='+os.environ['TEST_PLATFORM']+'\nHUB_HS_PLATFORM='+os.environ['TEST_PLATFORM']+'\nHUB_VALIDATOR_PLATFORM='+os.environ['TEST_PLATFORM']+'\n')
config.chmod(0o600)
# Web validates an HTTPS origin; Caddy test transport is plain HTTP on a different port.
# Preserve this one env override in fake checkout only.
p=root/'deploy/web/compose.web.yaml'; p.write_text(p.read_text().replace('${HUB_WEB_ORIGIN:-https://hub.example.invalid}','https://hub.example.invalid'))
# Wait for the real Caddy socket before invoking production preflight (avoid a fixture startup race).
import time
import urllib.request
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8089',timeout=1) as response:
            assert response.status == 200
        break
    except OSError:
        if attempt == 29:
            raise RuntimeError('fixture Caddy failed to become ready') from None
        time.sleep(0.2)
print('FIXTURE baseline: real PG four migrations + Mail + HubClock + Caddy; synthetic credentials only',flush=True)

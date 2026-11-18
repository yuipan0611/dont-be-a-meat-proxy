"""Validate the actual Compose mount contract without starting services or reading secrets."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


@unittest.skipUnless(
    os.environ.get('HUB_TEST_NO_DOCKER') != '1' and shutil.which('docker'),
    'Docker Compose disabled or unavailable',
)
class GatewayComposeTest(unittest.TestCase):
    def test_gateway_tmpfs_is_one_mount_with_all_security_options(self):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ['docker', 'compose', '-p', 'l09-compose-check', '-f', 'deploy/memory/compose.yaml',
             '-f', 'deploy/memory/compose.groq.yaml', 'config', '--format', 'json'],
            cwd=root, env={'PATH': os.environ['PATH'], 'HUB_GROUP_ID': 'group-a'},
            capture_output=True, text=True, check=True)
        config = json.loads(result.stdout)
        self.assertEqual(config['services']['llm-gateway']['tmpfs'],
                         ['/tmp:rw,nosuid,noexec,size=64m'])

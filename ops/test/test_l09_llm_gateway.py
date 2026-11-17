"""F-11/L-09 wiring: no VPS, root operations, provider calls or account credentials."""
from types import SimpleNamespace
import ast
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, mock_open

from ops import l09_launch as launch


class GatewayLaunchTest(unittest.TestCase):
    def test_runbook_groq_model_is_accepted_by_launch_config(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            (private / 'hubclock.sender.json').touch()
            model_map = private / 'architecture.json'
            model_map.write_text('{}')
            config = ('HUB_DISCORD_GUILD_ID=12345678\x39012345678\n'
                      'HUB_DISCORD_APPLICATION_ID=12345678\x39012345679\n'
                      'L09_OWNER_DISCORD_ID=12345678\x39012345680\n'
                      f'HUB_WEB_MAP_FILE={model_map}\n'
                      'HUB_LLM_BACKEND=groq-api\n'
                      'HUB_LLM_UPSTREAM_MODEL=openai/gpt-oss-120b\n')
            output = io.StringIO()
            with patch.dict(launch.ENV, {}, clear=True), patch.object(launch, 'PRIVATE', private), \
                 patch.object(launch.os, 'geteuid', return_value=0), \
                 patch.object(launch, 'secret_file', return_value=config), \
                 patch.object(launch, 'directory', side_effect=launch.Stop('config accepted')), \
                 patch('sys.argv', ['deploy-l09.sh', '--step', '1']), contextlib.redirect_stdout(output):
                launch.main()
            self.assertIn('config accepted', output.getvalue())

    def test_dry_run_uses_the_production_groq_backend_and_model(self):
        # Inspect only the fixture's generated config; never execute its root/Docker setup here.
        tree = ast.parse((launch.ROOT / 'ops/test/l09/setup.py').read_text())
        call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute) and node.func.attr == 'write_text'
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'config')
        config = eval(compile(ast.Expression(call.args[0]), '<fixture-config>', 'eval'),
                      {'os': SimpleNamespace(environ={'TEST_PLATFORM': 'linux/arm64'})})
        self.assertIn('HUB_LLM_BACKEND=groq-api\n', config)
        self.assertIn('HUB_LLM_UPSTREAM_MODEL=openai/gpt-oss-120b\n', config)
    def test_documented_groq_model_reaches_launch_step(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / 'hubclock.sender.json').write_text('{}')
            map_file = root / 'map.json'
            map_file.write_text('{}')
            config = '\n'.join([
                'HUB_DISCORD_GUILD_ID=11111111\x3111111111',
                'HUB_DISCORD_APPLICATION_ID=22222222\x3222222222',
                'L09_OWNER_DISCORD_ID=33333333\x3333333333',
                f'HUB_WEB_MAP_FILE={map_file}',
                'HUB_LLM_BACKEND=groq-api',
                'HUB_LLM_UPSTREAM_MODEL=openai/gpt-oss-120b',
            ])
            reached = []
            with patch.object(launch.os, 'geteuid', return_value=0), \
                 patch.object(launch, 'secret_file', return_value=config), \
                 patch.object(launch, 'PRIVATE', root), patch.object(launch, 'STATE', root), \
                 patch.dict(launch.ENV, {}, clear=True), patch.dict(launch.J, {}, clear=True), \
                 patch.object(launch, 'directory'), patch.object(launch, 'save'), \
                 patch('sys.argv', ['l09_launch.py', '--step', '1']), \
                 patch('builtins.open', mock_open()), patch.object(launch.fcntl, 'flock'), \
                 patch.object(launch, 'step1', side_effect=lambda: reached.append(launch.ENV['HUB_LLM_UPSTREAM_MODEL'])):
                self.assertEqual(launch.main(), 0)
            self.assertEqual(reached, ['openai/gpt-oss-120b'])

    def test_explicit_disabled_launch_does_not_require_provider_key_overlay(self):
        with patch.dict(launch.ENV, {'HUB_LLM_BACKEND': 'disabled'}, clear=True), patch.object(launch, 'dc') as dc:
            launch.mem('config', '--quiet')
            self.assertEqual(dc.call_args.args[1], ['deploy/memory/compose.yaml'])

    def test_selected_default_groq_mounts_only_its_private_key_overlay(self):
        with patch.dict(launch.ENV, {}, clear=True), patch.object(launch, 'dc') as dc:
            launch.mem('config', '--quiet')
            self.assertEqual(dc.call_args.args[1], ['deploy/memory/compose.yaml', 'deploy/memory/compose.groq.yaml'])

    def test_only_explicit_api_backend_mounts_the_provider_secret_overlay(self):
        for backend in ('gemini-api-free', 'gemini-api-paid', 'gemini-cli', 'antigravity-cli'):
            with self.subTest(backend=backend), patch.dict(launch.ENV, {'HUB_LLM_BACKEND': backend}, clear=True), patch.object(launch, 'dc') as dc:
                launch.mem('config', '--quiet')
                files = dc.call_args.args[1]
                self.assertEqual('deploy/memory/compose.gemini-api.yaml' in files, backend.startswith('gemini-api-'))

    def test_stage3_starts_gateway_before_consumers_without_generating_text(self):
        with patch.dict(launch.ENV, {'HUB_OPS_UID': '10001', 'HUB_OPS_GID': '10001', 'HUB_BOT_UID': '10002', 'HUB_BOT_GID': '10002'}, clear=True), \
             patch.dict(launch.J, {'before': {}}, clear=True), \
             patch.object(launch, 'unchanged'), patch.object(launch, 'office'), \
             patch.object(launch, 'mem') as mem, patch.object(launch, 'hub'), \
             patch.object(launch, 'run', return_value=SimpleNamespace(stdout=b'')), \
             patch.object(launch.os, 'chown'), patch.object(launch, 'evidence'), \
             patch.object(launch, 'secret_file', return_value='synthetic-identity'), patch.object(launch, 'put_secret') as copy:
            launch.step3()
            self.assertIn('llm-gateway', mem.call_args_list[0].args)
            up = [c for c in mem.call_args_list if c.args[0] == 'up']
            self.assertIn('llm-gateway', up[0].args)
            self.assertNotIn('hindsight', up[0].args)
            self.assertIn('hindsight', up[1].args)
            # No model endpoint is probed by this stage; readiness remains a separate acceptance.
            self.assertFalse(any('/v1/messages' in str(c) or '/chat/completions' in str(c) for c in mem.call_args_list))
            self.assertEqual(copy.call_args.args, (launch.PRIVATE / 'bot/hubbot.sender.json', 'synthetic-identity', 10002, 10002))


if __name__ == '__main__':
    unittest.main()

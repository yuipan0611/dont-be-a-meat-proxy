"""F-11/L-09 wiring: no VPS, root operations, provider calls or account credentials."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops import l09_launch as launch


class GatewayLaunchTest(unittest.TestCase):
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
        with patch.dict(launch.ENV, {'HUB_OPS_UID': '10001', 'HUB_OPS_GID': '10001'}, clear=True), \
             patch.dict(launch.J, {'before': {}}, clear=True), \
             patch.object(launch, 'unchanged'), patch.object(launch, 'office'), \
             patch.object(launch, 'mem') as mem, patch.object(launch, 'hub'), \
             patch.object(launch, 'run', return_value=SimpleNamespace(stdout=b'')), \
             patch.object(launch.os, 'chown'), patch.object(launch, 'evidence'):
            launch.step3()
            self.assertIn('llm-gateway', mem.call_args_list[0].args)
            up = [c for c in mem.call_args_list if c.args[0] == 'up']
            self.assertIn('llm-gateway', up[0].args)
            self.assertNotIn('hindsight', up[0].args)
            self.assertIn('hindsight', up[1].args)
            # No model endpoint is probed by this stage; readiness remains a separate acceptance.
            self.assertFalse(any('/v1/messages' in str(c) or '/chat/completions' in str(c) for c in mem.call_args_list))


if __name__ == '__main__':
    unittest.main()

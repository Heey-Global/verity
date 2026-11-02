"""Containment evidence must never bypass attestation of live endpoints."""
import ast
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock


class ContainmentObservation(unittest.TestCase):
    def observe(self, running=(False, False), wrong_id=False, wrong_program=False, containment=True):
        source = ast.parse(Path(__file__).with_name('deadline-observe.py').read_text())
        start = next(i for i, node in enumerate(source.body) if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'binding')
        end = next(i for i, node in enumerate(source.body) if isinstance(node, ast.FunctionDef))
        code = compile(ast.Module(body=source.body[start:end], type_ignores=[]), '<observer guards>', 'exec')
        binding = {'containerId': 'sandbox'}
        peer = {'index': 7}
        state = {'binding': binding, 'relayRegistration': {'containerId': 'relay'}, 'program': 42, 'peer': peer}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'identity.json').write_text(json.dumps(state))
            rows = [{'Id': value, 'State': {'Running': active}} for value, active in zip(('sandbox', 'relay'), running)]
            if wrong_id:
                rows[0]['Id'] = 'substituted'
            host = Mock(STATE=root, PINS=root)
            host.binding_key.return_value = 'identity'
            host.docker_inspect.side_effect = [json.dumps([row]) for row in rows]
            host.kernel_program.return_value = {'id': 43 if wrong_program else 42}
            host.endpoint.return_value = peer
            self.host = host
            exec(code, {'host': host, 'json': json, 'sys': types.SimpleNamespace(argv=['observe', json.dumps(binding)] + (['--containment'] if containment else []))})
        return host

    def test_stopped_endpoints_still_require_exact_container_and_program_identity(self):
        host = self.observe()
        self.assertEqual(host.docker_inspect.call_count, 2)
        host.kernel_program.assert_called_once()
        host.endpoint.assert_not_called()
        for change in [{'wrong_id': True}, {'wrong_program': True}]:
            with self.subTest(change=change), self.assertRaises(AssertionError):
                self.observe(**change)

    def test_live_endpoints_and_normal_observation_always_attest(self):
        for change in [{'running': (True, True)}, {'containment': False}]:
            host = self.observe(**change)
            host.endpoint.assert_called_once()
            host.attest.assert_called_once()


if __name__ == '__main__':
    unittest.main()

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('boot_vm', Path(__file__).with_name('boot-vm.py'))
boot_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_vm)


class BootEvidenceTests(unittest.TestCase):
    def test_process_restart_is_not_a_guest_reboot(self):
        before = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 249}
        with self.assertRaisesRegex(ValueError, 'did not reboot'):
            boot_vm.check_reboot(before, dict(before))
        after = {**before, 'boot_id': '22222222-2222-2222-2222-222222222222'}
        boot_vm.check_reboot(before, after)

    def test_rejects_container_init_and_old_systemd(self):
        before = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 249}
        for changes in ({'init': 'sh'}, {'systemd': 248}, {'boot_id': ''}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                boot_vm.check_reboot(before, {**before, **changes})

"""Execute the actual renewal decision in C; native BPF acceptance is a separate gate."""
import ctypes
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class RenewalDecision(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('cc')
        if not compiler:
            raise unittest.SkipTest('C compiler unavailable')
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-renew.bpf.c'
        wrapper = root / 'test.c'
        wrapper.write_text('''
#define memcpy __builtin_memcpy
#define VERITY_DEADLINE_RENEW_TEST
struct __sk_buff;
static void *test_lookup(void *, const void *);
static long test_update(void *, const void *, const void *, unsigned long long);
static unsigned long long test_boot(void);
static long test_load(const struct __sk_buff *, unsigned int, void *, unsigned int);
#include "''' + str(source) + '''"
static struct lease live;
static unsigned long long now;
static void *test_lookup(void *m, const void *k) { return &live; }
static long test_update(void *m, const void *k, const void *v, unsigned long long f) { memcpy(&live, v, sizeof(live)); return 0; }
static unsigned long long test_boot(void) { return now; }
static long test_load(const struct __sk_buff *s, unsigned int o, void *d, unsigned int n) {
    if (o + n > s->len) return -1; memcpy(d, s->payload + o, n); return 0;
}
int simulate(unsigned long long prior, unsigned long long expected, unsigned long long next,
             unsigned long long observed, unsigned int index) {
    live = (struct lease){prior, 5, 0}; now = observed;
    struct request candidate = {expected, next, index, 0};
    struct __sk_buff s = {.len=24}; memcpy(s.payload, &candidate, 24);
    int result = renew_deadline(&s);
    return result && live.deadline == next;
}
''')
        library = root / 'test.so'
        subprocess.run([compiler, '-shared', '-fPIC', '-O2', str(wrapper), '-o', str(library)], check=True)
        cls.module = ctypes.CDLL(str(library))
        cls.module.simulate.argtypes = [ctypes.c_uint64] * 4 + [ctypes.c_uint32]
        cls.module.simulate.restype = ctypes.c_int

    def test_live_handoff_preserves_continuity(self):
        self.assertEqual(self.module.simulate(100, 100, 200, 99, 5), 1)

    def test_expired_or_substituted_handoff_cannot_revive(self):
        for values in [(100, 100, 200, 100, 5), (100, 100, 200, 150, 5),
                       (100, 99, 200, 50, 5), (100, 100, 200, 50, 6),
                       (100, 100, 99, 50, 5), (100, 100, 1000000051, 50, 5)]:
            with self.subTest(values=values):
                self.assertEqual(self.module.simulate(*values), 0)

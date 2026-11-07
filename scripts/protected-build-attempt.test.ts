import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const helper = resolve('deploy/buildkit/protected-build-attempt');

describe('fixed protected build native helper', () => {
  it('rejects descriptors and commands before starting any child process', () => {
    const evidence = execFileSync(
      'python3',
      [
        '-c',
        `
import copy, hashlib, json, runpy
m = runpy.run_path(${JSON.stringify(helper)})
g = m['run'].__globals__
ref = 'ghcr.io/example/feature@sha256:' + 'a' * 64
request = {'projectId':'project-a','attemptId':'11111111-1111-4111-8111-111111111111','snapshot':'attempt-abc/verity-build-xyz','image':'verity-devc-repo:'+'a'*12,'noCache':False}
descriptor = {'version':1,'request':request,'additionalFeatures':ref}
identity = hashlib.sha256((request['projectId']+'\\0'+request['attemptId']).encode()).hexdigest()
g['check'] = lambda: {'nodeFeature':ref,'additionalFeatures':[ref]}
g['trusted'] = lambda path, directory=False: path
calls = []
g['subprocess'].run = lambda *args, **kwargs: calls.append(args)
g['subprocess'].Popen = lambda *args, **kwargs: calls.append(args)
results = []
for change in ['command','feature','image','identity','cache-type']:
    value = copy.deepcopy(descriptor)
    if change == 'command': value['command'] = 'reboot'
    if change == 'feature': value['additionalFeatures'] = 'ghcr.io/untrusted/feature:latest'
    if change == 'image': value['request']['image'] = '--privileged'
    if change == 'identity': value['request']['projectId'] = 'another-project'
    if change == 'cache-type': value['request']['noCache'] = 'false'
    g['load'] = lambda path: value
    try: m['run'](identity)
    except (ValueError, TypeError): results.append(change)
    else: raise AssertionError(change)
assert not calls, calls
print(json.dumps(results))
`,
      ],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(JSON.parse(evidence)).toEqual(['command', 'feature', 'image', 'identity', 'cache-type']);
  });
  it('requires actual host toolchain files rather than reporting generic readiness', () => {
    const result = execFileSync(
      'python3',
      [
        '-c',
        `
import runpy
m = runpy.run_path(${JSON.stringify(helper)})
g = m['check'].__globals__
g['trusted'] = lambda path, directory=False: (_ for _ in ()).throw(ValueError('missing pinned toolchain'))
g['os'].geteuid = lambda: 0
try: m['check']()
except ValueError: print('unavailable')
else: raise AssertionError('false readiness')
`,
      ],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(result.trim()).toBe('unavailable');
  });
  it('rejects an empty signed feature whitelist instead of advertising build readiness', () => {
    const result = execFileSync(
      'python3',
      [
        '-c',
        `
import runpy
m = runpy.run_path(${JSON.stringify(helper)})
g = m['check'].__globals__
g['trusted'] = lambda path, directory=False: path
g['os'].geteuid = lambda: 0
g['load'] = lambda path: {'nodeFeature':'ghcr.io/example/node@sha256:'+'a'*64,'additionalFeatures':[],'nodeOptions':{'version':'26.13.0'},'toolkitOptions':{'installRunnerSupervisor':True}}
try: m['check']()
except ValueError: print('unavailable')
else: raise AssertionError('empty whitelist falsely accepted')
`,
      ],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(result.trim()).toBe('unavailable');
  });
  it('uses a private metadata daemon endpoint and never imports through the host Engine', () => {
    const source = readFileSync(helper, 'utf8');
    expect(source).toContain("'DOCKER_HOST': 'unix://' + str(directory / 'docker.sock')");
    expect(source).toContain("'--host', env['DOCKER_HOST']");
    expect(source).toContain("'unix://' + str(directory / 'buildkit.sock')");
    expect(source).toContain("'type=docker,dest=' + str(directory / 'image.tar')");
    expect(source).not.toContain("['/usr/bin/docker', 'load'");
  });
});

it('DNS forwards only a bounded canonical name over the private Unix channel', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import json, runpy, struct
m = runpy.run_path(${JSON.stringify(helper)})
g = m['dns_answer'].__globals__
requests = []
class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, path): assert path == '/fixed/dns.sock'
    def sendall(self, data): requests.append(json.loads(data))
    def recv(self, count): return b'{"addresses":["203.0.113.7","2001:db8::7"],"ttlSeconds":3}\\n'
def connect(family, kind):
    assert family == g['socket'].AF_UNIX and kind == g['socket'].SOCK_STREAM
    return Connection()
g['socket'].socket = connect
name = b'\\x08registry\\x05npmjs\\x03org\\x00'
for kind, size in [(1,4),(28,16)]:
    query = struct.pack('!6H', 42, 0x100, 1,0,0,0) + name + struct.pack('!HH',kind,1)
    answer = m['dns_answer'](query, '/fixed/dns.sock')
    header = struct.unpack('!6H', answer[:12])
    assert header[3] == 1 and header[1] & 15 == 0
    assert len(answer) == len(query) + 12 + size
assert requests == [{'name':'registry.npmjs.org'}]*2
print('bounded private DNS')
`,
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  expect(result.trim()).toBe('bounded private DNS');
});

it('DNS rejects arbitrary socket output, compression pointers and unsupported records', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import runpy, struct
m = runpy.run_path(${JSON.stringify(helper)})
g = m['dns_answer'].__globals__
called = []
class Connection:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def settimeout(self, value): pass
    def connect(self,path): pass
    def sendall(self,data): pass
    def recv(self,count): return b'{"addresses":["1.2.3.4"],"ttlSeconds":999999}\\n'
def connect(*args): called.append(args); return Connection()
g['socket'].socket = connect
name=b'\\x07example\\x03com\\x00'
header=struct.pack('!6H',42,0x100,1,0,0,0)
try: m['dns_answer'](header+name+struct.pack('!HH',1,1),'/fixed/dns.sock')
except ValueError: pass
else: raise AssertionError('unbounded TTL')
called.clear()
answer=m['dns_answer'](header+name+struct.pack('!HH',16,1),'/fixed/dns.sock')
assert struct.unpack('!6H',answer[:12])[3] == 0 and not called
try: m['dns_answer'](header+b'\\xc0\\x0c'+struct.pack('!HH',1,1),'/fixed/dns.sock')
except ValueError: pass
else: raise AssertionError('compression accepted')
print('denied')
`,
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  expect(result.trim()).toBe('denied');
});

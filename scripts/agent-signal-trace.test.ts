import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve('features/verity-sandbox-toolkit/bin/verity-agent-signal-trace');
const interpreter = '/usr/bin/python3';
const python = spawnSync(interpreter, ['--version']).status === 0;
const suite =
  process.platform === 'linux' && process.getuid?.() !== 0 && python ? describe : describe.skip;

function probe(body: string) {
  const result = spawnSync(interpreter, ['-c', body, helper], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

suite('agent signal trace', () => {
  it('records the real SIGHUP sender and preserves fatal signal delivery', () => {
    const result = probe(`
import subprocess, sys, os, signal, json
tracer = subprocess.Popen([sys.argv[1], '--seconds', '2', '--launch', sys.executable, '-c', 'import time; time.sleep(1)'], stderr=subprocess.PIPE, text=True)
try:
    attached = json.loads(tracer.stderr.readline())
    os.kill(attached['pid'], signal.SIGHUP)
    lines = [json.loads(line) for line in tracer.stderr.readlines()]
    tracer.wait(timeout=5)
    print(json.dumps({'events': lines, 'status': tracer.returncode, 'sender': os.getpid(), 'pidIntact':attached['pid'] == tracer.pid}))
finally:
    if tracer.poll() is None:
        tracer.kill()
        tracer.wait()
`);
    expect(result.status).toBe(-1);
    expect(result.pidIntact).toBe(true);
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: 'signal', signal: 'SIGHUP', senderPid: result.sender }),
    );
  });

  it('detaches at the deadline while the launched agent continues and creates threads', () => {
    const result = probe(`
import subprocess, sys, json
program = 'import time,threading; time.sleep(.1); threading.Thread(target=lambda: time.sleep(.8)).start(); time.sleep(.6); print("alive", flush=True)'
tracer = subprocess.Popen([sys.argv[1], '--seconds', '.3', '--launch', sys.executable, '-c', program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    out, err = tracer.communicate(timeout=5)
    print(json.dumps({'stdout':out, 'events':[json.loads(line) for line in err.splitlines()], 'status':tracer.returncode}))
finally:
    if tracer.poll() is None:
        tracer.kill()
        tracer.wait()
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('alive\n');
    expect(result.events).toContainEqual(expect.objectContaining({ event: 'detached' }));
  });

  it('bounds output and leaves a handled SIGHUP observable to the agent', () => {
    const result = probe(`
import subprocess, sys, os, signal, json, time
program = 'import time,signal; signal.signal(signal.SIGHUP,lambda *args: print("hup",flush=True)); print("ready",flush=True); time.sleep(2)'
tracer = subprocess.Popen([sys.argv[1], '--seconds', '1', '--max-bytes', '1024', '--launch', sys.executable, '-u', '-c', program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    attached_line = tracer.stderr.readline()
    attached = json.loads(attached_line)
    assert tracer.stdout.readline().strip() == 'ready'
    for _ in range(20):
        os.kill(attached['pid'], signal.SIGHUP)
        time.sleep(.01)
    out, err = tracer.communicate(timeout=5)
    print(json.dumps({'bytes':len((attached_line+err).encode()), 'stdout':out, 'status':tracer.returncode}))
finally:
    if tracer.poll() is None:
        tracer.kill()
        tracer.wait()
`);
    expect(result.status).toBe(0);
    expect(result.bytes).toBeLessThanOrEqual(1024);
    expect(result.stdout).toContain('hup');
  });

  it('preserves a job-control stop when the observation deadline expires', () => {
    const result = probe(`
import subprocess, sys, os, signal, json, time
tracer = subprocess.Popen([sys.argv[1], '--seconds', '.3', '--launch', '/bin/sleep', '1'], stderr=subprocess.PIPE, text=True)
try:
    attached = json.loads(tracer.stderr.readline())
    os.kill(attached['pid'], signal.SIGSTOP)
    while True:
        event = json.loads(tracer.stderr.readline())
        if event['event'] == 'detached': break
    with open('/proc/%d/status' % attached['pid']) as status:
        state = next(line for line in status if line.startswith('State:'))
    os.kill(attached['pid'], signal.SIGCONT)
    tracer.wait(timeout=5)
    print(json.dumps({'state': state, 'status':tracer.returncode}))
finally:
    if tracer.poll() is None:
        tracer.kill()
        tracer.wait()
`);
    expect(result.state).toMatch(/T \(stopped\)/);
    expect(result.status).toBe(0);
  });

  it('preserves an ordinary nonzero agent exit after exec', () => {
    const result = probe(`
import subprocess, sys, json
tracer = subprocess.Popen([sys.argv[1], '--seconds', '1', '--launch', sys.executable, '-c', 'import sys; print("protocol",flush=True); sys.exit(7)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
out, err = tracer.communicate(timeout=5)
print(json.dumps({'stdout':out, 'status':tracer.returncode, 'events':[json.loads(line) for line in err.splitlines()]}))
`);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('protocol\n');
    expect(result.events).toContainEqual(expect.objectContaining({ event: 'exit', exitCode: 7 }));
  });

  it('cancels only the observer without terminating the adapter', () => {
    const result = probe(`
import subprocess, sys, os, signal, json
tracer = subprocess.Popen([sys.argv[1], '--seconds', '2', '--launch', sys.executable, '-c', 'import time; time.sleep(.4); print("alive",flush=True)'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
attached = json.loads(tracer.stderr.readline())
os.kill(attached['observerPid'], signal.SIGTERM)
out, err = tracer.communicate(timeout=5)
print(json.dumps({'stdout':out, 'status':tracer.returncode, 'events':[json.loads(line) for line in err.splitlines()]}))
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('alive\n');
    expect(result.events).toContainEqual(expect.objectContaining({ event: 'detached' }));
  });

  it('starts the adapter normally when ptrace is denied by a security policy', () => {
    const result = probe(`
import subprocess, sys, json, ctypes, platform
class Filter(ctypes.Structure):
    _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(Filter))]
number={'x86_64':101,'aarch64':117}[platform.machine()]
filters=(Filter*4)(Filter(0x20,0,0,0),Filter(0x15,0,1,number),Filter(6,0,0,0x50001),Filter(6,0,0,0x7fff0000))
program=Program(4,filters)
def deny_ptrace():
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(38,1,0,0,0) or libc.prctl(22,2,ctypes.byref(program),0,0):
        raise RuntimeError('cannot install test seccomp policy')
tracer=subprocess.Popen([sys.argv[1],'--seconds','1','--launch',sys.executable,'-c','import sys; print("protocol",flush=True); sys.exit(7)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=deny_ptrace)
out,err=tracer.communicate(timeout=8)
print(json.dumps({'stdout':out,'stderr':err,'status':tracer.returncode}))
`);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('protocol\n');
    expect(result.stderr).toContain('trace-failed');
  });

  it('delivers SIGHUP even when the diagnostic output reader has closed', () => {
    const result = probe(`
import subprocess, sys, os, signal, json
tracer=subprocess.Popen([sys.argv[1],'--seconds','2','--launch',sys.executable,'-c','import time; time.sleep(1)'],stderr=subprocess.PIPE,text=True)
attached=json.loads(tracer.stderr.readline())
tracer.stderr.close()
os.kill(attached['pid'],signal.SIGHUP)
tracer.wait(timeout=5)
print(json.dumps({'status':tracer.returncode}))
`);
    expect(result.status).toBe(-1);
  });

  it('starts the adapter even if diagnostic output is closed before attachment', () => {
    const result = probe(`
import subprocess, sys, json
tracer=subprocess.Popen([sys.argv[1],'--seconds','1','--launch',sys.executable,'-c','import sys; print("protocol",flush=True); sys.exit(7)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
tracer.stderr.close()
tracer.wait(timeout=8)
print(json.dumps({'stdout':tracer.stdout.read(),'status':tracer.returncode}))
`);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('protocol\n');
  });

  it('keeps signals and the deadline moving when diagnostic output is full', () => {
    const result = probe(`
import subprocess, sys, os, signal, json, fcntl, select
reader,writer=os.pipe()
program='import time,signal,fcntl,os; signal.signal(signal.SIGHUP,lambda *x: print("hup",flush=True)); print(fcntl.fcntl(2,fcntl.F_GETFL)&os.O_NONBLOCK,flush=True); time.sleep(1)'
tracer=subprocess.Popen([sys.argv[1],'--seconds','2','--launch',sys.executable,'-u','-c',program],stdout=subprocess.PIPE,stderr=writer,text=True)
stream=os.fdopen(reader)
try:
    attached=json.loads(stream.readline())
    flags=fcntl.fcntl(writer,fcntl.F_GETFL)
    fcntl.fcntl(writer,fcntl.F_SETFL,flags|os.O_NONBLOCK)
    while True:
        try: os.write(writer,b'x'*4096)
        except BlockingIOError: break
    fcntl.fcntl(writer,fcntl.F_SETFL,flags)
    blocking=tracer.stdout.readline().strip()
    os.kill(attached['pid'],signal.SIGHUP)
    assert select.select([tracer.stdout],[],[],3)[0], 'signal delivery blocked behind diagnostic output'
    delivered=tracer.stdout.readline().strip()
    tracer.wait(timeout=5)
    print(json.dumps({'blocking':blocking,'delivered':delivered,'status':tracer.returncode}))
finally:
    try: os.kill(attached['observerPid'],signal.SIGKILL)
    except ProcessLookupError: pass
    stream.close()
    os.close(writer)
    if tracer.poll() is None:
        tracer.kill()
        tracer.wait()
`);
    expect(result.status).toBe(0);
    expect(result.blocking).toBe('0');
    expect(result.delivered).toBe('hup');
  });

  it('execs the adapter when the observer cannot be created', () => {
    const result = probe(`
import subprocess, sys, json, ctypes, platform
class Filter(ctypes.Structure):
    _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(Filter))]
numbers={'x86_64':[56,57,58,435],'aarch64':[220,435]}[platform.machine()]
rows=[Filter(0x20,0,0,0)]
for number in numbers: rows.extend([Filter(0x15,0,1,number),Filter(6,0,0,0x5000b)])
rows.append(Filter(6,0,0,0x7fff0000))
filters=(Filter*len(rows))(*rows)
program=Program(len(rows),filters)
def deny_observer_creation():
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(38,1,0,0,0) or libc.prctl(22,2,ctypes.byref(program),0,0):
        raise RuntimeError('cannot install test seccomp policy')
tracer=subprocess.Popen([sys.argv[1],'--seconds','1','--launch',sys.executable,'-c','import sys; print("protocol",flush=True); sys.exit(7)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=deny_observer_creation)
out,err=tracer.communicate(timeout=8)
print(json.dumps({'stdout':out,'stderr':err,'status':tracer.returncode}))
`);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('protocol\n');
    expect(result.stderr).toContain('trace-failed');
  });

  it('captures signals through Node socketpair stdio used by the broker', () => {
    const result = probe(`
import subprocess,sys,json
code="""
const {spawn} = require('node:child_process');
const child=spawn('/usr/bin/python3',[process.argv[1],'--seconds','2','--launch','/bin/sleep','1']);
let buffer='', sent=false;
child.stderr.on('data',data=>{
 process.stdout.write(data); buffer+=data;
 if(!sent && buffer.includes(String.fromCharCode(10))) {
  const record=JSON.parse(buffer.split(String.fromCharCode(10))[0]);
  sent=true; process.kill(record.pid,'SIGHUP');
 }
});
child.on('exit',(code,signal)=>process.stdout.write(JSON.stringify({event:'adapter-result',code,signal})+String.fromCharCode(10)));
"""
node=subprocess.run(['node','-e',code,sys.argv[1]],capture_output=True,text=True,timeout=8)
assert node.returncode==0,node.stderr
print(json.dumps({'events':[json.loads(line) for line in node.stdout.splitlines()]}))
`);
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: 'signal', signal: 'SIGHUP' }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ event: 'adapter-result', code: null, signal: 'SIGHUP' }),
    );
  });
});

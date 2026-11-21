import type { ProjectRecord } from '@verity/store';
import type { RuntimeRunner } from './project-runtime.js';

export interface CapacityLeaseInput {
  userId: string;
  generation: string;
  action: 'create' | 'status' | 'retire';
  operationId: string;
}
export interface CapacityLeaseReply {
  ok: true;
  capacityLeaseVersion: 1;
  operationId: string;
  generation: string;
  state: 'held' | 'idle' | 'retired' | 'unknown';
  path: string;
  identity?: { device: string; inode: string };
}

const ROOT = '/run/verity-capacity-leases';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// The bridge is constant; only the validated protocol frame travels on stdin.
const BRIDGE = `const net=require('node:net');let input='',output='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>2048)process.exit(1)});
process.stdin.on('end',()=>{const socket=net.createConnection('/run/verity-runner-broker/agent-spawn-broker.sock');
socket.setTimeout(10000,()=>{socket.destroy();process.exit(1)});socket.on('error',()=>process.exit(1));
socket.on('connect',()=>socket.write(input));socket.on('data',chunk=>{output+=chunk;if(output.length>4096)process.exit(1)});
socket.on('end',()=>{try{const value=JSON.parse(output);if(value.ok!==true)process.exit(1);process.stdout.write(JSON.stringify(value))}catch{process.exit(1)}});});`;
const INSPECT =
  '{{json .Id}}\n{{json .State.Running}}\n{{json (index .Config.Labels "verity.project-id")}}\n{{json (index .Config.Labels "verity.container-generation")}}';

/** The caller resolves the user's sandbox from the store, never from request input. */
export async function requestProjectCapacityLease(
  project: ProjectRecord,
  input: CapacityLeaseInput,
  options: { runner: RuntimeRunner; dockerCommand: string; env: NodeJS.ProcessEnv },
): Promise<CapacityLeaseReply> {
  if (
    typeof input.operationId !== 'string' ||
    !UUID.test(input.operationId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.generation) ||
    !['create', 'status', 'retire'].includes(input.action) ||
    typeof input.userId !== 'string' ||
    !input.userId
  ) {
    throw new Error('Invalid capacity lease request.');
  }
  const path = `${ROOT}/${input.operationId}.lock`;
  const unknown: CapacityLeaseReply = {
    ok: true,
    capacityLeaseVersion: 1,
    operationId: input.operationId,
    generation: input.generation,
    state: 'unknown',
    path,
  };
  try {
    const inspect = await options.runner(
      options.dockerCommand,
      ['inspect', '--format', INSPECT, project.containerName],
      { env: options.env, timeoutMs: 10_000, maxBuffer: 4096 },
    );
    const lines = (inspect?.stdout ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    if (
      lines.length !== 4 ||
      typeof lines[0] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(lines[0]) ||
      lines[1] !== true ||
      lines[2] !== project.id ||
      lines[3] !== input.generation
    )
      return unknown;
    const result = await options.runner(
      options.dockerCommand,
      ['exec', '-i', '--user', '0', lines[0], 'node', '-e', BRIDGE],
      {
        env: options.env,
        timeoutMs: 15_000,
        maxBuffer: 4096,
        stdin:
          JSON.stringify({
            protocolVersion: 1,
            kind: 'capacity-lease',
            action: input.action,
            generation: input.generation,
            operationId: input.operationId,
          }) + '\n',
      },
    );
    const response = JSON.parse(result?.stdout ?? '') as CapacityLeaseReply;
    if (
      response.ok !== true ||
      response.capacityLeaseVersion !== 1 ||
      response.operationId !== input.operationId ||
      response.generation !== input.generation ||
      response.path !== path ||
      !['held', 'idle', 'retired', 'unknown'].includes(response.state) ||
      (response.state !== 'unknown' &&
        (!response.identity ||
          typeof response.identity.device !== 'string' ||
          typeof response.identity.inode !== 'string' ||
          !/^[0-9]+$/.test(response.identity.device) ||
          !/^[0-9]+$/.test(response.identity.inode)))
    )
      return unknown;
    return response;
  } catch {
    return unknown;
  }
}

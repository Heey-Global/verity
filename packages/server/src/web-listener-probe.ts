import type { ListeningProcess } from './listening-ports.js';

export interface WebListenerResult {
  protocol: 'http' | 'https';
  certificateFingerprint?: string;
}

/** Runs inside the sandbox. No project URLs, redirects, credentials or bodies. */
export const WEB_LISTENER_PROBE_SCRIPT = String.raw`
const http=require('node:http'),https=require('node:https'),net=require('node:net');
const input=JSON.parse(process.argv[1]);
function request(target,secure){return new Promise(resolve=>{
  let done=false,req;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);req?.destroy();resolve(value)};
  const timer=setTimeout(()=>finish(null),400);
  try{
    if(!net.isIP(target.host)||!Number.isInteger(target.port)||target.port<1||target.port>65535)return finish(null);
    req=(secure?https:http).request({host:target.host,port:target.port,path:'/',method:'HEAD',agent:false,maxHeaderSize:8192,...(secure?{rejectUnauthorized:false}:{})},response=>{
      const fingerprint=secure?response.socket.getPeerCertificate()?.fingerprint256:undefined;
      const valid=response.statusCode>=100&&response.statusCode<=599;
      response.destroy();finish(valid&&(!secure||fingerprint)?{protocol:secure?'https':'http',...(fingerprint?{certificateFingerprint:fingerprint}:{})}:null);
    });
    req.on('error',()=>finish(null));req.end();
  }catch{finish(null)}
})}
(async()=>{const targets=input.slice(0,16),results=new Array(targets.length);let next=0;async function worker(){while(next<targets.length){const index=next++,target=targets[index];results[index]=await request(target,true)||await request(target,false)}}await Promise.all([worker(),worker()]);process.stdout.write(JSON.stringify(results))})().catch(()=>process.exit(1));
`;

const POSITIVE_TTL_MS = 10_000;
const NEGATIVE_TTL_MS = 2_000;
export const WEB_PROBE_BATCH_SIZE = 16;

/** Socket identity and sandbox generation prevent reusing a verdict after rebinding. */
export class WebListenerClassifier {
  private readonly caches = new Map<
    string,
    Map<string, { at: number; result: WebListenerResult | null }>
  >();
  private readonly pending = new Map<string, Promise<ListeningProcess[]>>();

  async classify(
    sandbox: string,
    processes: readonly ListeningProcess[],
    probe: (targets: readonly { host: string; port: number }[]) => Promise<unknown>,
    fresh = false,
  ): Promise<ListeningProcess[]> {
    const identity = (p: ListeningProcess) =>
      JSON.stringify([
        p.sandboxGeneration,
        p.socketInode,
        p.pid,
        p.port,
        p.listenerAddress,
        p.command,
      ]);
    const signature = JSON.stringify([sandbox, processes.map(identity), fresh]);
    const pending = this.pending.get(signature);
    if (pending) return pending;
    const operation = (async () => {
      const now = Date.now();
      const keys = new Set(processes.map(identity));
      const cache =
        this.caches.get(sandbox) ??
        new Map<string, { at: number; result: WebListenerResult | null }>();
      this.caches.set(sandbox, cache);
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
      const stale = processes.filter((p) => {
        const entry = cache.get(identity(p));
        return (
          fresh || !entry || now - entry.at >= (entry.result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)
        );
      });
      // Oldest evidence first prevents deferred listeners from starving.
      stale.sort(
        (a, b) =>
          (cache.get(identity(a))?.at ?? -Infinity) - (cache.get(identity(b))?.at ?? -Infinity),
      );
      const selected = stale.slice(0, WEB_PROBE_BATCH_SIZE);
      if (selected.length) {
        let results: unknown;
        try {
          results = await probe(
            selected.map((p) => ({
              host:
                p.listenerAddress ?? p.loopbackAddress ?? (p.ipv6Wildcard ? '::1' : '127.0.0.1'),
              port: p.port,
            })),
          );
        } catch {
          results = [];
        }
        for (const [index, p] of selected.entries()) {
          const value: unknown = Array.isArray(results) ? results[index] : undefined;
          const result = parseWebListenerResult(value);
          cache.set(identity(p), { at: Date.now(), result });
        }
      }
      return processes.map((p) => {
        const raw = { ...p };
        delete raw.webProtocol;
        delete raw.webCertificateFingerprint;
        const entry = cache.get(identity(p));
        // A deferred recheck does not revoke evidence for the same live socket.
        // Rebinding prunes the identity above; an actual negative probe removes it.
        if (!entry?.result) return raw;
        return {
          ...raw,
          webProtocol: entry.result.protocol,
          ...(entry.result.certificateFingerprint
            ? { webCertificateFingerprint: entry.result.certificateFingerprint }
            : {}),
        };
      });
    })();
    this.pending.set(signature, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(signature) === operation) this.pending.delete(signature);
    }
  }
}

function parseWebListenerResult(value: unknown): WebListenerResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<WebListenerResult>;
  if (result.protocol === 'http') return { protocol: 'http' };
  if (
    result.protocol === 'https' &&
    typeof result.certificateFingerprint === 'string' &&
    /^(?:[\dA-F]{2}:){31}[\dA-F]{2}$/iu.test(result.certificateFingerprint)
  )
    return {
      protocol: 'https',
      certificateFingerprint: result.certificateFingerprint.toUpperCase(),
    };
  return null;
}

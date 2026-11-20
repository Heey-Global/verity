// HTTPS is terminated only inside the sandbox, pinned to the certificate observed
// by local discovery. Connector and edge certificate verification stay unchanged.
const CHILD_SCRIPT = String.raw`
const net=require('node:net'),tls=require('node:tls'),fs=require('node:fs');
const port=Number(process.env.VERITY_PREVIEW_FORWARDER),relay=Number(process.env.VERITY_PREVIEW_FORWARDER_PORT);
const address=process.env.VERITY_PREVIEW_FORWARDER_ADDRESS,protocol=process.env.VERITY_PREVIEW_FORWARDER_PROTOCOL;
const fingerprint=process.env.VERITY_PREVIEW_FORWARDER_FINGERPRINT;
const normalize=value=>(value||'').replace(/:/g,'').toLowerCase();
const server=net.createServer(client=>{
  let connected=false;
  const options={host:address,port};
  const target=protocol==='https'?tls.connect({...options,rejectUnauthorized:false}):net.connect(options);
  const deadline=setTimeout(()=>{target.destroy();client.destroy()},1000);
  target.once(protocol==='https'?'secureConnect':'connect',()=>{
    clearTimeout(deadline);
    if(protocol==='https'&&normalize(target.getPeerCertificate().fingerprint256)!==fingerprint){target.destroy();client.destroy();return}
    connected=true;client.pipe(target);target.pipe(client);
  });
  const close=()=>{clearTimeout(deadline);target.destroy();client.destroy()};
  client.on('error',close);target.on('error',close);
  client.on('close',()=>{clearTimeout(deadline);target.destroy()});
  target.on('close',()=>{clearTimeout(deadline);if(!connected)client.destroy()});
});
server.on('error',()=>process.exit(1));
server.listen(relay,'0.0.0.0',()=>{process.send({port:server.address().port});process.disconnect()});
setInterval(()=>{try{
  const present=['/proc/net/tcp','/proc/net/tcp6'].some(p=>fs.readFileSync(p,'utf8').split('\n').some(l=>{const f=l.trim().split(/\s+/);return f[3]==='0A'&&parseInt(f[1]?.split(':')[1],16)===port}));
  if(!present)process.exit(0);
}catch{}},2000).unref();
`;

/** Retain a relay port across helper crashes, but replace changed TLS identities. */
export const PREVIEW_FORWARDER_SCRIPT = String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const address=process.argv[2]||'127.0.0.1',port=Number(process.argv[1]);
const protocol=process.argv[3]||'http',fingerprint=(process.argv[4]||'').replace(/:/g,'').toLowerCase();
if(!['http','https'].includes(protocol)||(protocol==='https'&&!/^[a-f0-9]{64}$/.test(fingerprint)))process.exit(1);
const dir=process.env.VERITY_PREVIEW_FORWARDER_STATE_DIR||'/tmp/verity-preview-forwarders';
fs.mkdirSync(dir,{recursive:true});const path=dir+'/'+port+'.json';let previous;
function ownsListener(pid,relay){
  try{
    const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
    if(!env.includes('VERITY_PREVIEW_FORWARDER='+port))return false;
    const inodes=new Set(fs.readdirSync('/proc/'+pid+'/fd').flatMap(f=>{try{return [fs.readlinkSync('/proc/'+pid+'/fd/'+f).match(/^socket:\[(\d+)\]$/)?.[1]]}catch{return []}}));
    return fs.readFileSync('/proc/net/tcp','utf8').split('\n').some(line=>{const f=line.trim().split(/\s+/);return f[3]==='0A'&&parseInt(f[1]?.split(':')[1],16)===relay&&inodes.has(f[9])});
  }catch{return false}
}
try{
  previous=JSON.parse(fs.readFileSync(path,'utf8'));
  if(Number.isInteger(previous.port)&&previous.port>0&&previous.port<65536&&ownsListener(previous.pid,previous.port)){
    const env=fs.readFileSync('/proc/'+previous.pid+'/environ','utf8').split('\0');
    const matches=env.includes('VERITY_PREVIEW_FORWARDER_ADDRESS='+address)&&env.includes('VERITY_PREVIEW_FORWARDER_PROTOCOL='+protocol)&&env.includes('VERITY_PREVIEW_FORWARDER_FINGERPRINT='+fingerprint);
    if(matches){console.log(previous.port);process.exit(0)}
    process.kill(previous.pid);previous=undefined;
  }
}catch{}
const relay=Number.isInteger(previous?.port)&&previous.port>0&&previous.port<65536?previous.port:0;
const child=cp.spawn(process.execPath,['-e',${JSON.stringify(CHILD_SCRIPT)}],{
  detached:true,
  env:{...process.env,VERITY_PREVIEW_FORWARDER:String(port),VERITY_PREVIEW_FORWARDER_PORT:String(relay),VERITY_PREVIEW_FORWARDER_ADDRESS:address,VERITY_PREVIEW_FORWARDER_PROTOCOL:protocol,VERITY_PREVIEW_FORWARDER_FINGERPRINT:fingerprint},
  stdio:['ignore','ignore','ignore','ipc']
});
child.on('message',value=>{fs.writeFileSync(path,JSON.stringify({pid:child.pid,port:value.port}),{mode:0o600});console.log(value.port);child.unref()});
child.on('error',()=>process.exit(1));child.on('exit',()=>process.exit(1));setTimeout(()=>process.exit(1),4000).unref();
`;

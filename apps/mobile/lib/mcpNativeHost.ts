export const MCP_NATIVE_MESSAGE_LIMIT = 1024 * 1024;
export const MCP_NATIVE_DOCUMENT_LIMIT = 8 * 1024 * 1024;

/** Safe inside both an HTML script element and an injected JavaScript expression. */
export function scriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** A fixed local host owns the native bridge; untrusted HTML only enters its opaque frame. */
export function nativeMcpHost(document: string, channel: string): string {
  if (document.length > MCP_NATIVE_DOCUMENT_LIMIT) throw new Error('MCP app document too large');
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(channel)) throw new Error('Invalid MCP host channel');
  // srcdoc inherits this policy. Its server-supplied meta policy further restricts resources.
  // This local policy is independent of the production Verity web-page policy.
  const policy =
    "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; media-src https:; connect-src https:; frame-src about:; worker-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe title="Interactive app" sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" referrerpolicy="no-referrer"></iframe><script>
  (()=>{
    const channel=${scriptValue(channel)}, limit=${MCP_NATIVE_MESSAGE_LIMIT};
    const frame=document.querySelector('iframe');
    const native=window.ReactNativeWebView;
    let closed=false, loaded=false, count=0, start=Date.now();
    const post=(kind,message)=>{if(!closed)native.postMessage(JSON.stringify({channel,kind,message}));};
    const fail=()=>{post('failed');closed=true;frame.remove();};
    window.__verityMcpReceive=(envelope)=>{
      if(closed||!envelope||envelope.channel!==channel)return;
      const message=envelope.message;
      if(JSON.stringify(message).length>limit)return fail();
      frame.contentWindow.postMessage(message,'*');
    };
    window.addEventListener('message',event=>{
      if(closed||event.source!==frame.contentWindow)return;
      if(Date.now()-start>=1000){start=Date.now();count=0;}
      if(++count>128)return fail();
      try {if(JSON.stringify(event.data).length>limit)return fail();post('rpc',event.data);}catch{fail();}
    });
    frame.addEventListener('load',()=>{if(loaded)fail();else loaded=true;});
    post('ready');
    frame.srcdoc=${scriptValue(document)};
  })();
  </script></body></html>`;
}

/** No initial or subsequent navigation may leave the fixed local document. */
export function nativeMcpNavigation(url: string): boolean {
  return url === 'about:blank' || url === 'about:srcdoc';
}

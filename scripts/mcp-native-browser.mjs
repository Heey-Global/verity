// Real SDK/Chromium regression for the native wrapper and transport, without a listener.
// This checks browser semantics, not WKWebView/Android WebView runtime behavior.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';

const cache = resolve('.cache/mcp-native-browser');
await mkdir(cache, { recursive: true });
const hostBundle = await build({
  stdin: {
    contents: `export {nativeMcpHost} from './apps/mobile/lib/mcpNativeHost'; export {NativeMcpTransport} from './apps/mobile/lib/mcpNativeTransport'; export {appDocument} from './packages/server/src/mcp-apps-routes';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  write: false,
  format: 'esm',
  platform: 'node',
});
await writeFile(resolve(cache, 'host.mjs'), hostBundle.outputFiles[0].text);
const loaded = /** @type {unknown} */ (
  await import(pathToFileURL(resolve(cache, 'host.mjs')).href)
);
const { nativeMcpHost, NativeMcpTransport, appDocument } =
  /** @type {{ nativeMcpHost: typeof import('../apps/mobile/lib/mcpNativeHost.js').nativeMcpHost; NativeMcpTransport: typeof import('../apps/mobile/lib/mcpNativeTransport.js').NativeMcpTransport; appDocument: typeof import('../packages/server/src/mcp-apps-routes.js').appDocument }} */ (
    loaded
  );
/** @typedef {{ReactNativeWebView?: {postMessage(raw: string): void}; nativePost(raw: string): Promise<void>; document: {querySelector(selector: string): unknown}}} NativeGlobals */
const sdk = await build({
  stdin: {
    contents: `import {App} from '@modelcontextprotocol/ext-apps';
 const blocked=fn=>{try{fn();return false}catch{return true}};
 for(const [key,value] of Object.entries({parent:blocked(()=>parent.document.body),bridge:blocked(()=>parent.ReactNativeWebView),cookie:blocked(()=>document.cookie),storage:blocked(()=>localStorage.length)}))document.body.setAttribute('data-'+key,String(value));
 const app=new App({name:'Native fixture',version:'1.0.0'});
 app.ontoolinput=input=>document.body.setAttribute('data-input',input.arguments.query);
 app.ontoolresult=result=>document.getElementById('result').textContent=String(result.structuredContent.count);
 document.getElementById('refresh').onclick=async()=>{try{app.ontoolresult(await app.callServerTool({name:'refresh',arguments:{}}))}catch{document.getElementById('denied').textContent='denied'}};
 document.getElementById('navigate').onclick=()=>location.href='about:blank';
 app.connect();`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const document = appDocument(
  `<output id="result">waiting</output><output id="denied"></output><button id="refresh">Refresh</button><button id="navigate">Navigate</button><script>${sdk.outputFiles[0].text}</script>`,
);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
const context = await browser.newContext();
const page = await context.newPage();
const channel = 'dfbf27da-bbe6-4f5e-8548-6b6a15ec3cee';
let failures = 0,
  calls = 0,
  allow = true;
/** @type {Set<Promise<unknown>>} */
const scripts = new Set();
const transport = new NativeMcpTransport(
  channel,
  (script) => {
    const job = page.evaluate(script);
    scripts.add(job);
    void job.finally(() => scripts.delete(job));
  },
  () => {
    failures++;
  },
);
const bridge = new AppBridge(
  null,
  { name: 'Verity', version: '1.0.0' },
  { serverTools: {} },
  { hostContext: { platform: 'mobile', displayMode: 'inline', availableDisplayModes: ['inline'] } },
);
/** @param {number} count */
const result = (count) => ({
  content: [{ type: 'text', text: String(count) }],
  structuredContent: { count },
});
bridge.oninitialized = () => {
  void bridge
    .sendToolInput({ arguments: { query: 'documents' } })
    .then(() => bridge.sendToolResult(result(3)));
};
bridge.oncalltool = () => {
  calls++;
  if (!allow) return Promise.reject(new Error('Approval denied'));
  return Promise.resolve(result(4));
};
try {
  await page.exposeFunction('nativePost', (/** @type {unknown} */ raw) => {
    if (typeof raw === 'string') transport.receive(raw);
  });
  await context.addInitScript(() => {
    const globals = /** @type {NativeGlobals} */ (/** @type {unknown} */ (globalThis));
    globals.ReactNativeWebView = {
      postMessage: (raw) => {
        void globals.nativePost(raw);
      },
    };
  });
  await bridge.connect(transport);
  await page.evaluate(() => {
    const globals = /** @type {NativeGlobals} */ (/** @type {unknown} */ (globalThis));
    globals.ReactNativeWebView = {
      postMessage: (raw) => {
        void globals.nativePost(raw);
      },
    };
  });
  const html = nativeMcpHost(document, channel);
  // Mutation mode demonstrates that the isolation assertions reject a weakened sandbox.
  await page.setContent(
    process.argv.includes('--unsafe-sandbox')
      ? html.replace('sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"')
      : html,
  );
  const frame = page.frameLocator('iframe');
  await frame.locator('#result').filter({ hasText: '3' }).waitFor();
  assert.equal(await frame.locator('body').getAttribute('data-input'), 'documents');
  for (const key of ['parent', 'bridge', 'cookie', 'storage'])
    assert.equal(await frame.locator('body').getAttribute('data-' + key), 'true');
  // Android can expose the raw native API to child frames. Unknown channels grant no authority.
  await frame.locator('body').evaluate(() => {
    const globals = /** @type {NativeGlobals} */ (/** @type {unknown} */ (globalThis));
    globals.ReactNativeWebView?.postMessage(
      JSON.stringify({
        kind: 'rpc',
        channel: 'forged',
        message: { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'refresh' } },
      }),
    );
  });
  assert.equal(calls, 0);
  await frame.locator('#refresh').click();
  await frame.locator('#result').filter({ hasText: '4' }).waitFor();
  allow = false;
  await frame.locator('#refresh').click();
  await frame.locator('#denied').filter({ hasText: 'denied' }).waitFor();
  await bridge.sendToolResult(result(5));
  await frame.locator('#result').filter({ hasText: '5' }).waitFor();
  await page.waitForTimeout(16_000);
  assert.equal(await frame.locator('#result').textContent(), '5');
  assert.equal(failures, 0);
  await frame.locator('#navigate').click();
  await page.waitForFunction(() => {
    const globals = /** @type {NativeGlobals} */ (/** @type {unknown} */ (globalThis));
    return globals.document.querySelector('iframe') === null;
  });
  assert.equal(failures, 1);
  console.log(
    'PASS: native host SDK handshake, saved input/result, refresh, denied action, result update, timeout survival, isolation and navigation revocation',
  );
} finally {
  await bridge.close();
  await Promise.allSettled([...scripts]);
  await context.close();
  await browser.close();
}

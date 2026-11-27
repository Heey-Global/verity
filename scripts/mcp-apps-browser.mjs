// Run --build first, then --check for portless Fastify/Chromium verification.
// For a network test, use --serve through Verity, then --check <managed URL>.
// The host uses the real web card, server routes, production CSP and Apps SDK.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import assert from 'node:assert/strict';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
const cache = resolve(root, '.cache/mcp-apps-browser');
const event = {
  t: 'mcp_app',
  appId: '00000000-0000-4000-8000-000000000001',
  projectId: 'p',
  sessionId: 's',
  turnId: 'finished',
  connectionId: 'c',
  toolName: 'dashboard',
  resourceUri: 'ui://dashboard',
  input: {},
  result: { content: [{ type: 'text', text: 'Count: 0' }], structuredContent: { count: 0 } },
};

/** @param {string} contents @param {import('esbuild').BuildOptions} [options] */
async function bundle(contents, options = {}) {
  return build({
    stdin: { contents, resolveDir: root, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    ...options,
  });
}

async function prepare() {
  await mkdir(cache, { recursive: true });
  const sdk = await bundle(`import {App} from '@modelcontextprotocol/ext-apps';
    const blocked = (action) => {try {action(); return false;} catch {return true;}};
    const isolation = {
      parent: blocked(()=>parent.document.body),
      cookie: blocked(()=>document.cookie), storage: blocked(()=>localStorage.length)
    };
    for (const [key,value] of Object.entries(isolation)) document.body.setAttribute('data-'+key,String(value));
    const app = new App({name:'SDK regression fixture',version:'1.0.0'});
    app.ontoolresult = r => document.getElementById('count').textContent='Count: '+r.structuredContent.count;
    document.getElementById('refresh').onclick = async()=>app.ontoolresult(await app.callServerTool({name:'refresh',arguments:{}}));
    app.connect().catch(e=>console.error(e));`);
  const document = `<output id="count">Waiting</output><button id="refresh">Refresh</button><script>${sdk.outputFiles[0].text}</script>`;
  for (const legacy of [false, true]) {
    /** @type {import('esbuild').Plugin} */
    const plugin = {
      name: 'native-shell-stubs',
      setup(b) {
        b.onResolve(
          {
            filter:
              /^(react-native-unistyles|@verity\/events|\.\.\/lib\/client|\.\/ui\/(Card|Text))$/,
          },
          (a) => ({ path: a.path, namespace: 'shell' }),
        );
        b.onLoad({ filter: /.*/, namespace: 'shell' }, (a) => ({
          contents:
            a.path === 'react-native-unistyles'
              ? `export const useUnistyles=()=>({theme:{colors:{surface:'#fff'}},rt:{themeName:'dark'}});`
              : a.path === '@verity/events'
                ? `export const actionTitle=()=> 'SDK regression fixture';`
                : a.path === '../lib/client'
                  ? `const client={
                createMcpAppDocumentUrl:async()=>${legacy ? JSON.stringify(document) : `(await (await fetch('/sessions/s/mcp-apps/${event.appId}/document',{method:'POST'})).json()).path`},
                callMcpAppTool:async(s,a,call)=> (await fetch('/sessions/s/mcp-apps/${event.appId}/call',{
                  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(call)})).json()
              }; export const createVerityClient=()=>client;`
                  : `import React from 'react'; export const ${a.path.endsWith('Card') ? 'Card' : 'Text'}=({children})=>React.createElement('div',null,children);`,
          resolveDir: root,
          loader: 'js',
        }));
        if (legacy)
          b.onLoad({ filter: /McpAppCard\.web\.tsx$/ }, async (a) => ({
            contents: (await readFile(a.path, 'utf8')).replace(
              'iframe.src = documentUrl;',
              'iframe.srcdoc = documentUrl;',
            ),
            resolveDir: resolve(root, 'apps/mobile/components'),
            loader: 'tsx',
          }));
      },
    };
    const host = await bundle(
      `import React from 'react';import {createRoot} from 'react-dom/client';
      import {McpAppCard} from './apps/mobile/components/McpAppCard.web.tsx';
      window.React=React;createRoot(document.getElementById('root')).render(React.createElement(McpAppCard,{event:${JSON.stringify(event)}}));`,
      { plugins: [plugin] },
    );
    const name = legacy ? 'legacy' : 'index';
    await writeFile(resolve(cache, `${name}.js`), host.outputFiles[0].text);
    await writeFile(
      resolve(cache, `${name}.html`),
      `<div id="root"></div><script src="/app/${name}.js"></script>`,
    );
  }
  // Bundle the real TypeScript route modules; keep installed Node packages external.
  await build({
    stdin: {
      contents: `
    import Fastify from 'fastify';
    import compress from '@fastify/compress';
    import {registerWebAppRoutes} from './packages/server/src/web-app.ts';
    import {registerMcpAppsRoutes} from './packages/server/src/mcp-apps-routes.ts';
    import {connectionFingerprint} from './packages/server/src/mcp-apps.ts';
    import {dashboardFixture} from './packages/server/src/mcp-apps-fixture.test-helper.ts';
    const app=Fastify();await app.register(compress,{global:false});
    registerWebAppRoutes(app,${JSON.stringify(cache)});
    const fixture=dashboardFixture(); const connection={id:'c',url:'https://fixture.example'};
    const event={...${JSON.stringify(event)},connectionFingerprint:connectionFingerprint(connection)};
    registerMcpAppsRoutes(app,{
      authorizeRequest:async()=>true,captureDocumentAccess:()=>async()=>true,
      resolveConnection:async()=>connection,getProjectId:async()=> 'p',getApp:async()=>event,
      emit:async()=>{},approve:async()=>true,settled:async()=>{},closeSession:async()=>{},
      rpc:async(c,m,p,s,v)=>m==='resources/read'?{result:{contents:[{
        uri:event.resourceUri,mimeType:'text/html;profile=mcp-app',text:${JSON.stringify(document)}
      }]}}:fixture.rpc(c,m,p,s,v),
    });
    export {app};
    `,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: resolve(cache, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    alias: { '@verity/events': resolve(root, 'packages/events/src/index.ts') },
  });
}

/** @returns {Promise<import('fastify').FastifyInstance>} */
async function loadFixtureApp() {
  /** @type {unknown} */
  const module = await import(pathToFileURL(resolve(cache, 'server.mjs')).href);
  /** @type {unknown} */
  const value = Reflect.get(/** @type {object} */ (module), 'app');
  return /** @type {import('fastify').FastifyInstance} */ (value);
}

/** @param {string | undefined} baseUrl */
async function check(baseUrl) {
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });
  try {
    const context = await browser.newContext();
    if (!baseUrl) {
      const app = await loadFixtureApp();
      await context.route('http://verity.test/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const data = request.postDataBuffer();
        const response = await app.inject({
          method: /** @type {import('fastify').HTTPMethods} */ (request.method()),
          url: url.pathname + url.search,
          headers: request.headers(),
          ...(data ? { payload: data } : {}),
        });
        const headers = Object.fromEntries(
          Object.entries(response.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
        );
        await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
      });
      context.on('close', () => void app.close());
    }
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    const base = (baseUrl ?? 'http://verity.test').replace(/\/$/, '');
    await page.goto(`${base}/app/legacy.html`);
    await page
      .getByText('Interactive app unavailable.', { exact: false })
      .waitFor({ timeout: 25_000 });
    assert(
      errors.some((e) => /Content Security Policy|script-src/.test(e)),
      'Legacy must fail because of the production CSP',
    );
    console.log('PASS: legacy srcdoc is blocked by production CSP');
    errors.length = 0;
    const response = await page.goto(`${base}/app/`);
    assert(response);
    const parentPolicy = response.headers()['content-security-policy'];
    assert(parentPolicy?.includes("script-src 'self' 'wasm-unsafe-eval'"));
    const frame = page.frameLocator('iframe');
    await frame.locator('#count').filter({ hasText: 'Count: 0' }).waitFor();
    for (const key of ['parent', 'cookie', 'storage']) {
      assert.equal(await frame.locator('body').getAttribute('data-' + key), 'true');
    }
    await frame.locator('#refresh').click();
    await frame.locator('#count').filter({ hasText: 'Count: 1' }).waitFor();
    await page.waitForTimeout(16_000);
    assert.equal(await page.getByText('Interactive app unavailable.', { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
    // A fresh document opened at top level must also have an opaque origin.
    const minted = await page.evaluate(
      async (url) => (await fetch(url, { method: 'POST' })).text(),
      `${base}/sessions/s/mcp-apps/${event.appId}/document`,
    );
    const { path } = z.object({ path: z.string() }).parse(JSON.parse(minted));
    const direct = await context.newPage();
    const documentResponse = await direct.goto(`${base}${path}`);
    assert(
      documentResponse.headers()['content-security-policy'].includes('sandbox allow-scripts;'),
    );
    for (const key of ['cookie', 'storage']) {
      assert.equal(await direct.locator('body').getAttribute('data-' + key), 'true');
    }
    assert.equal(
      await page.evaluate(async (url) => (await fetch(url)).status, `${base}${path}`),
      404,
    );
    console.log(
      'PASS: SDK handshake, result, refresh, timeout survival, opaque-origin isolation, direct navigation and one-use ticket',
    );
  } finally {
    await browser.close();
  }
}

if (process.argv[2] === '--build') await prepare();
else if (process.argv[2] === '--serve') {
  console.log('Starting MCP Apps browser test server');
  const app = await loadFixtureApp();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT) });
} else if (process.argv[2] === '--check') await check(process.argv[3]);
else throw new Error('Use --build, --serve through verity dev-server, or --check <managed URL>');

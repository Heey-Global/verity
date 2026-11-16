// Shared plumbing for scripts that render the browser export of apps/mobile with
// Playwright: serving the static export, opening a page in demo mode, and waiting
// until the page has settled. Used by render-app-screens.mjs (website and App
// Store images) and render-mockups.mjs (spec mockups).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';
import { URL } from 'node:url';

// Storage keys read by apps/mobile/lib/demoMode.ts and demoShowcase.ts.
const DEMO_STORAGE = { 'verity.demoMode.v1': '1', 'verity.demoShowcase.v1': '1' };

// The callbacks passed to `page.evaluate` run in the page. The scripts' type
// program has no DOM library (adding it would retype `fetch` for every script),
// so each callback reads the few browser globals it needs through this shape.
/**
 * @typedef {{ innerText: string, getBoundingClientRect(): { x: number, y: number, width: number, height: number } }} PageElement
 * @typedef {{
 *   document: {
 *     fonts: { ready: Promise<unknown> },
 *     querySelectorAll(selector: string): ArrayLike<PageElement>,
 *     activeElement: { blur?: () => void } | null,
 *   },
 *   localStorage: { setItem(key: string, value: string): void },
 * }} PageGlobals
 */

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};

/**
 * Fails with the build command when the export is missing, instead of rendering
 * an empty page.
 * @param {string} dist
 */
export function requireExport(dist) {
  if (!existsSync(join(dist, 'index.html')))
    throw new Error(
      `No browser export in ${dist}. Run: npm run build:web --workspace @verity/mobile-app -- --max-workers 1`,
    );
}

// The export expects the `/app` base path (apps/mobile/app.config.ts) and
// client-side routing, so unknown paths fall back to index.html.
/**
 * @param {string} dist
 * @returns {Promise<import('node:http').Server>}
 */
export function serve(dist) {
  const server = createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    } catch {
      // A malformed escape is served the app shell like any unknown path.
    }
    let file = join(dist, pathname.replace(/^\/app(?=\/|$)/, ''));
    if (!file.startsWith(dist + sep) || !existsSync(file) || statSync(file).isDirectory())
      file = join(dist, 'index.html');
    res.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

/**
 * The base URL of a server started by `serve`, including the export's base path.
 * @param {import('node:http').Server} server
 */
export function exportBaseUrl(server) {
  const address = /** @type {import('node:net').AddressInfo | null} */ (server.address());
  return `http://127.0.0.1:${address?.port}/app`;
}

/** @param {import('playwright').Page} page */
export async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    () => /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis)).document.fonts.ready,
  );
  // Demo replies and layout animations are timer-driven, not network-driven.
  await page.waitForTimeout(1500);
}

/**
 * Opens a page whose storage switches the app into the demo transport before
 * the bundle runs, so no real server or credential is involved. Page errors are
 * collected in `errors`; callers fail the render when it is not empty.
 * @param {import('playwright').Browser} browser
 * @param {{ viewport: { width: number, height: number }, deviceScaleFactor?: number }} options
 */
export async function openDemoPage(browser, { viewport, deviceScaleFactor }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: deviceScaleFactor ?? 2,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
  });
  await context.addInitScript((entries) => {
    const { localStorage } = /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis));
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, DEMO_STORAGE);
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/**
 * The browser client focuses the composer; images show it at rest.
 * @param {import('playwright').Page} page
 */
export async function blurFocus(page) {
  await page.evaluate(() => {
    const { document } = /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis));
    document.activeElement?.blur?.();
  });
  await page.waitForTimeout(300);
}

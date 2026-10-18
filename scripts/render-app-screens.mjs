#!/usr/bin/env node
// Renders product images for the website from the real app. The browser export
// of apps/mobile runs in demo mode with the showcase scenario
// (apps/mobile/lib/demoShowcase.ts), so every image shows the shipped
// components with sample data instead of a hand-edited screenshot.
//
//   npm run build:web --workspace @verity/mobile-app -- --max-workers 1
//   npx playwright install chromium-headless-shell
//   npm run render:app-screens -- [--only <name>] [--out <dir>]
//
// Each scene writes `app-<name>.png` at twice the CSS resolution unless it is
// only there for its crops; a crop writes one PNG per component, cut to the
// smallest element containing all of the crop's text markers. The files sit
// directly in the website's assets folder because the website's checks and
// Dockerfile list every asset by its flat `assets/<file>` path.
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: join(root, 'apps/mobile/dist') },
    out: { type: 'string', default: join(root, 'docs/website/site/assets') },
    only: { type: 'string', multiple: true },
  },
});

// Storage keys read by apps/mobile/lib/demoMode.ts and demoShowcase.ts.
const STORAGE = { 'verity.demoMode.v1': '1', 'verity.demoShowcase.v1': '1' };

const PHONE = { width: 393, height: 852 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * @typedef {{ click: string } | { press: string } | { wait: number }} Step
 * @typedef {{ name: string, text: string[], pad?: number, maxHeight?: number }} Crop
 * @typedef {{ name: string, viewport: { width: number, height: number }, steps?: Step[], crops?: Crop[], cropsOnly?: boolean }} Scene
 * @type {Scene[]}
 */
const SCENES = [
  {
    name: 'desktop-session',
    viewport: DESKTOP,
    steps: [{ click: 'Checkout redesign' }],
    crops: [
      {
        name: 'session-list',
        text: ['WEEK', 'Northwind Shop', 'Search ranking'],
        maxHeight: 615,
      },
      { name: 'usage-meters', text: ['Claude', 'Codex', 'WEEK'], maxHeight: 120 },
      // The project list without the usage meters above it, for the hero.
      {
        name: 'project-list',
        text: ['Northwind Shop', 'Customer Research', 'Northwind App'],
        maxHeight: 560,
      },
    ],
  },
  {
    name: 'phone-approval',
    viewport: PHONE,
    cropsOnly: true,
    steps: [{ click: 'Interview synthesis' }],
    crops: [{ name: 'approval-email', text: ['Send email to', 'Deny'], pad: 12 }],
  },
  {
    name: 'phone-plan',
    viewport: PHONE,
    cropsOnly: true,
    steps: [{ click: 'Weekly sales email' }],
    crops: [{ name: 'plan', text: ['Summarize revenue', 'Show full plan', 'Implement'], pad: 12 }],
  },
  {
    name: 'phone-automation',
    viewport: PHONE,
    steps: [{ click: 'Research digest' }],
    crops: [{ name: 'automation-card', text: ['RECURRING TASK', 'Create automation'], pad: 12 }],
  },
  {
    name: 'phone-pr',
    viewport: PHONE,
    steps: [{ click: 'Fix payment retries' }],
    crops: [{ name: 'pull-request', text: ['PR #214', 'Merge'], pad: 12 }],
  },
  {
    name: 'phone-package',
    viewport: PHONE,
    cropsOnly: true,
    steps: [{ click: 'Offline order notes' }],
    crops: [{ name: 'release-delay', text: ['install dependencies', 'Set up delay'], pad: 12 }],
  },
  {
    name: 'phone-secret',
    viewport: PHONE,
    cropsOnly: true,
    steps: [{ click: 'Refund duplicate charges' }],
    crops: [{ name: 'approval-secret', text: ['STRIPE_API_KEY', 'Deny'], pad: 12 }],
  },
  {
    name: 'phone-models',
    viewport: PHONE,
    cropsOnly: true,
    steps: [
      { click: 'Search ranking' },
      { press: 'Current model: qwen3-coder. Tap to switch model.' },
    ],
    crops: [{ name: 'model-picker', text: ['SWITCH MODEL', 'kimi-k2'], maxHeight: 470 }],
  },
  {
    name: 'phone-knowledge',
    viewport: PHONE,
    cropsOnly: true,
    steps: [
      { click: 'Interview synthesis' },
      { press: 'Browse session files' },
      { click: 'Project Knowledge' },
      { click: 'sources' },
      { click: 'meetings' },
    ],
    crops: [{ name: 'knowledge-files', text: ['Repository', 'Project', 'Aylin'], maxHeight: 400 }],
  },
];

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

// The export expects the `/app` base path (apps/mobile/app.config.ts) and
// client-side routing, so unknown paths fall back to index.html.
/**
 * @param {string} dist
 * @returns {Promise<import('node:http').Server>}
 */
function serve(dist) {
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

/** @param {import('playwright').Page} page */
async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    () => /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis)).document.fonts.ready,
  );
  // Demo replies and layout animations are timer-driven, not network-driven.
  await page.waitForTimeout(1500);
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} markers
 */
async function cropBox(page, markers) {
  return page.evaluate((needles) => {
    const { document } = /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis));
    /** @param {PageElement} el */
    const area = (el) => el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    const match = Array.from(document.querySelectorAll('div'))
      .filter((el) => area(el) > 0 && needles.every((needle) => el.innerText.includes(needle)))
      .sort((a, b) => area(a) - area(b))[0];
    if (!match) return null;
    const { x, y, width, height } = match.getBoundingClientRect();
    return { x, y, width, height };
  }, markers);
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} base
 * @param {Scene} scene
 * @param {string} out
 */
async function render(browser, base, scene, out) {
  const context = await browser.newContext({
    viewport: scene.viewport,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
  });
  await context.addInitScript((entries) => {
    const { localStorage } = /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis));
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, STORAGE);
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/`);
  await settle(page);
  for (const step of scene.steps ?? []) {
    if ('click' in step) await page.getByText(step.click, { exact: true }).first().click();
    // Icon buttons have no visible text; their accessibility label is the handle.
    else if ('press' in step) await page.getByLabel(step.press, { exact: true }).first().click();
    else await page.waitForTimeout(step.wait);
    await settle(page);
  }
  if (errors.length) throw new Error(`${scene.name}: ${errors.join('; ')}`);
  // The browser client focuses the composer; images show it at rest.
  await page.evaluate(() => {
    const { document } = /** @type {PageGlobals} */ (/** @type {unknown} */ (globalThis));
    document.activeElement?.blur?.();
  });
  await page.waitForTimeout(300);
  if (!scene.cropsOnly) {
    await page.screenshot({ path: join(out, `app-${scene.name}.png`) });
    console.log(`app-${scene.name}.png`);
  }
  for (const crop of scene.crops ?? []) {
    const box = await cropBox(page, crop.text);
    if (!box) throw new Error(`${scene.name}: no element contains ${crop.text.join(' + ')}`);
    const pad = crop.pad ?? 0;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    await page.screenshot({
      path: join(out, `app-${crop.name}.png`),
      clip: {
        x,
        y,
        width: Math.min(box.x + box.width + pad, scene.viewport.width) - x,
        // Lists and sheets fill their column; cut the empty space below them.
        height: Math.min(box.y + box.height + pad - y, crop.maxHeight ?? Infinity),
      },
    });
    console.log(`app-${crop.name}.png`);
  }
  await context.close();
}

const dist = resolve(args.dist ?? '');
if (!existsSync(join(dist, 'index.html')))
  throw new Error(
    `No browser export in ${dist}. Run: npm run build:web --workspace @verity/mobile-app -- --max-workers 1`,
  );
const out = resolve(args.out ?? '');
mkdirSync(out, { recursive: true });
const only = args.only ?? [];
const unknown = only.filter((name) => !SCENES.some((scene) => scene.name === name));
if (unknown.length)
  throw new Error(
    `Unknown scene ${unknown.join(', ')}. Known: ${SCENES.map((s) => s.name).join(', ')}`,
  );
const scenes = only.length ? SCENES.filter((scene) => only.includes(scene.name)) : SCENES;

const server = await serve(dist);
const browser = await chromium.launch();
try {
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${address.port}/app`;
  // One scene at a time: each export instance holds a full app in memory.
  for (const scene of scenes) await render(browser, base, scene, out);
} finally {
  await browser.close();
  server.close();
}

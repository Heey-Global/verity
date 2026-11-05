#!/usr/bin/env node
// Renders product images for the website from the real app. The browser export
// of apps/mobile runs in demo mode with the showcase scenario
// (apps/mobile/lib/demoShowcase.ts), so every image shows the shipped
// components with sample data instead of a hand-edited screenshot.
//
//   npm run build:web --workspace @verity/mobile-app -- --max-workers 1
//   npx playwright install chromium-headless-shell
//   npm run render:app-screens -- [--only <name>] [--out <dir>]
//   npm run render:app-screens -- --app-store [--base-url <url>/app] [--out <dir>]
// App Store scenes render iPhone at 1320×2868 and iPad at 2064×2752 into
// .cache/app-store by default. --base-url renders against an already running
// demo export instead of serving --dist locally.
//
// Each scene writes `app-<name>.png` at its device scale factor (twice the CSS
// resolution unless the scene sets another) unless it is only there for its
// crops; a crop writes one PNG per component, cut to the
// smallest element containing all of the crop's text markers. The files sit
// directly in the website's assets folder because the website's checks and
// Dockerfile list every asset by its flat `assets/<file>` path.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import {
  blurFocus,
  exportBaseUrl,
  openDemoPage,
  requireExport,
  serve,
  settle,
} from './lib/app-export.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: join(root, 'apps/mobile/dist') },
    out: { type: 'string' },
    only: { type: 'string', multiple: true },
    'base-url': { type: 'string' },
    'app-store': { type: 'boolean', default: false },
  },
});

const PHONE = { width: 393, height: 852 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * @typedef {{ click: string } | { press: string } | { wait: number }} Step
 * @typedef {{ name: string, text: string[], pad?: number, maxHeight?: number }} Crop
 * @typedef {{ name: string, viewport: { width: number, height: number }, deviceScaleFactor?: number, steps?: Step[], crops?: Crop[], cropsOnly?: boolean }} Scene
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
      { press: 'Current model: Qwen3.8-Max. Tap to switch model.' },
    ],
    crops: [
      { name: 'model-picker', text: ['SWITCH MODEL', 'DeepSeek-V4.1-Flash-1017'], maxHeight: 505 },
    ],
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

/** @typedef {import('./lib/app-export.mjs').PageGlobals} PageGlobals */
/** @typedef {import('./lib/app-export.mjs').PageElement} PageElement */

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
  const { context, page, errors } = await openDemoPage(browser, scene);
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
  await blurFocus(page);
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
if (!args['base-url']) requireExport(dist);
// Store shots stay out of the published website assets unless --out says so.
const out = resolve(
  args.out ?? join(root, args['app-store'] ? '.cache/app-store' : 'docs/website/site/assets'),
);
mkdirSync(out, { recursive: true });
const only = args.only ?? [];
if (args['app-store'] && only.length) throw new Error('--only cannot be combined with --app-store');
const unknown = only.filter((name) => !SCENES.some((scene) => scene.name === name));
if (unknown.length)
  throw new Error(
    `Unknown scene ${unknown.join(', ')}. Known: ${SCENES.map((s) => s.name).join(', ')}`,
  );
const scenes = args['app-store']
  ? [
      {
        name: 'store-iphone-projects',
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
      },
      {
        name: 'store-iphone-session',
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        steps: [{ click: 'Fix payment retries' }],
      },
      // The iPad split view shows the project list beside the open session.
      {
        name: 'store-ipad-payment-retries',
        viewport: { width: 1032, height: 1376 },
        deviceScaleFactor: 2,
        steps: [{ click: 'Fix payment retries' }],
      },
      {
        name: 'store-ipad-checkout-redesign',
        viewport: { width: 1032, height: 1376 },
        deviceScaleFactor: 2,
        steps: [{ click: 'Checkout redesign' }],
      },
    ]
  : only.length
    ? SCENES.filter((scene) => only.includes(scene.name))
    : SCENES;

const baseUrl = args['base-url']?.replace(/\/+$/, '');
if (baseUrl !== undefined && !URL.canParse(baseUrl))
  throw new Error(`--base-url must be an absolute URL, got '${args['base-url']}'`);
const server = baseUrl ? null : await serve(dist);
const browser = await chromium.launch();
try {
  const base = baseUrl ?? exportBaseUrl(/** @type {import('node:http').Server} */ (server));
  // One scene at a time: each export instance holds a full app in memory.
  for (const scene of scenes) await render(browser, base, scene, out);
} finally {
  await browser.close();
  server?.close();
}

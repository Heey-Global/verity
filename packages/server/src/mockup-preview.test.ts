import { expect, it } from 'vitest';
import { mockupPreviewDocument, mockupPreviewPolicy } from './mockup-preview.js';

it('preserves local HTML controls, inline styles, and embedded images', () => {
  const preview = mockupPreviewDocument(`
    <!doctype html><html><head><style>summary { color: red }</style></head><body>
    <details open><summary>Show pricing</summary>
      <label><input type="radio" name="plan" checked>Monthly</label>
      <img src="data:image/png;base64,AA==" alt="Logo">
    </details></body></html>`);
  expect(preview).toContain('<style>summary { color: red }</style>');
  expect(preview).toContain('<summary>Show pricing</summary>');
  expect(preview).toMatch(/<input type="radio" name="plan" checked/);
  expect(preview).toContain('src="data:image/png;base64,AA=="');
});

it('removes active content and keeps resource restrictions on the rendered document', () => {
  const preview = mockupPreviewDocument(`
    <link rel="stylesheet" href="https://example.test/theme.css">
    <a class="nav-item" href="https://example.test">External link</a>
    <form action="https://example.test"><input type="file"></form>
    <img src="https://example.test/graphic.png" alt="External image" onload="init()">
    <script>init()</script>`);
  expect(preview).toContain('<a class="nav-item">External link</a>');
  expect(preview).toContain('alt="External image"');
  expect(preview).not.toMatch(/example\.test|onload|<script|<form|type="file"/);
  expect(preview).toContain("default-src 'none'");
  expect(preview).toContain("script-src 'none'");
  expect(mockupPreviewPolicy).toMatch(/; sandbox; frame-ancestors 'self'$/);
});

it('keeps safe document attributes used by CSS and locale settings', () => {
  const preview = mockupPreviewDocument(
    '<html lang="ar" dir="rtl" data-theme="dark" style="--spacing: 1rem"><head><title>Hidden tab title</title><style>html[data-theme="dark"] body.compact { color: white }</style></head><body class="compact" style="padding: var(--spacing)" onload="init()">Draft</body></html>',
  );
  expect(preview).toContain('<html lang="ar" dir="rtl" data-theme="dark" style="--spacing: 1rem">');
  expect(preview).toContain('<body class="compact" style="padding: var(--spacing)">');
  expect(preview).toContain('html[data-theme="dark"] body.compact');
  expect(preview).not.toContain('onload');
  expect(preview).not.toContain('Hidden tab title');
});

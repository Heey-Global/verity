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
    <a href="https://example.test">External link</a>
    <form action="https://example.test"><input type="file"></form>
    <img src="https://example.test/graphic.png" alt="External image" onload="init()">
    <script>init()</script>`);
  expect(preview).toContain('External link');
  expect(preview).toContain('alt="External image"');
  expect(preview).not.toMatch(/example\.test|onload|<script|<form|type="file"/);
  expect(preview).toContain("default-src 'none'");
  expect(preview).toContain("script-src 'none'");
  expect(mockupPreviewPolicy).toMatch(/; sandbox; frame-ancestors 'self'$/);
});

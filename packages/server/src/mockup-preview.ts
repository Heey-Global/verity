import sanitizeHtml from 'sanitize-html';

export const MAX_HTML_MOCKUP_BYTES = 2 * 1024 * 1024;

const resourcePolicy = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const mockupPreviewPolicy = `${resourcePolicy}; sandbox; frame-ancestors 'self'`;

export class MockupPreviewLimitError extends Error {}

const options: sanitizeHtml.IOptions = {
  nestingLimit: 64,
  nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'title'],
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'button',
    'details',
    'figure',
    'figcaption',
    'img',
    'input',
    'label',
    'style',
    'summary',
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'role', 'aria-*', 'lang', 'dir', 'hidden', 'title', 'data-*'],
    img: ['src', 'alt', 'width', 'height'],
    label: ['for'],
    input: ['type', 'name', 'value', 'checked', 'disabled'],
    button: ['disabled', 'type'],
    details: ['name', 'open'],
  },
  allowedSchemes: ['data'],
  allowProtocolRelative: false,
  allowVulnerableTags: true, // Inline CSS runs under the document's resource policy.
  transformTags: {
    input: (_tag, attributes) =>
      attributes.type === 'checkbox' || attributes.type === 'radio'
        ? { tagName: 'input', attribs: attributes }
        : { tagName: 'span', attribs: {} },
  },
};

function documentAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .filter(([name]) => /^(?:class|id|lang|dir|style|data-[a-z0-9_.:-]+)$/u.test(name))
    .map(
      ([name, value]) =>
        ` ${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`,
    )
    .join('');
}

export function mockupPreviewDocument(html: string): string {
  let tags = 0;
  let htmlAttributes = '';
  let bodyAttributes = '';
  const content = sanitizeHtml(html, {
    ...options,
    // The parser still visits elements beyond the output nesting limit.
    onOpenTag: () => {
      if (++tags > 4096) throw new MockupPreviewLimitError('HTML mockup exceeds 4096 elements');
    },
    transformTags: {
      ...options.transformTags,
      html: (tagName, attribs) => {
        htmlAttributes = documentAttributes(attribs);
        return { tagName, attribs };
      },
      body: (tagName, attribs) => {
        bodyAttributes = documentAttributes(attribs);
        return { tagName, attribs };
      },
    },
  });
  return `<!doctype html><html${htmlAttributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${resourcePolicy}"></head><body${bodyAttributes}>${content}</body></html>`;
}

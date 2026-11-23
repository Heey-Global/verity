import sanitizeHtml from 'sanitize-html';

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

const options: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'a'),
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

export function mockupPreviewDocument(html: string): string {
  const content = sanitizeHtml(html, options);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${resourcePolicy}"></head><body>${content}</body></html>`;
}

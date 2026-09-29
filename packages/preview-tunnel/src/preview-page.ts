const STYLES = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#050611;color:#eef0ff}
*{box-sizing:border-box}
body{min-height:100vh;min-height:100dvh;margin:0;display:grid;place-items:center;padding:clamp(20px,5vw,64px);background:radial-gradient(circle at 12% 4%,#152855 0,transparent 34%),radial-gradient(circle at 92% 90%,#28133d 0,transparent 30%),#050611}
main{width:min(100%,480px)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:32px;font-size:13px;font-weight:800;letter-spacing:.18em}
.brand-mark{display:grid;place-items:center;width:32px;height:32px;border:1px solid #2ab0ff;border-radius:9px;color:#2ab0ff;font-size:17px;letter-spacing:0}
.brand span:last-child{color:#b6bad5}
.card{position:relative;overflow:hidden;padding:clamp(24px,6vw,40px);border:1px solid #2a2552;border-radius:20px;background:#101021;box-shadow:0 24px 80px #0008}
.card:before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,#2ab0ff 0 68%,#ff35da)}
.eyebrow{margin:0 0 20px;color:#2ab0ff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
h1{margin:0 0 14px;font-size:clamp(28px,6vw,38px);line-height:1.13;letter-spacing:-.035em}
.copy{margin:0;color:#a8add0;font-size:15px;line-height:1.65}
form{margin-top:32px}
label{display:block;margin-bottom:10px;color:#d5d8ef;font-size:13px;font-weight:700}
input{width:100%;min-height:54px;padding:14px 16px;border:1px solid #49446e;border-radius:11px;background:#1b1933;color:#eef0ff;font:inherit;font-size:18px;letter-spacing:.18em;outline:none}
input:focus{border-color:#2ab0ff;box-shadow:0 0 0 3px #2ab0ff33}
input::placeholder{color:#77799e;letter-spacing:normal}
button{width:100%;min-height:54px;margin-top:16px;border:0;border-radius:11px;background:#2ab0ff;color:#00111f;font:inherit;font-size:15px;font-weight:800;cursor:pointer}
button:hover{background:#70ccff}
button:focus-visible{outline:3px solid #ff35da;outline-offset:3px}
.error{margin:0 0 18px;padding:12px 14px;border:1px solid #a84471;border-radius:9px;background:#371a34;color:#ffd8e9;font-size:14px;line-height:1.4}
.foot{margin:20px 0 0;color:#8589af;font-size:12px;line-height:1.5}
@media(max-width:480px){body{display:block;padding:24px 16px}.brand{margin:12px 4px 24px}.card{border-radius:16px}.foot{padding:0 4px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .15s ease}}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function shell(title: string, eyebrow: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#050611"><title>${escapeHtml(title)} · Verity Preview</title><style>${STYLES}</style></head><body><main><div class="brand"><span class="brand-mark" aria-hidden="true">V</span><span>VERITY</span></div><section class="card" aria-labelledby="page-title"><p class="eyebrow">${escapeHtml(eyebrow)}</p>${content}</section><p class="foot">This preview is temporary. Only open links you trust.</p></main></body></html>`;
}

export function loginPage(next: string, error?: string): string {
  return shell(
    'Enter preview code',
    'Private preview',
    `<h1 id="page-title">Enter your code</h1><p class="copy">Use the code shared with you to open this preview.</p><form method="post" action="/__verity/login"><input type="hidden" name="next" value="${escapeHtml(next)}">${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<label for="pin">Preview code</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,12}" minlength="6" maxlength="12" placeholder="6–12 digits" required autofocus><button type="submit">Open preview</button></form>`,
  );
}

export function previewErrorPage(message: string): string {
  return shell(
    'Preview unavailable',
    'Preview unavailable',
    `<h1 id="page-title">We can’t open this page.</h1><p class="copy">${escapeHtml(message)}</p>`,
  );
}

export const PREVIEW_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

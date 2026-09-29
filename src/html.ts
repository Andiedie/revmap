import { createHash } from 'crypto';
import { Review } from './model';

declare const CLIENT_JS: string;
declare const CLIENT_CSS: string;

export function renderHTML(review: Review): string {
  const script = CLIENT_JS.replace(/<\/script/gi, '<\\/script');
  const hash = createHash('sha256').update(script).digest('base64');
  const data = JSON.stringify(review).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>Review changes · revmap</title><style>${CLIENT_CSS}</style></head>
<body><div id="app"></div><div id="boot-error" role="alert">This review needs a browser that runs JavaScript. Open the HTML in a web browser rather than a file previewer. If this message remains visible, the page could not start.</div>
<script id="review-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

// Cleans admin-written rich text (the contenteditable editor's output) before
// it is stored or emailed. The editor only ever produces simple formatting
// (bold/italic/lists/links/images/tables), so this removes everything that
// can execute or load active content rather than trying to be a full HTML
// parser: script/style/iframe/object/embed/form tags, inline event handlers
// (onclick=...), and javascript:/vbscript:/data:text/html URLs. It matters
// because a template saved by one admin is re-rendered inside another
// admin's editor (innerHTML), and because the same HTML goes out in email.
export function sanitizeEmailHtml(html) {
  let s = String(html ?? '');
  // whole elements that can run or embed code (with their content)
  s = s.replace(/<\s*(script|style|iframe|object|embed|form|meta|link|base|applet|noscript)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // ...and any unclosed/self-closing leftovers of the same tags
  s = s.replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|meta|link|base|applet|noscript|input|button|textarea|select)\b[^>]*>/gi, '');
  // inline event handlers, quoted or bare
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // dangerous URL schemes in href/src/action/formaction/xlink:href
  const BAD = String.raw`(?:java\s*script|vbscript|data\s*:\s*text\/html)`;
  s = s.replace(new RegExp(String.raw`\b(href|src|action|formaction|xlink:href)\s*=\s*(["'])\s*${BAD}[\s\S]*?\2`, 'gi'), '$1="#"');
  s = s.replace(new RegExp(String.raw`\b(href|src|action|formaction|xlink:href)\s*=\s*${BAD}[^\s>]*`, 'gi'), '$1="#"');
  // CSS that can pull in script (old IE expression()/behavior) or remote urls with js
  s = s.replace(/expression\s*\(/gi, 'blocked(').replace(/javascript\s*:/gi, 'blocked:');
  return s;
}

// True when the rich text has no visible content (empty editor leaves
// things like "<p><br></p>" or "&nbsp;" behind).
export function isBlankHtml(html) {
  const text = String(html ?? '').replace(/<img\b[^>]*>/gi, 'IMG').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim();
  return text === '';
}

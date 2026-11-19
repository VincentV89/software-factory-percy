import sanitize from 'sanitize-html';

/** Template pipeline: parse merge tags, require unsubscribe, sanitise, render (FR-TPL-01..04, FR-DLV-09). */

export interface TemplateIssue {
  field: 'subject' | 'html' | 'text';
  position: number;
  reason: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const UNSUBSCRIBE_FIELD = 'unsubscribe_url';

/** Finds `{{field}}` tags. Malformed tags (`{{name`, `{{}}`, `{{bad-name}}`) are errors with their position. */
export function parseMergeTags(input: string, field: TemplateIssue['field']): { fields: string[]; issues: TemplateIssue[] } {
  const fields = new Set<string>();
  const issues: TemplateIssue[] = [];
  let i = 0;
  while (i < input.length) {
    const open = input.indexOf('{{', i);
    if (open < 0) break;
    const close = input.indexOf('}}', open + 2);
    const nextOpen = input.indexOf('{{', open + 2);
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      issues.push({ field, position: open, reason: 'merge tag is not closed with }}' });
      i = open + 2;
      continue;
    }
    const name = input.slice(open + 2, close).trim();
    if (name === '') issues.push({ field, position: open, reason: 'merge tag is empty' });
    else if (!NAME.test(name)) issues.push({ field, position: open, reason: `merge tag "${name}" is not a valid field name` });
    else fields.add(name);
    i = close + 2;
  }
  return { fields: [...fields], issues };
}

export interface TemplateContent {
  subject: string;
  html: string;
  text: string;
}

export interface ValidatedTemplate extends TemplateContent {
  /** Merge fields used, excluding unsubscribe_url. */
  fields: string[];
  removed: string[];
}

const REMOVAL_CHECKS: [RegExp, string][] = [
  [/<script\b/i, '<script> elements'],
  [/<iframe\b/i, '<iframe> elements'],
  [/<object\b/i, '<object> elements'],
  [/<embed\b/i, '<embed> elements'],
  [/\son[a-z]+\s*=/i, 'inline event handlers'],
  [/javascript\s*:/i, 'javascript: URLs'],
];

const SANITIZE_OPTIONS: sanitize.IOptions = {
  allowedTags: [...sanitize.defaults.allowedTags, 'img', 'center', 'font', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'style'],
  disallowedTagsMode: 'discard',
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'valign', 'color', 'dir', 'lang', 'title'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    font: ['face', 'size', 'color'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowVulnerableTags: true,
  nonTextTags: ['script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
};

export function sanitizeHtml(html: string): { html: string; removed: string[] } {
  const removed = REMOVAL_CHECKS.filter(([re]) => re.test(html)).map(([, label]) => label);
  return { html: sanitize(html, SANITIZE_OPTIONS), removed };
}

export class TemplateValidationError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super('Template is not valid.');
  }
}

/** Save-time pipeline. Throws TemplateValidationError listing every problem. */
export function validateTemplate(input: TemplateContent): ValidatedTemplate {
  const issues: TemplateIssue[] = [];
  const parsed = (['subject', 'html', 'text'] as const).map((f) => parseMergeTags(input[f], f));
  for (const p of parsed) issues.push(...p.issues);
  const [subjectTags, htmlTags, textTags] = parsed;
  if (!htmlTags?.fields.includes(UNSUBSCRIBE_FIELD)) issues.push({ field: 'html', position: 0, reason: 'the HTML body must contain {{unsubscribe_url}}' });
  if (!textTags?.fields.includes(UNSUBSCRIBE_FIELD)) issues.push({ field: 'text', position: 0, reason: 'the text body must contain {{unsubscribe_url}}' });
  if (subjectTags?.fields.includes(UNSUBSCRIBE_FIELD)) issues.push({ field: 'subject', position: input.subject.indexOf('{{'), reason: 'the subject cannot contain {{unsubscribe_url}}' });
  if (issues.length > 0) throw new TemplateValidationError(issues);
  const { html, removed } = sanitizeHtml(input.html);
  const fields = new Set<string>();
  for (const p of parsed) for (const f of p.fields) if (f !== UNSUBSCRIBE_FIELD) fields.add(f);
  return { subject: input.subject, html, text: input.text, fields: [...fields].sort(), removed };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const TAG = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface RenderValues {
  [field: string]: string | undefined;
}

export interface Rendered extends TemplateContent {
  missing: string[];
}

/**
 * Render a template. HTML merge values are HTML-escaped (FR-DLV-09); the subject is stripped of
 * CR/LF. With `highlightMissing`, absent values are marked instead of left blank (FR-TPL-04).
 */
export function render(t: TemplateContent, values: RenderValues, opts: { highlightMissing?: boolean } = {}): Rendered {
  const missing = new Set<string>();
  const sub = (mode: 'html' | 'text' | 'subject') => (_: string, name: string): string => {
    const v = values[name];
    if (v === undefined || v === '') {
      missing.add(name);
      if (!opts.highlightMissing) return '';
      return mode === 'html' ? `<mark data-missing="${escapeHtml(name)}">[${escapeHtml(name)}]</mark>` : `[missing: ${name}]`;
    }
    if (mode === 'html') return escapeHtml(v);
    if (mode === 'subject') return v.replace(/[\r\n]+/g, ' ');
    return v;
  };
  return {
    subject: t.subject.replace(TAG, sub('subject')),
    html: t.html.replace(TAG, sub('html')),
    text: t.text.replace(TAG, sub('text')),
    missing: [...missing],
  };
}

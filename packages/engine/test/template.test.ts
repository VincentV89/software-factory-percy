import { describe, expect, it } from 'vitest';
import { TemplateValidationError, escapeHtml, parseMergeTags, render, sanitizeHtml, validateTemplate } from '../src/domain/template';

const valid = { subject: 'Hello {{name}}', html: '<p>Hi {{name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>', text: 'Hi {{name}} {{unsubscribe_url}}' };

describe('merge tags (FR-TPL-01, FR-TPL-03)', () => {
  it('finds fields, ignoring whitespace inside braces', () => {
    expect(parseMergeTags('{{ name }} and {{email}} {{name}}', 'text')).toEqual({ fields: ['name', 'email'], issues: [] });
  });

  it.each([
    ['Hi {{name', 0 + 3, 'not closed'],
    ['Hi {{}} there', 3, 'empty'],
    ['{{bad-name}}', 0, 'not a valid field name'],
    ['{{a {{b}}', 0, 'not closed'],
  ])('reports %j at position %i', (input, position, reason) => {
    const out = parseMergeTags(input, 'html');
    expect(out.issues[0]).toMatchObject({ field: 'html', position, reason: expect.stringContaining(reason) });
  });
});

describe('validateTemplate (FR-TPL-02, FR-TPL-03)', () => {
  it('accepts a valid template and lists its fields', () => {
    const v = validateTemplate(valid);
    expect(v.fields).toEqual(['name']);
    expect(v.removed).toEqual([]);
  });

  it('names the body missing {{unsubscribe_url}}', () => {
    try {
      validateTemplate({ ...valid, text: 'Hi {{name}}' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateValidationError);
      expect((e as TemplateValidationError).issues.map((i) => i.field)).toEqual(['text']);
    }
    expect(() => validateTemplate({ ...valid, html: '<p>x</p>' })).toThrow(TemplateValidationError);
    expect(() => validateTemplate({ ...valid, subject: 'x {{unsubscribe_url}}' })).toThrow(TemplateValidationError);
  });

  it('sanitises HTML and reports what was removed', () => {
    const v = validateTemplate({
      ...valid,
      html: '<p onclick="steal()">Hi</p><script>alert(1)</script><iframe src="x"></iframe><object></object><embed src="y"><a href="javascript:alert(1)">x</a><a href="{{unsubscribe_url}}">u</a>',
    });
    expect(v.html).not.toMatch(/script|onclick|iframe|object|embed|javascript:/i);
    expect(v.html).toContain('href="{{unsubscribe_url}}"');
    expect(v.removed).toEqual(['<script> elements', '<iframe> elements', '<object> elements', '<embed> elements', 'inline event handlers', 'javascript: URLs']);
  });

  it('keeps ordinary email markup', () => {
    const out = sanitizeHtml('<table><tr><td style="color:red"><img src="https://x/y.png" alt="a"></td></tr></table>');
    expect(out.html).toContain('<img src="https://x/y.png" alt="a" />');
    expect(out.removed).toEqual([]);
  });
});

describe('render (FR-DLV-09, FR-TPL-04)', () => {
  it('escapes merge values in HTML only and strips CR/LF from the subject', () => {
    const out = render(valid, { name: '<b>Ann</b>\r\nBcc: x', unsubscribe_url: 'https://p/u/t' });
    expect(out.html).toContain('Hi &lt;b&gt;Ann&lt;/b&gt;');
    expect(out.text).toContain('Hi <b>Ann</b>');
    expect(out.subject).toBe('Hello <b>Ann</b> Bcc: x');
    expect(out.missing).toEqual([]);
  });

  it('highlights missing values in preview instead of leaving them blank', () => {
    const out = render(valid, { unsubscribe_url: '#' }, { highlightMissing: true });
    expect(out.missing).toEqual(['name']);
    expect(out.subject).toBe('Hello [missing: name]');
    expect(out.html).toContain('<mark data-missing="name">[name]</mark>');
    expect(render(valid, { unsubscribe_url: '#' }).subject).toBe('Hello ');
  });

  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

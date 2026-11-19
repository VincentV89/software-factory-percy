import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { ErrorBox, useLoad } from '../components';

interface TemplateBody {
  name: string;
  subject: string;
  html: string;
  text: string;
}

interface Preview {
  subject: string;
  html: string;
  text: string;
  missing: string[];
}

/** Template edit and preview (FR-TPL-01..04). The preview HTML is shown as escaped source, never executed. */
export function TemplateEditor() {
  const { teamId = '', templateId } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<TemplateBody>({ name: '', subject: '', html: '', text: '' });
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<{ removed: string[] }>();
  const [preview, setPreview] = useState<Preview>();
  const [listId, setListId] = useState('');
  const [addrHash, setAddrHash] = useState('');
  const lists = useLoad(() => api<{ items: { listId: string; name: string }[] }>('GET', `/api/contacts/teams/${teamId}/lists`), [teamId]);
  const members = useLoad(() => (listId ? api<{ items: { addrHash: string; email?: string; attrs: Record<string, string> }[] }>('GET', `/api/contacts/teams/${teamId}/lists/${listId}/members`) : Promise.resolve({ items: [] })), [teamId, listId]);

  useEffect(() => {
    if (!templateId) return;
    api<TemplateBody>('GET', `/api/engine/teams/${teamId}/templates/${templateId}`).then((t) => setForm({ name: t.name, subject: t.subject, html: t.html, text: t.text }), setError);
  }, [teamId, templateId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSaved(undefined);
    try {
      const out = templateId
        ? await api<{ templateId: string; removed: string[] }>('PUT', `/api/engine/teams/${teamId}/templates/${templateId}`, form)
        : await api<{ templateId: string; removed: string[] }>('POST', `/api/engine/teams/${teamId}/templates`, form);
      setSaved(out);
      if (!templateId) navigate(`/teams/${teamId}/templates/${out.templateId}`, { replace: true });
    } catch (err) {
      setError(err);
    }
  };

  const runPreview = async () => {
    if (!templateId) return;
    try {
      setPreview(await api<Preview>('POST', `/api/engine/teams/${teamId}/templates/${templateId}/preview`, listId && addrHash ? { listId, addrHash } : { values: {} }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <h1>{templateId ? 'Edit template' : 'New template'}</h1>
      <form onSubmit={(e) => void save(e)} className="card" data-testid="template-form">
        <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="template-form-name" /></label>
        <label>Subject <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required data-testid="template-form-subject" /></label>
        <label>HTML body <textarea rows={8} value={form.html} onChange={(e) => setForm({ ...form, html: e.target.value })} required data-testid="template-form-html" /></label>
        <label>Text body <textarea rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} required data-testid="template-form-text" /></label>
        <p className="muted">Use merge fields like <code>{'{{name}}'}</code>. Both bodies must contain <code>{'{{unsubscribe_url}}'}</code>.</p>
        <ErrorBox error={error} testId="template-form-error" />
        {saved && <p className="notice" data-testid="template-saved">Saved.{saved.removed.length > 0 && ` Removed from the HTML: ${saved.removed.join(', ')}.`}</p>}
        <button type="submit" data-testid="template-form-submit">Save template</button>
      </form>
      {templateId && (
        <div className="card" data-testid="template-preview">
          <h2>Preview</h2>
          <label>
            List
            <select value={listId} onChange={(e) => { setListId(e.target.value); setAddrHash(''); }} data-testid="template-preview-list">
              <option value="">Sample values</option>
              {lists.data?.items.map((l) => <option key={l.listId} value={l.listId}>{l.name}</option>)}
            </select>
          </label>
          {listId && (
            <label>
              Contact
              <select value={addrHash} onChange={(e) => setAddrHash(e.target.value)} data-testid="template-preview-contact">
                <option value="">Choose a contact</option>
                {members.data?.items.map((m) => <option key={m.addrHash} value={m.addrHash}>{m.attrs['name'] ? `${m.attrs['name']} (${m.email ?? ''})` : m.email}</option>)}
              </select>
            </label>
          )}
          <button type="button" onClick={() => void runPreview()} data-testid="template-preview-button">Preview</button>
          {preview && (
            <div>
              <p>Subject: <strong data-testid="template-preview-subject">{preview.subject}</strong></p>
              {preview.missing.length > 0 && <p className="warning" data-testid="template-preview-missing">No value for: {preview.missing.join(', ')}</p>}
              <h3>HTML</h3>
              <pre data-testid="template-preview-html">{preview.html}</pre>
              <h3>Text</h3>
              <pre data-testid="template-preview-text">{preview.text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

import { Link, useParams } from 'react-router';
import { api } from '../api';
import { Empty, ErrorBox, formatTime, useLoad } from '../components';

export function TemplatesPage() {
  const { teamId = '' } = useParams();
  const templates = useLoad(() => api<{ items: { templateId: string; name: string; subject: string; updatedAt: string }[] }>('GET', `/api/engine/teams/${teamId}/templates`), [teamId]);
  return (
    <section>
      <h1>Templates</h1>
      <Link to={`/teams/${teamId}/templates/new`} className="button" data-testid="template-new-link">New template</Link>
      <ErrorBox error={templates.error} />
      {templates.data?.items.length === 0 && <Empty testId="templates-empty">No templates yet. Create a template.</Empty>}
      {templates.data && templates.data.items.length > 0 && (
        <table data-testid="templates-table">
          <thead><tr><th>Name</th><th>Subject</th><th>Updated</th></tr></thead>
          <tbody>
            {templates.data.items.map((t) => (
              <tr key={t.templateId}>
                <td><Link to={`/teams/${teamId}/templates/${t.templateId}`} data-testid="template-link">{t.name}</Link></td>
                <td>{t.subject}</td>
                <td>{formatTime(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { Empty, ErrorBox, formatTime, useLoad } from '../components';

interface ListRow {
  listId: string;
  name: string;
  memberCount: number;
  eligibleCount: number;
  updatedAt: string;
}

export function ListsPage() {
  const { teamId = '' } = useParams();
  const lists = useLoad(() => api<{ items: ListRow[] }>('GET', `/api/contacts/teams/${teamId}/lists`), [teamId]);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/contacts/teams/${teamId}/lists`, { name });
      setName('');
      lists.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section>
      <h1>Lists</h1>
      <form onSubmit={(e) => void create(e)} className="inline" data-testid="list-form">
        <input placeholder="New list name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="list-form-name" />
        <button type="submit" data-testid="list-form-submit">Create list</button>
      </form>
      <ErrorBox error={error ?? lists.error} />
      {lists.data?.items.length === 0 && <Empty testId="lists-empty">No lists yet. Create a list, then upload a CSV.</Empty>}
      {lists.data && lists.data.items.length > 0 && (
        <table data-testid="lists-table">
          <thead><tr><th>Name</th><th>Members</th><th>Audience</th><th>Updated</th></tr></thead>
          <tbody>
            {lists.data.items.map((l) => (
              <tr key={l.listId}>
                <td><Link to={`/teams/${teamId}/lists/${l.listId}`} data-testid="list-link">{l.name}</Link></td>
                <td>{l.memberCount}</td>
                <td>{l.eligibleCount}</td>
                <td>{formatTime(l.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router';
import { ApiError, api, setCsrf, signOut, type KillSwitch, type Me } from './api';
import { ErrorBox, formatTime, useLoad } from './components';
import { SessionContext, isAdmin, useMe } from './session';
import { AdminPage } from './pages/Admin';
import { CampaignDetail } from './pages/CampaignDetail';
import { CampaignsPage } from './pages/Campaigns';
import { KillSwitchPage } from './pages/KillSwitch';
import { ListDetail } from './pages/ListDetail';
import { ListsPage } from './pages/Lists';
import { TemplateEditor } from './pages/TemplateEditor';
import { TemplatesPage } from './pages/Templates';

export function App() {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    api<Me>('GET', '/api/platform/me').then(
      (m) => {
        setCsrf(m.csrfToken);
        setMe(m);
      },
      (e: unknown) => setError(e),
    );
  }, []);
  if (error && !(error instanceof ApiError && error.status === 401)) return <main className="page"><ErrorBox error={error} /></main>;
  if (!me) return <main className="page" data-testid="loading">Signing in…</main>;
  return (
    <SessionContext.Provider value={me}>
      <Shell />
    </SessionContext.Provider>
  );
}

function Home() {
  const me = useMe();
  const first = me.teams[0];
  if (first) return <Navigate to={`/teams/${first.teamId}/campaigns`} replace />;
  if (isAdmin(me)) return <Navigate to="/admin" replace />;
  return <AccessNotSetUp />;
}

function AccessNotSetUp() {
  return (
    <section data-testid="access-not-set-up">
      <h1>Access not set up</h1>
      <p>You are signed in, but you are not a member of any team yet. Ask your agency admin to add you.</p>
    </section>
  );
}

function KillBanner() {
  const me = useMe();
  const { data } = useLoad(() => api<{ items: KillSwitch[] }>('GET', '/api/engine/kill-switches'), [], 15_000);
  const label = (scope: string): string => {
    const [kind, id] = scope.split('#');
    if (kind === 'TEAM') return `team ${me.teams.find((t) => t.teamId === id)?.teamName ?? id}`;
    if (kind === 'AGENCY') return `agency ${me.teams.find((t) => t.agencyId === id)?.agencyName ?? me.agencyAdmin.find((a) => a.agencyId === id)?.agencyName ?? id}`;
    return 'all of Percy';
  };
  if (!data || data.items.length === 0 || (me.teams.length === 0 && !isAdmin(me))) return null;
  return (
    <div className="banner" role="alert" data-testid="kill-switch-banner">
      {data.items.map((k) => (
        <p key={k.scope} data-testid="kill-switch-banner-item">
          <strong>Sending is stopped for {label(k.scope)}</strong> ({k.scope}): {k.reason}. Set by {k.setBy} at {formatTime(k.setAt)}.
        </p>
      ))}
    </div>
  );
}

function TeamNav() {
  const me = useMe();
  const { teamId } = useParams();
  const team = me.teams.find((t) => t.teamId === teamId);
  if (!team) return <AccessNotSetUp />;
  return (
    <nav className="subnav" aria-label="Team">
      <NavLink to={`/teams/${team.teamId}/campaigns`} data-testid="nav-campaigns">Campaigns</NavLink>
      <NavLink to={`/teams/${team.teamId}/lists`} data-testid="nav-lists">Lists</NavLink>
      <NavLink to={`/teams/${team.teamId}/templates`} data-testid="nav-templates">Templates</NavLink>
    </nav>
  );
}

function Shell() {
  const me = useMe();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand" data-testid="nav-home">Percy</Link>
        {me.teams.length > 1 && (
          <span className="teams">
            {me.teams.map((t) => (
              <Link key={t.teamId} to={`/teams/${t.teamId}/campaigns`} data-testid={`team-link-${t.teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{t.teamName}</Link>
            ))}
          </span>
        )}
        {isAdmin(me) && <NavLink to="/kill-switch" data-testid="nav-kill-switch">Kill switch</NavLink>}
        {isAdmin(me) && <NavLink to="/admin" data-testid="nav-admin">Admin</NavLink>}
        <span className="who" data-testid="whoami">{me.email ?? me.officerId}</span>
        <button type="button" onClick={() => void signOut()} data-testid="sign-out-button">Sign out</button>
      </header>
      <KillBanner />
      <main className="page">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/access-not-set-up" element={<AccessNotSetUp />} />
          <Route path="/teams/:teamId/*" element={<TeamRoutes />} />
          <Route path="/kill-switch" element={isAdmin(me) ? <KillSwitchPage /> : <Navigate to="/" />} />
          <Route path="/admin" element={isAdmin(me) ? <AdminPage /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function TeamRoutes() {
  return (
    <>
      <TeamNav />
      <Routes>
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:campaignId" element={<CampaignDetail />} />
        <Route path="lists" element={<ListsPage />} />
        <Route path="lists/:listId" element={<ListDetail />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/new" element={<TemplateEditor />} />
        <Route path="templates/:templateId" element={<TemplateEditor />} />
      </Routes>
    </>
  );
}

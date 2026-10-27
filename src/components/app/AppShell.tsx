'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useDeskContext } from '../../client/DeskProvider';
import { formatWat } from '../../client/format';
import { Pill } from '../primitives';
import { ExtractionStatus } from '../IntegrationStrip';

const NAV = [
  {
    href: '/app',
    label: 'Orders',
    match: (p: string) => p === '/app' || p.startsWith('/app/orders')
  },
  { href: '/app/sources', label: 'Sources', match: (p: string) => p.startsWith('/app/sources') },
  { href: '/app/activity', label: 'Activity', match: (p: string) => p.startsWith('/app/activity') }
];

function Crumbs({ pathname }: { pathname: string }) {
  const parts = pathname
    .replace(/^\/app\/?/, '')
    .split('/')
    .filter(Boolean);
  if (parts[0] === 'orders' && parts[1]) {
    return (
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/app">Orders</Link>
        <span aria-hidden="true">/</span>
        <b>{decodeURIComponent(parts[1])}</b>
      </nav>
    );
  }
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/app';
  const desk = useDeskContext();
  const { state, pending } = desk;
  const busy = pending !== null;

  return (
    <div className="shell">
      <aside className="side">
        <Link href="/" className="l-brand" aria-label="Dispatch home">
          <span className="l-mark" aria-hidden="true">
            <i />
          </span>
          Dispatch
        </Link>
        <nav className="side-nav" aria-label="App">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="side-link"
              aria-current={item.match(pathname) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <Pill tone="pending" dot>
            Demo scenario
          </Pill>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-top">
          <div className="app-top-inner">
            <Crumbs pathname={pathname} />
            {state && (
              <div className="app-top-end">
                <span className="clock">{formatWat(state.scenarioClockIso)}</span>
                <div className="seg" role="group" aria-label="Role">
                  {(['manager', 'operator'] as const).map((role) => (
                    <button
                      key={role}
                      aria-pressed={state.currentUser.role === role}
                      disabled={busy}
                      onClick={() => desk.switchRole(role)}
                    >
                      {role === 'manager' ? 'Manager' : 'Operator'}
                    </button>
                  ))}
                </div>
                <ExtractionStatus state={state} />
                {state.currentUser.role === 'manager' && (
                  <button className="btn btn-quiet" disabled={busy} onClick={desk.reset}>
                    Reset sample data
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        {state || desk.orderNotFound ? (
          <main className="page" aria-busy={busy}>
            {desk.loadError && !desk.orderNotFound && (
              <div className="row" role="alert">
                <span className="pill pill-risk">{desk.loadError}</span>
                <button className="btn" disabled={busy} onClick={() => void desk.refresh()}>
                  Refresh
                </button>
              </div>
            )}
            {children}
          </main>
        ) : (
          <main className="loading" aria-busy={!desk.loadError}>
            {desk.loadError ? (
              <>
                <p className="pill pill-risk" role="alert">
                  {desk.loadError}
                </p>
                <button className="btn" onClick={() => void desk.refresh()}>
                  Refresh
                </button>
              </>
            ) : (
              <p>Loading…</p>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

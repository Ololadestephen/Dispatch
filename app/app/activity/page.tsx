'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDeskContext } from '@/src/client/DeskProvider';
import type { ActivityResponse } from '@/src/client/deskState';
import { DotPanel } from '@/src/components/app/DotPanel';

type AuditEvent = ActivityResponse['events'][number];

export default function ActivityPage() {
  const { loadActivity } = useDeskContext();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadActivity()
      .then((payload) => {
        if (live) setEvents(payload.events);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [loadActivity]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Activity</h1>
        <span className="caption">All orders</span>
      </div>
      {error && (
        <p className="pill pill-risk" role="alert">
          {error}
        </p>
      )}
      {events === null ? (
        !error && <p className="muted">Loading activity…</p>
      ) : events.length ? (
        <div className="bento">
          <section className="tile span-12" aria-label="Activity">
            <ol className="audit">
              {events.map((event) => (
                <li key={event.eventId}>
                  <span className="audit-who">
                    <Link
                      href={
                        event.orderId === 'WORKSPACE'
                          ? '/app/sources'
                          : `/app/orders/${encodeURIComponent(event.orderId)}`
                      }
                    >
                      {event.orderId === 'WORKSPACE' ? 'Workspace' : event.orderId}
                    </Link>
                    {' · '}
                    {event.actorName.split(' (')[0]}
                    {event.receiptVersion !== null && ` · v${event.receiptVersion}`}
                  </span>
                  <span>{event.summary}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <DotPanel title="No activity yet." />
      )}
    </>
  );
}

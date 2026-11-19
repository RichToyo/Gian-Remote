/**
 * Host selector — the only Host chrome in the header (breadcrumb never
 * repeats the Host). Status is always text + dot, never color alone.
 */

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';
import { hostDisplayName } from '../host-selection.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function HostStatusText({
  online,
  reconnecting,
  paused = false,
  noNetwork = false,
}: {
  online: boolean;
  reconnecting: boolean;
  /** Another tab of this browser holds the connection. */
  paused?: boolean;
  /** The browser itself is offline, not the computer. */
  noNetwork?: boolean;
}) {
  const t = useT();
  const label = paused
    ? t('host.status.paused')
    : noNetwork
      ? t('host.status.noNetwork')
      : reconnecting
        ? t('host.status.reconnecting')
        : online
          ? t('host.status.connected')
          : t('host.status.offline');
  return <small className="rw-host-status">{label}</small>;
}

export function HostSelector({ variant = 'header' }: { variant?: 'header' | 'rail' }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = state.hosts.find((h) => h.id === state.currentHostId) ?? null;
  const reconnecting = state.connection.kind === 'relay_reconnecting' || state.connection.kind === 'resyncing';
  const online = state.connection.kind === 'online';
  const paused = state.connection.kind === 'taken_over';
  const noNetwork = state.connection.kind === 'browser_offline';
  const status = <HostStatusText online={online} reconnecting={reconnecting} paused={paused} noNetwork={noNetwork} />;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`rw-host${open ? ' open' : ''}${variant === 'rail' ? ' rw-host-rail' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="rw-host-btn"
        aria-label={t('host.selector.label')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`rw-host-dot${online ? '' : reconnecting ? ' busy' : paused ? ' paused' : ' off'}`} aria-hidden="true" />
        {variant === 'rail' ? (
          <span className="rw-host-label">
            <span className="rw-host-current">{current ? hostDisplayName(current, state.hosts) : t('host.select')}</span>
            {current && status}
          </span>
        ) : (
          <>
            <span className="rw-host-current">{current ? hostDisplayName(current, state.hosts) : t('host.select')}</span>
            {current && status}
          </>
        )}
        <Icon name="caret-down" size={10} />
      </button>
      {open && (
        <div className="rw-host-pop" role="menu" aria-label={t('host.selector.label')}>
          {state.hosts.map((host) => (
            <button
              key={host.id}
              type="button"
              role="menuitemradio"
              aria-checked={host.id === state.currentHostId}
              className={`rw-host-row${host.id === state.currentHostId ? ' is-current' : ''}${host.online ? '' : ' is-off'}`}
              onClick={() => {
                setOpen(false);
                if (state.auth.kind === 'challenge-login') actions.challengeLogin(host.id);
                else actions.selectHost(host.id);
              }}
            >
              <span className={`rw-host-dot${host.online ? '' : ' off'}`} aria-hidden="true" />
              <span className="rw-host-name">
                {hostDisplayName(host, state.hosts)}
                <small>
                  {host.online
                    ? `${t('host.row.sessions', { count: host.sessionCount })} · ${t('host.status.online')}`
                    : `${t('host.status.offline')}${host.lastSeenAt ? ` · ${t('host.row.lastSeen', { time: formatTime(host.lastSeenAt) })}` : ''}`}
                </small>
              </span>
              {host.id === state.currentHostId && <span className="rw-host-check" aria-hidden="true">✓</span>}
            </button>
          ))}
          <button type="button" role="menuitem" className="rw-host-row"
            onClick={() => { setOpen(false); actions.startPairing(); }}>
            {t('host.add')}
          </button>
        </div>
      )}
    </div>
  );
}

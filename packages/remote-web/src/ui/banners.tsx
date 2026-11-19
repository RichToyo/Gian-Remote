/**
 * Connection state matrix (proposal §7.4 / §14, mockup F6/F15). Every state
 * gets a distinct tone + icon + action; nothing collapses into a generic
 * "Host offline". While the state is not `online`, mutations stay disabled
 * and the transcript is marked stale with the snapshot time.
 */

import type { ConnectionState } from '../controller/types.js';
import { mutationsEnabled } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions } from './controller-context.js';
import { Icon } from './icons.js';
import { HostSelector } from './host-selector.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function isStaleConnection(connection: ConnectionState): boolean {
  return !mutationsEnabled(connection);
}

/** Inline banner for non-terminal states. Returns null while online. */
export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  const t = useT();

  switch (connection.kind) {
    case 'online':
      return null;
    case 'browser_offline':
      return (
        <div className="session-banner rw-danger" role="status" data-conn="browser_offline">
          <Icon name="wifi-off" size={13} />
          <span>{t('conn.browserOffline')}</span>
          <span className="session-banner-spacer" />
          <span className="rw-stale-tag" data-tone="danger">{t('conn.tag.offline')}</span>
        </div>
      );
    case 'relay_reconnecting':
      return (
        <div className="session-banner rw-info" role="status" data-conn="relay_reconnecting">
          <span className="spinner" role="status" aria-label={t('conn.tag.reconnecting')} />
          <span>{t('conn.relayReconnecting', { n: connection.attempt })}</span>
          <span className="session-banner-spacer" />
          <span className="rw-stale-tag" data-tone="info">{t('conn.tag.reconnecting')}</span>
        </div>
      );
    case 'resyncing':
      return (
        <div className="session-banner rw-info" role="status" data-conn="resyncing">
          <span className="spinner" role="status" aria-label={t('conn.tag.resync')} />
          <span>{t('conn.resyncing', { done: connection.synced, total: connection.total })}</span>
          <span className="session-banner-spacer" />
          <span className="rw-stale-tag" data-tone="info">{t('conn.tag.resync')}</span>
        </div>
      );
    case 'host_offline':
      return (
        <div className="session-banner rw-warn" role="status" data-conn="host_offline">
          <Icon name="warning" size={13} />
          <span>{t('conn.hostOffline', { time: formatTime(connection.lastSeenAt) })}</span>
          <span className="session-banner-spacer" />
          <span className="rw-stale-tag">{t('conn.tag.stale')}</span>
        </div>
      );
    case 'version_mismatch':
      return (
        <div className="session-banner rw-warn" role="status" data-conn="version_mismatch">
          <Icon name="warning" size={13} />
          <span>
            {t('conn.versionMismatch', {
              required: connection.requiredVersion,
              actual: connection.hostVersion,
            })}
          </span>
          <span className="session-banner-spacer" />
          <button type="button" className="btn xs secondary">
            {t('conn.versionMismatch.action')}
          </button>
        </div>
      );
    case 'taken_over':
      return (
        <div className="session-banner rw-info" role="status" data-conn="taken_over">
          <Icon name="warning" size={13} />
          <span>{t('conn.takenOver')}</span>
          <span className="session-banner-spacer" />
          <ConnectionAction label={t('conn.takenOver.action')} />
        </div>
      );
    case 'device_revoked':
    case 'server_changed':
      // Terminal: rendered as a full-page card by the app shell, not a banner.
      return null;
  }
}

function ConnectionAction({ label }: { label: string }) {
  const actions = useRemoteActions();
  return (
    <button type="button" className="btn xs secondary" onClick={() => actions.refreshState()}>
      {label}
    </button>
  );
}

/** UNKNOWN_OUTCOME strip (§14): never a blind retry — refresh only. */
export function UnknownOutcomeBanner({ commandId }: { commandId: string }) {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="session-banner rw-warn" role="status" data-conn="unknown_outcome">
      <Icon name="warning" size={13} />
      <span>{t('chat.unknown.banner')}</span>
      <span className="session-banner-spacer" />
      <button
        type="button"
        className="btn xs secondary"
        onClick={() => actions.refreshState()}
      >
        {t('chat.unknown.refresh')}
      </button>
      <button
        type="button"
        className="btn xs ghost icon"
        aria-label={t('common.close')}
        onClick={() => actions.dismissUnknown(commandId)}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** Full-page terminal card for device_revoked (§7.4: cache cleared, back to
 *  pairing). */
const REVOKED_COPY = {
  revoked: { title: 'pair.revoked.title', desc: 'pair.revoked.desc' },
  key_missing: { title: 'pair.revoked.keyMissing.title', desc: 'pair.revoked.keyMissing.desc' },
  host_key_changed: { title: 'pair.revoked.hostKeyChanged.title', desc: 'pair.revoked.hostKeyChanged.desc' },
} as const;

export function DeviceRevokedPage({ reason = 'revoked' }: { reason?: keyof typeof REVOKED_COPY }) {
  const t = useT();
  const actions = useRemoteActions();
  const copy = REVOKED_COPY[reason];
  return (
    <div className="rw-pair" data-conn="device_revoked" data-reason={reason}>
      <div className="rw-pair-card">
        <HostSelector />
        <span className="rw-fail-ico">
          <Icon name="warning" size={15} />
        </span>
        <span className="rw-fail-title">{t(copy.title)}</span>
        <span className="rw-fail-desc">{t(copy.desc)}</span>
        <button type="button" className="btn sm primary" onClick={() => actions.restartPairing()}>
          {t('pair.revoked.action')}
        </button>
      </div>
    </div>
  );
}

/** Full-page card for a Remote Server whose identity differs from the pin:
 *  nothing connects until the user decides to trust it. */
export function ServerChangedPage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-pair" data-conn="server_changed">
      <div className="rw-pair-card">
        <span className="rw-fail-ico">
          <Icon name="warning" size={15} />
        </span>
        <span className="rw-fail-title">{t('server.changed.title')}</span>
        <span className="rw-fail-desc">{t('server.changed.desc')}</span>
        <button type="button" className="btn sm secondary" onClick={() => actions.trustServerIdentity()}>
          {t('server.changed.action')}
        </button>
      </div>
    </div>
  );
}

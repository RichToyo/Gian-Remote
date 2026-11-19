/**
 * Remote Settings: appearance (theme + accent), the computers this browser
 * is paired with (each can be removed, two-step), and signing this browser
 * out, which revokes its pairings and deletes its keys and caches.
 */

import { useState } from 'react';
import type { AccentName, RemoteHostEntry, ThemeName } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { hostDisplayName } from '../host-selection.js';
import { HeaderButton, PageHeader } from './page.js';

const THEMES: ThemeName[] = ['light', 'warm', 'dark', 'system'];
const ACCENTS: Array<{ id: AccentName; swatch: string }> = [
  { id: 'rose', swatch: 'oklch(0.62 0.15 5)' },
  { id: 'azure', swatch: 'oklch(0.62 0.13 230)' },
  { id: 'moss', swatch: 'oklch(0.62 0.11 150)' },
  { id: 'plum', swatch: 'oklch(0.62 0.14 320)' },
];

function HostRow({ host }: { host: RemoteHostEntry }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [confirming, setConfirming] = useState(false);
  const isCurrent = host.id === state.currentHostId;

  return (
    <div className="rw-dev" data-host-id={host.id}>
      <span className={`rw-host-dot${host.online ? '' : ' off'}`} aria-hidden="true" />
      <span className="rw-dev-body">
        <span className="rw-dev-name">
          {hostDisplayName(host, state.hosts)}
          {isCurrent && <span className="rw-dev-badge">{t('settings.host.current')}</span>}
        </span>
        <span className="rw-dev-meta">
          {host.online
            ? isCurrent && host.latencyMs != null
              ? t('settings.connectedMeta', { latency: host.latencyMs })
              : t('host.status.online')
            : t('host.status.offline')}
        </span>
      </span>
      {confirming ? (
        <span className="rw-dev-confirm" role="alertdialog" aria-label={t('settings.host.disconnect')}>
          <span className="rw-dev-confirm-text">
            {t('settings.host.disconnectConfirm', { name: host.name })}
          </span>
          <button
            type="button"
            className="btn xs danger"
            onClick={() => {
              setConfirming(false);
              actions.disconnectHost(host.id);
            }}
          >
            {t('settings.host.disconnect')}
          </button>
          <button type="button" className="btn xs ghost" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn xs danger-ghost"
          title={t('settings.host.disconnectHint')}
          onClick={() => setConfirming(true)}
        >
          {t('settings.host.disconnect')}
        </button>
      )}
    </div>
  );
}

export function SettingsBody() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [logoutConfirming, setLogoutConfirming] = useState(false);

  return (
    <div className="rw-settings" data-testid="remote-settings">
      <section className="rw-card" aria-labelledby="rw-set-appearance">
        <h2 className="rw-card-title" id="rw-set-appearance">{t('settings.appearance')}</h2>
        <div className="rw-card-row">
          <span className="rw-card-label">{t('settings.theme')}</span>
          <div className="segm sm" role="radiogroup" aria-label={t('settings.theme')}>
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={state.settings.theme === theme}
                className={`segm-item${state.settings.theme === theme ? ' active' : ''}`}
                onClick={() => actions.setTheme(theme)}
              >
                {t(`settings.theme.${theme}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="rw-card-row">
          <span className="rw-card-label">{t('settings.accent')}</span>
          <div className="rw-accents">
            {ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                className={`rw-acc${state.settings.accent === accent.id ? ' on' : ''}`}
                title={accent.id}
                aria-label={accent.id}
                aria-pressed={state.settings.accent === accent.id}
                style={{ background: accent.swatch }}
                onClick={() => actions.setAccent(accent.id)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="rw-card" aria-labelledby="rw-set-hosts">
        <div className="rw-card-head">
          <h2 className="rw-card-title" id="rw-set-hosts">{t('settings.hosts')}</h2>
          <button type="button" className="btn xs secondary" onClick={() => actions.startPairing()}>
            {t('host.add')}
          </button>
        </div>
        {state.hosts.map((host) => (
          <HostRow key={host.id} host={host} />
        ))}
        <p className="rw-card-hint">{t('settings.host.disconnectHint')}</p>
      </section>

      <section className="rw-card" aria-labelledby="rw-set-browser">
        <h2 className="rw-card-title" id="rw-set-browser">{t('settings.browser')}</h2>
        {logoutConfirming ? (
          <div className="rw-confirm" role="alertdialog" aria-label={t('settings.logout')}>
            <span className="rw-confirm-text">{t('settings.logoutConfirm')}</span>
            <div className="rw-confirm-actions">
              <button
                type="button"
                className="btn sm danger"
                onClick={() => {
                  setLogoutConfirming(false);
                  actions.logoutBrowser();
                }}
              >
                {t('settings.logout')}
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setLogoutConfirming(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="rw-card-row">
            <p className="rw-card-hint">{t('settings.logoutHint')}</p>
            <button
              type="button"
              className="btn sm secondary"
              disabled={state.signingOut === true}
              onClick={() => setLogoutConfirming(true)}
            >
              {t(state.signingOut ? 'settings.signingOut' : 'settings.logout')}
            </button>
          </div>
        )}
      </section>

      <p className="rw-settings-foot">
        <a href="/enrollment">{t('enrollment.title')}</a>
      </p>
    </div>
  );
}

/** Wide/mid: settings render inside the main panel. */
export function SettingsMainPanel() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <main className="main">
      <PageHeader
        title={t('settings.title')}
        leading={<HeaderButton icon="back" label={t('settings.back')} onClick={() => actions.backToChat()} />}
      />
      <div className="main-scroll">
        <div className="rw-page-body">
          <SettingsBody />
        </div>
      </div>
    </main>
  );
}

/** Narrow: settings as a full-screen page. */
export function SettingsPage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-page" data-page="settings">
      <PageHeader
        title={t('settings.title')}
        leading={<HeaderButton icon="back" label={t('shell.back')} onClick={() => actions.backToChat()} />}
      />
      <div className="rw-page-scroll">
        <div className="rw-page-body">
          <SettingsBody />
        </div>
      </div>
    </div>
  );
}

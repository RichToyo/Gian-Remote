/**
 * App shell. Wide and mid layouts: the conversation rail (computer switcher,
 * New chat, search, Tasks / Recent) beside one main card whose header names
 * what is open. Narrow layouts show one full-screen page at a time: the chat
 * with a list button, or the list, New chat, Settings or a file.
 */

import { useEffect } from 'react';
import { LocaleProvider, useT } from './i18n/index.js';
import { resolveTheme, useSystemDark } from './theme.js';
import { useRemoteActions, useRemoteState } from './ui/controller-context.js';
import { ConnectionBanner, DeviceRevokedPage, ServerChangedPage } from './ui/banners.js';
import { ChatPage } from './ui/chat.js';
import { ChatHeader } from './ui/chat-header.js';
import { FileMainPanel, FilePage, FileSheetPanel } from './ui/file-viewer.js';
import { Icon } from './ui/icons.js';
import { NewChatPage } from './ui/new-chat.js';
import { HeaderButton, PageHeader } from './ui/page.js';
import { PairingApp } from './ui/pairing.js';
import { Rail, RailPage } from './ui/rail.js';
import { SettingsMainPanel, SettingsPage } from './ui/settings.js';
import { useViewportMode } from './ui/viewport.js';

function InitialConnectionPanel() {
  const t = useT();
  const state = useRemoteState();
  if (!state.currentHostId) {
    return (
      <div className="rw-center-state" role="status">
        <Icon name="computer" size={22} />
        <strong>{t('host.select')}</strong>
        <span>{t('host.selectHint')}</span>
      </div>
    );
  }
  return (
    <>
      <ConnectionBanner connection={state.connection} />
      <div className="rw-center-state" role="status" aria-label={t('conn.initial.title')} aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <strong>{t('conn.initial.title')}</strong>
        <span>{state.connectionPhase ? t(`conn.phase.${state.connectionPhase}`) : t('conn.initial.desc')}</span>
        {state.connectionFailed && <span className="rw-center-hint">{t('conn.failedHint')}</span>}
      </div>
    </>
  );
}

/** Nothing selected yet: say what to do instead of showing a blank card. */
function EmptyMain() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const canCreate = state.capabilities['session.create']?.state === 'supported';
  return (
    <>
      <ConnectionBanner connection={state.connection} />
      <div className="rw-center-state">
        <Icon name="compose" size={22} />
        <strong>{t('main.empty.title')}</strong>
        <span>{t(mode === 'narrow' ? 'main.empty.descNarrow' : 'main.empty.desc')}</span>
        <div className="rw-center-actions">
          {mode === 'narrow' && (
            <button type="button" className="btn sm secondary" onClick={() => actions.openMobilePage('rail')}>
              {t('main.empty.browse')}
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                actions.openNewChat('');
                if (mode === 'narrow') actions.openMobilePage('new-chat');
              }}
            >
              {t('rail.newChat.title')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** A directory chat whose session.subscribe has not answered yet. */
function OpeningChat() {
  const t = useT();
  return (
    <div className="rw-center-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t('chat.opening')}</span>
    </div>
  );
}

function NewChatMain() {
  const t = useT();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  return (
    <>
      <PageHeader
        title={t('newchat.title')}
        leading={<HeaderButton icon="back" label={t('shell.back')} onClick={() => actions.backToChat()} />}
      />
      {mode !== 'narrow' && <ConnectionBannerSlot />}
      <NewChatPage />
    </>
  );
}

function ConnectionBannerSlot() {
  const state = useRemoteState();
  return <ConnectionBanner connection={state.connection} />;
}

function useCurrentSession() {
  const state = useRemoteState();
  const view = state.view;
  const session = view.kind === 'chat' ? state.sessions.find((item) => item.id === view.sessionId) : undefined;
  const opening = view.kind === 'chat' && !session && state.directory?.opening === view.sessionId;
  return { session, opening };
}

function DesktopShell() {
  const state = useRemoteState();
  const mode = useViewportMode();
  const view = state.view;
  const awaitingInitialSnapshot = state.auth.kind === 'challenge-login' && state.snapshotReceivedAt === null;
  const { session, opening } = useCurrentSession();
  const fileOpen = state.fileViewer !== null;
  // Wide: the file opens beside the chat; mid: it replaces the chat.
  const fileAsPanel = fileOpen && mode === 'wide';
  const fileAsMain = fileOpen && mode === 'mid';

  let main;
  if (awaitingInitialSnapshot) {
    main = <main className="main rw-initial-main" aria-busy="true"><InitialConnectionPanel /></main>;
  } else if (fileAsMain) {
    main = <FileMainPanel />;
  } else if (view.kind === 'settings') {
    main = <SettingsMainPanel />;
  } else if (view.kind === 'new-chat') {
    main = <main className="main"><NewChatMain /></main>;
  } else if (session) {
    main = (
      <main className="main">
        <ChatHeader session={session} />
        <ChatPage session={session} />
      </main>
    );
  } else {
    main = <main className="main">{opening ? <OpeningChat /> : <EmptyMain />}</main>;
  }

  return (
    <div className="rw-app" data-mode={mode}>
      <Rail />
      {main}
      {fileAsPanel && <FileSheetPanel />}
    </div>
  );
}

function NarrowShell() {
  const state = useRemoteState();
  const page = state.mobilePage;
  const awaitingInitialSnapshot = state.auth.kind === 'challenge-login' && state.snapshotReceivedAt === null;
  const { session, opening } = useCurrentSession();

  if (page === 'rail') {
    return <div className="rw-app" data-mode="narrow"><RailPage /></div>;
  }
  if (page === 'settings') {
    return <div className="rw-app" data-mode="narrow"><SettingsPage /></div>;
  }
  if (page === 'new-chat') {
    return (
      <div className="rw-app" data-mode="narrow">
        <div className="rw-page" data-page="new-chat"><NewChatMain /></div>
      </div>
    );
  }
  if (page === 'file' && state.fileViewer) {
    return <div className="rw-app" data-mode="narrow"><FilePage /></div>;
  }
  return (
    <div className="rw-app" data-mode="narrow">
      <main
        className={`main${awaitingInitialSnapshot ? ' rw-initial-main' : ''}`}
        aria-busy={awaitingInitialSnapshot || undefined}
      >
        {awaitingInitialSnapshot ? <NarrowConnecting />
          : session ? (
            <>
              <ChatHeader session={session} />
              <ChatPage session={session} />
            </>
          ) : opening ? <OpeningChat /> : <EmptyMain />}
      </main>
    </div>
  );
}

function NarrowConnecting() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <>
      <PageHeader
        title={t('rail.title')}
        leading={<HeaderButton icon="menu" label={t('shell.menu')} onClick={() => actions.openMobilePage('rail')} />}
      />
      <InitialConnectionPanel />
    </>
  );
}

function Shell() {
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const systemDark = useSystemDark();

  // Apply theme/accent to the document root element the tokens bind to.
  // `system` tracks the OS dark-mode preference live.
  useEffect(() => {
    document.body.dataset.theme = resolveTheme(state.settings.theme, systemDark);
    document.body.dataset.accent = state.settings.accent;
  }, [state.settings.theme, state.settings.accent, systemDark]);

  useEffect(() => {
    if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'enter-code') {
      actions.restoreBrowserSession();
    }
  }, [actions, state.auth]);

  // Terminal states are full pages: caches are already cleared by the
  // controller, and the only ways forward are pairing again or an explicit
  // decision about the Server.
  if (state.connection.kind === 'device_revoked') {
    return <DeviceRevokedPage reason={state.connection.reason} />;
  }
  if (state.connection.kind === 'server_changed') {
    return <ServerChangedPage />;
  }
  // Remembered device-key authentication stays in the product shell. If
  // legacy state contains more than one Host, the rail's selector owns that
  // choice instead of a standalone login page.
  if (state.auth.kind === 'pairing') {
    return <PairingApp />;
  }
  return mode === 'narrow' ? <NarrowShell /> : <DesktopShell />;
}

export function App() {
  // The locale is Host-driven (state snapshot), not a boot-time constant, so
  // the provider must live under the controller and rebind on state change.
  const state = useRemoteState();
  return (
    <LocaleProvider locale={state.locale}>
      <Shell />
    </LocaleProvider>
  );
}

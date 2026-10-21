import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CHAT_UI_MESSAGE_KEYS } from '@gian/chat-ui';
import { generateCanonicalId, type RemoteStateSnapshot } from '@gian/remote-protocol';
import { applySnapshotToState } from '../src/controller/apply-control.js';
import type { RemoteUiState } from '../src/controller/types.js';
import { EN } from '../src/i18n/en.js';
import { LocaleProvider, REMOTE_WEB_LOCALE, resolveRemoteWebLocale, useLocale, useT } from '../src/i18n/index.js';

function Probe() {
  const locale = useLocale();
  const t = useT();
  return createElement('span', null, `${locale}:${t('pair.code.field')}`);
}

function baseState(): RemoteUiState {
  return {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
    connection: { kind: 'browser_offline' },
    hosts: [],
    currentHostId: null,
    locale: 'en',
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    interactionPhases: {},
    interactionErrors: {},
    capabilities: {},
    catalogRevision: '',
    catalog: null,
    catalogInvalidated: false,
    logos: {},
    snapshotReceivedAt: null,
    view: { kind: 'empty' },
    mobilePage: 'chat',
    transcripts: {},
    drafts: {},
    translations: {},
    queueNotice: null,
    fileViewer: null,
    fileDownload: { status: 'idle' },
    mutations: {},
    unknownCommandId: null,
    settings: { theme: 'system', accent: 'azure' },
  };
}

function hostSnapshot(locale?: 'en' | 'zh-CN'): RemoteStateSnapshot {
  return {
    type: 'state.snapshot',
    snapshot_id: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    revision: 'rev-1',
    event_sequence: 0,
    host: {
      id: generateCanonicalId(),
      name: 'Office Mac',
      online: true,
      version: '0.6.4',
      ...(locale ? { locale } : {}),
    },
    workspaces: [],
    tasks: [],
    sessions: [],
    interactions: [],
    capabilities: {},
    attention: [],
    catalog_revision: 'cat-1',
  };
}

describe('i18n locale source', () => {
  it('normalizes both legacy Host locale and missing locale to English', () => {
    // Before any snapshot (pairing, enrollment) the UI is English.
    expect(baseState().locale).toBe('en');
    // A negotiated Host ships its configured UI locale in the snapshot.
    const zh = applySnapshotToState(baseState(), hostSnapshot('zh-CN'));
    expect(zh.locale).toBe('en');
    // Old Hosts and stale encrypted caches omit the field: back to 'en'.
    const legacy = applySnapshotToState(zh, hostSnapshot());
    expect(legacy.locale).toBe('en');
    // index.html keeps the pre-boot default; LocaleProvider syncs <html lang>.
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).toContain('<html lang="en">');
  });
});

describe('English product copy', () => {
  it('keeps the provider context and copy in English when the prop is legacy zh-CN', () => {
    render(createElement(LocaleProvider, {
      locale: 'zh-CN',
      children: createElement(Probe),
    }));
    expect(screen.getByText('en:Pairing code')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(resolveRemoteWebLocale('zh-CN')).toBe(REMOTE_WEB_LOCALE);
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
  });

  it('every chat-ui message key is present in the English table', () => {
    for (const key of CHAT_UI_MESSAGE_KEYS) {
      expect(EN[key], `en missing ${key}`).toBeTruthy();
    }
  });
});

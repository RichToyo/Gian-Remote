/**
 * Named fixture scenarios — the single source for screenshot evidence
 * (`?fixture=<name>`) and for tests that want a precomposed state. Each
 * entry is plain controller state; nothing here touches a network.
 */

import type { RemoteInteraction } from '@gian/remote-protocol';
import type { FixtureScenario } from './controller/fixture.js';
import {
  sampleHosts,
  sampleSessions,
  sampleTasks,
  sampleTranscript,
} from './controller/fixture.js';

export function sampleInteraction(partial?: Partial<RemoteInteraction>): RemoteInteraction {
  return {
    id: 'int-1',
    revision: 'irev-1',
    session_id: 's-1',
    turn_id: 'turn-1',
    kind: 'approval',
    created_at: new Date().toISOString(),
    presentation: {
      title: 'Run command',
      description: 'Run this from the repository root',
      risk: 'medium',
      subject: 'git config core.hooksPath .husky',
      actions: [
        { id: 'act-allow', label: 'Allow once', tone: 'default' },
        { id: 'act-decline', label: 'Decline', tone: 'danger' },
      ],
    },
    ...partial,
  };
}

const base = Date.UTC(2026, 8, 1, 13, 2, 0);

export const FIXTURE_SCENARIOS: Record<string, FixtureScenario> = {
  /** F1: desktop chat, active turn, queue with two entries. */
  chat: {},

  /** Composer with one upload in progress and one that failed. */
  'composer-uploads': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: [{ ...sampleSessions()[1]!, status: 'done' }],
        transcripts: { 's-2': sampleTranscript() },
        uploads: { 's-2': [
          { id: 'u1', name: 'screen-recording.mov', size: 4_000_000, status: 'uploading' },
          { id: 'u2', name: 'build-logs.zip', size: 31_000_000, status: 'failed', error: 'FILE_TOO_LARGE' },
        ] },
      },
    },
    view: { kind: 'chat', sessionId: 's-2' },
  },

  /** An image attachment in the transcript shown as a preview. */
  'attachment-preview': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: [{ ...sampleSessions()[1]!, status: 'done' }],
        transcripts: { 's-2': sampleTranscript().map(item => (item.kind === 'user'
          ? { ...item, attachments: [{ name: 'settings.png', mime: 'image/png', url: 'ref-settings', size: 52_000 }] }
          : item)) },
        thumbnails: { 'ref-settings': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSczMjAnIGhlaWdodD0nMjAwJz48cmVjdCB3aWR0aD0nMzIwJyBoZWlnaHQ9JzIwMCcgZmlsbD0nI2U5ZTNmNScvPjxyZWN0IHg9JzI0JyB5PScyNCcgd2lkdGg9JzI3MicgaGVpZ2h0PScyOCcgcng9JzYnIGZpbGw9JyNiOWE2ZTAnLz48cmVjdCB4PScyNCcgeT0nNjgnIHdpZHRoPScyMDAnIGhlaWdodD0nMTQnIHJ4PSc0JyBmaWxsPScjY2ZjM2VhJy8+PHJlY3QgeD0nMjQnIHk9JzkyJyB3aWR0aD0nMjQwJyBoZWlnaHQ9JzE0JyByeD0nNCcgZmlsbD0nI2NmYzNlYScvPjxyZWN0IHg9JzI0JyB5PScxNDAnIHdpZHRoPScxMjAnIGhlaWdodD0nMzYnIHJ4PSc4JyBmaWxsPScjOGY2ZmQxJy8+PC9zdmc+' },
      },
    },
    view: { kind: 'chat', sessionId: 's-2' },
  },

  /** Idle session (no active turn), plain Send. */
  'chat-idle': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: [
          {
            ...sampleSessions()[1]!,
            status: 'done',
          },
        ],
        transcripts: { 's-2': sampleTranscript() },
      },
    },
    view: { kind: 'chat', sessionId: 's-2' },
  },

  'wide-content': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: [{ ...sampleSessions()[1]!, status: 'done' }],
        transcripts: { 's-2': [{
          kind: 'assistant', id: 'wide-layout', exec: 'claude', ts: base, turn: 1,
          text: [
            '| ' + Array.from({ length: 18 }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |',
            '| ' + Array.from({ length: 18 }, () => '---').join(' | ') + ' |',
            '| ' + Array.from({ length: 18 }, (_, i) => `Value ${i + 1}`).join(' | ') + ' |',
            '', '```javascript', `const value = "${'LongCode'.repeat(60)}";`, '```',
          ].join('\n'),
        }] },
      },
    },
    view: { kind: 'chat', sessionId: 's-2' },
    mobilePage: 'chat',
  },

  /** F2: file open (ready) — wide shows the right panel, mid/narrow a page. */
  'file-ready': {
    mobilePage: 'file',
    fileViewer: {
      status: 'ready',
      handle: { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' },
      text: '#!/bin/sh\n# GianDev: run the quick regression gate before push\n# Skip: git push --no-verify\nset -e\n\npnpm verify:quick -- --base origin/main\n',
      sizeLabel: '128 B',
    },
  },

  'file-loading': {
    mobilePage: 'file',
    fileViewer: {
      status: 'loading',
      handle: { id: 'file-1', sessionId: 's-1', label: 'pre-push', dirLabel: '.husky/' },
    },
  },

  'file-too-large': {
    mobilePage: 'file',
    fileViewer: {
      status: 'too_large',
      handle: { id: 'file-2', sessionId: 's-1', label: 'dump.sql', dirLabel: 'artifacts/' },
      limitLabel: '1 MB',
    },
  },

  /** F6: Host offline — stale snapshot, mutations disabled. */
  'host-offline': {
    connection: { kind: 'host_offline', lastSeenAt: base },
  },

  'browser-offline': {
    connection: { kind: 'browser_offline' },
  },

  'relay-reconnecting': {
    connection: { kind: 'relay_reconnecting', attempt: 2 },
  },

  resyncing: {
    connection: { kind: 'resyncing', synced: 3, total: 8 },
  },

  'version-mismatch': {
    connection: { kind: 'version_mismatch', requiredVersion: '0.5.4', hostVersion: '0.5.2' },
  },

  'device-revoked': {
    connection: { kind: 'device_revoked' },
  },

  'device-key-missing': {
    connection: { kind: 'device_revoked', reason: 'key_missing' },
  },

  'host-key-changed': {
    connection: { kind: 'device_revoked', reason: 'host_key_changed' },
  },

  /** Another tab of this browser took the connection. */
  'taken-over': {
    connection: { kind: 'taken_over' },
  },

  'server-changed': {
    connection: { kind: 'server_changed' },
  },

  /** Unknown outcome strip (§14). */
  'unknown-outcome': {
    unknownCommandId: 'cmd-0001',
  },

  /** F12: PRECONDITION_FAILED — queue replaced wholesale + notice. */
  'queue-conflict': {
    queueNotice: { kind: 'replaced-remotely' },
  },

  /** Interaction card pending in the transcript. */
  'interaction-pending': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        interactions: [sampleInteraction()],
        transcripts: { 's-1': sampleTranscript() },
      },
    },
  },

  'interaction-question': {
    hostData: {
      'host-home': {
        workspaces: [{ id: 'ws-1', name: '~/Coding/Gian-Dev' }],
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        interactions: [
          sampleInteraction({
            id: 'int-q',
            kind: 'question',
            presentation: {
              title: 'Which locations should this change cover?',
              description: 'Confirm the scope before you submit:',
              risk: 'low',
              actions: [
                { id: 'act-submit', label: 'Submit', tone: 'default' },
                { id: 'act-cancel', label: 'Cancel', tone: 'danger' },
              ],
              inputs: [
                {
                  id: 'in-scope',
                  label: 'Scope',
                  type: 'multi_select',
                  options: [
                    { value: 'hook', label: '.husky/pre-push', description: 'The hook itself' },
                    { value: 'pkg', label: 'package.json', description: 'Document the verify:quick script' },
                    { value: 'contrib', label: 'CONTRIBUTING.md', description: 'Update the contributing guide' },
                  ],
                },
              ],
            },
          }),
        ],
        transcripts: { 's-1': sampleTranscript() },
      },
    },
  },

  /** F11: New Chat form (desktop in main panel / narrow full page). */
  'new-chat': {
    view: { kind: 'new-chat', presetTaskId: 'task-1' },
    mobilePage: 'new-chat',
  },

  /** F7/F8: Settings. */
  settings: {
    view: { kind: 'settings' },
    mobilePage: 'settings',
  },

  /** Narrow rail page (F4). */
  'rail-mobile': {
    mobilePage: 'rail',
  },

  /** B1 pairing pages. */
  'pair-code': {
    auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
  },
  'pair-qr': {
    auth: { kind: 'pairing', pairing: { kind: 'qr-confirm', hostName: 'MacBook Pro · Home', deviceName: 'iPhone 17 Pro' } },
  },
  'pair-waiting': {
    auth: { kind: 'pairing', pairing: { kind: 'waiting', deviceName: 'iPhone 17 Pro', expiresAt: Date.now() + 240_000 } },
  },
  'pair-failed-expired': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'expired' } },
  },
  'pair-failed-rejected': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'rejected' } },
  },
  'pair-failed-rate-limited': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'attempt-limit' } },
  },
  'pair-failed-host-offline': {
    auth: { kind: 'pairing', pairing: { kind: 'failed', reason: 'host-offline', hostName: 'MacBook Pro · Home' } },
  },
  'challenge-login': {
    auth: { kind: 'challenge-login', hosts: sampleHosts() },
    connection: { kind: 'resyncing', synced: 0, total: 1 },
    snapshotReceivedAt: null,
  },
};

import { describe, expect, it } from 'vitest';
import {
  AUTH_PROTOCOL,
  generateCanonicalId,
  exportPublicJwk,
  generateP256KeyPair,
  RemoteProtocolError,
  generateUuidV7,
  sha256Hex,
  type RemoteMethod,
  type RemoteStateSnapshot,
} from '@gian/remote-protocol';
import { MemoryEncryptedHostCache } from '../src/cache/encrypted-cache.js';
import { MemoryPendingDraftStore } from '../src/cache/pending-drafts.js';
import { createProductionController, type ProductionController } from '../src/controller/create.js';
import type { DeviceRelayClientOptions, DeviceRelayLike } from '../src/transport/relay-client.js';
import { MemoryBrowserIdentityStore } from '../src/transport/identity.js';
import { MemoryCookieJar, type RemoteHttpClient } from '../src/transport/http.js';

const hostId = '11111111-1111-4111-8111-111111111111';
const deviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = generateCanonicalId();
const FEATURE = 'wire.conversation_translation';

class FakeRelay implements DeviceRelayLike {
  isOpen = false;
  negotiatedCapabilities: readonly string[] | null = [FEATURE];
  private closed = false;
  readonly sent: Array<{ type?: string; command_id?: string; method?: string; params?: unknown }> = [];

  constructor(private readonly input: DeviceRelayClientOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'closed');
    this.isOpen = true;
  }

  async sendControl(message: object): Promise<void> {
    this.sent.push(message as (typeof this.sent)[number]);
  }

  async sendContent(): Promise<void> {}

  close(reason = 'device_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    this.input.handlers.onClose?.(reason);
  }

  async emit(message: { type?: string; [key: string]: unknown }): Promise<void> {
    await this.input.handlers.onControl(message);
  }

  async answer(method: RemoteMethod, data: unknown): Promise<void> {
    const request = [...this.sent].reverse().find(message => message.method === method && message.type === 'command.request');
    if (!request) throw new Error(`no ${method} command sent`);
    await this.emit({ type: 'command.result', command_id: request.command_id, ok: true, data });
  }

  lastCommand(method: RemoteMethod) {
    return [...this.sent].reverse().find(message => message.method === method && message.type === 'command.request');
  }
}

function snapshot(): RemoteStateSnapshot {
  return {
    type: 'state.snapshot',
    snapshot_id: generateCanonicalId(),
    host_generation: generateCanonicalId(),
    revision: 'rev-1',
    event_sequence: 0,
    host: { id: hostId, name: 'Office', online: true, version: '0.6.8' },
    workspaces: [],
    tasks: [{ id: generateCanonicalId(), name: 'Doing', updated_at: new Date().toISOString(), session_ids: [sessionId] }],
    sessions: [{
      id: sessionId,
      revision: 'session-rev-1',
      name: 'Translation session',
      task_id: generateCanonicalId(),
      workspace_id: generateCanonicalId(),
      agent: { id: generateCanonicalId(), name: 'Codex', proxy: 'codex' },
      status: 'done',
      queue: { revision: 'queue-rev-1', entries: [] },
      updated_at: new Date().toISOString(),
    }],
    interactions: [],
    capabilities: {},
    attention: [],
    catalog_revision: 'cat-1',
  };
}

const translationState = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  configured: true,
  sending_language: 'en',
  reading_language: 'zh-CN',
  revision: 1,
  config_revision: 1,
  automatic_revision: 0,
  automatic_epoch: 'epoch-1',
  automatic: [],
  ...overrides,
});

async function viWait(check: () => Promise<boolean> | boolean, timeoutMs = 1_500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('timed out');
}

async function bootedController(options: { draftStore?: MemoryPendingDraftStore } = {}): Promise<{
  controller: ProductionController;
  relays: FakeRelay[];
  currentRelay: () => FakeRelay;
  draftStore: MemoryPendingDraftStore;
}> {
  const identity = new MemoryBrowserIdentityStore();
  const cache = new MemoryEncryptedHostCache();
  const draftStore = options.draftStore ?? new MemoryPendingDraftStore();
  await identity.createPending();
  await identity.bindPending(hostId);
  await cache.put(hostId, { type: 'state.snapshot', host: { id: hostId, name: 'Office' } });
  const hostKey = await exportPublicJwk((await generateP256KeyPair()).publicKey);
  const http: RemoteHttpClient = {
    cookies: new MemoryCookieJar(),
    async request(path) {
      if (path === '/api/v1/sessions/device-challenge') {
        return { protocol: AUTH_PROTOCOL, challenge_id: generateCanonicalId(), challenge: 'c', expires_at: Date.now() + 60_000 };
      }
      if (path === '/api/v1/sessions/device-login') {
        return {
          protocol: AUTH_PROTOCOL,
          access_token: 'token',
          expires_at: Date.now() + 60_000,
          device_id: deviceId,
          host_id: hostId,
          crypto_connection_id: generateCanonicalId(),
          host_public_key: hostKey,
        };
      }
      if (path === '/api/v1/ws-tickets') return { protocol: AUTH_PROTOCOL, ticket: 't', expires_at: Date.now() + 60_000 };
      throw new Error(path);
    },
    async get() { return { protocol: AUTH_PROTOCOL }; },
    async del() { return { protocol: AUTH_PROTOCOL }; },
  };
  const relays: FakeRelay[] = [];
  const controller = createProductionController({
    baseUrl: 'https://remote.test',
    publicOrigin: 'https://remote.test',
    identity,
    cache,
    http,
    autoRestore: false,
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
    draftStore,
    createRelay(input) { const relay = new FakeRelay(input); relays.push(relay); return relay; },
  });
  const currentRelay = () => {
    const relay = relays.at(-1);
    if (!relay) throw new Error('no relay created');
    return relay;
  };
  controller.actions.challengeLogin(hostId);
  await viWait(() => controller.state.connection.kind === 'online');
  await currentRelay().answer('state.refresh', snapshot());
  await viWait(() => controller.state.sessions.some(session => session.id === sessionId));
  // Hydration: subscribe carries the negotiated translation state; the page
  // carries the reading translations for its turns.
  await viWait(() => Boolean(currentRelay().lastCommand('session.subscribe')));
  await currentRelay().answer('session.subscribe', {
    session: snapshot().sessions[0],
    cursor: 'session-rev-1',
    translation: translationState(),
  });
  await currentRelay().answer('session.page', {
    session_id: sessionId,
    has_more: false,
    items: [],
    translations: [{
      id: generateCanonicalId(),
      session_id: sessionId,
      purpose: 'read',
      source_id: 'turn:1',
      target_language: 'zh-CN',
      text: String.fromCodePoint(0x5386, 0x53f2, 0x8bd1, 0x6587),
      text_length: 5,
      text_sha256: 'b'.repeat(64),
      source_sha256: 'b'.repeat(64),
    }],
  });
  await viWait(() => controller.state.translations[sessionId]?.supported === true);
  return { controller, relays, currentRelay, draftStore };
}

function translationEvent(event: Record<string, unknown>) {
  return {
    type: 'event',
    host_generation: generateCanonicalId(),
    event_sequence: 0,
    event: { kind: 'translation.updated', session_id: sessionId, ...event },
  };
}

describe('remote conversation translation', () => {
  it('gates an automatic send: request first, dispatch only with the Host receipt', async () => {
    const { controller, currentRelay } = await bootedController();
    const relay = currentRelay();
    try {
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x4f60, 0x597d));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const request = relay.lastCommand('translation.request')!;
      const params = request.params as { purpose?: string; text?: string; request_id?: string };
      expect(params.purpose).toBe('send');
      expect(params.text).toBe(String.fromCodePoint(0x4f60, 0x597d));
      expect(relay.lastCommand('session.send')).toBeUndefined();
      expect(controller.state.drafts[sessionId]?.text ?? '').toBe('');
      expect(controller.state.translations[sessionId]?.send?.phase).toBe('translating');

      await relay.answer('translation.request', { request_id: params.request_id, status: 'accepted' });
      const recordId = generateCanonicalId();
      await relay.emit(translationEvent({
        request_id: params.request_id,
        upsert: {
          id: recordId,
          session_id: sessionId,
          purpose: 'send',
          target_language: 'en',
          text: 'Hello',
          text_length: 5,
          text_sha256: 'a'.repeat(64),
          source_sha256: 'a'.repeat(64),
        },
      }));
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      const send = relay.lastCommand('session.send')!;
      expect((send.params as { translation_id?: string }).translation_id).toBe(recordId);
      expect((send.params as { text?: string }).text).toBe(String.fromCodePoint(0x4f60, 0x597d));
      await relay.answer('session.send', { session: snapshot().sessions[0] });
      await viWait(() => controller.state.translations[sessionId]?.send === null);
    } finally { controller.close(); }
  });

  it('failed translation offers retry / send original / reclaim — never a silent original', async () => {
    const { controller, currentRelay } = await bootedController();
    const relay = currentRelay();
    try {
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x4f60, 0x597d));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const request = relay.lastCommand('translation.request')!;
      const requestId = (request.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await relay.emit(translationEvent({ request_id: requestId, error: String.fromCodePoint(0x6a21, 0x578b, 0x4e0d, 0x53ef, 0x7528) }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      expect(relay.lastCommand('session.send')).toBeUndefined();

      controller.actions.retryTranslationSend(sessionId);
      await viWait(() => relay.sent.filter(message => message.method === 'translation.request').length === 2);
      const retried = relay.lastCommand('translation.request')!;
      const retryId = (retried.params as { request_id?: string }).request_id;
      expect(retryId).not.toBe(requestId);
      await relay.answer('translation.request', { request_id: retryId, status: 'accepted' });
      await relay.emit(translationEvent({ request_id: retryId, error: 'still down' }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');

      controller.actions.sendOriginalTranslation(sessionId);
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      expect((relay.lastCommand('session.send')!.params as { translation_id?: string }).translation_id).toBe('original');
      await relay.answer('session.send', { session: snapshot().sessions[0] });
      await viWait(() => controller.state.translations[sessionId]?.send === null);

      // Reclaim restores the draft and cancels the in-flight request.
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x62ff, 0x56de, 0x6765));
      controller.actions.sendDraft(sessionId);
      await viWait(() => relay.sent.filter(message => message.method === 'translation.request').length === 3);
      const third = relay.lastCommand('translation.request')!;
      const thirdId = (third.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: thirdId, status: 'accepted' });
      controller.actions.reclaimTranslationSend(sessionId);
      expect(controller.state.drafts[sessionId]?.text).toBe(String.fromCodePoint(0x62ff, 0x56de, 0x6765));
      expect(controller.state.translations[sessionId]?.send).toBeNull();
      await viWait(() => Boolean(relay.lastCommand('translation.cancel')));
      expect((relay.lastCommand('translation.cancel')!.params as { request_id?: string }).request_id).toBe(thirdId);
    } finally { controller.close(); }
  });

  it('syncs the switch both ways and applies Host-confirmed state', async () => {
    const { controller, currentRelay } = await bootedController();
    const relay = currentRelay();
    try {
      expect(controller.state.translations[sessionId]?.enabled).toBe(true);
      controller.actions.setAutoTranslation(sessionId, false);
      await viWait(() => Boolean(relay.lastCommand('translation.set_auto')));
      const params = relay.lastCommand('translation.set_auto')!.params as { enabled?: boolean; expected_enabled?: boolean; expected_revision?: number };
      expect(params).toEqual({ session_id: sessionId, enabled: false, expected_enabled: true, expected_revision: 1 });
      // Not yet flipped locally — only the Host confirmation applies.
      expect(controller.state.translations[sessionId]?.enabled).toBe(true);
      await relay.answer('translation.set_auto', translationState({ enabled: false, revision: 2 }));
      await viWait(() => controller.state.translations[sessionId]?.enabled === false);
      expect(controller.state.translations[sessionId]?.revision).toBe(2);

      // Another view's toggle arrives as an event and applies verbatim.
      await relay.emit(translationEvent({ state: translationState({ enabled: true, revision: 3 }) }));
      await viWait(() => controller.state.translations[sessionId]?.enabled === true);
      expect(controller.state.translations[sessionId]?.revision).toBe(3);
    } finally { controller.close(); }
  });

  it('stores paged and live reading translations, and tracks globe requests', async () => {
    const { controller, currentRelay } = await bootedController();
    const relay = currentRelay();
    try {
      expect(controller.state.translations[sessionId]?.results['turn:1']?.[0]?.text).toBe(String.fromCodePoint(0x5386, 0x53f2, 0x8bd1, 0x6587));

      controller.actions.retryReadTranslation(sessionId, 'turn:2', 'Reply body');
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const params = relay.lastCommand('translation.request')!.params as {
        purpose?: string; source_id?: string; text?: string; request_id?: string;
      };
      expect(params).toMatchObject({ purpose: 'read', source_id: 'turn:2', text: 'Reply body' });
      expect(controller.state.translations[sessionId]?.reading['turn:2']?.pending).toBe(true);
      await relay.answer('translation.request', { request_id: params.request_id, status: 'accepted' });
      await relay.emit(translationEvent({
        request_id: params.request_id,
        upsert: {
          id: generateCanonicalId(),
          session_id: sessionId,
          purpose: 'read',
          source_id: 'turn:2',
          target_language: 'zh-CN',
          text: String.fromCodePoint(0x56de, 0x590d, 0x8bd1, 0x6587),
          text_length: 5,
          text_sha256: 'c'.repeat(64),
          source_sha256: 'c'.repeat(64),
        },
      }));
      await viWait(() => controller.state.translations[sessionId]?.results['turn:2']?.[0]?.text === String.fromCodePoint(0x56de, 0x590d, 0x8bd1, 0x6587));
      expect(controller.state.translations[sessionId]?.reading['turn:2']).toBeUndefined();

      // The globe override is per-view and defaults follow the switch
      // (enabled=true here): first click collapses, second expands again.
      controller.actions.toggleReadTranslation(sessionId, 'turn:2', 'Reply body');
      expect(controller.state.translations[sessionId]?.expandOverrides['turn:2']).toBe(false);
      controller.actions.toggleReadTranslation(sessionId, 'turn:2', 'Reply body');
      expect(controller.state.translations[sessionId]?.expandOverrides['turn:2']).toBe(true);
    } finally { controller.close(); }
  });

  it('queues plainly on a busy session — no pre-translation, no stale receipt', async () => {
    const { controller, currentRelay } = await bootedController();
    const relay = currentRelay();
    try {
      const busy = snapshot();
      busy.sessions[0]!.active_turn = { id: generateCanonicalId(), turn_number: 4 };
      await relay.emit({
        type: 'event',
        host_generation: generateCanonicalId(),
        event_sequence: 1,
        event: { kind: 'session.updated', session: busy.sessions[0] },
      });
      await viWait(() => controller.state.sessions[0]?.active_turn !== undefined);
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x6392, 0x961f, 0x6d88, 0x606f));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      expect(relay.lastCommand('translation.request')).toBeUndefined();
      const send = relay.lastCommand('session.send')!;
      expect((send.params as { busy?: string }).busy).toBe('queue');
      expect((send.params as { translation_id?: string }).translation_id).toBeUndefined();
    } finally { controller.close(); }
  });

  it('restarts an in-flight gate under a fresh generation after reconnect', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const first = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x6062, 0x590d, 0x6211));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(first.lastCommand('translation.request')));
      const firstId = (first.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      first.close('read_timeout');
      await viWait(() => currentRelay() !== first && controller.state.connection.kind === 'online');
      const second = currentRelay();
      // The recovery sync may take either path (resume replay or a full
      // snapshot); both end by restarting the orphaned gate.
      await viWait(() => Boolean(second.lastCommand('state.refresh') || second.sent.find(message => message.type === 'resume.request')));
      if (second.lastCommand('state.refresh')) {
        await second.answer('state.refresh', snapshot());
      } else {
        await second.emit({ type: 'resume.ok', host_generation: generateCanonicalId(), replay_from: 0, replay_through: 0, revision: 'rev-1' });
      }
      await viWait(() => Boolean(second.lastCommand('translation.request')));
      const restartedId = (second.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      expect(restartedId).not.toBe(firstId);
      expect(controller.state.translations[sessionId]?.send?.phase).toBe('translating');
      // The echo identity is the stable submission id — restarting the
      // request generation must not strand the bubble or its status row.
      const submissionId = controller.state.translations[sessionId]?.send?.submissionId;
      expect(controller.state.transcripts[sessionId]?.items.some(item => item.id === `translation-echo:${submissionId}`)).toBe(true);
    } finally { controller.close(); }
  });

  it('a dispatched send with a lost ACK recovers via command.status and never re-sends (F1)', async () => {
    const { controller, currentRelay, relays } = await bootedController();
    try {
      const first = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x4f60, 0x597d));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(first.lastCommand('translation.request')));
      const requestId = (first.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await first.answer('translation.request', { request_id: requestId, status: 'accepted' });
      const recordId = generateCanonicalId();
      await first.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: recordId, session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'Hello', text_length: 5, text_sha256: 'a'.repeat(64), source_sha256: 'a'.repeat(64),
        },
      }));
      await viWait(() => Boolean(first.lastCommand('session.send')));
      const sendCommandId = first.lastCommand('session.send')!.command_id!;
      expect(controller.state.translations[sessionId]?.send?.phase).toBe('dispatching');

      // The ACK is lost: disconnect before the command.result.
      first.close('read_timeout');
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'unknown');
      await viWait(() => currentRelay() !== first && controller.state.connection.kind === 'online');
      const second = currentRelay();
      // Recovery sync, then command.status — the ONLY retry path.
      await viWait(() => Boolean(second.lastCommand('state.refresh') || second.sent.find(message => message.type === 'resume.request')));
      if (second.lastCommand('state.refresh')) await second.answer('state.refresh', snapshot());
      else await second.emit({ type: 'resume.ok', host_generation: generateCanonicalId(), replay_from: 0, replay_through: 0, revision: 'rev-1' });
      await viWait(() => Boolean(second.lastCommand('command.status')));
      const statusProbe = second.lastCommand('command.status')!;
      expect((statusProbe.params as { command_id?: string }).command_id).toBe(sendCommandId);
      await second.emit({
        type: 'command.result', command_id: statusProbe.command_id, ok: true,
        data: { command_id: sendCommandId, state: 'succeeded', result: { session: snapshot().sessions[0], delivery_id: generateCanonicalId() } },
      });
      await viWait(() => controller.state.translations[sessionId]?.send === null);
      const totalSends = relays.flatMap(relay => relay.sent).filter(message => message.method === 'session.send').length;
      expect(totalSends).toBe(1);
    } finally { controller.close(); }
  });

  it('send-original double-click dispatches exactly once (F1)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x70b9, 0x4e24, 0x6b21));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      controller.actions.sendOriginalTranslation(sessionId);
      controller.actions.sendOriginalTranslation(sessionId);
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      expect(relay.sent.filter(message => message.method === 'session.send').length).toBe(1);
      expect((relay.lastCommand('session.send')!.params as { translation_id?: string }).translation_id).toBe('original');
      // After submission the gate is dispatching: no alternative dispatch action fires.
      controller.actions.sendOriginalTranslation(sessionId);
      controller.actions.retryTranslationSend(sessionId);
      expect(relay.sent.filter(message => message.method === 'session.send').length).toBe(1);
    } finally { controller.close(); }
  });

  it('busy send-original keeps the explicit intent on the queued entry (F4)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x539f, 0x6587, 0x76f4, 0x53d1));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await relay.emit(translationEvent({ request_id: requestId, error: String.fromCodePoint(0x6a21, 0x578b, 0x4e0d, 0x53ef, 0x7528) }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      // The session turns busy before the user picks Send original.
      const busy = snapshot();
      busy.sessions[0]!.active_turn = { id: generateCanonicalId(), turn_number: 7 };
      await relay.emit({
        type: 'event', host_generation: generateCanonicalId(), event_sequence: 2,
        event: { kind: 'session.updated', session: busy.sessions[0] },
      });
      await viWait(() => controller.state.sessions[0]?.active_turn !== undefined);
      controller.actions.sendOriginalTranslation(sessionId);
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      const params = relay.lastCommand('session.send')!.params as { busy?: string; translation_id?: string };
      expect(params.busy).toBe('queue');
      expect(params.translation_id).toBe('original');
    } finally { controller.close(); }
  });

  it('a stale toggle result never overwrites a newer Host revision (F6)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      expect(controller.state.translations[sessionId]?.enabled).toBe(true);
      // Another view disables it first (revision 2 lands via event).
      await relay.emit(translationEvent({ state: translationState({ enabled: false, revision: 2 }) }));
      await viWait(() => controller.state.translations[sessionId]?.enabled === false);
      // Our own enable write (preconditioned on revision 2) then resolves with
      // a STALE success body — it must not re-enable the UI.
      controller.actions.setAutoTranslation(sessionId, true);
      await viWait(() => Boolean(relay.lastCommand('translation.set_auto')));
      expect((relay.lastCommand('translation.set_auto')!.params as { expected_revision?: number }).expected_revision).toBe(2);
      await relay.answer('translation.set_auto', translationState({ enabled: true, revision: 1 }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.enabled).toBe(false);
      expect(controller.state.translations[sessionId]?.revision).toBe(2);
      // A settings save bumps the Host-wide config revision; a delayed state
      // carrying the OLD config must not overwrite the new languages either.
      await relay.emit(translationEvent({ state: translationState({ enabled: false, revision: 2, config_revision: 2, reading_language: 'en' }) }));
      await viWait(() => controller.state.translations[sessionId]?.readingLanguage === 'en');
      await relay.emit(translationEvent({ state: translationState({ enabled: true, revision: 2, config_revision: 1 }) }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.readingLanguage).toBe('en');
      expect(controller.state.translations[sessionId]?.enabled).toBe(false);
    } finally { controller.close(); }
  });

  it('a lost manual-read terminal status is recovered by request identity (F7)', async () => {
    const { controller, currentRelay, relays } = await bootedController();
    try {
      const first = currentRelay();
      controller.actions.retryReadTranslation(sessionId, 'turn:9', String.fromCodePoint(0x65e7, 0x6d88, 0x606f));
      await viWait(() => Boolean(first.lastCommand('translation.request')));
      expect(controller.state.translations[sessionId]?.reading['turn:9']?.pending).toBe(true);
      // The settle event is lost with the connection.
      first.close('read_timeout');
      await viWait(() => currentRelay() !== first && controller.state.connection.kind === 'online');
      const second = currentRelay();
      await viWait(() => Boolean(second.lastCommand('state.refresh') || second.sent.find(message => message.type === 'resume.request')));
      if (second.lastCommand('state.refresh')) await second.answer('state.refresh', snapshot());
      else await second.emit({ type: 'resume.ok', host_generation: generateCanonicalId(), replay_from: 0, replay_through: 0, revision: 'rev-1' });
      // Recovery asks for the durable outcome by request identity.
      await viWait(() => Boolean(second.lastCommand('translation.request_status')));
      const probe = second.lastCommand('translation.request_status')!;
      await second.emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: {
          state: 'succeeded',
          record: {
            id: generateCanonicalId(), session_id: sessionId, purpose: 'read', source_id: 'turn:9',
            target_language: 'zh-CN', text: String.fromCodePoint(0x6062, 0x590d, 0x7684, 0x8bd1, 0x6587), text_length: 5, text_sha256: 'd'.repeat(64), source_sha256: 'd'.repeat(64),
          },
        },
      });
      await viWait(() => controller.state.translations[sessionId]?.results['turn:9']?.[0]?.text === String.fromCodePoint(0x6062, 0x590d, 0x7684, 0x8bd1, 0x6587));
      expect(controller.state.translations[sessionId]?.reading['turn:9']).toBeUndefined();
      void relays;
    } finally { controller.close(); }
  });

  it('an unknown manual-read outcome resets the row so globe can retry (F7)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const first = currentRelay();
      controller.actions.retryReadTranslation(sessionId, 'turn:5', String.fromCodePoint(0x65e7, 0x6d88, 0x606f));
      await viWait(() => Boolean(first.lastCommand('translation.request')));
      first.close('read_timeout');
      await viWait(() => currentRelay() !== first && controller.state.connection.kind === 'online');
      const second = currentRelay();
      await viWait(() => Boolean(second.lastCommand('state.refresh') || second.sent.find(message => message.type === 'resume.request')));
      if (second.lastCommand('state.refresh')) await second.answer('state.refresh', snapshot());
      else await second.emit({ type: 'resume.ok', host_generation: generateCanonicalId(), replay_from: 0, replay_through: 0, revision: 'rev-1' });
      await viWait(() => Boolean(second.lastCommand('translation.request_status')));
      const probe = second.lastCommand('translation.request_status')!;
      await second.emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: { state: 'unknown' },
      });
      await viWait(() => controller.state.translations[sessionId]?.reading['turn:5'] === undefined);
      // The row is free: a fresh globe request starts a new generation.
      controller.actions.retryReadTranslation(sessionId, 'turn:5', String.fromCodePoint(0x65e7, 0x6d88, 0x606f));
      await viWait(() => Boolean(second.lastCommand('translation.request')));
      expect(controller.state.translations[sessionId]?.reading['turn:5']?.pending).toBe(true);
    } finally { controller.close(); }
  });

  it('descriptor-only records page their full text and verify the hash (F3)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      const full = String.fromCodePoint(0x5b8c).repeat(20_000);
      const digest = await sha256Hex(new TextEncoder().encode(full));
      const recordId = generateCanonicalId();
      await relay.emit(translationEvent({
        upsert: {
          id: recordId, session_id: sessionId, purpose: 'read', source_id: 'turn:3',
          target_language: 'zh-CN', text_length: full.length, text_sha256: digest, source_sha256: 'e'.repeat(64),
        },
      }));
      await viWait(() => controller.state.translations[sessionId]?.results['turn:3']?.length === 1);
      // Descriptor-only: nothing renders complete until the paged text verifies.
      expect(controller.state.translations[sessionId]?.results['turn:3']?.[0]?.text).toBeUndefined();
      await viWait(() => Boolean(relay.lastCommand('translation.result_text')));
      const first = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: first.command_id, ok: true,
        data: { text: full.slice(0, 16_000), next_offset: 16_000 } });
      await viWait(() => (relay.lastCommand('translation.result_text')!.params as { offset?: number }).offset === 16_000);
      const second = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: second.command_id, ok: true,
        data: { text: full.slice(16_000) } });
      await viWait(() => controller.state.translations[sessionId]?.fullTexts[recordId] === full);
    } finally { controller.close(); }
  });

  it('a draft persisted after the real dispatch is confirmed before any restore (F1/F5)', async () => {
    const draftStore = new MemoryPendingDraftStore();
    const first = await bootedController({ draftStore });
    let sendCommandId = '';
    try {
      const relay = first.currentRelay();
      first.controller.actions.setDraftText(sessionId, String.fromCodePoint(0x5df2, 0x53d1, 0x51fa, 0x7684, 0x539f, 0x6587));
      first.controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await relay.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'Sent', text_length: 4, text_sha256: 'f'.repeat(64), source_sha256: 'f'.repeat(64),
        },
      }));
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      sendCommandId = relay.lastCommand('session.send')!.command_id!;
      // The dispatch is persisted with its fixed identity; the ACK never lands.
      await viWait(async () => (await draftStore.list(hostId, sessionId))[0]?.payload.sendCommandId === sendCommandId);
    } finally { first.controller.close(); }

    // A fresh page boot (new controller, same encrypted store) must confirm
    // the command before treating the text as an unsent draft.
    const second = await bootedController({ draftStore });
    try {
      await viWait(() => Boolean(second.currentRelay().lastCommand('command.status')));
      const probe = second.currentRelay().lastCommand('command.status')!;
      expect((probe.params as { command_id?: string }).command_id).toBe(sendCommandId);
      await second.currentRelay().emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: { command_id: sendCommandId, state: 'succeeded' },
      });
      await viWait(async () => (await draftStore.list(hostId, sessionId)).length === 0);
      expect(second.controller.state.drafts[sessionId]?.text ?? '').toBe('');
    } finally { second.controller.close(); }
  });

  it('reclaim with an occupied composer keeps both texts (F5)', async () => {
    const draftStore = new MemoryPendingDraftStore();
    const { controller, currentRelay } = await bootedController({ draftStore });
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x65e7, 0x6587, 0x672c, 0x41));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await relay.emit(translationEvent({ request_id: requestId, error: String.fromCodePoint(0x5931, 0x8d25) }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      // The user types something new while the failed row waits.
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x65b0, 0x6587, 0x672c, 0x42));
      controller.actions.reclaimTranslationSend(sessionId);
      expect(controller.state.drafts[sessionId]?.text).toBe(String.fromCodePoint(0x65b0, 0x6587, 0x672c, 0x42));
      expect(controller.state.translations[sessionId]?.send).toBeNull();
      expect(controller.state.translations[sessionId]?.error).toBe('translation.reclaimKeptAside');
      // A was kept aside, not lost: emptying the composer restores it once,
      // with NO full-page refresh (R2-3).
      await viWait(async () => (await draftStore.list(hostId, sessionId))[0]?.payload.draft.text === String.fromCodePoint(0x65e7, 0x6587, 0x672c, 0x41));
      controller.actions.setDraftText(sessionId, '');
      await viWait(() => controller.state.drafts[sessionId]?.text === String.fromCodePoint(0x65e7, 0x6587, 0x672c, 0x41));
      await viWait(async () => (await draftStore.list(hostId, sessionId)).length === 0);
    } finally { controller.close(); }
  });

  it('the wire send waits for the dispatch identity to be persisted (F1/F2 delayed store)', async () => {
    let release!: () => void;
    const draftStore = new MemoryPendingDraftStore();
    const realPut = draftStore.put.bind(draftStore);
    let hold: Promise<void> | null = null;
    draftStore.put = (h, s, sub, payload) => {
      const run = () => realPut(h, s, sub, payload);
      return hold ? hold.then(run) : run();
    };
    const { controller, currentRelay } = await bootedController({ draftStore });
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x7b49, 0x4e00, 0x4e0b));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      // Hold the dispatch-time persist: the frame must wait for it.
      hold = new Promise(resolve => { release = resolve; });
      await relay.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'Hold on', text_length: 7, text_sha256: 'a'.repeat(64), source_sha256: 'a'.repeat(64),
        },
      }));
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(relay.lastCommand('session.send')).toBeUndefined();
      release();
      hold = null;
      await viWait(() => Boolean(relay.lastCommand('session.send')));
    } finally { controller.close(); }
  });

  it('a failing draft store aborts the dispatch instead of sending unbacked (F1/F2)', async () => {
    const draftStore = new MemoryPendingDraftStore();
    const realPut = draftStore.put.bind(draftStore);
    let calls = 0;
    draftStore.put = (h, s, sub, payload) => {
      calls += 1;
      // The gate-start persist works; the dispatch-identity persist fails.
      return calls === 1 ? realPut(h, s, sub, payload) : Promise.reject(new Error('disk full'));
    };
    const { controller, currentRelay } = await bootedController({ draftStore });
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x4e0d, 0x8981, 0x53d1));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await relay.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'Do not send', text_length: 11, text_sha256: 'a'.repeat(64), source_sha256: 'a'.repeat(64),
        },
      }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      expect(relay.lastCommand('session.send')).toBeUndefined();
      // The draft survives as a pre-dispatch backup — restorable, not lost.
      await viWait(async () => (await draftStore.list(hostId, sessionId))[0]?.payload.phase === 'translating');
    } finally { controller.close(); }
  });

  it('restore confirms terminal state: failed restores, expired/not_seen keep the backup (F1/F5)', async () => {
    for (const status of ['failed', 'expired', 'not_seen'] as const) {
      const draftStore = new MemoryPendingDraftStore();
      const sendCommandId = generateUuidV7();
      await draftStore.put(hostId, sessionId, 'sub-restore', {
        draft: { text: String.fromCodePoint(0x843d, 0x76d8, 0x7684, 0x539f, 0x6587), attachments: [], contextItems: [], document: null },
        at: Date.now(),
        phase: 'dispatching',
        sendCommandId,
      });
      const { controller, currentRelay } = await bootedController({ draftStore });
      try {
        await viWait(() => Boolean(currentRelay().lastCommand('command.status')));
        const probe = currentRelay().lastCommand('command.status')!;
        expect((probe.params as { command_id?: string }).command_id).toBe(sendCommandId);
        await currentRelay().emit({
          type: 'command.result', command_id: probe.command_id, ok: true,
          data: { command_id: sendCommandId, state: status },
        });
        if (status === 'failed') {
          await viWait(() => controller.state.drafts[sessionId]?.text === String.fromCodePoint(0x843d, 0x76d8, 0x7684, 0x539f, 0x6587));
          await viWait(async () => (await draftStore.list(hostId, sessionId)).length === 0);
        } else {
          await new Promise(resolve => setTimeout(resolve, 60));
          expect(controller.state.drafts[sessionId]?.text ?? '').toBe('');
          expect((await draftStore.list(hostId, sessionId)).length).toBe(1);
        }
      } finally { controller.close(); }
    }
  });

  it('an unknown gate keeps its dispatch identity — reclaim is not offered until reconciliation (F1)', async () => {
    const draftStore = new MemoryPendingDraftStore();
    const { controller, currentRelay, relays } = await bootedController({ draftStore });
    try {
      const first = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x53ef, 0x80fd, 0x5df2, 0x53d1, 0x51fa));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(first.lastCommand('translation.request')));
      const requestId = (first.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await first.answer('translation.request', { request_id: requestId, status: 'accepted' });
      await first.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'Maybe sent', text_length: 10, text_sha256: 'a'.repeat(64), source_sha256: 'a'.repeat(64),
        },
      }));
      await viWait(() => Boolean(first.lastCommand('session.send')));
      const sendCommandId = first.lastCommand('session.send')!.command_id!;
      first.close('read_timeout');
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'unknown');
      // No identity-dropping take-back while the outcome is in doubt.
      controller.actions.reclaimTranslationSend(sessionId);
      expect(controller.state.translations[sessionId]?.send?.phase).toBe('unknown');
      expect(controller.state.drafts[sessionId]?.text ?? '').toBe('');
      expect((await draftStore.list(hostId, sessionId))[0]?.payload.sendCommandId).toBe(sendCommandId);
      // Reconnect: command.status owns the resolution; a terminal failure
      // reopens the gate, and only then does reclaim restore the text.
      await viWait(() => currentRelay() !== first && controller.state.connection.kind === 'online');
      const second = currentRelay();
      await viWait(() => Boolean(second.lastCommand('state.refresh') || second.sent.find(message => message.type === 'resume.request')));
      if (second.lastCommand('state.refresh')) await second.answer('state.refresh', snapshot());
      else await second.emit({ type: 'resume.ok', host_generation: generateCanonicalId(), replay_from: 0, replay_through: 0, revision: 'rev-1' });
      await viWait(() => Boolean(second.lastCommand('command.status')));
      const probe = second.lastCommand('command.status')!;
      await second.emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: { command_id: sendCommandId, state: 'failed', error: { code: 'INVALID_FRAME', message: 'receipt rejected' } },
      });
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      controller.actions.reclaimTranslationSend(sessionId);
      expect(controller.state.drafts[sessionId]?.text).toBe(String.fromCodePoint(0x53ef, 0x80fd, 0x5df2, 0x53d1, 0x51fa));
      const totalSends = relays.flatMap(relay => relay.sent).filter(message => message.method === 'session.send').length;
      expect(totalSends).toBe(1);
    } finally { controller.close(); }
  });

  it('re-entering a hydrated session re-subscribes and reconciles pending reads (R2-1)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      const sessionBId = generateCanonicalId();
      const busy = snapshot();
      busy.sessions.push({
        ...snapshot().sessions[0]!,
        id: sessionBId,
        name: 'Second session',
        revision: 'session-rev-b',
      });
      // Materialize session B in the state.
      await relay.emit({
        type: 'event', host_generation: generateCanonicalId(), event_sequence: 3,
        event: { kind: 'session.updated', session: busy.sessions[1] },
      });
      await viWait(() => controller.state.sessions.some(session => session.id === sessionBId));

      // A: start a manual read and leave it pending.
      controller.actions.retryReadTranslation(sessionId, 'turn:9', String.fromCodePoint(0x65e7, 0x6d88, 0x606f));
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestId = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      expect(controller.state.translations[sessionId]?.reading['turn:9']?.pending).toBe(true);

      // Switch to B: a fresh subscribe goes out (Host holds one subscription).
      const subscribesBefore = relay.sent.filter(message => message.method === 'session.subscribe').length;
      controller.actions.selectSession(sessionBId);
      await viWait(() => relay.sent.filter(message => message.method === 'session.subscribe').length > subscribesBefore);
      expect((relay.lastCommand('session.subscribe')!.params as { session_id?: string }).session_id).toBe(sessionBId);

      // Back to A: hydrated history is NOT re-paged, but the session is
      // re-subscribed and the pending read is reconciled by request identity.
      const pagesBefore = relay.sent.filter(message => message.method === 'session.page').length;
      controller.actions.selectSession(sessionId);
      await viWait(() => (relay.lastCommand('session.subscribe')!.params as { session_id?: string }).session_id === sessionId);
      expect(relay.sent.filter(message => message.method === 'session.page').length).toBe(pagesBefore);
      await relay.answer('session.subscribe', { session: snapshot().sessions[0], cursor: 'session-rev-1', translation: translationState() });
      await viWait(() => Boolean(relay.lastCommand('translation.request_status')));
      const probe = relay.lastCommand('translation.request_status')!;
      expect((probe.params as { request_id?: string }).request_id).toBe(requestId);
      await relay.emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: {
          state: 'succeeded',
          record: {
            id: generateCanonicalId(), session_id: sessionId, purpose: 'read', source_id: 'turn:9',
            target_language: 'zh-CN', text: String.fromCodePoint(0x5207, 0x6362, 0x540e, 0x6062, 0x590d), text_length: 5, text_sha256: 'a'.repeat(64), source_sha256: 'a'.repeat(64),
          },
        },
      });
      await viWait(() => controller.state.translations[sessionId]?.results['turn:9']?.[0]?.text === String.fromCodePoint(0x5207, 0x6362, 0x540e, 0x6062, 0x590d));
      expect(controller.state.translations[sessionId]?.reading['turn:9']).toBeUndefined();

      // Late outcomes from an old generation never touch a newer one:
      // reset + retry creates request B; a late record carrying request A's
      // id merges as data while request B keeps its pending row.
      controller.actions.retryReadTranslation(sessionId, 'turn:10', String.fromCodePoint(0x53e6, 0x4e00, 0x6761));
      await viWait(() => relay.sent.filter(message => message.method === 'translation.request').length >= 2);
      const requestB = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      expect(requestB).not.toBe(requestId);
      await relay.emit(translationEvent({
        request_id: requestId,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'read', source_id: 'turn:10',
          target_language: 'zh-CN', text: String.fromCodePoint(0x8fdf, 0x5230, 0x7684, 0x4e00, 0x4ee3), text_length: 5, text_sha256: 'b'.repeat(64), source_sha256: 'b'.repeat(64),
        },
      }));
      await viWait(() => controller.state.translations[sessionId]?.results['turn:10']?.length === 1);
      expect(controller.state.translations[sessionId]?.reading['turn:10']?.pending).toBe(true);
      expect(controller.state.translations[sessionId]?.reading['turn:10']?.requestId).toBe(requestB);
    } finally { controller.close(); }
  });

  it('a kept-aside draft restores after the newer send completes — no refresh (R2-3)', async () => {
    const draftStore = new MemoryPendingDraftStore();
    const { controller, currentRelay } = await bootedController({ draftStore });
    try {
      const relay = currentRelay();
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x65e7, 0x6587, 0x672c, 0x41));
      controller.actions.sendDraft(sessionId);
      await viWait(() => Boolean(relay.lastCommand('translation.request')));
      const requestA = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestA, status: 'accepted' });
      await relay.emit(translationEvent({ request_id: requestA, error: String.fromCodePoint(0x5931, 0x8d25) }));
      await viWait(() => controller.state.translations[sessionId]?.send?.phase === 'failed');
      controller.actions.setDraftText(sessionId, String.fromCodePoint(0x65b0, 0x6587, 0x672c, 0x42));
      controller.actions.reclaimTranslationSend(sessionId);
      expect(controller.state.drafts[sessionId]?.text).toBe(String.fromCodePoint(0x65b0, 0x6587, 0x672c, 0x42));
      await viWait(async () => (await draftStore.list(hostId, sessionId)).length === 1);

      // Send B through its own gate; when B completes, A restores without any refresh.
      controller.actions.sendDraft(sessionId);
      await viWait(() => relay.sent.filter(message => message.method === 'translation.request').length === 2);
      const requestB = (relay.lastCommand('translation.request')!.params as { request_id?: string }).request_id;
      await relay.answer('translation.request', { request_id: requestB, status: 'accepted' });
      await relay.emit(translationEvent({
        request_id: requestB,
        upsert: {
          id: generateCanonicalId(), session_id: sessionId, purpose: 'send', target_language: 'en',
          text: 'New text B', text_length: 10, text_sha256: 'c'.repeat(64), source_sha256: 'c'.repeat(64),
        },
      }));
      await viWait(() => Boolean(relay.lastCommand('session.send')));
      await relay.answer('session.send', { session: snapshot().sessions[0] });
      await viWait(() => controller.state.drafts[sessionId]?.text === String.fromCodePoint(0x65e7, 0x6587, 0x672c, 0x41));
      expect(controller.state.translations[sessionId]?.send).toBeNull();
      await viWait(async () => (await draftStore.list(hostId, sessionId)).length === 0);
    } finally { controller.close(); }
  });

  it('ordered automatic deltas advance the version; stale snapshots and retired epochs never roll back (R2-4)', async () => {
    const { controller, currentRelay, relays } = await bootedController();
    try {
      const relay = currentRelay();
      // Baseline from subscribe: revision 0, epoch-1 (no artificial seeding).
      expect(controller.state.translations[sessionId]?.automaticRevision).toBe(0);
      // rev1: live pending delta → applies and advances the version.
      await relay.emit(translationEvent({
        automatic: { source_id: 'turn:1', pending: true },
        automatic_revision: 1, automatic_epoch: 'epoch-1',
      }));
      await viWait(() => controller.state.translations[sessionId]?.automatic['turn:1']?.pending === true);
      expect(controller.state.translations[sessionId]?.automaticRevision).toBe(1);
      // rev2: live failure delta → settles with an error.
      await relay.emit(translationEvent({
        automatic: { source_id: 'turn:1', pending: false, error: String.fromCodePoint(0x6a21, 0x578b, 0x5931, 0x8d25) },
        automatic_revision: 2, automatic_epoch: 'epoch-1',
      }));
      await viWait(() => controller.state.translations[sessionId]?.automatic['turn:1']?.error === String.fromCodePoint(0x6a21, 0x578b, 0x5931, 0x8d25));
      expect(controller.state.translations[sessionId]?.automaticRevision).toBe(2);
      // A LATE full-state snapshot carrying rev1/pending=true (same switch
      // and config revisions) must not resurrect the pending row.
      await relay.emit(translationEvent({
        state: translationState({ automatic: [{ source_id: 'turn:1', pending: true }], automatic_revision: 1 }),
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.automatic['turn:1']?.error).toBe(String.fromCodePoint(0x6a21, 0x578b, 0x5931, 0x8d25));
      // rev3: the successful clear delta.
      await relay.emit(translationEvent({
        automatic: { source_id: 'turn:1', pending: false },
        automatic_revision: 3, automatic_epoch: 'epoch-1',
      }));
      await viWait(() => controller.state.translations[sessionId]?.automatic['turn:1'] === undefined);
      // A stale snapshot at rev2 (pending) is still older — rejected.
      await relay.emit(translationEvent({
        state: translationState({ automatic: [{ source_id: 'turn:1', pending: true }], automatic_revision: 2 }),
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.automatic['turn:1']).toBeUndefined();
      // A stale delta from the same epoch (rev2 pending after rev3 clear) is
      // rejected too.
      await relay.emit(translationEvent({
        automatic: { source_id: 'turn:1', pending: true },
        automatic_revision: 2, automatic_epoch: 'epoch-1',
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.automatic['turn:1']).toBeUndefined();
      // Host restart with a lost in-flight mutation: the set_auto ACK never
      // arrives, the connection drops, and the recovered ledger receipt
      // (epoch A) lands AFTER the baseline reset but BEFORE the fresh
      // subscribe — it must not preempt the baseline.
      controller.actions.setAutoTranslation(sessionId, false);
      await viWait(() => Boolean(relay.lastCommand('translation.set_auto')));
      const setAutoCommandId = relay.lastCommand('translation.set_auto')!.command_id!;
      relay.close('read_timeout');
      await viWait(() => currentRelay() !== relay && controller.state.connection.kind === 'online');
      const relay2 = currentRelay();
      // The reconnect issues a fresh state.refresh on the new relay.
      await viWait(() => Boolean(relay2.lastCommand('state.refresh')));
      const restarted = snapshot();
      restarted.host_generation = generateCanonicalId();
      await relay2.answer('state.refresh', restarted);
      await viWait(() => controller.state.translations[sessionId]?.automaticEpoch === '');
      // The recovered command.status probe for the lost set_auto resolves
      // with a STALE epoch-A result: it applies only the orderable switch,
      // never the automatic baseline.
      await viWait(() => Boolean(relay2.lastCommand('command.status')));
      const probe = relay2.lastCommand('command.status')!;
      expect((probe.params as { command_id?: string }).command_id).toBe(setAutoCommandId);
      await relay2.emit({
        type: 'command.result', command_id: probe.command_id, ok: true,
        data: {
          command_id: setAutoCommandId,
          state: 'succeeded',
          result: translationState({
            enabled: false, revision: 2, automatic_revision: 5, automatic_epoch: 'epoch-1',
            automatic: [{ source_id: 'turn:9', pending: true }],
          }),
        },
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.automaticEpoch).toBe('');
      expect(controller.state.translations[sessionId]?.automatic['turn:9']).toBeUndefined();
      // The authoritative fresh subscribe establishes epoch B wholesale.
      await viWait(() => (relay2.lastCommand('session.subscribe')!.params as { session_id?: string }).session_id === sessionId);
      await relay2.answer('session.subscribe', {
        session: restarted.sessions[0],
        cursor: 'session-rev-1',
        // The confirmed switch revision survives the Host restart; only the
        // automatic progress epoch resets.
        translation: translationState({ enabled: false, revision: 2, automatic_revision: 0, automatic_epoch: 'epoch-2', automatic: [{ source_id: 'turn:5', pending: true }] }),
      });
      await viWait(() => controller.state.translations[sessionId]?.automaticEpoch === 'epoch-2');
      expect(controller.state.translations[sessionId]?.revision).toBe(2);
      expect(controller.state.translations[sessionId]?.enabled).toBe(false);
      expect(controller.state.translations[sessionId]?.automatic['turn:5']?.pending).toBe(true);
      // …and a retired-epoch A packet (e.g. a ledger-replayed historical
      // result) never rolls the new baseline back.
      await relay2.emit(translationEvent({
        state: translationState({ automatic: [], automatic_revision: 3, automatic_epoch: 'epoch-1' }),
      }));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(controller.state.translations[sessionId]?.automatic['turn:5']?.pending).toBe(true);
      expect(controller.state.translations[sessionId]?.automaticEpoch).toBe('epoch-2');
      void relays;
    } finally { controller.close(); }
  });

  it('a failed descriptor page becomes an actionable error retried in place (F3)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      const full = String.fromCodePoint(0x6574).repeat(20_000);
      const digest = await sha256Hex(new TextEncoder().encode(full));
      const recordId = generateCanonicalId();
      await relay.emit(translationEvent({
        upsert: {
          id: recordId, session_id: sessionId, purpose: 'read', source_id: 'turn:3',
          target_language: 'zh-CN', text_length: full.length, text_sha256: digest, source_sha256: 'e'.repeat(64),
        },
      }));
      await viWait(() => Boolean(relay.lastCommand('translation.result_text')));
      const first = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: first.command_id, ok: true,
        data: { text: full.slice(0, 16_000), next_offset: 16_000 } });
      await viWait(() => (relay.lastCommand('translation.result_text')!.params as { offset?: number }).offset === 16_000);
      // The second page fails: the row becomes an actionable error, not an
      // endless Translating state.
      const second = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: second.command_id, ok: false,
        error: { code: 'HOST_OFFLINE', message: 'relay dropped' } });
      await viWait(() => controller.state.translations[sessionId]?.fullTextErrors[recordId] === true);
      expect(controller.state.translations[sessionId]?.fullTexts[recordId]).toBeUndefined();
      // In-place retry: same record id, fresh fetch, succeeds.
      controller.actions.retryTranslationText(sessionId, recordId);
      await viWait(() => controller.state.translations[sessionId]?.fullTextErrors[recordId] === undefined);
      await viWait(() => (relay.sent.filter(message => message.method === 'translation.result_text').length) >= 3);
      const retryFirst = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: retryFirst.command_id, ok: true,
        data: { text: full.slice(0, 16_000), next_offset: 16_000 } });
      await viWait(() => (relay.lastCommand('translation.result_text')!.params as { offset?: number }).offset === 16_000);
      const retrySecond = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: retrySecond.command_id, ok: true,
        data: { text: full.slice(16_000) } });
      await viWait(() => controller.state.translations[sessionId]?.fullTexts[recordId] === full);
    } finally { controller.close(); }
  });

  it('a failed sent-translation descriptor fetch exposes a retry on the bubble (F3)', async () => {
    const { controller, currentRelay } = await bootedController();
    try {
      const relay = currentRelay();
      const full = String.fromCodePoint(0x53d1).repeat(20_000);
      const digest = await sha256Hex(new TextEncoder().encode(full));
      const recordId = generateCanonicalId();
      await relay.emit({
        type: 'event', host_generation: generateCanonicalId(), event_sequence: 5,
        event: {
          kind: 'transcript.item',
          session_id: sessionId,
          item: {
            kind: 'user', id: generateCanonicalId(), turn_id: generateCanonicalId(), turn: 1,
            ts: Date.now(), text: String.fromCodePoint(0x539f, 0x6587),
            translation: { id: recordId, target_language: 'en', text_length: full.length, text_sha256: digest },
          },
        },
      });
      await viWait(() => Boolean(relay.lastCommand('translation.result_text')));
      const first = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: first.command_id, ok: false,
        error: { code: 'HOST_OFFLINE', message: 'relay dropped' } });
      await viWait(() => {
        const item = controller.state.transcripts[sessionId]?.items.find(entry => entry.kind === 'user' && entry.translation?.id === recordId);
        return item?.kind === 'user' && item.translation?.fetchError === true;
      });
      controller.actions.retryTranslationText(sessionId, recordId);
      await viWait(() => relay.sent.filter(message => message.method === 'translation.result_text').length >= 2);
      const retry = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: retry.command_id, ok: true,
        data: { text: full.slice(0, 16_000), next_offset: 16_000 } });
      await viWait(() => (relay.lastCommand('translation.result_text')!.params as { offset?: number }).offset === 16_000);
      const retry2 = relay.lastCommand('translation.result_text')!;
      await relay.emit({ type: 'command.result', command_id: retry2.command_id, ok: true,
        data: { text: full.slice(16_000) } });
      await viWait(() => {
        const item = controller.state.transcripts[sessionId]?.items.find(entry => entry.kind === 'user' && entry.translation?.id === recordId);
        return item?.kind === 'user' && item.translation?.text === full && item.translation.fetchError === false;
      });
    } finally { controller.close(); }
  });
});

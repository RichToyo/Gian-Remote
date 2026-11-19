import {
  ACCOUNT_PROTOCOL,
  accountLoginStartedSchema,
  accountLoginResultSchema,
  remoteAccountChallengePayload,
  exportPublicJwk,
  type AccountLoginStarted,
  type AccountLoginResult,
  REMOTE_METHOD_RESULTS,
  CONTENT_WINDOW_CHUNKS,
  PAIRING_TTL_MS,
  RemoteProtocolError,
  isRemoteErrorCode,
  addSnapshotPart,
  attachmentResultSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  canonicalEventSchema,
  catalogReadResultSchema,
  commandStatusResultSchema,
  createSnapshotPartAssembly,
  filePreviewResultSchema,
  finalizeSnapshotParts,
  formatPairingCode,
  generateCanonicalId,
  generateUuidV7,
  parseClosed,
  proxyLogoResultSchema,
  stateSnapshotPartSchema,
  stateSnapshotPendingSchema,
  transcriptPageSchema,
  type SnapshotPartAssembly,
  remoteStateSnapshotSchema,
  remoteFileRefSchema,
  selfRevokePayload,
  signBytes,
  statePatchSchema,
  transferAckSchema,
  transferCancelSchema,
  transferErrorSchema,
  remoteTranslationStateSchema,
  directoryListResultSchema,
  type RemoteDirectoryEntry,
  type RemoteInteraction,
  type RemoteSession,
  sha256Hex,
  type RemoteMethod,
  type RemoteStateSnapshot,
  type RemoteTranscriptItem,
  type RemoteTranslation,
} from '@gian/remote-protocol';
import { withSendTimeout, type SendTimeout, type TranscriptItem } from '@gian/chat-ui';
import type { Executor } from '@gian/shared';
import { createEncryptedHostCache, type EncryptedHostCache } from '../cache/encrypted-cache.js';
import { createPendingDraftStore, type PendingDraftStore } from '../cache/pending-drafts.js';
import { DeviceAuthClient } from '../transport/auth-client.js';
import {
  createBrowserIdentityStore,
  MissingHostKeyError,
  type BrowserIdentityStore,
} from '../transport/identity.js';
import { createRemoteHttpClient, type RemoteHttpClient } from '../transport/http.js';
import { clearServerIdentityPin, identityPinRejected, pinDiscoveredServer } from '../transport/server-pin.js';
import { HostKeyChangedError, hostKeyFingerprint } from '../transport/host-key-pin.js';
import {
  DeviceRelayClient,
  type DeviceRelayFactory,
  type DeviceRelayLike,
} from '../transport/relay-client.js';
import {
  applyCanonicalEvent,
  applySnapshotToState,
  applyStatePatch,
  applyTranscriptPage,
  beginTranscriptLoad,
  failTranscriptLoad,
} from './apply-control.js';
import {
  TransferAckGate,
  uploadRemoteAttachment,
  type AttachmentUploadResult,
} from './attachment-upload.js';
import { advanceCanonicalSequence, occupiesCanonicalSequence } from './event-sequence.js';
import {
  applyDownloadChunk,
  applyDownloadMetadata,
  completeDownload,
  previewMayComplete,
  startDownload,
  type DownloadTransfer,
} from './download-transfer.js';
import { viewerFromPreviewBytes, viewerFromPreviewError } from './file-preview.js';
import {
  nextUnknownCommandId,
  statusNeedsRefresh,
  takePendingOnDisconnect,
  type PendingWaiter,
  type RecoverableCommand,
} from './pending-commands.js';
import { sessionSendParams } from './session-send.js';
import {
  applyTranslationAutomatic,
  applyTranslationFullText,
  applyTranslationFullTextError,
  clearTranslationFullTextError,
  applyTranslationNote,
  applyTranslationPage,
  applyTranslationReadError,
  applyTranslationState,
  applyTranslationUpsert,
  markTranslationUnsupported,
  readingValue,
  resetTranslationRead,
  restoreTranslationReading,
  translationUiFor,
} from './translation.js';
import type { RemoteTranslationUiState, TranslationSendGate } from './types.js';
import { createHostSelectionStore, type HostSelectionStore } from '../host-selection.js';
import {
  connectionHeld,
  draftIsEmpty,
  emptyDirectoryList,
  emptyDirectoryState,
  emptyDraft,
  mutationsEnabled,
  type DirectoryList,
  type DirectoryListState,
  type DirectoryUiState,
  type DraftUpload,
  type ThumbnailState,
  thumbnailKey,
  type CreateSessionInput,
  type PairingFailure,
  type RemoteCatalog,
  type RemoteHostEntry,
  type RemoteUiActions,
  type RemoteUiController,
  type RemoteUiState,
} from './types.js';

interface StateRefreshEntry {
  hostId: string;
  epoch: number;
  held: Array<{ type?: string; [key: string]: unknown }>;
  overflow: boolean;
  done: Promise<unknown>;
}

/** Canonical frames held while one state.refresh is in flight. */
const MAX_HELD_CANONICAL_FRAMES = 2000;
/** directory.changed arrives for every Host event; refresh at most this often. */
export const DIRECTORY_REFRESH_DEBOUNCE_MS = 1_500;
export const DIRECTORY_SEARCH_DEBOUNCE_MS = 300;
/** directory.list reads per load: the Host examines a bounded number of
 *  conversations per read, so one page can be short but incomplete. */
const DIRECTORY_READS_PER_LOAD = 4;
const DIRECTORY_PAGE_SIZE = 64;
/** Directory chats kept pinned (drafts and transcripts survive) per Host. */
const MAX_PINNED_SESSIONS = 30;

interface HostAuthSession {
  accessToken: string;
  accessExpiresAt: number;
  deviceId: string;
  hostPublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  cryptoConnectionId: string;
}

export interface ProductionControllerOptions {
  baseUrl: string;
  publicOrigin: string;
  /** Explicit persistence partition for an embedded native client. Ordinary
   * same-origin Remote Web leaves this unset for storage compatibility. */
  storageScope?: string;
  wsUrl?: string;
  fetchFn?: typeof fetch;
  http?: RemoteHttpClient;
  identity?: BrowserIdentityStore;
  cache?: EncryptedHostCache;
  autoRestore?: boolean;
  platform?: string;
  userAgent?: string;
  createRelay?: DeviceRelayFactory;
  pairingNonce?: string;
  onPairingLinkDismissed?: () => void;
  hostSelection?: HostSelectionStore;
  /** Encrypted pending-draft persistence for gated translation sends. */
  draftStore?: PendingDraftStore;
  readStallMs?: number;
  readTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface ProductionController extends RemoteUiController {
  close(): void;
}

export const PAIRING_POLL_INITIAL_MS = 500;
export const PAIRING_POLL_MAX_MS = 12_000;
// Host-side projections can legitimately take more than a few seconds for a
// large transcript or a cold Agent catalog. Reconnecting sooner than that
// interrupts the response and turns a slow read into a permanent retry loop.
export const READ_STALL_RECONNECT_MS = 30_000;
export const READ_COMMAND_TIMEOUT_MS = 90_000;
export const RECONNECT_BASE_MS = 400;
export const RECONNECT_MAX_MS = 10_000;
/** A host.online/host.offline notice means the Host state changed just now;
 *  retry quickly instead of assuming a long outage. */
export const HOST_OFFLINE_RECONNECT_MAX_MS = 5_000;
export const SNAPSHOT_ASSEMBLY_TIMEOUT_MS = 10_000;
/** A verified Server identity is re-checked at most this often. Every
 *  reconnect used to re-post /server-identity, which spent the shared
 *  rate limit while a Host was offline. */
export const SERVER_PIN_RECHECK_MS = 10 * 60_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5_000;

export function nextPairingPollDelay(delayMs: number): number {
  return Math.min(PAIRING_POLL_MAX_MS, delayMs * 2);
}

export function createProductionController(options: ProductionControllerOptions): ProductionController {
  const identity = options.identity ?? createBrowserIdentityStore(options.storageScope);
  const cache = options.cache ?? createEncryptedHostCache(options.storageScope);
  const http = options.http ?? createRemoteHttpClient({
    baseUrl: options.baseUrl,
    origin: options.publicOrigin,
    fetchFn: options.fetchFn,
  });
  const auth = new DeviceAuthClient(http);
  const wsUrl = options.wsUrl ?? relayWsUrl(options.baseUrl);
  const platform = options.platform ?? detectPlatform();
  const userAgent = options.userAgent ?? detectUserAgent();
  const readStallMs = options.readStallMs ?? READ_STALL_RECONNECT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? READ_COMMAND_TIMEOUT_MS;
  const reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
  const browserEvents = typeof window === 'undefined' ? null : window;

  const listeners = new Set<() => void>();
  let relay: DeviceRelayLike | null = null;
  let relayHostId: string | null = null;
  let relayEpoch: number | null = null;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectInFlight: Promise<void> | null = null;
  let refreshInFlight: Promise<void> | null = null;
  const snapshotAssemblies = new Map<string, {
    commandId: string;
    hostId: string;
    epoch: number;
    assembly?: SnapshotPartAssembly;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const pending = new Map<string, PendingWaiter & {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  const hostRuntimes = new Map<string, {
    epoch: number;
    lastEventSequence: number;
    snapshotRevision: string;
    hostGeneration: string;
    recoverable: RecoverableCommand[];
    reconnects: number;
    /** The current connection negotiated wire.conversation_translation. */
    translationFeature: boolean;
  }>();
  /** Directory load generation per list; a newer load or a Host switch
   *  makes an older one's pages land nowhere. */
  const directoryGenerations: Record<DirectoryList, number> = { tasks: 0, repos: 0, search: 0 };
  let directoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let directorySearchTimer: ReturnType<typeof setTimeout> | null = null;
  const hostSessions = new Map<string, HostAuthSession>();
  const hostDrafts = new Map<string, RemoteUiState['drafts']>();
  /** Send-gate waiters keyed by translation request_id (generation-isolated:
   *  a late settle for an abandoned generation finds no waiter). */
  const translationSendWaiters = new Map<string, { hostId: string; sessionId: string }>();
  /** Manual globe read waiters keyed by translation request_id. */
  const translationReadWaiters = new Map<string, { hostId: string; sessionId: string; sourceId: string }>();
  /** 45s hard timeouts for send-gate translations, keyed by request_id. */
  const translationSendTimers = new Map<string, SendTimeout>();
  const uploadWaiters = new Map<string, {
    hostId: string;
    resolve: (value: AttachmentUploadResult) => void;
    reject: (error: unknown) => void;
  }>();
  const uploadAcks = new Map<string, TransferAckGate>();
  /** Sessions with a plain session.send in flight. */
  const sendingSessions = new Set<string>();
  /** Image previews waiting for a transfer slot, and the transfers in use. */
  const thumbnailQueue: Array<{ key: string; hostId: string; sessionId: string; reference: string; name: string }> = [];
  const thumbnailTransfers = new Map<string, { key: string; resolve: () => void; reject: (error: unknown) => void }>();
  let thumbnailsActive = 0;
  const downloads = new Map<string, DownloadTransfer>();
  /** In-flight `proxy.logo` reads, keyed `${proxy}:${variant}`. */
  const logoInflight = new Set<string>();
  /** Hosts whose protocol predates `proxy.logo` (INVALID_FRAME on first try). */
  const logoUnsupportedHosts = new Set<string>();
  /** Proxy/variant pairs a Host reported missing; no retry against that Host. */
  const logoMisses = new Map<string, number>();
  const logoRetries = new Map<string, number>();
  const logoRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  let state: RemoteUiState = emptyUiState();
  state.account = { status: 'signed_out' };
  let accountSession: Extract<AccountLoginResult, { status: 'authorized' }> | null = null;
  let accountPending: { started: AccountLoginStarted; signature: string } | null = null;
  let accountPolling = false;
  let accountGeneration = 0;
  let fileGeneration = 0;
  const hostSelection = options.hostSelection ?? createHostSelectionStore(options.storageScope);
  let navigationGeneration = 0;
  let pairingReturnHostId: string | null = null;
  let qrNonce = options.pairingNonce;
  let pairingGeneration = 0;
  let restoreInFlight: Promise<void> | null = null;
  let restoreAgain = false;
  let serverPinVerifiedAt = 0;
  let stateRefresh: StateRefreshEntry | null = null;
  let epochCounter = 0;
  if (qrNonce) {
    const pairingUrl = new URL('/', options.baseUrl);
    pairingUrl.hash = new URLSearchParams({ nonce: qrNonce }).toString();
    state.auth = {
      kind: 'pairing',
      pairing: {
        kind: 'qr-confirm', hostName: new URL(options.publicOrigin).host,
        deviceName: 'This browser', pairingUrl: pairingUrl.href,
      },
    };
  }

  function dismissPairingLink(): void {
    if (!qrNonce) return;
    qrNonce = undefined;
    options.onPairingLinkDismissed?.();
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function update(patch: Partial<RemoteUiState>): void {
    state = { ...state, ...patch };
    // Reconnecting cannot reuse a pre-disconnect running indication. A fresh
    // Host session projection or history page must confirm it again.
    if (patch.connection && patch.connection.kind !== 'online') {
      state = {
        ...state,
        transcripts: Object.fromEntries(Object.entries(state.transcripts).map(([sessionId, transcript]) => [
          sessionId, { ...transcript, streaming: false },
        ])),
      };
    }
    emit();
  }

  function setPairingFailure(reason: PairingFailure): void {
    update({
      auth: { kind: 'pairing', pairing: { kind: 'failed', reason } },
    });
  }

  async function clearHostPairingMaterial(hostId: string): Promise<void> {
    if (hostSelection.get() === hostId) hostSelection.set(null);
    hostSessions.delete(hostId);
    hostDrafts.delete(hostId);
    await Promise.all([
      identity.clearHost(hostId),
      cache.clear(hostId),
      // Gated-send drafts are conversation content: revocation removes them
      // from the encrypted store too (F2).
      translationDraftStore.clearHost(hostId),
    ]);
    update({ hosts: state.hosts.filter(host => host.id !== hostId) });
  }

  function hostRuntime(hostId: string) {
    const current = hostRuntimes.get(hostId) ?? {
      epoch: 0,
      lastEventSequence: -1,
      snapshotRevision: '',
      hostGeneration: '',
      recoverable: [],
      reconnects: 0,
      translationFeature: false,
    };
    hostRuntimes.set(hostId, current);
    return current;
  }

  function bumpEpoch(hostId: string): number {
    const runtime = hostRuntime(hostId);
    // One counter for every Host and the whole page: an epoch is never
    // reused, even after sign-out clears the runtimes.
    epochCounter += 1;
    runtime.epoch = epochCounter;
    return runtime.epoch;
  }

  function prepareHostView(hostId: string): void {
    refreshInFlight = null;
    cancelDirectoryTimers();
    for (const list of ['tasks', 'repos', 'search'] as const) directoryGenerations[list] += 1;
    if (state.currentHostId && state.currentHostId !== hostId) hostDrafts.set(state.currentHostId, state.drafts);
    const drafts = state.currentHostId === hostId ? state.drafts : hostDrafts.get(hostId) ?? {};
    adoptableEchoes.clear();
    // A switched-away projection is no longer mounted. Ask for a full
    // snapshot on return, never replay deltas over another Host's state.
    const runtime = hostRuntime(hostId);
    runtime.lastEventSequence = -1;
    runtime.snapshotRevision = '';
    runtime.hostGeneration = '';
    const unknownCommandId = runtime.recoverable.find(command => (
      showsUnknownOutcome(command.method) && state.mutations[command.commandId]?.phase === 'unknown'
    ))?.commandId ?? null;
    update({ currentHostId: hostId, connection: { kind: 'resyncing', synced: 0, total: 1 },
      auth: { kind: 'challenge-login', hosts: state.hosts }, snapshotReceivedAt: null,
      mobilePage: 'chat', fileViewer: null, view: { kind: 'empty' },
      tasks: [], sessions: [], workspaces: [], interactions: [], capabilities: {},
      catalog: null, catalogInvalidated: true, transcripts: {}, drafts,
      translations: {},
      directory: { ...emptyDirectoryState(hostId), view: state.directory?.view ?? 'tasks' },
      thumbnails: {}, uploads: {},
      logos: {},
      queueNotice: null, unknownCommandId, interactionErrors: {}, interactionPhases: {},
      fileDownload: { status: 'idle' } });
  }

  function clearRelayBinding(): void {
    relay = null;
    relayHostId = null;
    relayEpoch = null;
  }

  function boundRelay(): { relay: DeviceRelayLike; hostId: string; epoch: number } | null {
    if (!relay?.isOpen || !relayHostId || relayEpoch == null) return null;
    if (state.currentHostId !== relayHostId) return null;
    if (hostRuntime(relayHostId).epoch !== relayEpoch) return null;
    return { relay, hostId: relayHostId, epoch: relayEpoch };
  }

  function transferRelay(): { relay: DeviceRelayLike; hostId: string; epoch: number } | null {
    if (state.connection.kind !== 'online') return null;
    return boundRelay();
  }

  function abortDownloadsForHost(hostId: string): void {
    let touched = false;
    for (const [transferId, entry] of downloads) {
      if (entry.hostId !== hostId) continue;
      downloads.delete(transferId);
      thumbnailTransfers.get(transferId)?.reject(new RemoteProtocolError('UNKNOWN_OUTCOME', 'disconnected'));
      thumbnailTransfers.delete(transferId);
      touched = true;
    }
    if (!touched) return;
    const patch: Partial<RemoteUiState> = {};
    if (state.fileDownload.status === 'downloading') {
      patch.fileDownload = { status: 'idle' };
    }
    if (state.fileViewer?.status === 'loading') {
      patch.fileViewer = viewerFromPreviewError(state.fileViewer.handle, 'UNKNOWN_OUTCOME');
    }
    if (Object.keys(patch).length > 0) update(patch);
  }

  function abortAllDownloads(): void {
    const hostIds = new Set(Array.from(downloads.values(), (entry) => entry.hostId));
    for (const hostId of hostIds) abortDownloadsForHost(hostId);
    downloads.clear();
  }

  function applySnapshot(snapshot: RemoteStateSnapshot): void {
    const runtime = hostRuntime(snapshot.host.id);
    // Authoritative restart signal: a changed Host generation resets the
    // per-session automatic baseline (epoch ''), so the fresh sync adopts the
    // new Host epoch wholesale — and retired-epoch packets never roll back.
    if (runtime.hostGeneration && runtime.hostGeneration !== snapshot.host_generation) {
      const cleared = Object.fromEntries(Object.entries(state.translations).map(([sessionId, ui]) => [
        sessionId,
        { ...ui, automatic: {}, automaticRevision: 0, automaticEpoch: '' },
      ]));
      update({ translations: cleared });
    }
    runtime.lastEventSequence = snapshot.event_sequence - 1;
    runtime.snapshotRevision = snapshot.revision;
    runtime.hostGeneration = snapshot.host_generation;
    // The open chat leaving the Doing snapshot (Task completed while a patch
    // was missed or held) stays open on directory Hosts; applySnapshot's
    // hydrate below re-reads it, and access loss drops it then.
    const openId = state.view.kind === 'chat' ? state.view.sessionId : null;
    if (openId && directoryState().supported && directoryState().hostId === snapshot.host.id
      && state.sessions.some(item => item.id === openId) && !snapshot.sessions.some(item => item.id === openId)) {
      pinSession(openId);
    }
    const next = applySnapshotToState(state, snapshot);
    update({ ...next, connectionPhase: undefined, connectionFailed: false });
    replayHeldFrames(snapshot.host.id);
    void cache.put(snapshot.host.id, snapshot);
    if (directoryState().supported) loadVisibleDirectory(true);
    if (next.view.kind === 'chat') hydrateSessionDetached(next.view.sessionId, 'initial', true);
    recoverTranslationGates();
    // The first snapshot may land after the catalog; retry the lazy logo
    // fetch once both are present.
    if (state.catalog) ensureProxyLogos(state.catalog);
  }

  function noteSequence(hostId: string, type: string, sequence: number, eventKind?: string): boolean {
    if (!occupiesCanonicalSequence(type, eventKind)) return true;
    const runtime = hostRuntime(hostId);
    if (advanceCanonicalSequence(runtime.lastEventSequence, sequence) === 'gap') {
      requestState();
      return false;
    }
    runtime.lastEventSequence = sequence;
    return true;
  }

  function cancelReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(
    hostId: string,
    options: { maxMs?: number; connection?: RemoteUiState['connection'] } = {},
  ): void {
    if (
      closed
      || reconnectTimer
      || state.currentHostId !== hostId
      || state.connection.kind === 'browser_offline'
      || connectionHeld(state.connection)
    ) return;
    const runtime = hostRuntime(hostId);
    runtime.reconnects += 1;
    const attempt = runtime.reconnects;
    const exponent = Math.min(16, Math.max(0, attempt - 1));
    const delayMs = Math.min(options.maxMs ?? reconnectMaxMs, reconnectBaseMs * (2 ** exponent));
    update({ connection: options.connection ?? { kind: 'relay_reconnecting', attempt } });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectHost(hostId).catch(() => undefined);
    }, delayMs);
  }

  function handleBrowserOffline(): void {
    if (closed || !state.currentHostId || connectionHeld(state.connection)) return;
    cancelReconnect();
    update({ connection: { kind: 'browser_offline' } });
  }

  function handleBrowserOnline(): void {
    const hostId = state.currentHostId;
    if (
      closed
      || !hostId
      || state.connection.kind === 'online'
      || connectionHeld(state.connection)
    ) return;
    cancelReconnect();
    void connectHost(hostId).catch(() => undefined);
  }

  function retireHostSession(hostId: string, reason: 'replaced' | 'disconnected' = 'replaced'): void {
    bumpEpoch(hostId);
    markDisconnectedPending(hostId);
    if (relayHostId !== hostId) return;
    const current = relay;
    clearRelayBinding();
    current?.close(reason);
  }

  function markDisconnectedPending(hostId: string): void {
    for (const [id, entry] of snapshotAssemblies) {
      if (entry.hostId !== hostId) continue;
      clearTimeout(entry.timer);
      snapshotAssemblies.delete(id);
    }
    const recovered = takePendingOnDisconnect(pending, hostId);
    const runtime = hostRuntime(hostId);
    runtime.recoverable.push(...recovered);
    // An in-flight send becomes "outcome unknown" (the banner offers a
    // status check); it must not keep Send blocked for that chat.
    sendingSessions.clear();
    // A dispatching translation gate whose send command lost its ACK moves to
    // unknown: command.status owns the recovery — it is never re-sent (F1).
    const recoveredIds = new Set(recovered.map(command => command.commandId));
    for (const [sessionId, ui] of Object.entries(state.translations)) {
      const gate = ui.send;
      if (gate?.phase === 'dispatching' && recoveredIds.has(gate.sendCommandId)) {
        gateSet(sessionId, { ...gate, phase: 'unknown' });
      }
    }
    for (const command of recovered) {
      finishMutation(
        command.commandId,
        'unknown',
        'UNKNOWN_OUTCOME',
        'disconnected before result',
        showsUnknownOutcome(command.method) && state.currentHostId === hostId,
      );
    }
    for (const [transferId, waiter] of [...uploadWaiters]) {
      if (waiter.hostId !== hostId) continue;
      rejectTransfer(
        transferId,
        new RemoteProtocolError('UNKNOWN_OUTCOME', 'disconnected before upload finished'),
      );
    }
    abortDownloadsForHost(hostId);
  }

  function rejectTransfer(transferId: string, error: unknown): void {
    const abortError = error instanceof Error
      ? error
      : new RemoteProtocolError('UNKNOWN_OUTCOME', 'transfer failed');
    uploadAcks.get(transferId)?.abort(abortError);
    const waiter = uploadWaiters.get(transferId);
    uploadWaiters.delete(transferId);
    uploadAcks.delete(transferId);
    waiter?.reject(abortError);
    const thumbnail = thumbnailTransfers.get(transferId);
    if (thumbnail) {
      thumbnailTransfers.delete(transferId);
      downloads.delete(transferId);
      thumbnail.reject(abortError);
      return;
    }
    const download = downloads.get(transferId);
    if (download) {
      downloads.delete(transferId);
      failDownload(download, abortError);
    }
  }

  function failDownload(entry: DownloadTransfer | undefined, error: unknown): void {
    if (!entry) return;
    if (entry.purpose === 'save') {
      update({
        fileDownload: {
          status: 'error',
          message: error instanceof Error ? error.message : 'download failed',
        },
      });
      return;
    }
    if (previewMayComplete(entry, state.fileViewer) && state.fileViewer) {
      update({ fileViewer: viewerFromPreviewError(state.fileViewer.handle, errorCode(error)) });
    }
  }

  async function sendCommand(
    method: RemoteMethod,
    params: unknown,
    label: string,
    options: {
      recoverOnDisconnect?: boolean;
      onCommandId?: (commandId: string) => void;
      /** Awaited after the command identity is minted and BEFORE the frame
       *  goes on the wire — a failing hook aborts the dispatch (the gated
       *  send uses it to durably persist the dispatch identity first). */
      beforeDispatch?: (commandId: string) => Promise<void>;
    } = {},
  ): Promise<unknown> {
    const readable = method === 'state.refresh'
      || method === 'catalog.read'
      || method === 'session.subscribe'
      || method === 'session.page'
      || method === 'command.status'
      || method === 'translation.state'
      || method === 'translation.result_text'
      || method === 'translation.request_status'
      || method === 'proxy.logo' || method === 'file.preview' || method === 'file.resolve' || method === 'file.tree'
      || method === 'directory.list';
    const transport = boundRelay();
    if (!transport) {
      if (!readable) throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
      // A held state (another tab, a changed Server, a lost pairing) is the
      // user's to leave; a background read must not turn it into "offline"
      // and so re-enable automatic reconnects.
      if (state.connection.kind !== 'resyncing' && state.connection.kind !== 'relay_reconnecting'
        && !connectionHeld(state.connection)) {
        update({ connection: { kind: 'host_offline', lastSeenAt: Date.now() } });
      }
      return undefined;
    }
    if (!readable && !mutationsEnabled(state.connection)) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Host is not ready for mutations');
    }
    const commandId = generateUuidV7();
    const attemptId = generateCanonicalId();
    const hostId = transport.hostId;
    options.onCommandId?.(commandId);
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(commandId, {
        hostId,
        method,
        label,
        params,
        recoverOnDisconnect: options.recoverOnDisconnect,
        resolve,
        reject,
      });
    });
    update({
      mutations: {
        ...state.mutations,
        [commandId]: { commandId, label, phase: 'pending', startedAt: Date.now() },
      },
    });
    // Observe the result before async encryption/send can race with disconnect.
    // A beforeDispatch hook (e.g. persisting the gated send's fixed identity)
    // is awaited BEFORE the frame goes on the wire; its failure aborts the
    // dispatch through the ordinary send-failure path.
    const sending = Promise.resolve().then(async () => {
      await options.beforeDispatch?.(commandId);
      // The awaited hook may span a host switch, logout or relay
      // replacement: never send the minted command through a stale binding
      // (same discipline as the attachment path's bound-relay checks).
      const live = boundRelay();
      if (closed || !live || live.relay !== transport.relay || live.hostId !== transport.hostId || live.epoch !== transport.epoch) {
        throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'connection changed during dispatch preparation');
      }
      await transport.relay.sendControl({
        type: 'command.request',
        command_id: commandId,
        created_at: Date.now(),
        attempt_id: attemptId,
        method,
        params,
      });
    }).catch((error) => {
      const waiter = pending.get(commandId);
      pending.delete(commandId);
      finishMutation(commandId, 'failed', errorCode(error), error instanceof Error ? error.message : 'send failed');
      waiter?.reject(error);
      throw error;
    });
    return Promise.all([sending, result]).then(([, response]) => response);
  }

  function dispatchCommand(method: RemoteMethod, params: unknown, label: string): void {
    void sendCommand(method, params, label).catch(() => undefined);
  }

  async function sendReadCommand(
    method: 'catalog.read' | 'state.refresh' | 'session.subscribe' | 'session.page' | 'proxy.logo' | 'command.status'
      | 'translation.state' | 'translation.result_text' | 'translation.request_status' | 'directory.list',
    params: unknown,
    label: string,
    recoverOnDisconnect = true,
  ): Promise<unknown> {
    const hostId = state.currentHostId;
    const command = sendCommand(method, params, label, { recoverOnDisconnect });
    const watchdog = hostId ? setTimeout(() => {
      if (closed || state.currentHostId !== hostId) return;
      const stalled = boundRelay();
      if (!stalled || stalled.hostId !== hostId) return;
      clearRelayBinding();
      stalled.relay.close('read_timeout');
    }, readStallMs) : null;
    try {
      const result = await withTimeout(command, readTimeoutMs, `${label} timed out`);
      if (result === undefined) {
        throw new RemoteProtocolError('HOST_OFFLINE', `${label} is unavailable`);
      }
      return result;
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  function requestCatalog(): void {
    void sendReadCommand('catalog.read', {}, 'catalog.read').catch(() => undefined);
  }

  /** Lazily fetch branding logos for every proxy in the catalog, both theme
   *  variants. Hosts predating the method answer INVALID_FRAME once and are
   *  never asked again — the monogram fallback stays. */
  function ensureProxyLogos(catalog: RemoteCatalog): void {
    const hostId = state.currentHostId;
    if (!hostId || logoUnsupportedHosts.has(hostId)) return;
    const proxies = [...new Set(catalog.agents.map(agent => agent.proxy))]
      .filter(proxy => proxy !== 'unknown');
    for (const proxy of proxies) {
      for (const variant of ['light', 'dark'] as const) {
        const key = `${hostId}:${proxy}:${variant}`;
        if (state.logos[proxy]?.[variant] || logoInflight.has(key) || (logoMisses.get(key) ?? 0) > Date.now()) continue;
        logoInflight.add(key);
        void sendReadCommand('proxy.logo', { proxy, variant }, 'proxy.logo')
          .then((data) => {
            if (data === undefined || state.currentHostId !== hostId || closed) return;
            const logo = parseClosed(proxyLogoResultSchema, data);
            const url = `data:${logo.media_type};base64,${logo.data_base64}`;
            update({ logos: { ...state.logos, [proxy]: { ...state.logos[proxy], [variant]: url } } });
            logoMisses.delete(key); logoRetries.delete(key);
          })
          .catch((error) => {
            const code = errorCode(error);
            if (code === 'INVALID_FRAME') {
              logoUnsupportedHosts.add(hostId);
            } else {
              logoMisses.set(key, Date.now() + 5000);
              const attempt = (logoRetries.get(key) ?? 0) + 1;
              logoRetries.set(key, attempt);
              if (attempt <= 3) {
                const timer = setTimeout(() => {
                  logoRetryTimers.delete(timer);
                  if (!closed && state.currentHostId === hostId && state.catalog) ensureProxyLogos(state.catalog);
                }, 5100);
                logoRetryTimers.add(timer);
              }
            }
          })
          .finally(() => logoInflight.delete(key));
      }
    }
  }

  /**
   * One state.refresh per Host connection at a time. While it is in flight,
   * canonical events and patches are held instead of applied: the snapshot
   * includes everything before its sequence, and holding the rest keeps a
   * snapshot that finishes after newer events from being rejected (which
   * used to close the Relay) or from rolling those events back. Held frames
   * at or past the snapshot's sequence are replayed once it lands.
   */
  function requestStateAsync(): Promise<unknown> {
    const hostId = state.currentHostId;
    if (!hostId) return Promise.resolve(undefined);
    const epoch = hostRuntime(hostId).epoch;
    if (stateRefresh && stateRefresh.hostId === hostId && stateRefresh.epoch === epoch) return stateRefresh.done;
    const entry: StateRefreshEntry = { hostId, epoch, held: [], overflow: false, done: Promise.resolve(undefined) };
    entry.done = sendReadCommand('state.refresh', {}, 'state.refresh')
      .catch((error) => {
        // Never drop what arrived meanwhile: replay it over the current
        // state. Any gap it shows asks for a snapshot again.
        if (stateRefresh === entry) replayHeldFrames(hostId);
        throw error;
      })
      .finally(() => { if (stateRefresh === entry) stateRefresh = null; });
    stateRefresh = entry;
    return entry.done;
  }

  function requestState(): void {
    void requestStateAsync().catch(() => undefined);
  }

  // ── Attachment uploads and image previews ───────────────────────────────

  function setUploads(sessionId: string, uploads: DraftUpload[]): void {
    const next = { ...(state.uploads ?? {}) };
    if (uploads.length) next[sessionId] = uploads; else delete next[sessionId];
    update({ uploads: next });
  }

  function setThumbnail(key: string, value: ThumbnailState): void {
    update({ thumbnails: { ...(state.thumbnails ?? {}), [key]: value } });
  }

  /** Two previews at a time: each is a full E2E transfer of up to 1 MiB. */
  function pumpThumbnails(): void {
    while (thumbnailsActive < 2 && thumbnailQueue.length) {
      const job = thumbnailQueue.shift()!;
      if (job.hostId !== state.currentHostId) {
        // Another Host is showing; let the chat ask again when it returns.
        continue;
      }
      thumbnailsActive += 1;
      void loadThumbnail(job)
        .catch(() => {
          if (state.currentHostId === job.hostId) setThumbnail(job.key, { status: 'error' });
        })
        .finally(() => {
          thumbnailsActive -= 1;
          pumpThumbnails();
        });
    }
  }

  async function loadThumbnail(job: { key: string; hostId: string; sessionId: string; reference: string; name: string }): Promise<void> {
    const resolved = parseClosed(remoteFileRefSchema, await withTimeout(sendCommand('file.resolve', {
      session_id: job.sessionId, reference: job.reference,
    }, 'file.resolve', { recoverOnDisconnect: false }), readTimeoutMs, 'file reference timed out'));
    if (!resolved.previewable || resolved.size > MAX_FILE_PREVIEW_BYTES || !resolved.mime.startsWith('image/')) {
      setThumbnail(job.key, { status: 'skipped' });
      return;
    }
    const preview = parseClosed(filePreviewResultSchema, await withTimeout(sendCommand('file.preview', {
      handle_id: resolved.id,
    }, 'file.preview', { recoverOnDisconnect: false }), readTimeoutMs, 'file preview timed out'));
    const transport = transferRelay();
    if (!transport || transport.hostId !== job.hostId) throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
    const transferId = preview.transfer_id;
    const done = new Promise<void>((resolve, reject) => {
      thumbnailTransfers.set(transferId, { key: job.key, resolve, reject });
    });
    downloads.set(transferId, startDownload({
      hostId: transport.hostId,
      purpose: 'preview',
      handle: { id: resolved.id, sessionId: job.sessionId, label: job.name },
      name: preview.file.name,
      mime: preview.file.mime,
      size: preview.file.size,
    }));
    try {
      await transport.relay.sendControl({ type: 'download.request', transfer_id: transferId, kind: 'file', handle_id: resolved.id });
    } catch (error) {
      downloads.delete(transferId);
      thumbnailTransfers.delete(transferId);
      throw error;
    }
    await withTimeout(done, readTimeoutMs, 'image preview timed out').finally(() => {
      if (thumbnailTransfers.has(transferId)) {
        thumbnailTransfers.delete(transferId);
        downloads.delete(transferId);
      }
    });
  }

  // ── Conversation directory (wire.session_directory_v1) ──────────────────

  function directoryState(): DirectoryUiState {
    return state.directory ?? emptyDirectoryState();
  }

  function patchDirectory(patch: Partial<DirectoryUiState>): void {
    update({ directory: { ...directoryState(), ...patch } });
  }

  function patchDirectoryList(list: DirectoryList, patch: Partial<DirectoryListState>): void {
    const directory = directoryState();
    patchDirectory({ lists: { ...directory.lists, [list]: { ...directory.lists[list], ...patch } } });
  }

  function cancelDirectoryTimers(): void {
    if (directoryRefreshTimer) clearTimeout(directoryRefreshTimer);
    if (directorySearchTimer) clearTimeout(directorySearchTimer);
    directoryRefreshTimer = null;
    directorySearchTimer = null;
  }

  function directoryUsable(): boolean {
    return directoryState().supported && Boolean(boundRelay());
  }

  /**
   * Load one directory list. `fresh` replaces the entries once the new pages
   * arrive (the rail keeps the old rows meanwhile); otherwise it continues
   * from the saved cursor ("Load more"). Reads are bounded per load.
   */
  async function loadDirectoryList(list: DirectoryList, fresh: boolean): Promise<void> {
    if (!directoryUsable()) return;
    const hostId = state.currentHostId;
    const current = directoryState().lists[list];
    const query = list === 'search' ? directoryState().query.trim() : undefined;
    if (list === 'search' && !query) return;
    if (!fresh && (current.status === 'complete' || !current.cursor)) return;
    const generation = ++directoryGenerations[list];
    const live = () => !closed && state.currentHostId === hostId && directoryGenerations[list] === generation;
    let entries = fresh ? [] : [...current.entries];
    let cursor: string | null = fresh ? null : current.cursor;
    patchDirectoryList(list, { status: 'loading', error: undefined, ...(fresh && list === 'search' ? { query } : {}) });
    try {
      for (let read = 0, restarted = false; read < DIRECTORY_READS_PER_LOAD; read += 1) {
        const data = await sendReadCommand('directory.list', {
          view: list,
          ...(query ? { query } : {}),
          limit: DIRECTORY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }, 'directory.list', false);
        if (!live()) return;
        const page = parseClosed(directoryListResultSchema, data);
        if (page.state === 'cursor_invalid') {
          // The directory changed under the cursor: start this list over once.
          if (restarted) throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'directory kept changing');
          restarted = true;
          entries = [];
          cursor = null;
          continue;
        }
        entries = mergeDirectoryEntries(entries, page.entries);
        cursor = page.next_cursor;
        if (page.state === 'complete') break;
      }
      if (!live()) return;
      patchDirectoryList(list, { entries, cursor, status: cursor ? 'incomplete' : 'complete', error: undefined,
        ...(list === 'search' ? { query } : {}) });
    } catch (error) {
      if (!live()) return;
      patchDirectoryList(list, { status: 'error', error: errorCode(error) });
    }
  }

  function loadVisibleDirectory(fresh = true): void {
    if (!directoryUsable()) return;
    const directory = directoryState();
    const list: DirectoryList = directory.query.trim() ? 'search' : directory.view;
    void loadDirectoryList(list, fresh);
  }

  /** directory.changed: the Host sends one for every event, so coalesce. */
  function scheduleDirectoryRefresh(): void {
    if (directoryRefreshTimer || !directoryState().supported) return;
    directoryRefreshTimer = setTimeout(() => {
      directoryRefreshTimer = null;
      if (closed || !directoryUsable()) return;
      loadVisibleDirectory(true);
      // A pinned chat gets no session.updated events; re-read it instead.
      if (state.view.kind === 'chat' && directoryState().pinned.includes(state.view.sessionId)) {
        subscribeSession(state.view.sessionId);
      }
    }, DIRECTORY_REFRESH_DEBOUNCE_MS);
  }

  function pinSession(sessionId: string): void {
    const directory = directoryState();
    if (directory.pinned[0] === sessionId) return;
    const pinned = [sessionId, ...directory.pinned.filter(id => id !== sessionId)].slice(0, MAX_PINNED_SESSIONS);
    patchDirectory({ pinned });
  }

  /** A directory chat this device may no longer open (archived, hidden,
   *  access changed): forget it and leave the view if it was open. */
  function dropDirectorySession(sessionId: string): void {
    const directory = directoryState();
    const lists = Object.fromEntries(Object.entries(directory.lists).map(([name, list]) => [
      name, { ...list, entries: list.entries.filter(entry => entry.id !== sessionId) },
    ])) as DirectoryUiState['lists'];
    const wasPinned = directory.pinned.includes(sessionId);
    const viewing = state.view.kind === 'chat' && state.view.sessionId === sessionId;
    update({
      directory: { ...directory, lists, pinned: directory.pinned.filter(id => id !== sessionId),
        opening: directory.opening === sessionId ? null : directory.opening },
      ...(wasPinned ? {
        sessions: state.sessions.filter(session => session.id !== sessionId),
        interactions: state.interactions.filter(interaction => interaction.session_id !== sessionId),
      } : {}),
      ...(viewing ? { view: { kind: 'empty' as const } } : {}),
    });
  }

  /** Answer of session.subscribe for a chat outside the snapshot: it is the
   *  only source of that chat's state and pending interactions. */
  function adoptSubscribedSession(session: RemoteSession, interactions: RemoteInteraction[] | undefined): boolean {
    const pinned = directoryState().pinned.includes(session.id);
    const inSnapshot = state.sessions.some(item => item.id === session.id) && !pinned;
    if (inSnapshot) return false;
    // A late answer for a chat the user already left is not adopted: only
    // the chat on screen (or one already pinned, being re-read) is.
    const onScreen = state.view.kind === 'chat' && state.view.sessionId === session.id;
    if (!onScreen && !pinned) return false;
    pinSession(session.id);
    const others = state.interactions.filter(interaction => interaction.session_id !== session.id);
    update({
      sessions: [...state.sessions.filter(item => item.id !== session.id), session],
      ...(interactions ? { interactions: [...others, ...interactions] } : {}),
      directory: { ...directoryState(), opening: directoryState().opening === session.id ? null : directoryState().opening },
    });
    return onScreen;
  }

  /** History for a chat that is already subscribed. Never subscribes again:
   *  the Host keeps one subscription per device, and every subscribe moves
   *  it (and drops other chats' file references). */
  function loadHistory(sessionId: string): void {
    const loading = beginTranscriptLoad(state, sessionId, 'initial');
    update({ transcripts: loading.transcripts });
    void hydrateSession(sessionId, 'initial').catch(() => {
      update({ transcripts: failTranscriptLoad(state, sessionId, 'initial').transcripts });
    });
  }

  /** True when this canonical frame was held for the in-flight refresh. */
  function holdForRefresh(
    message: { type?: string; [key: string]: unknown },
    boundHostId: string,
    boundEpoch: number,
  ): boolean {
    const entry = stateRefresh;
    if (!entry || entry.hostId !== boundHostId || entry.epoch !== boundEpoch) return false;
    const eventKind = (message.event as { kind?: unknown } | undefined)?.kind;
    if (!occupiesCanonicalSequence(String(message.type), typeof eventKind === 'string' ? eventKind : undefined)) return false;
    if (entry.held.length >= MAX_HELD_CANONICAL_FRAMES) {
      // Too much to hold: drop the rest. Replay then meets a gap and asks
      // for one more snapshot instead of growing without bound.
      entry.overflow = true;
      return true;
    }
    entry.held.push(message);
    return true;
  }

  /** Synchronous on purpose: the event and patch branches of onControl do
   *  not await, so the held frames apply in order before the Relay hands
   *  over the next live frame. */
  function replayHeldFrames(hostId: string): void {
    const entry = stateRefresh;
    if (!entry || entry.hostId !== hostId) return;
    stateRefresh = null;
    const runtime = hostRuntime(hostId);
    for (const message of entry.held) {
      const sequence = Number(message.event_sequence);
      // Already part of the snapshot.
      if (Number.isFinite(sequence) && sequence <= runtime.lastEventSequence) continue;
      if (runtime.epoch !== entry.epoch || state.currentHostId !== hostId) return;
      void onControl(message, hostId, entry.epoch).catch(() => undefined);
    }
    if (entry.overflow) requestState();
  }

  function refreshStateFromUi(): void {
    const hostId = state.currentHostId;
    if (!hostId || refreshInFlight) return;
    const hadBoundRelay = Boolean(boundRelay());
    cancelReconnect();
    update({ connection: { kind: 'resyncing', synced: 0, total: 1 } });
    const run = (async () => {
      if (hadBoundRelay) {
        await recoverPendingCommands(hostId);
      } else {
        const connecting = connectInFlight;
        if (connecting) await connecting.catch(() => undefined);
        if (closed || state.currentHostId !== hostId) return;
        if (!boundRelay()) await connectHost(hostId);
      }
      if (closed || state.currentHostId !== hostId) return;
      await requestStateAsync();
    })().catch((error) => {
      if (
        closed
        || state.currentHostId !== hostId
        || state.connection.kind !== 'resyncing'
      ) return;
      if (reconnectTimer) return;
      update({ connection: connectionAfterFailure(error) });
    }).finally(() => {
      if (refreshInFlight === run) refreshInFlight = null;
    });
    refreshInFlight = run;
  }

  function hydrateSessionDetached(
    sessionId: string,
    operation: 'initial' | 'older' = 'initial',
    force = false,
  ): void {
    if (operation === 'initial') {
      // Subscription is NOT history loading (R2-1): re-entering an already
      // hydrated session must still re-subscribe (the Host holds exactly one
      // subscribed session per connection — without this, its translation
      // events keep going to the previously viewed session), refresh its
      // translation state, reconcile pending manual reads by request
      // identity, and offer the encrypted draft backup a restore chance.
      subscribeSession(sessionId);
      restoreGatedDraft(sessionId);
      reconcileTranslationSession(sessionId);
      const current = state.transcripts[sessionId];
      if (!force && current?.hydrated && !current.historyError) return;
    }
    const loading = beginTranscriptLoad(state, sessionId, operation);
    update({ transcripts: loading.transcripts });
    void hydrateSession(sessionId, operation).catch(() => {
      const failed = failTranscriptLoad(state, sessionId, operation);
      update({ transcripts: failed.transcripts });
    });
  }

  function subscribeSession(sessionId: string): void {
    const hostId = state.currentHostId;
    void sendCommand('session.subscribe', { session_id: sessionId }, 'session.subscribe')
      .then((data) => {
        if (!data || closed || state.currentHostId !== hostId) return;
        const result = parseClosed(REMOTE_METHOD_RESULTS['session.subscribe'], data) as {
          session: RemoteSession;
          interactions?: RemoteInteraction[];
          translation?: import('@gian/remote-protocol').RemoteTranslationState;
        };
        const adoptedOnScreen = directoryState().supported && adoptSubscribedSession(result.session, result.interactions);
        update({
          translations: result.translation
            // A live subscribe answer on the current connection is the
            // authoritative baseline read — only it may establish or
            // replace the automatic epoch.
            ? applyTranslationState(state.translations, sessionId, result.translation, { authoritativeBaseline: true })
            : markTranslationUnsupported(state.translations, sessionId),
        });
        if (adoptedOnScreen) {
          // A directory chat opened outside the snapshot: its history waits
          // for the session (and its agent) to be known.
          const transcript = state.transcripts[sessionId];
          if (!transcript || (!transcript.hydrated && !transcript.historyError)) loadHistory(sessionId);
          restoreGatedDraft(sessionId);
          reconcileTranslationSession(sessionId);
        }
      })
      .catch((error) => {
        if (closed || state.currentHostId !== hostId) return;
        if (directoryState().supported && errorCode(error) === 'REMOTE_CAPABILITY_DENIED') dropDirectorySession(sessionId);
        else if (directoryState().opening === sessionId) patchDirectory({ opening: null });
      });
  }

  /** Per-session reconciliation on (re)subscription: pending manual reads
   *  re-query their terminal status by request identity (F7), and
   *  descriptor-only records refill their full text (F3). Scoped to the
   *  session being viewed — never starts work for other sessions. */
  function reconcileTranslationSession(sessionId: string): void {
    if (!mutationsEnabled(state.connection)) return;
    const ui = state.translations[sessionId];
    if (!ui?.supported) return;
    for (const [sourceId, entry] of Object.entries(ui.reading)) {
      if (!entry.pending || !entry.requestId) continue;
      recoverReadRequest(sessionId, sourceId, entry.requestId);
    }
    for (const records of Object.values(ui.results)) {
      for (const record of records) {
        if (record.text === undefined && !ui.fullTexts[record.id]) {
          void fetchFullTranslationText(sessionId, record.id, record.textSha256);
        }
      }
    }
  }

  function recoverReadRequest(sessionId: string, sourceId: string, requestId: string): void {
    void sendReadCommand('translation.request_status', {
      session_id: sessionId,
      request_id: requestId,
    }, 'translation.request_status', false).then((data) => {
      if (!data || closed) return;
      const status = parseClosed(REMOTE_METHOD_RESULTS['translation.request_status'], data);
      // A NEWER generation for the same source owns the row — a late status
      // for an old request must not clear or overwrite it (R2-1).
      const live = state.translations[sessionId]?.reading[sourceId];
      const ownsRow = live?.pending === true && live.requestId === requestId;
      if (status.state === 'succeeded' && status.record) {
        // The record is real persisted data — merge it regardless…
        let next = applyTranslationUpsert(state.translations, status.record);
        // …but keep a newer generation's pending row intact.
        if (live?.pending && live.requestId !== requestId) {
          next = restoreTranslationReading(next, sessionId, sourceId, live);
        }
        update({ translations: next });
        if (status.record.text === undefined) {
          void fetchFullTranslationText(sessionId, status.record.id, status.record.text_sha256);
        }
        if (ownsRow) translationReadWaiters.delete(requestId);
        return;
      }
      if (!ownsRow) return;
      if (status.state === 'failed') {
        translationReadWaiters.delete(requestId);
        update({ translations: applyTranslationReadError(state.translations, sessionId, sourceId, status.error ?? 'Translation failed') });
      } else if (status.state === 'unknown') {
        // No durable outcome anywhere: reset the row so globe retries
        // instead of showing a permanent Translating state.
        translationReadWaiters.delete(requestId);
        update({ translations: resetTranslationRead(state.translations, sessionId, sourceId) });
      }
      // 'pending': the Host is still running it; the live settle event
      // lands normally through the subscription.
    }).catch(() => {
      const live = state.translations[sessionId]?.reading[sourceId];
      if (live?.pending && live.requestId === requestId) {
        translationReadWaiters.delete(requestId);
        update({ translations: resetTranslationRead(state.translations, sessionId, sourceId) });
      }
    });
  }

  async function hydrateSession(sessionId: string, operation: 'initial' | 'older'): Promise<void> {
    const cursor = operation === 'older' ? state.transcripts[sessionId]?.cursor : undefined;
    const result = await sendReadCommand('session.page', {
      session_id: sessionId,
      turns: 3,
      ...(cursor ? { cursor } : {}),
    }, 'session.page');
    if (!result) throw new RemoteProtocolError('HOST_OFFLINE', 'message history is unavailable');
    const page = parseClosed(REMOTE_METHOD_RESULTS['session.page'], result) as {
      items: RemoteTranscriptItem[];
      has_more: boolean;
      cursor?: string;
      translations?: RemoteTranslation[];
    };
    const session = state.sessions.find((item) => item.id === sessionId);
    const exec = session?.agent.proxy || 'claude';
    const next = applyTranscriptPage(
      state,
      sessionId,
      page.items,
      exec,
      page.has_more,
      page.cursor,
      operation === 'older',
    );
    update({
      transcripts: next.transcripts,
      ...(page.translations?.length
        ? { translations: applyTranslationPage(state.translations, sessionId, page.translations) }
        : {}),
    });
    adoptTranslationEcho(sessionId);
    fetchSentTranslationDescriptors(sessionId);
    for (const dto of page.translations ?? []) {
      if (dto.text === undefined) void fetchFullTranslationText(sessionId, dto.id, dto.text_sha256);
    }
  }

  // ── Conversation translation (wire.conversation_translation) ────────────

  /** Encrypted, Host-scoped pending-draft persistence (F2): never plaintext
   *  localStorage, and cleared on dispatch, reclaim, logout and revoke. */
  const translationDraftStore = options.draftStore ?? createPendingDraftStore(options.storageScope);
  /** Echoes awaiting their canonical user item, per session: delivery-id
   *  match preferred, exact-text fallback only after the gate finished. */
  const adoptableEchoes = new Map<string, { echoId: string; deliveryId?: string; text: string; ts: number }>();

  function handleTranslationUpdated(
    hostId: string,
    event: {
      session_id: string;
      state?: import('@gian/remote-protocol').RemoteTranslationState;
      automatic?: import('@gian/remote-protocol').RemoteTranslationAutomatic;
      automatic_revision?: number;
      automatic_epoch?: string;
      upsert?: RemoteTranslation;
      request_id?: string;
      error?: string;
    },
  ): void {
    const sessionId = event.session_id;
    let translations = state.translations;
    if (event.state) translations = applyTranslationState(translations, sessionId, event.state);
    if (event.automatic) {
      translations = applyTranslationAutomatic(translations, sessionId, event.automatic, {
        revision: event.automatic_revision ?? 0,
        epoch: event.automatic_epoch ?? '',
      });
    }
    if (event.upsert) {
      // A record is real persisted data — always merge it; but its arrival
      // must not clear a NEWER pending generation for the same source (R2-1).
      const srcId = event.upsert.source_id;
      const liveRow = srcId ? translationUiFor(translations, sessionId).reading[srcId] : undefined;
      translations = applyTranslationUpsert(translations, event.upsert);
      if (srcId && liveRow?.pending && liveRow.requestId && liveRow.requestId !== event.request_id) {
        translations = restoreTranslationReading(translations, sessionId, srcId, liveRow);
      }
    }
    update({ translations });
    if (event.upsert && event.upsert.purpose === 'read' && event.upsert.text === undefined) {
      void fetchFullTranslationText(sessionId, event.upsert.id, event.upsert.text_sha256);
    }
    if (!event.request_id) return;
    const sendWaiter = translationSendWaiters.get(event.request_id);
    if (sendWaiter && sendWaiter.hostId === hostId) {
      translationSendWaiters.delete(event.request_id);
      if (event.error) {
        translationSendTimers.get(event.request_id)?.clear();
        translationSendTimers.delete(event.request_id);
        failTranslationSend(sessionId, event.request_id, event.error, false);
      } else if (event.upsert) {
        completeTranslationSend(sessionId, event.request_id, event.upsert);
      }
      return;
    }
    const readWaiter = translationReadWaiters.get(event.request_id);
    if (readWaiter && readWaiter.hostId === hostId) {
      translationReadWaiters.delete(event.request_id);
      if (event.error) {
        // A late failure only lands on the request generation it belongs to —
        // never on a newer generation for the same source (R2-1).
        const live = state.translations[readWaiter.sessionId]?.reading[readWaiter.sourceId];
        if (live?.pending && live.requestId === event.request_id) {
          update({
            translations: applyTranslationReadError(state.translations, readWaiter.sessionId, readWaiter.sourceId, event.error),
          });
        }
      }
      // A successful read is the upsert merge above (record-level, idempotent).
    }
  }

  // ── Gated-send draft durability (F2/F5) ────────────────────────────────

  /** Persist the gate's draft WITH its phase and fixed dispatch identity, so
   *  a refresh after the real send (before its ACK) cannot mistake
   *  already-sent text for an unsent draft (F1/F5). */
  function persistGatedDraft(hostId: string, sessionId: string, gate: TranslationSendGate): void {
    void translationDraftStore.put(hostId, sessionId, gate.submissionId, {
      draft: gate.draft,
      at: Date.now(),
      phase: gate.phase === 'failed' ? 'translating' : gate.phase,
      ...((gate.phase === 'dispatching' || gate.phase === 'unknown') && gate.sendCommandId
        ? { sendCommandId: gate.sendCommandId } : {}),
      ...((gate.phase === 'dispatching' || gate.phase === 'unknown') && gate.deliveryId
        ? { deliveryId: gate.deliveryId } : {}),
    }).catch(() => undefined);
  }

  function dropGatedDraft(hostId: string, sessionId: string, submissionId: string): void {
    void translationDraftStore.remove(hostId, sessionId, submissionId).catch(() => undefined);
  }

  /** Restore-once with confirmation (F5 + F1): read WITHOUT consuming; apply
   *  only when a live gate does not own the text and the composer is empty;
   *  delete the backup only after it lands. A draft persisted in a
   *  dispatching/unknown phase confirms the fixed send command's terminal
   *  state first — an already-delivered text is never restored as unsent. An
   *  occupied composer keeps the backup for a later restore. */
  function restoreGatedDraft(sessionId: string): void {
    const hostId = state.currentHostId;
    if (!hostId) return;
    void translationDraftStore.list(hostId, sessionId).then(async entries => {
      if (closed || state.currentHostId !== hostId) return;
      // Oldest first: each entry confirms its own terminal state before any
      // restore or removal; the composer is never overwritten.
      for (const entry of entries) {
        if (closed || state.currentHostId !== hostId) return;
        if (state.translations[sessionId]?.send) return;
        const payload = entry.payload;
        if (payload.phase !== 'translating' && payload.sendCommandId) {
          const raw = await sendReadCommand('command.status', { command_id: payload.sendCommandId }, 'command.status', false)
            .catch(() => null);
          if (!raw) return; // status unreadable now — keep the backups for the next idle restore
          const status = parseClosed(commandStatusResultSchema, raw);
          if (status.state === 'succeeded') {
            // Delivered: drop this backup without restoring anything.
            await translationDraftStore.remove(hostId, sessionId, entry.submissionId).catch(() => undefined);
            continue;
          }
          // Only a terminal failure proves the dispatch never landed. Per the
          // protocol's unknown-outcome convention, accepted/unknown_outcome/
          // not_seen/expired all keep the backup untouched.
          if (status.state !== 'failed') return;
        }
        if (!draftIsEmpty(state.drafts[sessionId] ?? emptyDraft())) return;
        update({ drafts: { ...state.drafts, [sessionId]: payload.draft } });
        await translationDraftStore.remove(hostId, sessionId, entry.submissionId).catch(() => undefined);
        return;
      }
    }).catch(() => undefined);
  }

  // ── Pending original bubble (echo) + inline gate status ────────────────

  function upsertTranslationEcho(sessionId: string, submissionId: string, draft: RemoteUiState['drafts'][string]): void {
    const transcript = state.transcripts[sessionId];
    const items = transcript?.items ?? [];
    const lastTs = items.reduce((max, item) => Math.max(max, item.ts), 0);
    const lastTurn = items.reduce((max, item) => Math.max(max, item.turn), 0);
    const echoId = `translation-echo:${submissionId}`;
    const exec = (state.sessions.find(item => item.id === sessionId)?.agent.proxy || 'claude') as Executor;
    const echo: TranscriptItem = {
      kind: 'user',
      id: echoId,
      text: draft.text,
      exec,
      ts: Math.max(Date.now(), lastTs + 1),
      turn: lastTurn + 1,
      pending: true,
    };
    update({
      transcripts: {
        ...state.transcripts,
        [sessionId]: {
          ...(transcript ?? {
            hydrated: false, streaming: false, hasOlder: false, loadingOlder: false, historyError: null,
          }),
          items: [...items.filter(item => item.id !== echoId), echo],
        },
      },
    });
  }

  function markTranslationEcho(sessionId: string, submissionId: string, failed: boolean): void {
    const transcript = state.transcripts[sessionId];
    const echoId = `translation-echo:${submissionId}`;
    if (!transcript?.items.some(item => item.id === echoId)) return;
    update({
      transcripts: {
        ...state.transcripts,
        [sessionId]: {
          ...transcript,
          items: transcript.items.map(item => item.id === echoId ? { ...item, failed } : item),
        },
      },
    });
  }

  function removeTranslationEcho(sessionId: string, submissionId: string): void {
    const transcript = state.transcripts[sessionId];
    const echoId = `translation-echo:${submissionId}`;
    adoptableEchoes.delete(sessionId);
    if (!transcript?.items.some(item => item.id === echoId)) return;
    update({
      transcripts: {
        ...state.transcripts,
        [sessionId]: { ...transcript, items: transcript.items.filter(item => item.id !== echoId) },
      },
    });
  }

  /** Adopt the echo once the canonical user item lands. Delivery identity is
   *  preferred (set when the dispatch result carried it); the exact-text
   *  fallback applies only after the gate has already finished, so a
   *  coincidental earlier message can never be mistaken for this send. */
  function adoptTranslationEcho(sessionId: string): void {
    const adoptable = adoptableEchoes.get(sessionId);
    if (!adoptable) return;
    const transcript = state.transcripts[sessionId];
    if (!transcript) return;
    const match = transcript.items.find(item => item.kind === 'user' && !item.pending
      && (adoptable.deliveryId
        ? item.deliveryId === adoptable.deliveryId
        : item.text === adoptable.text && item.ts >= adoptable.ts));
    if (!match) return;
    removeTranslationEcho(sessionId, adoptable.echoId.slice('translation-echo:'.length));
  }

  function gateSet(sessionId: string, gate: RemoteTranslationUiState['send']): void {
    update({
      translations: {
        ...state.translations,
        [sessionId]: { ...translationUiFor(state.translations, sessionId), send: gate },
      },
    });
  }

  /** Gate entry for a translated send (auto ON, idle session). The draft
   *  leaves the composer into the gate and a pending original bubble shows
   *  the inline translation status; only a Host receipt or an explicit user
   *  choice (retry / send original / reclaim) settles it. */
  function sendDraftGated(sessionId: string, draft: RemoteUiState['drafts'][string]): void {
    const hostId = state.currentHostId;
    if (!hostId) return;
    const submissionId = generateCanonicalId();
    const requestId = generateCanonicalId();
    update({ drafts: { ...state.drafts, [sessionId]: emptyDraft() } });
    gateSet(sessionId, { phase: 'translating', submissionId, requestId, draft });
    upsertTranslationEcho(sessionId, submissionId, draft);
    persistGatedDraft(hostId, sessionId, { phase: 'translating', submissionId, requestId, draft });
    startSendRequest(sessionId, requestId, draft);
  }

  function startSendRequest(sessionId: string, requestId: string, draft: RemoteUiState['drafts'][string]): void {
    const hostId = state.currentHostId;
    if (!hostId) return;
    translationSendWaiters.set(requestId, { hostId, sessionId });
    const timeout = withSendTimeout(() => {
      const gate = state.translations[sessionId]?.send;
      if (gate?.requestId !== requestId || gate.phase !== 'translating') return;
      translationSendWaiters.delete(requestId);
      translationSendTimers.delete(requestId);
      void sendCommand('translation.cancel', { session_id: sessionId, request_id: requestId }, 'translation.cancel')
        .catch(() => undefined);
      failTranslationSend(sessionId, requestId, '', true);
    });
    translationSendTimers.set(requestId, timeout);
    const session = state.sessions.find((item) => item.id === sessionId);
    const document = sessionSendParams(sessionId, draft, session).composer_document;
    void sendCommand('translation.request', {
      session_id: sessionId,
      request_id: requestId,
      purpose: 'send',
      // The exact composer text: the Host validates the settled receipt
      // against THIS string when session.send references it.
      text: draft.text,
      ...(document ? { composer_document: document } : {}),
    }, 'translation.request').catch((error) => {
      if (!translationSendWaiters.delete(requestId)) return;
      translationSendTimers.get(requestId)?.clear();
      translationSendTimers.delete(requestId);
      failTranslationSend(sessionId, requestId, error instanceof Error ? error.message : 'Translation failed', false);
    });
  }

  function cancelSendRequest(sessionId: string, requestId: string): void {
    if (translationSendWaiters.delete(requestId)) {
      void sendCommand('translation.cancel', { session_id: sessionId, request_id: requestId }, 'translation.cancel')
        .catch(() => undefined);
    }
    translationSendTimers.get(requestId)?.clear();
    translationSendTimers.delete(requestId);
  }

  function failTranslationSend(sessionId: string, requestId: string, error: string, timedOut: boolean): void {
    const gate = state.translations[sessionId]?.send;
    if (!gate || gate.requestId !== requestId) return;
    if (gate.phase !== 'translating') return;
    markTranslationEcho(sessionId, gate.submissionId, true);
    gateSet(sessionId, { phase: 'failed', submissionId: gate.submissionId, requestId, draft: gate.draft, error, timedOut });
  }

  /** A dispatched send whose ACK is in doubt: the fixed command identity is
   *  recovered by command.status — the gate waits, it never re-sends. */
  function markTranslationSendUnknown(sessionId: string, requestId: string): void {
    const gate = state.translations[sessionId]?.send;
    if (!gate || gate.requestId !== requestId || gate.phase !== 'dispatching') return;
    const unknown = { ...gate, phase: 'unknown' as const };
    gateSet(sessionId, unknown);
    if (state.currentHostId) persistGatedDraft(state.currentHostId, sessionId, unknown);
  }

  function finishTranslationSend(sessionId: string, requestId: string): void {
    const gate = state.translations[sessionId]?.send;
    if (state.currentHostId && gate) dropGatedDraft(state.currentHostId, sessionId, gate.submissionId);
    if (gate?.requestId !== requestId) return;
    gateSet(sessionId, null);
    // The canonical user bubble replaces the echo; adoption runs on every
    // transcript application until it lands.
    const echoId = `translation-echo:${gate?.submissionId ?? requestId}`;
    adoptableEchoes.set(sessionId, {
      echoId,
      ...(gate && 'deliveryId' in gate && gate.deliveryId ? { deliveryId: gate.deliveryId } : {}),
      text: gate?.draft.text ?? '',
      ts: state.transcripts[sessionId]?.items.find(item => item.id === echoId)?.ts ?? Date.now(),
    });
    adoptTranslationEcho(sessionId);
    // The gate's composer slot is free again: a kept-aside draft from an
    // older gate restores now (confirmed before consuming) — R2-3/F5.
    restoreGatedDraft(sessionId);
  }

  /** Dispatch the gated draft under a FIXED session.send command identity
   *  (F1). The gate moves to dispatching before the command is minted; a lost
   *  ACK is recovered by command.status via the pending-command ledger, never
   *  by issuing another send. */
  function dispatchGatedSend(
    sessionId: string,
    requestId: string,
    draft: RemoteUiState['drafts'][string],
    params: ReturnType<typeof sessionSendParams> & { translation_id?: string },
  ): void {
    const gate = state.translations[sessionId]?.send;
    if (!gate || gate.requestId !== requestId) return;
    if (gate.phase !== 'translating' && gate.phase !== 'failed') return;
    const hostId = state.currentHostId;
    void sendCommand('session.send', params, 'session.send', {
      onCommandId: commandId => {
        const current = state.translations[sessionId]?.send;
        if (!current || current.requestId !== requestId) return;
        if (current.phase !== 'translating' && current.phase !== 'failed') return;
        gateSet(sessionId, {
          phase: 'dispatching',
          submissionId: current.submissionId,
          requestId,
          draft,
          sendCommandId: commandId,
        });
      },
      // The fixed dispatch identity lands in the encrypted store BEFORE the
      // frame goes on the wire; a persistence failure aborts the dispatch
      // (nothing was sent) instead of leaving a refresh window (F1/F2).
      beforeDispatch: commandId => hostId
        ? translationDraftStore.put(hostId, sessionId, gate.submissionId, {
          draft,
          at: Date.now(),
          phase: 'dispatching',
          sendCommandId: commandId,
        })
        : Promise.resolve(),
    }).then((data) => {
      const current = state.translations[sessionId]?.send;
      if (!current || current.requestId !== requestId) return;
      if (current.phase !== 'dispatching' && current.phase !== 'unknown') return;
      const deliveryId = (data as { delivery_id?: string } | undefined)?.delivery_id;
      if (deliveryId) gateSet(sessionId, { ...current, deliveryId });
      finishTranslationSend(sessionId, requestId);
    }).catch((error) => {
      const current = state.translations[sessionId]?.send;
      if (!current || current.requestId !== requestId) return;
      if (current.phase === 'translating' || current.phase === 'failed') {
        // The command was never minted (offline/unready transport): nothing
        // was dispatched — reopen the gate as failed with the draft intact.
        gateSet(sessionId, {
          phase: 'failed',
          submissionId: current.submissionId,
          requestId,
          draft,
          error: error instanceof Error ? error.message : 'Send failed',
          timedOut: false,
        });
        markTranslationEcho(sessionId, current.submissionId, true);
        return;
      }
      if (errorCode(error) === 'UNKNOWN_OUTCOME') {
        markTranslationSendUnknown(sessionId, requestId);
        return;
      }
      // Terminal dispatch failure (e.g. rejected receipt): the message was
      // NOT sent — the gate reopens with the draft intact.
      gateSet(sessionId, { phase: 'failed', submissionId: current.submissionId, requestId, draft, error: error instanceof Error ? error.message : 'Send failed', timedOut: false });
      markTranslationEcho(sessionId, current.submissionId, true);
    });
  }

  /** Host receipt in hand: dispatch the real send with the receipt
   *  reference only — the Host revalidates source text/document. */
  function completeTranslationSend(sessionId: string, requestId: string, record: RemoteTranslation): void {
    const gate = state.translations[sessionId]?.send;
    if (!gate || gate.requestId !== requestId || gate.phase !== 'translating') return;
    translationSendTimers.get(requestId)?.clear();
    translationSendTimers.delete(requestId);
    const session = state.sessions.find((item) => item.id === sessionId);
    dispatchGatedSend(sessionId, requestId, gate.draft, {
      ...sessionSendParams(sessionId, gate.draft, session),
      translation_id: record.id,
    });
  }

  /** Dispatch the gated draft without a receipt. `original=true` is the
   *  explicit "Send original" choice; the intent travels WITH the queued
   *  entry when the session is busy, so drain never re-translates it (F4). */
  function dispatchGatedDraft(sessionId: string, requestId: string, draft: RemoteUiState['drafts'][string], original: boolean): void {
    const session = state.sessions.find((item) => item.id === sessionId);
    dispatchGatedSend(sessionId, requestId, draft, {
      ...sessionSendParams(sessionId, draft, session),
      ...(original ? { translation_id: 'original' as const } : {}),
    });
  }

  /** After a reconnect the settled events may be lost. Translating gates
   *  restart under a fresh request generation (Host cache/coalescing makes
   *  it cheap); dispatching/unknown gates belong to their fixed command
   *  identity and are recovered by command.status — never restarted (F1).
   *  Manual reads re-query their terminal status by request identity (F7),
   *  scoped to the session being viewed — other sessions reconcile when
   *  selected, so a reconnect never starts their translation work (R2-1). */
  function recoverTranslationGates(): void {
    if (state.connection.kind !== 'online') return;
    for (const [sessionId, ui] of Object.entries(state.translations)) {
      if (ui.send?.phase === 'translating') {
        cancelSendRequest(sessionId, ui.send.requestId);
        const requestId = generateCanonicalId();
        const draft = ui.send.draft;
        // The echo and durable backup keep the stable submission identity;
        // only the translation request generation changes (F5 echo fix).
        gateSet(sessionId, { phase: 'translating', submissionId: ui.send.submissionId, requestId, draft });
        startSendRequest(sessionId, requestId, draft);
      }
    }
    if (state.view.kind === 'chat') reconcileTranslationSession(state.view.sessionId);
  }

  /** Page a descriptor-only translation's complete text through
   *  translation.result_text and verify the assembled hash (F3). */
  async function fetchFullTranslationText(sessionId: string, recordId: string, expectedSha256: string): Promise<void> {
    const hostId = state.currentHostId;
    if (!hostId) return;
    try {
      let offset = 0;
      let assembled = '';
      for (let guard = 0; guard < 64; guard += 1) {
        const data = await sendReadCommand('translation.result_text', {
          session_id: sessionId,
          record_id: recordId,
          ...(offset ? { offset } : {}),
        }, 'translation.result_text', false);
        if (!data) return;
        const page = parseClosed(REMOTE_METHOD_RESULTS['translation.result_text'], data);
        assembled += page.text;
        if (page.next_offset === undefined) break;
        if (page.next_offset <= offset) throw new RemoteProtocolError('INVALID_FRAME', 'translation paging did not advance');
        offset = page.next_offset;
      }
      const digest = await sha256Hex(new TextEncoder().encode(assembled));
      if (digest !== expectedSha256) throw new RemoteProtocolError('INVALID_FRAME', 'translation text hash mismatch');
      if (closed || state.currentHostId !== hostId) return;
      update({ translations: applyTranslationFullText(state.translations, sessionId, recordId, assembled) });
      patchSentTranslationText(sessionId, recordId, assembled);
    } catch {
      // A failed/interrupted page or a hash mismatch is an actionable error
      // with in-place retry — never an endless Translating state.
      if (closed || state.currentHostId !== hostId) return;
      update({ translations: applyTranslationFullTextError(state.translations, sessionId, recordId) });
      markSentTranslationFetchError(sessionId, recordId);
    }
  }

  /** Fill a descriptor-only sent-translation summary on the user bubble once
   *  its full text has been paged in and verified. */
  function patchSentTranslationText(sessionId: string, recordId: string, text: string): void {
    const transcript = state.transcripts[sessionId];
    if (!transcript) return;
    if (!transcript.items.some(item => item.kind === 'user' && item.translation?.id === recordId && item.translation.text === undefined)) return;
    update({
      transcripts: {
        ...state.transcripts,
        [sessionId]: {
          ...transcript,
          items: transcript.items.map(item => (
            item.kind === 'user' && item.translation?.id === recordId && item.translation.text === undefined
              ? { ...item, translation: { ...item.translation, text, fetchError: false } }
              : item
          )),
        },
      },
    });
  }

  /** Flag the sent-translation descriptor's fetch failure on the bubble so
   *  it renders an actionable retry instead of an invisible pending. */
  function markSentTranslationFetchError(sessionId: string, recordId: string): void {
    const transcript = state.transcripts[sessionId];
    if (!transcript) return;
    if (!transcript.items.some(item => item.kind === 'user' && item.translation?.id === recordId && item.translation.text === undefined)) return;
    update({
      transcripts: {
        ...state.transcripts,
        [sessionId]: {
          ...transcript,
          items: transcript.items.map(item => (
            item.kind === 'user' && item.translation?.id === recordId && item.translation.text === undefined
              ? { ...item, translation: { ...item.translation, fetchError: true } }
              : item
          )),
        },
      },
    });
  }

  /** Descriptor-only sent translations on freshly applied user items page
   *  their full text in the background (F3). */
  function fetchSentTranslationDescriptors(sessionId: string): void {
    const transcript = state.transcripts[sessionId];
    if (!transcript) return;
    for (const item of transcript.items) {
      if (item.kind === 'user' && item.translation?.id && item.translation.text === undefined) {
        void fetchFullTranslationText(sessionId, item.translation.id, item.translation.textSha256 ?? '');
      }
    }
  }

  function startReadRequest(sessionId: string, sourceId: string, text: string): void {
    const hostId = state.currentHostId;
    if (!hostId) return;
    const requestId = generateCanonicalId();
    translationReadWaiters.set(requestId, { hostId, sessionId, sourceId });
    update({
      translations: {
        ...state.translations,
        [sessionId]: {
          ...translationUiFor(state.translations, sessionId),
          reading: {
            ...translationUiFor(state.translations, sessionId).reading,
            [sourceId]: { pending: true, requestId },
          },
        },
      },
    });
    void sendCommand('translation.request', {
      session_id: sessionId,
      request_id: requestId,
      purpose: 'read',
      source_id: sourceId,
      text,
    }, 'translation.request').catch((error) => {
      if (!translationReadWaiters.delete(requestId)) return;
      update({
        translations: applyTranslationReadError(
          state.translations,
          sessionId,
          sourceId,
          error instanceof Error ? error.message : 'Translation failed',
        ),
      });
    });
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new RemoteProtocolError('HOST_OFFLINE', message));
      }, timeoutMs);
      promise.then(
        value => { clearTimeout(timeout); resolve(value); },
        error => { clearTimeout(timeout); reject(error); },
      );
    });
  }

  function finishMutation(
    commandId: string,
    phase: 'succeeded' | 'failed' | 'unknown',
    errorCode?: string,
    errorMessage?: string,
    showUnknownOutcome = true,
  ): void {
    const current = state.mutations[commandId];
    if (!current) return;
    update({
      mutations: {
        ...state.mutations,
        [commandId]: { ...current, phase, errorCode, errorMessage },
      },
      unknownCommandId: showUnknownOutcome
        ? nextUnknownCommandId(state.unknownCommandId, commandId, phase)
        : state.unknownCommandId,
    });
  }

  async function onControl(
    message: { type?: string; [key: string]: unknown },
    boundHostId: string,
    boundEpoch: number,
  ): Promise<void> {
    if (hostRuntime(boundHostId).epoch !== boundEpoch) return;
    if (message.type === 'snapshot.required') {
      if (state.currentHostId !== boundHostId) return;
      requestState();
      return;
    }
    if (message.type === 'directory.changed') {
      if (state.currentHostId !== boundHostId) return;
      scheduleDirectoryRefresh();
      return;
    }
    if (message.type === 'resume.ok') {
      if (state.currentHostId !== boundHostId) return;
      const runtime = hostRuntime(boundHostId);
      if (typeof message.replay_from === 'number') runtime.lastEventSequence = Number(message.replay_from) - 1;
      // resume.ok describes the replay destination, not the state already
      // applied here. Each replayed patch advances the local revision.
      update({ connection: { kind: 'online' } });
      if (state.view.kind === 'chat' && message.transcript_included !== true) hydrateSessionDetached(state.view.sessionId, 'initial', true);
      recoverTranslationGates();
      return;
    }
    if (message.type === 'transcript.page') {
      if (state.currentHostId !== boundHostId) return;
      const page = parseClosed(transcriptPageSchema, message);
      const sessionId = page.session_id;
      if (state.view.kind !== 'chat' || state.view.sessionId !== sessionId) return;
      const session = state.sessions.find((item) => item.id === sessionId);
      const exec = session?.agent.proxy || 'claude';
      const next = applyTranscriptPage(
        state,
        sessionId,
        page.items,
        exec,
        page.has_more,
        page.cursor,
        false,
      );
      update({
        transcripts: next.transcripts,
        ...(page.translations?.length
          ? { translations: applyTranslationPage(state.translations, sessionId, page.translations) }
          : {}),
      });
      adoptTranslationEcho(sessionId);
      fetchSentTranslationDescriptors(sessionId);
      for (const dto of page.translations ?? []) {
        if (dto.text === undefined) void fetchFullTranslationText(sessionId, dto.id, dto.text_sha256);
      }
      return;
    }
    if (message.type === 'state.snapshot.part') {
      if (state.currentHostId !== boundHostId) return;
      const snapshotId = typeof message.snapshot_id === 'string' ? message.snapshot_id : '';
      const entry = snapshotAssemblies.get(snapshotId);
      if (!entry || entry.hostId !== boundHostId || entry.epoch !== boundEpoch) return;
      try {
        const part = parseClosed(stateSnapshotPartSchema, message);
        entry.assembly ??= createSnapshotPartAssembly(part);
        addSnapshotPart(entry.assembly, part);
        if (entry.assembly.parts.size !== entry.assembly.part_total) return;
        const snapshot = await finalizeSnapshotParts(entry.assembly);
        if (hostRuntime(boundHostId).epoch !== boundEpoch || closed) return;
        if (snapshotAssemblies.get(snapshotId) !== entry) return;
        const runtime = hostRuntime(boundHostId);
        if (snapshot.host.id !== boundHostId || snapshot.snapshot_id !== snapshotId
          || snapshot.host_generation !== entry.assembly.host_generation
          || snapshot.revision !== entry.assembly.revision
          || snapshot.event_sequence !== entry.assembly.event_sequence
          || (runtime.hostGeneration === snapshot.host_generation
            && runtime.lastEventSequence >= snapshot.event_sequence)) {
          throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'snapshot binding changed during transfer');
        }
        clearTimeout(entry.timer);
        snapshotAssemblies.delete(snapshotId);
        await onControl({ type: 'command.result', command_id: entry.commandId, ok: true, data: snapshot }, boundHostId, boundEpoch);
      } catch {
        // Keep the read pending so ordinary disconnect recovery retries it.
        relay?.close('snapshot_invalid');
      }
      return;
    }
    if (message.type === 'event') {
      if (state.currentHostId !== boundHostId) return;
      if (holdForRefresh(message, boundHostId, boundEpoch)) return;
      const event = parseClosed(canonicalEventSchema, message);
      if (!noteSequence(boundHostId, event.type, event.event_sequence, event.event.kind)) return;
      if (event.event.kind === 'translation.updated') {
        handleTranslationUpdated(boundHostId, event.event);
        return;
      }
      update(applyCanonicalEvent(state, event));
      if (event.event.kind === 'transcript.item' && event.event.item.kind === 'user') {
        adoptTranslationEcho(event.event.session_id);
        fetchSentTranslationDescriptors(event.event.session_id);
      }
      return;
    }
    if (message.type === 'state.patch') {
      if (state.currentHostId !== boundHostId) return;
      if (holdForRefresh(message, boundHostId, boundEpoch)) return;
      const patch = parseClosed(statePatchSchema, message);
      const revision = hostRuntime(boundHostId).snapshotRevision;
      if (revision && patch.base_revision !== revision) {
        requestState();
        return;
      }
      if (!noteSequence(boundHostId, patch.type, patch.event_sequence)) return;
      hostRuntime(boundHostId).snapshotRevision = patch.revision;
      // A chat leaving the Doing snapshot (its Task completed, or it moved
      // out of one) stays open on directory Hosts; re-read it from the Host.
      const openId = state.view.kind === 'chat' ? state.view.sessionId : null;
      const leaving = openId && directoryState().supported && patch.patch.sessions?.remove_ids.includes(openId)
        ? openId : null;
      if (leaving) pinSession(leaving);
      update(applyStatePatch(state, patch));
      if (leaving) subscribeSession(leaving);
      if (patch.patch.sessions || patch.patch.tasks) scheduleDirectoryRefresh();
      return;
    }
    if (message.type === 'transfer.ack') {
      try {
        const ack = parseClosed(transferAckSchema, message);
        uploadAcks.get(ack.transfer_id)?.push({
          contiguous_offset: ack.contiguous_offset,
          window_chunks: ack.window_chunks,
        });
      } catch {
        // Closed-schema ack is required; ignore a malformed window update.
      }
      return;
    }
    if (message.type === 'transfer.error' || message.type === 'transfer.cancel') {
      try {
        if (message.type === 'transfer.error') {
          const failed = parseClosed(transferErrorSchema, message);
          rejectTransfer(failed.transfer_id, new RemoteProtocolError(failed.code, failed.message));
        } else {
          const cancelled = parseClosed(transferCancelSchema, message);
          rejectTransfer(
            cancelled.transfer_id,
            new RemoteProtocolError('UNKNOWN_OUTCOME', cancelled.reason),
          );
        }
      } catch (error) {
        const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
        if (transferId) rejectTransfer(transferId, error);
      }
      return;
    }
    if (message.type === 'attachment.result') {
      try {
        const result = parseClosed(attachmentResultSchema, message);
        const waiter = uploadWaiters.get(result.transfer_id);
        uploadWaiters.delete(result.transfer_id);
        uploadAcks.delete(result.transfer_id);
        waiter?.resolve({
          transfer_id: result.transfer_id,
          upload_id: result.upload_id,
          attachment_id: result.attachment_id,
          name: result.name,
          mime: result.mime,
          size: result.size,
        });
      } catch (error) {
        const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
        if (transferId) rejectTransfer(transferId, error);
      }
      return;
    }
    if (
      message.type === 'download.metadata'
      || message.type === 'attachment.chunk'
      || message.type === 'download.complete'
    ) {
      const transferId = typeof message.transfer_id === 'string' ? message.transfer_id : '';
      const current = transferId ? downloads.get(transferId) : undefined;
      if (current && current.hostId !== boundHostId) return;
      try {
        if (!current || !transferId) return;
        if (message.type === 'download.metadata') {
          const next = applyDownloadMetadata(current, message, boundHostId);
          downloads.set(transferId, next);
          if (next.purpose === 'save') {
            update({ fileDownload: { status: 'downloading', pct: 0 } });
          }
          return;
        }
        if (message.type === 'attachment.chunk') {
          const next = applyDownloadChunk(current, message, transferId);
          downloads.set(transferId, next);
          if (next.purpose === 'save') {
            update({
              fileDownload: {
                status: 'downloading',
                pct: next.size > 0 ? Math.min(100, Math.round((next.nextOffset / next.size) * 100)) : 0,
              },
            });
          }
          const transport = boundRelay();
          if (transport && transport.hostId === boundHostId && transport.epoch === boundEpoch) {
            void transport.relay.sendControl({
              type: 'transfer.ack',
              transfer_id: transferId,
              contiguous_offset: next.nextOffset,
              window_chunks: CONTENT_WINDOW_CHUNKS,
            }).catch(() => undefined);
          }
          return;
        }
        downloads.delete(transferId);
        const bytes = await completeDownload(current, message);
        const thumbnail = thumbnailTransfers.get(transferId);
        if (thumbnail) {
          thumbnailTransfers.delete(transferId);
          const viewer = viewerFromPreviewBytes(current.handle!, bytes, current.mime);
          setThumbnail(thumbnail.key, viewer.status === 'image' ? { status: 'ready', dataUrl: viewer.dataUrl } : { status: 'skipped' });
          thumbnail.resolve();
          return;
        }
        if (current.purpose === 'preview') {
          if (previewMayComplete(current, state.fileViewer)) {
            update({ fileViewer: viewerFromPreviewBytes(current.handle!, bytes, current.mime) });
          }
          return;
        }
        saveBrowserFile(current.name, current.mime, bytes);
        update({ fileDownload: { status: 'idle' } });
      } catch (error) {
        if (transferId) downloads.delete(transferId);
        const thumbnail = transferId ? thumbnailTransfers.get(transferId) : undefined;
        if (thumbnail) {
          thumbnailTransfers.delete(transferId);
          thumbnail.reject(error);
          return;
        }
        failDownload(current, error);
      }
      return;
    }
    if (message.type === 'command.accepted') return;
    if (message.type === 'command.result') {
      const commandId = String(message.command_id ?? '');
      const pendingCommand = pending.get(commandId);
      if (!pendingCommand || pendingCommand.hostId !== boundHostId) return;
      if (message.ok && pendingCommand.method === 'state.refresh'
        && (message.data as { type?: string } | undefined)?.type === 'state.snapshot.pending') {
        const receipt = parseClosed(stateSnapshotPendingSchema, message.data);
        const previous = snapshotAssemblies.get(receipt.snapshot_id);
        if (previous) return;
        const transport = boundRelay();
        if (!transport || transport.epoch !== boundEpoch) return;
        const timer = setTimeout(() => {
          const entry = snapshotAssemblies.get(receipt.snapshot_id);
          if (entry?.commandId !== commandId) return;
          transport.relay.close('snapshot_timeout');
        }, SNAPSHOT_ASSEMBLY_TIMEOUT_MS);
        snapshotAssemblies.set(receipt.snapshot_id, { commandId, hostId: boundHostId, epoch: boundEpoch, timer });
        update({ connection: { kind: 'resyncing', synced: 0, total: 1 } });
        return;
      }
      pending.delete(commandId);
      if (!message.ok) {
        const code = String((message.error as { code?: string } | undefined)?.code ?? 'UNKNOWN_OUTCOME');
        if (pendingCommand?.method === 'file.preview' && state.fileViewer
          && (pendingCommand.params as { handle_id?: string })?.handle_id === state.fileViewer.handle.id) {
          update({ fileViewer: viewerFromPreviewError(state.fileViewer.handle, code) });
        }
        finishMutation(
          commandId,
          code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed',
          code,
          String((message.error as { message?: string } | undefined)?.message ?? code),
          showsUnknownOutcome(pendingCommand.method),
        );
        pendingCommand?.reject(new RemoteProtocolError(
          isRemoteErrorCode(code) ? code : 'INVALID_FRAME',
          String((message.error as { message?: string } | undefined)?.message ?? code),
        ));
        return;
      }
      try {
        applyCommandData(pendingCommand.method, message.data, pendingCommand.hostId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid command result';
        finishMutation(commandId, 'failed', 'INVALID_FRAME', detail);
        pendingCommand.reject(new RemoteProtocolError('INVALID_FRAME', detail));
        return;
      }
      finishMutation(commandId, 'succeeded');
      pendingCommand.resolve(message.data);
      return;
    }
    if (message.type === 'error' && message.code === 'DEVICE_REVOKED') {
      if (state.currentHostId !== boundHostId) return;
      void clearHostPairingMaterial(boundHostId);
      update({ connection: { kind: 'device_revoked' } });
      relay?.close('device_revoked');
    }
  }

  function applyCommandData(
    method: RemoteMethod | undefined,
    data: unknown,
    hostId?: string,
    applyOptions: { recovered?: boolean } = {},
  ): void {
    if (!method) return;
    if (method === 'state.refresh') {
      const snapshot = parseClosed(remoteStateSnapshotSchema, data);
      // The chunked path checks this binding; a whole snapshot must too, or
      // one paired Host could present its data as another's.
      if (hostId && snapshot.host.id !== hostId) {
        throw new RemoteProtocolError('INVALID_FRAME', 'snapshot belongs to a different Host');
      }
      applySnapshot(snapshot);
      return;
    }
    if (method === 'catalog.read') {
      const catalog = parseClosed(catalogReadResultSchema, data) as RemoteCatalog;
      update({
        catalog,
        catalogRevision: catalog.catalog_revision,
        catalogInvalidated: false,
        workspaces: catalog.workspaces,
      });
      ensureProxyLogos(catalog);
      return;
    }
    if (method === 'session.create' || method === 'session.update' || method === 'session.send') {
      const session = (data as { session?: unknown; id?: string } | undefined)?.session ?? data;
      if (applyOptions.recovered) {
        // command.status returns the result stored when the command first
        // ran. The resumed event stream already carries everything since,
        // so this old projection must not roll the session back. A recovered
        // create still opens its chat if the user is waiting on New chat.
        if (method === 'session.create' && state.view.kind === 'new-chat'
          && session && typeof session === 'object' && typeof (session as { id?: unknown }).id === 'string') {
          const sessionId = (session as { id: string }).id;
          if (state.sessions.some(item => item.id === sessionId)) {
            update({ view: { kind: 'chat', sessionId }, mobilePage: 'chat', fileViewer: null });
            hydrateSessionDetached(sessionId, 'initial', true);
          }
        }
        return;
      }
      if (session && typeof session === 'object' && 'id' in (session as object)) {
        const next = applyCanonicalEvent(state, {
          type: 'event',
          host_generation: (state.currentHostId
            ? hostRuntime(state.currentHostId).hostGeneration
            : '') || generateCanonicalId(),
          event_sequence: (state.currentHostId
            ? hostRuntime(state.currentHostId).lastEventSequence
            : -1) + 1,
          event: { kind: 'session.updated', session: session as never },
        });
        const created = session as RemoteSession;
        // A chat created outside an open Task is never in the snapshot.
        if (method === 'session.create' && directoryState().supported
          && !(created.task_id && state.tasks.some(task => task.id === created.task_id))) {
          pinSession(created.id);
        }
        update(method === 'session.create'
          ? {
              ...next,
              directory: directoryState(),
              view: { kind: 'chat', sessionId: String((session as { id: unknown }).id) },
              mobilePage: 'chat',
              fileViewer: null,
            }
          : next);
        if (method === 'session.create') {
          // Subscribe right away: the Host streams a chat's transcript only
          // to the connection subscribed to it, and nothing else would load
          // the new chat's (empty) history.
          hydrateSessionDetached(created.id, 'initial', true);
          scheduleDirectoryRefresh();
        }
      }
      return;
    }
    if (method === 'file.preview' && state.fileViewer) {
      const preview = parseClosed(filePreviewResultSchema, data);
      const handle = state.fileViewer.handle;
      if (handle.id !== preview.file.id) return;
      const transferId = preview.transfer_id;
      const transport = transferRelay();
      if (!transport || (hostId && transport.hostId !== hostId)) {
        update({ fileViewer: viewerFromPreviewError(handle, 'HOST_OFFLINE') });
        return;
      }
      downloads.set(transferId, startDownload({
        hostId: transport.hostId,
        purpose: 'preview',
        handle,
        name: preview.file.name,
        mime: preview.file.mime,
        size: preview.file.size,
      }));
      void transport.relay.sendControl({
        type: 'download.request',
        transfer_id: transferId,
        kind: 'file',
        handle_id: handle.id,
      }).catch((error) => {
        downloads.delete(transferId);
        update({
          fileViewer: viewerFromPreviewError(
            handle,
            error instanceof Error ? error.message : 'download failed',
          ),
        });
      });
    }
  }

  async function recoverPendingCommands(hostId: string): Promise<void> {
    const runtime = hostRuntime(hostId);
    // Reconcile writes before replaying presentation reads. A slow history
    // projection must not delay confirmation of a message the user sent.
    const waiting = [...runtime.recoverable].sort((left, right) => (
      Number(isReplaySafeRead(left.method)) - Number(isReplaySafeRead(right.method))
    ));
    runtime.recoverable = [];
    for (const command of waiting) {
      if (state.currentHostId !== hostId) {
        hostRuntime(hostId).recoverable.push(command);
        continue;
      }
      if (isReplaySafeRead(command.method)) {
        try {
          const result = await sendReadCommand(
            command.method,
            command.params ?? {},
            command.label,
            false,
          );
          finishMutation(command.commandId, 'succeeded', undefined, undefined, false);
          command.resolve?.(result);
        } catch (error) {
          if (state.currentHostId === hostId) hostRuntime(hostId).recoverable.push(command);
          finishMutation(
            command.commandId,
            'unknown',
            'UNKNOWN_OUTCOME',
            error instanceof Error ? error.message : 'read replay failed',
            false,
          );
        }
        continue;
      }
      try {
        const status = parseClosed(
          commandStatusResultSchema,
          await sendCommand('command.status', { command_id: command.commandId }, 'command.status'),
        );
        if (status.state === 'succeeded') {
          applyCommandData(command.method, status.result, hostId, { recovered: true });
          finishMutation(command.commandId, 'succeeded');
          command.resolve?.(status.result);
          continue;
        }
        if (status.state === 'failed') {
          finishMutation(
            command.commandId,
            'failed',
            status.error?.code ?? 'COMMAND_FAILED',
            status.error?.message,
          );
          command.reject?.(new Error(status.error?.message ?? 'command failed'));
          continue;
        }
        if (status.state === 'accepted') {
          if (state.currentHostId === hostId) hostRuntime(hostId).recoverable.push(command);
          finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', status.state);
          continue;
        }
        if (statusNeedsRefresh(status.state)) {
          finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', status.state);
          command.reject?.(new RemoteProtocolError('UNKNOWN_OUTCOME', status.state));
        }
      } catch {
        if (state.currentHostId === hostId) {
          hostRuntime(hostId).recoverable.push(command);
        }
        finishMutation(command.commandId, 'unknown', 'UNKNOWN_OUTCOME', 'status lookup failed');
      }
    }
  }

  function onNotice(notice: { type?: string }, boundHostId: string, boundEpoch: number): void {
    if (hostRuntime(boundHostId).epoch !== boundEpoch) return;
    if (notice.type === 'device.revoked') {
      if (state.currentHostId !== boundHostId) return;
      void clearHostPairingMaterial(boundHostId);
      update({ connection: { kind: 'device_revoked' } });
      relay?.close('device_revoked');
      return;
    }
    if (notice.type === 'host.offline') {
      if (state.currentHostId !== boundHostId) return;
      markDisconnectedPending(boundHostId);
      scheduleReconnect(boundHostId, {
        maxMs: HOST_OFFLINE_RECONNECT_MAX_MS,
        connection: { kind: 'host_offline', lastSeenAt: Date.now() },
      });
      return;
    }
    if (notice.type === 'host.online' && state.currentHostId === boundHostId) {
      if (relay?.isOpen) return;
      cancelReconnect();
      void connectHost(boundHostId).catch(() => undefined);
    }
  }

  async function deviceLogin(hostId: string): Promise<HostAuthSession> {
    const browserId = await identity.browserInstallationId();
    const hostIdentity = await identity.hostIdentity(hostId);
    const challenge = await auth.challenge(browserId, hostId);
    const login = await auth.login({
      browserInstallationId: browserId,
      hostId,
      challengeId: challenge.challenge_id,
      signature: await signBytes(hostIdentity.privateKey, new TextEncoder().encode(challenge.challenge_id)),
    });
    await identity.checkHostKey(hostId, hostKeyFingerprint(login.host_public_key));
    const session: HostAuthSession = {
      accessToken: login.access_token,
      accessExpiresAt: login.expires_at,
      deviceId: login.device_id,
      hostPublicKey: login.host_public_key,
      cryptoConnectionId: login.crypto_connection_id,
    };
    hostSessions.set(hostId, session);
    return session;
  }

  async function refreshPairedHosts(isCurrent: () => boolean): Promise<void> {
    try {
      const me = await auth.me();
      const hosts = await mergeRememberedHosts(me.hosts ?? []);
      if (!isCurrent()) return;
      update({ hosts });
    } catch { /* A directory refresh must not interrupt a working Host connection. */ }
  }

  async function mergeRememberedHosts(authorized: Array<{ host_id: string; name: string; online: boolean }>): Promise<RemoteHostEntry[]> {
    // A browser cookie is scoped to one confirmed Host delegation. Other
    // remembered Hosts remain selectable but require their own key challenge.
    const hosts = new Map<string, RemoteHostEntry>();
    for (const id of await identity.listHostIds()) {
      hosts.set(id, state.hosts.find(host => host.id === id)
        ?? { id, name: 'Gian Host', online: false, sessionCount: 0 });
    }
    for (const host of authorized) hosts.set(host.host_id, {
      ...hosts.get(host.host_id), id: host.host_id, name: host.name, online: host.online,
      sessionCount: hosts.get(host.host_id)?.sessionCount ?? 0,
    });
    return [...hosts.values()];
  }

  async function authenticateHost(
    hostId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<HostAuthSession> {
    const existing = hostSessions.get(hostId);
    if (existing) {
      if (!options.forceRefresh && existing.accessExpiresAt > Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
        return existing;
      }
      try {
        const refreshed = await auth.refresh(hostId);
        const next = {
          ...existing,
          accessToken: refreshed.access_token,
          accessExpiresAt: refreshed.expires_at,
        };
        hostSessions.set(hostId, next);
        return next;
      } catch {
        // Cookie/family lost: fall back to a new device-login.
      }
    }
    return deviceLogin(hostId);
  }

  async function connectHost(hostId: string): Promise<void> {
    if (closed) return;
    const epoch = bumpEpoch(hostId);
    if (connectInFlight) {
      await connectInFlight.catch(() => undefined);
      if (closed || epoch !== hostRuntime(hostId).epoch) return;
    }
    const run = connectHostUnlocked(hostId, epoch);
    connectInFlight = run;
    try {
      await run;
    } catch (error) {
      if (closed || epoch !== hostRuntime(hostId).epoch) return;
      if (state.currentHostId === hostId) update({ connectionFailed: true });
      if (devicePairingWasLost(error)) {
        await clearHostPairingMaterial(hostId);
        if (!closed && epoch === hostRuntime(hostId).epoch && state.currentHostId === hostId) {
          update({ connection: { kind: 'device_revoked', reason: pairingLossReason(error) } });
        }
      }
      if (relayHostId === hostId) retireHostSession(hostId, 'disconnected');
      else markDisconnectedPending(hostId);
      if (identityPinRejected(error)) {
        // A different Server identity is a decision for the user, not a
        // transient failure: stop here instead of "retrying automatically".
        serverPinVerifiedAt = 0;
        if (state.currentHostId === hostId) update({ connection: { kind: 'server_changed' } });
      } else if (!devicePairingWasLost(error)) {
        scheduleReconnect(hostId);
      }
      throw error;
    } finally {
      if (connectInFlight === run) connectInFlight = null;
    }
  }

  async function connectHostUnlocked(hostId: string, epoch: number): Promise<void> {
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    cancelReconnect();
    update({ connection: { kind: 'resyncing', synced: 0, total: 1 }, currentHostId: hostId,
      connectionPhase: 'auth', connectionFailed: false });
    if (Date.now() - serverPinVerifiedAt >= SERVER_PIN_RECHECK_MS) {
      await pinDiscoveredServer({ origin: options.publicOrigin, storageScope: options.storageScope, fetchFn: options.fetchFn });
      serverPinVerifiedAt = Date.now();
    }
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    const hostIdentity = await identity.hostIdentity(hostId);
    let session = await authenticateHost(hostId);
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    void refreshPairedHosts(() => !closed && epoch === hostRuntime(hostId).epoch && state.currentHostId === hostId);
    update({ connectionPhase: 'relay' });
    let ticket;
    try {
      ticket = await auth.wsTicket(session.accessToken, hostId);
    } catch (error) {
      if (errorCode(error) !== 'AUTH_REQUIRED') throw error;
      session = await authenticateHost(hostId, { forceRefresh: true });
      ticket = await auth.wsTicket(session.accessToken, hostId);
    }
    if (closed || epoch !== hostRuntime(hostId).epoch) return;
    if (relayHostId && relayHostId !== hostId) {
      retireHostSession(relayHostId, 'replaced');
    } else if (relay) {
      const stale = relay;
      clearRelayBinding();
      stale.close('replaced');
    }
    const boundEpoch = epoch;
    const boundHostId = hostId;
    const relayInput = {
      wsUrl,
      ticket: ticket.ticket,
      identity: hostIdentity,
      hostPublicKey: session.hostPublicKey,
      hostId,
      deviceId: session.deviceId,
      cryptoConnectionId: session.cryptoConnectionId,
      // The directory lists every conversation this device may open (not
      // only the Doing snapshot), adds search and chats outside a Task.
      hello: { sessionDirectoryV1: true },
      handlers: {
        onControl(message: { type?: string; [key: string]: unknown }) {
          return onControl(message, boundHostId, boundEpoch);
        },
        onNotice(notice: { type?: string }) {
          onNotice(notice, boundHostId, boundEpoch);
        },
        onClose(reason: string) {
          markDisconnectedPending(hostId);
          if (closed) return;
          // This tab clears its binding before closing a relay itself, so a
          // 'replaced' close on the still-bound relay came from the Server:
          // another tab or window of this browser connected as this device.
          // Reconnecting would take the connection back and start a tug of
          // war, so this tab waits until the user picks it again.
          if (reason === 'replaced' && relay === nextRelay && state.currentHostId === hostId) {
            clearRelayBinding();
            cancelReconnect();
            bumpEpoch(hostId);
            update({ connection: { kind: 'taken_over' } });
            return;
          }
          if (
            reason === 'replaced'
            || reason === 'closed'
            || reason === 'disconnected'
            || reason === 'logout'
            || reason === 'handshake_failed'
          ) {
            return;
          }
          if (state.currentHostId !== hostId) return;
          if (state.connection.kind === 'device_revoked' || reason === 'device_revoked') {
            if (reason === 'device_revoked') void clearHostPairingMaterial(hostId);
            if (state.connection.kind !== 'device_revoked') update({ connection: { kind: 'device_revoked', reason: 'revoked' } });
            return;
          }
          scheduleReconnect(hostId);
        },
      },
    };
    const nextRelay = options.createRelay ? options.createRelay(relayInput) : new DeviceRelayClient(relayInput);
    relay = nextRelay;
    relayHostId = hostId;
    relayEpoch = boundEpoch;
    try {
      await nextRelay.connect();
      if (closed || epoch !== hostRuntime(hostId).epoch) {
        if (relay === nextRelay) clearRelayBinding();
        nextRelay.close('replaced');
        return;
      }
      const runtime = hostRuntime(hostId);
      runtime.translationFeature = nextRelay.negotiatedCapabilities?.includes('wire.conversation_translation') === true;
      const directorySupported = nextRelay.negotiatedCapabilities?.includes('wire.session_directory_v1') === true;
      if (directoryState().hostId !== hostId) {
        // A Host reached without prepareHostView (a just-paired one): start
        // from an empty directory so nothing of the previous Host remains.
        for (const list of ['tasks', 'repos', 'search'] as const) directoryGenerations[list] += 1;
        update({ directory: { ...emptyDirectoryState(hostId), supported: directorySupported, view: directoryState().view } });
      } else if (directoryState().supported !== directorySupported) {
        patchDirectory({ supported: directorySupported });
      }
      // Previews that failed on the previous connection may load now.
      if (state.thumbnails && Object.values(state.thumbnails).some(item => item.status === 'error')) {
        update({ thumbnails: Object.fromEntries(Object.entries(state.thumbnails).filter(([, item]) => item.status !== 'error')) });
      }
      update({ connectionPhase: 'sync' });
      if (runtime.lastEventSequence >= 0 && runtime.snapshotRevision && runtime.hostGeneration) {
        await nextRelay.sendControl({
          type: 'resume.request',
          host_generation: runtime.hostGeneration,
          after_event_sequence: runtime.lastEventSequence,
          current_revision: runtime.snapshotRevision,
          ...(state.view.kind === 'chat' ? { subscribed_session_id: state.view.sessionId } : {}),
        }).catch(() => undefined);
      } else if (!refreshInFlight) {
        requestState();
      }
    } catch (error) {
      nextRelay.close('handshake_failed');
      if (relay === nextRelay) clearRelayBinding();
      throw error;
    }
    hostRuntime(hostId).reconnects = 0;
    update({ connection: { kind: 'online' } });
    await recoverPendingCommands(hostId);
  }

  async function claimAndWait(code: string | undefined, deviceName: string, grantNonce?: string): Promise<void> {
    const generation = ++pairingGeneration;
    const current = () => !closed && generation === pairingGeneration;
    update({ auth: { kind: 'pairing', pairing: { kind: 'waiting', deviceName, expiresAt: Date.now() + PAIRING_TTL_MS } } });
    let browserId: string;
    let claimed;
    try {
      await pinDiscoveredServer({ origin: options.publicOrigin, storageScope: options.storageScope, fetchFn: options.fetchFn });
      if (!current()) return;
      browserId = await identity.browserInstallationId();
      if (!current()) return;
      const pendingIdentity = await identity.createPending();
      if (!current()) return;
      claimed = await auth.claimPairing({
        browserInstallationId: browserId,
        devicePublicKey: pendingIdentity.publicJwk,
        platform,
        userAgent,
        code,
        grantNonce,
      });
    } catch (error) {
      if (current()) setPairingFailure(mapPairingFailure(error, state));
      return;
    }
    if (!current()) return;
    await identity.bindPending(claimed.host_id);
    if (!current()) return;
    update({
      auth: {
        kind: 'pairing',
        pairing: { kind: 'waiting', deviceName, expiresAt: Date.now() + PAIRING_TTL_MS },
      },
      currentHostId: claimed.host_id,
      drafts: hostDrafts.get(claimed.host_id) ?? {},
    });
    const started = Date.now();
    let pollDelayMs = PAIRING_POLL_INITIAL_MS;
    const poll = async (): Promise<void> => {
      if (!current()) return;
      if (Date.now() - started > PAIRING_TTL_MS) {
        setPairingFailure('expired');
        return;
      }
      try {
        await auth.challenge(browserId, claimed.host_id);
        if (!current()) return;
        await connectHost(claimed.host_id);
        if (!current()) return;
        hostSelection.set(claimed.host_id);
        pairingReturnHostId = null;
        update({ addingHost: false });
        await refreshPairedHosts(current);
        return;
      } catch (error) {
        if (!current()) return;
        const codeName = errorCode(error);
        if (codeName === 'DEVICE_REVOKED') {
          setPairingFailure('rejected');
          return;
        }
        if (codeName !== 'DEVICE_NOT_PAIRED' && codeName !== 'AUTH_REQUIRED') {
          setPairingFailure(mapPairingFailure(error, state));
          return;
        }
      }
      const delayMs = pollDelayMs;
      pollDelayMs = nextPairingPollDelay(pollDelayMs);
      pollTimer = setTimeout(() => {
        void poll();
      }, delayMs);
    };
    await poll();
  }

  async function restore(): Promise<void> {
    const generation = navigationGeneration;
    try {
      const me = await auth.me();
      const hosts = await mergeRememberedHosts(me.hosts ?? []);
      if (closed || generation !== navigationGeneration || state.addingHost) return;
      if (hosts.length === 0) {
        await restoreRememberedHosts();
        return;
      }
      const preferred = hostSelection.get();
      const selected = hosts.find(host => host.id === preferred) ?? (hosts.length === 1 ? hosts[0] : undefined);
      if (selected) {
        update({
          auth: { kind: 'challenge-login', hosts },
          hosts,
          currentHostId: selected.id,
        });
        await connectHost(selected.id);
        return;
      }
      hostSelection.set(null);
      update({ auth: { kind: 'challenge-login', hosts }, hosts });
    } catch {
      if (closed || generation !== navigationGeneration || state.addingHost) return;
      if (state.connection.kind === 'device_revoked') return;
      if (state.auth.kind === 'challenge-login' && state.currentHostId) return;
      await restoreRememberedHosts();
    }
  }

  function requestRestore(): void {
    if (closed || qrNonce || state.addingHost) return;
    if (restoreInFlight) {
      restoreAgain = true;
      return;
    }
    const run = restore().finally(() => {
      if (restoreInFlight === run) restoreInFlight = null;
      if (
        !restoreAgain
        || closed
        || state.auth.kind !== 'pairing'
        || state.auth.pairing.kind !== 'enter-code'
      ) return;
      restoreAgain = false;
      requestRestore();
    });
    restoreInFlight = run;
  }

  async function restoreRememberedHosts(): Promise<void> {
    const generation = navigationGeneration;
    const hostIds = await identity.listHostIds();
    if (closed || generation !== navigationGeneration || state.addingHost) return;
    if (hostIds.length === 0) return;
    // Authentication must not wait for encrypted snapshot-cache I/O. The
    // live snapshot supplies the canonical Host name and Session counts once
    // the device-key challenge succeeds.
    const hosts: RemoteHostEntry[] = hostIds.map(hostId => ({
      id: hostId,
      name: 'Gian Host',
      online: false,
      sessionCount: 0,
    }));
    const selected = hosts.find(host => host.id === hostSelection.get()) ?? (hosts.length === 1 ? hosts[0] : undefined);
    if (!selected) {
      update({ auth: { kind: 'challenge-login', hosts }, hosts });
      return;
    }
    const host = selected;
    update({
      auth: { kind: 'challenge-login', hosts },
      hosts,
      currentHostId: host.id,
      connection: { kind: 'resyncing', synced: 0, total: 1 },
    });
    await connectHost(host.id).catch(() => undefined);
  }

  /** Revoke this browser's pairing with one Host on the Server. */
  async function selfRevokeHost(hostId: string): Promise<void> {
    const creds = await authenticateHost(hostId);
    const hostIdentity = await identity.hostIdentity(hostId);
    const signedAt = Date.now();
    await auth.selfRevoke({
      hostId,
      signedAt,
      accessToken: creds.accessToken,
      signature: await signBytes(
        hostIdentity.privateKey,
        new TextEncoder().encode(selfRevokePayload({
          hostId,
          deviceId: creds.deviceId,
          signedAt,
        })),
      ),
    });
  }

  async function forgetHost(hostId: string, forgetOptions: { revoke: boolean }): Promise<void> {
    if (forgetOptions.revoke) {
      try {
        await selfRevokeHost(hostId);
      } catch (error) {
        // Without its key, or with the pairing already gone on the Server,
        // there is nothing left to revoke from here: remove the Host locally
        // instead of leaving it stuck in the list.
        if (!devicePairingWasLost(error)) {
          update({
            mutations: {
              ...state.mutations,
              [hostId]: {
                commandId: hostId,
                label: 'host.revoke',
                phase: 'failed',
                errorCode: errorCode(error),
                errorMessage: error instanceof Error ? error.message : 'self-revoke failed',
                startedAt: Date.now(),
              },
            },
          });
          return;
        }
      }
    }
    if (state.currentHostId === hostId) {
      cancelReconnect();
      retireHostSession(hostId, 'disconnected');
    }
    hostSessions.delete(hostId);
    hostDrafts.delete(hostId);
    await identity.clearHost(hostId);
    if (hostSelection.get() === hostId) hostSelection.set(null);
    await cache.clear(hostId);
    // Self-revoke / disconnect also wipes gated-send drafts (F2).
    await translationDraftStore.clearHost(hostId);
    const hosts = state.hosts.filter((host) => host.id !== hostId);
    const next = hosts[0];
    if (next) {
      update({ hosts });
      actions.selectHost(next.id);
    } else {
      update({
        hosts,
        currentHostId: null,
        auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
      });
    }
  }

  async function acceptAccount(result: Extract<AccountLoginResult, { status: 'authorized' }>): Promise<void> {
    const generation = accountGeneration;
    if (closed || generation !== accountGeneration) return;
    const previous = accountSession;
    // GitHub completion replaces only the account bearer. It does not drop
    // pairings, device keys, or the live Remote connection.
    accountSession = result;
    http.setAccountToken?.(result.account_token);
    await cache.put('__account__', result);
    if (previous && previous.account_token !== result.account_token) {
      void http.request('/api/v1/account/logout', { protocol: ACCOUNT_PROTOCOL }, previous.account_token).catch(() => undefined);
    }
    if (closed || generation !== accountGeneration) return;
    update({ account: { status: 'signed_in', login: result.account.login } });
  }

  const actions: RemoteUiActions = {
    startGitHubLogin() {
      const generation = ++accountGeneration;
      accountPending = null;
      update({ account: { status: 'pending' } });
      void (async () => {
        const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const started = parseClosed(accountLoginStartedSchema, await http.request('/api/v1/account/start', {
          protocol: ACCOUNT_PROTOCOL, peer: { role: 'controller', installation_id: generateCanonicalId(),
            public_key: await exportPublicJwk(keys.publicKey) },
        }));
        const signature = await signBytes(keys.privateKey,
          new TextEncoder().encode(remoteAccountChallengePayload(started.challenge)));
        if (closed || generation !== accountGeneration) return;
        accountPending = { started, signature };
        update({ account: { status: 'pending', userCode: started.user_code,
          expiresAt: started.expires_at, intervalSeconds: started.interval_seconds } });
      })().catch(() => {
        if (!closed && generation === accountGeneration) update({ account: { status: 'error' } });
      });
    },
    pollGitHubLogin() {
      if (!accountPending || accountPolling) return;
      const pendingLogin = accountPending;
      const generation = accountGeneration;
      accountPolling = true;
      void (async () => {
        const result = parseClosed(accountLoginResultSchema, await http.request('/api/v1/account/poll', {
          protocol: ACCOUNT_PROTOCOL, login_id: pendingLogin.started.login_id, signature: pendingLogin.signature,
        }));
        if (closed || generation !== accountGeneration) return;
        if (result.status === 'authorized') {
          accountPending = null;
          await acceptAccount(result);
        } else if (result.status === 'pending') {
          update({ account: { ...state.account!, intervalSeconds: result.interval_seconds } });
        } else {
          accountPending = null;
          update({ account: { status: 'error' } });
        }
      })().catch(() => {
        if (!closed && generation === accountGeneration) update({ account: { status: 'error' } });
      }).finally(() => { accountPolling = false; });
    },
    restoreBrowserSession() {
      requestRestore();
    },

    startPairing() {
      ++navigationGeneration;
      ++pairingGeneration;
      cancelReconnect();
      if (pollTimer) clearTimeout(pollTimer);
      dismissPairingLink();
      pairingReturnHostId = state.currentHostId;
      if (state.currentHostId) hostDrafts.set(state.currentHostId, state.drafts);
      if (state.currentHostId) retireHostSession(state.currentHostId, 'replaced');
      update({ addingHost: true, currentHostId: null, connection: { kind: 'browser_offline' },
        auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } });
    },

    selectHost(hostId) {
      if (!state.hosts.some(host => host.id === hostId)) return;
      if (hostId === state.currentHostId) return;
      ++navigationGeneration;
      hostSelection.set(hostId);
      cancelReconnect();
      if (state.currentHostId) retireHostSession(state.currentHostId, 'replaced');
      bumpEpoch(hostId);
      prepareHostView(hostId);
      void connectHost(hostId).catch(() => undefined);
    },
    selectSession(sessionId) {
      const known = state.sessions.some((session) => session.id === sessionId);
      const listed = directoryState().supported && Object.values(directoryState().lists)
        .some(list => list.entries.some(entry => entry.id === sessionId));
      if (!known && !listed) return;
      update({ view: { kind: 'chat', sessionId }, mobilePage: 'chat', fileViewer: null,
        ...(known ? {} : { directory: { ...directoryState(), opening: sessionId } }) });
      // A directory chat outside the snapshot arrives with session.subscribe;
      // its history loads once the session (and its agent) is known.
      if (known) hydrateSessionDetached(sessionId);
      else subscribeSession(sessionId);
    },
    openNewChat(presetTaskId) {
      update({ view: { kind: 'new-chat', presetTaskId }, mobilePage: 'new-chat' });
      requestCatalog();
    },
    openSettings() {
      update({ view: { kind: 'settings' }, mobilePage: 'settings' });
    },
    openMobilePage(page) {
      update({ mobilePage: page });
    },
    backToChat() {
      const view = state.view.kind === 'chat'
        ? state.view
        : state.sessions[0]
          ? { kind: 'chat' as const, sessionId: state.sessions[0].id }
          : { kind: 'empty' as const };
      update({ view, mobilePage: 'chat', fileViewer: null });
    },
    refreshCatalog() {
      requestCatalog();
    },
    setDirectoryView(view) {
      if (directoryState().view === view && !directoryState().query) return;
      patchDirectory({ view, query: '' });
      if (directoryState().lists[view].status === 'idle' || directoryState().lists[view].status === 'error') {
        void loadDirectoryList(view, true);
      }
    },
    setDirectoryQuery(query) {
      patchDirectory({ query });
      if (directorySearchTimer) clearTimeout(directorySearchTimer);
      directorySearchTimer = null;
      if (!query.trim()) {
        ++directoryGenerations.search;
        patchDirectoryList('search', emptyDirectoryList());
        return;
      }
      patchDirectoryList('search', { status: 'loading' });
      directorySearchTimer = setTimeout(() => {
        directorySearchTimer = null;
        void loadDirectoryList('search', true);
      }, DIRECTORY_SEARCH_DEBOUNCE_MS);
    },
    loadMoreDirectory(list) {
      void loadDirectoryList(list, false);
    },
    refreshDirectory() {
      loadVisibleDirectory(true);
    },
    createSession(input: CreateSessionInput) {
      if (!input.taskId && !directoryState().supported) return;
      dispatchCommand('session.create', {
        catalog_revision: state.catalogRevision,
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        ...(input.taskId ? { task_id: input.taskId } : {}),
        name: input.name,
        model: input.model,
        thinking: input.thinking,
        service_tier: input.serviceTier,
      }, 'session.create');
    },
    setDraftText(sessionId, text) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, text } } });
      // The composer just became idle-empty: a kept-aside gated draft gets
      // its restore chance now (confirmed before consuming, never
      // overwriting) — no full-page refresh required (R2-3/F5).
      if (!text.trim() && draftIsEmpty(state.drafts[sessionId] ?? emptyDraft())) {
        restoreGatedDraft(sessionId);
      }
    },
    addDraftAttachment(sessionId, attachment) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: { ...draft, attachments: [...draft.attachments, attachment] },
        },
      });
    },
    uploadDraftAttachment(sessionId, file) {
      const uploadId = generateCanonicalId();
      const entry: DraftUpload = { id: uploadId, name: file.name, size: file.size, status: 'uploading' };
      const failUpload = (code: string) => setUploads(sessionId, (state.uploads?.[sessionId] ?? [])
        .map(item => (item.id === uploadId ? { ...item, status: 'failed' as const, error: code } : item)));
      setUploads(sessionId, [...(state.uploads?.[sessionId] ?? []), entry]);
      if (file.size > MAX_ATTACHMENT_BYTES || file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        failUpload('FILE_TOO_LARGE');
        return;
      }
      const started = transferRelay();
      if (!started) {
        failUpload('HOST_OFFLINE');
        return;
      }
      const sendOnBound = (
        send: (message: Record<string, unknown>) => Promise<void>,
      ) => (message: Record<string, unknown>) => {
        const current = transferRelay();
        if (
          !current
          || current.relay !== started.relay
          || current.hostId !== started.hostId
          || current.epoch !== started.epoch
        ) {
          return Promise.reject(new RemoteProtocolError('UNKNOWN_OUTCOME', 'host changed before upload finished'));
        }
        return send(message);
      };
      void uploadRemoteAttachment({
        sessionId,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
        sendControl: sendOnBound((message) => started.relay.sendControl(message)),
        sendContent: sendOnBound((message) => started.relay.sendContent(message)),
        registerWaiters: (transferId) => {
          const acks = uploadAcks.get(transferId) ?? new TransferAckGate();
          uploadAcks.set(transferId, acks);
          const result = new Promise<AttachmentUploadResult>((resolve, reject) => {
            uploadWaiters.set(transferId, { hostId: started.hostId, resolve, reject });
          });
          return {
            result,
            acks,
            cleanup: () => {
              rejectTransfer(
                transferId,
                new RemoteProtocolError('UNKNOWN_OUTCOME', 'upload aborted'),
              );
            },
          };
        },
      }).then((attachment) => {
        const cancelled = !(state.uploads?.[sessionId] ?? []).some(item => item.id === uploadId);
        setUploads(sessionId, (state.uploads?.[sessionId] ?? []).filter(item => item.id !== uploadId));
        if (!cancelled) actions.addDraftAttachment(sessionId, attachment);
      }).catch((error) => {
        // A cancelled chip stays gone; the failure is still recorded.
        if ((state.uploads?.[sessionId] ?? []).some(item => item.id === uploadId)) failUpload(errorCode(error));
        update({
          queueNotice: null,
          mutations: {
            ...state.mutations,
            [sessionId]: {
              commandId: sessionId,
              label: 'attachment.upload',
              phase: 'failed',
              errorCode: errorCode(error),
              errorMessage: error instanceof Error ? error.message : 'upload failed',
              startedAt: Date.now(),
            },
          },
        });
      });
    },
    dismissUpload(sessionId, uploadId) {
      // Also cancels one still uploading: it then never joins the draft, and
      // Send no longer waits for it.
      setUploads(sessionId, (state.uploads?.[sessionId] ?? []).filter(item => item.id !== uploadId));
    },
    requestThumbnail(sessionId, attachment) {
      const hostId = state.currentHostId;
      if (!hostId) return;
      const key = thumbnailKey(sessionId, attachment.url);
      // A failed preview stays failed until the next connection clears it,
      // so a broken file is never fetched in a loop.
      if (state.thumbnails?.[key]) return;
      if (!attachment.mime?.startsWith('image/') || (attachment.size ?? 0) > MAX_FILE_PREVIEW_BYTES) {
        setThumbnail(key, { status: 'skipped' });
        return;
      }
      setThumbnail(key, { status: 'loading' });
      thumbnailQueue.push({ key, hostId, sessionId, reference: attachment.url, name: attachment.name });
      pumpThumbnails();
    },
    addDraftContextItem(sessionId, item) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: { ...draft, contextItems: [...draft.contextItems, item] },
        },
      });
    },
    setDraftDocument(sessionId, doc) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({ drafts: { ...state.drafts, [sessionId]: { ...draft, document: doc } } });
    },
    removeDraftAttachment(sessionId, attachmentId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: {
            ...draft,
            attachments: draft.attachments.filter((item) => item.id !== attachmentId),
          },
        },
      });
    },
    removeDraftContextItem(sessionId, itemId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      update({
        drafts: {
          ...state.drafts,
          [sessionId]: {
            ...draft,
            contextItems: draft.contextItems.filter((item) => item.id !== itemId),
          },
        },
      });
    },
    sendDraft(sessionId) {
      const draft = state.drafts[sessionId] ?? emptyDraft();
      if (draftIsEmpty(draft)) return;
      // Never send while a file the user attached is still on its way.
      if (state.uploads?.[sessionId]?.some(upload => upload.status === 'uploading')) return;
      const session = state.sessions.find((item) => item.id === sessionId);
      const ui = state.translations[sessionId];
      // Automatic translated sending gates ONLY a text-bearing send on an
      // idle session. A busy session queues plainly and the Host's drain
      // applies the then-current switch — no client pre-translation, so no
      // receipt can go stale or double-translate.
      if (ui?.supported && ui.enabled && draft.text.trim() && !session?.active_turn) {
        if (ui.send) return;
        if (!ui.configured) {
          update({ translations: applyTranslationNote(state.translations, sessionId, 'translation.configureFirst') });
          return;
        }
        sendDraftGated(sessionId, draft);
        return;
      }
      // One send per session at a time: the draft stays in the composer
      // until the Host confirms it, so a second Enter in that window would
      // otherwise send the same message again under a new command id.
      if (sendingSessions.has(sessionId)) return;
      sendingSessions.add(sessionId);
      void sendCommand('session.send', sessionSendParams(sessionId, draft, session), 'session.send')
        .then(() => {
          if (state.drafts[sessionId] !== draft) return;
          update({ drafts: { ...state.drafts, [sessionId]: emptyDraft() } });
          // A successful plain send frees the composer: a kept-aside gated
          // draft restores now (confirmed, never overwriting) — R2-3/F5.
          restoreGatedDraft(sessionId);
        })
        .catch(() => undefined)
        .finally(() => sendingSessions.delete(sessionId));
    },
    setAutoTranslation(sessionId, enabled) {
      const ui = state.translations[sessionId];
      if (!ui?.supported || !mutationsEnabled(state.connection)) return;
      if (enabled && !ui.configured) {
        update({ translations: applyTranslationNote(state.translations, sessionId, 'translation.configureFirst') });
        return;
      }
      // Explicit value + optimistic preconditions (value AND revision); the
      // Host-confirmed state (result/event) is the only thing that flips the
      // UI, and its revision guard rejects stale application (F6).
      void sendCommand('translation.set_auto', {
        session_id: sessionId,
        enabled,
        expected_enabled: ui.enabled,
        expected_revision: ui.revision,
      }, 'translation.set_auto')
        .then((data) => {
          const confirmed = parseClosed(remoteTranslationStateSchema, data);
          update({ translations: applyTranslationState(state.translations, sessionId, confirmed) });
        })
        .catch((error) => {
          update({
            translations: applyTranslationNote(
              state.translations,
              sessionId,
              error instanceof Error ? error.message : 'translation.failed',
            ),
          });
        });
    },
    toggleReadTranslation(sessionId, sourceId, text) {
      const ui = translationUiFor(state.translations, sessionId);
      if (!ui.supported) return;
      const expanded = !(ui.expandOverrides[sourceId] ?? ui.enabled);
      update({
        translations: {
          ...state.translations,
          [sessionId]: { ...ui, expandOverrides: { ...ui.expandOverrides, [sourceId]: expanded } },
        },
      });
      if (!expanded) return;
      const current = readingValue(translationUiFor(state.translations, sessionId), sourceId);
      if (current.pending || current.record || current.error) return;
      startReadRequest(sessionId, sourceId, text);
    },
    retryReadTranslation(sessionId, sourceId, text) {
      const ui = translationUiFor(state.translations, sessionId);
      if (!ui.supported || ui.reading[sourceId]?.pending) return;
      startReadRequest(sessionId, sourceId, text);
    },
    retryTranslationText(sessionId, recordId) {
      const ui = translationUiFor(state.translations, sessionId);
      if (!ui.supported) return;
      // The expected hash comes from the read record or the sent-translation
      // descriptor on the user bubble — whichever carries this record id.
      const record = Object.values(ui.results).flat().find(entry => entry.id === recordId);
      const sentItem = state.transcripts[sessionId]?.items.find(
        item => item.kind === 'user' && item.translation?.id === recordId,
      );
      const expectedSha256 = record?.textSha256
        ?? (sentItem?.kind === 'user' ? sentItem.translation?.textSha256 : undefined);
      if (!expectedSha256) return;
      update({ translations: clearTranslationFullTextError(state.translations, sessionId, recordId) });
      void fetchFullTranslationText(sessionId, recordId, expectedSha256);
    },
    retryTranslationSend(sessionId) {
      const gate = state.translations[sessionId]?.send;
      // Only a failed gate retries; a dispatching/unknown send belongs to its
      // fixed command identity (command.status), never a second send (F1).
      if (!gate || gate.phase !== 'failed') return;
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session?.active_turn) {
        // Busy: queue plainly with no intent — drain-time translation under
        // the then-current switch IS the retry.
        dispatchGatedDraft(sessionId, gate.requestId, gate.draft, false);
        return;
      }
      const requestId = generateCanonicalId();
      const draft = gate.draft;
      markTranslationEcho(sessionId, gate.submissionId, false);
      gateSet(sessionId, { phase: 'translating', submissionId: gate.submissionId, requestId, draft });
      startSendRequest(sessionId, requestId, draft);
    },
    sendOriginalTranslation(sessionId) {
      const gate = state.translations[sessionId]?.send;
      // Available only before the real dispatch: after submission the fixed
      // command identity owns the outcome and no alternative send is allowed.
      if (!gate || (gate.phase !== 'translating' && gate.phase !== 'failed')) return;
      cancelSendRequest(sessionId, gate.requestId);
      dispatchGatedDraft(sessionId, gate.requestId, gate.draft, true);
    },
    reclaimTranslationSend(sessionId) {
      const gate = state.translations[sessionId]?.send;
      // Only pre-dispatch phases may reclaim. dispatching waits for the ACK;
      // unknown keeps the fixed dispatch identity and finishes command.status
      // reconciliation first — there is no identity-dropping take-back that
      // could turn a possibly-sent text into a resendable draft (F1).
      if (!gate || (gate.phase !== 'translating' && gate.phase !== 'failed')) return;
      cancelSendRequest(sessionId, gate.requestId);
      const hostId = state.currentHostId;
      removeTranslationEcho(sessionId, gate.submissionId);
      const occupied = !draftIsEmpty(state.drafts[sessionId] ?? emptyDraft());
      if (!occupied) {
        // Restore the gated text and consume the durable backup.
        update({ drafts: { ...state.drafts, [sessionId]: gate.draft } });
        if (hostId) dropGatedDraft(hostId, sessionId, gate.submissionId);
      } else if (hostId) {
        // Conflict resolution (F5): never overwrite text typed after the
        // gate started — the gated draft stays in the encrypted backup and
        // restores when the composer is empty again.
        persistGatedDraft(hostId, sessionId, {
          phase: 'translating',
          submissionId: gate.submissionId,
          requestId: gate.requestId,
          draft: gate.draft,
        });
        update({
          translations: applyTranslationNote(state.translations, sessionId, 'translation.reclaimKeptAside'),
        });
      }
      gateSet(sessionId, null);
    },
    stopSession(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('session.stop', {
        session_id: sessionId,
        session_revision: session.revision,
      }, 'session.stop');
    },
    updateSessionConfig(sessionId, config) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('session.update', {
        session_id: sessionId,
        session_revision: session.revision,
        ...config,
      }, 'session.update');
    },
    retryTranscript(sessionId) {
      hydrateSessionDetached(sessionId, 'initial', true);
    },
    loadOlderTranscript(sessionId) {
      const transcript = state.transcripts[sessionId];
      if (!transcript?.hasOlder || !transcript.cursor || transcript.loadingOlder) return;
      hydrateSessionDetached(sessionId, 'older');
    },
    editQueueEntry(sessionId, queueId, text) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.update', {
        session_id: sessionId,
        queue_id: queueId,
        text,
        expected_queue_revision: session.queue.revision,
      }, 'queue.update');
    },
    removeQueueEntry(sessionId, queueId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.remove', {
        session_id: sessionId,
        queue_id: queueId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.remove');
    },
    clearQueue(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.clear', {
        session_id: sessionId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.clear');
    },
    sendQueueNow(sessionId) {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      dispatchCommand('queue.send_now', {
        session_id: sessionId,
        expected_queue_revision: session.queue.revision,
      }, 'queue.send_now');
    },
    respondToInteraction(interactionId, actionId, values) {
      const interaction = state.interactions.find((item) => item.id === interactionId);
      if (!interaction) return;
      // A card already being responded to never fires a second mutation.
      if ((state.interactionPhases[interactionId] ?? 'pending') !== 'pending') return;
      update({
        interactionPhases: { ...state.interactionPhases, [interactionId]: 'responding' },
        interactionErrors: omitKey(state.interactionErrors, interactionId),
      });
      // Unlike fire-and-forget mutations, a failed respond must surface on
      // the card: swallowing it left the UI looking like the click did
      // nothing (dispatchCommand catches into the void).
      void sendCommand('interaction.respond', {
        interaction_id: interactionId,
        interaction_revision: interaction.revision,
        action_id: actionId,
        values,
      }, 'interaction.respond').catch((error: unknown) => {
        update({
          interactionPhases: { ...state.interactionPhases, [interactionId]: 'pending' },
          interactionErrors: {
            ...state.interactionErrors,
            [interactionId]: error instanceof Error ? error.message : 'interaction.respond failed',
          },
        });
      });
    },
    openFile(handle) {
      const generation = ++fileGeneration;
      update({ fileViewer: { status: 'loading', handle } });
      const hostId = state.currentHostId;
      void (async () => {
        let selected = handle;
        {
          const resolved = parseClosed(remoteFileRefSchema, await withTimeout(sendCommand('file.resolve', {
            session_id: handle.sessionId, reference: handle.id,
          }, 'file.resolve', { recoverOnDisconnect: false }), readTimeoutMs, 'file reference timed out'));
          if (generation !== fileGeneration || state.currentHostId !== hostId || state.fileViewer?.handle !== handle) return;
          selected = { ...handle, id: resolved.id, label: resolved.name };
          update({ fileViewer: { status: 'loading', handle: selected } });
        }
        await withTimeout(sendCommand('file.preview', { handle_id: selected.id }, 'file.preview',
          { recoverOnDisconnect: false }), readTimeoutMs, 'file preview timed out');
      })().catch(error => {
        if (generation === fileGeneration && state.currentHostId === hostId && state.fileViewer?.status === 'loading') {
          update({ fileViewer: viewerFromPreviewError(state.fileViewer.handle, errorCode(error)) });
        }
      });
    },
    closeFile() {
      ++fileGeneration;
      update({ fileViewer: null, fileDownload: { status: 'idle' } });
    },
    reloadFile() {
      if (state.fileViewer) actions.openFile(state.fileViewer.handle);
    },
    downloadFile() {
      const viewer = state.fileViewer;
      const transport = transferRelay();
      if (!viewer || !transport) return;
      const transferId = generateCanonicalId();
      downloads.set(transferId, startDownload({
        hostId: transport.hostId,
        purpose: 'save',
        handle: viewer.handle,
        name: viewer.handle.label,
        mime: 'application/octet-stream',
      }));
      update({ fileDownload: { status: 'downloading', pct: 0 } });
      void transport.relay.sendControl({
        type: 'download.request',
        transfer_id: transferId,
        kind: 'file',
        handle_id: viewer.handle.id,
      }).catch((error) => {
        downloads.delete(transferId);
        update({
          fileDownload: {
            status: 'error',
            message: error instanceof Error ? error.message : 'download failed',
          },
        });
      });
    },
    refreshState() {
      refreshStateFromUi();
    },
    dismissUnknown(commandId) {
      if (state.unknownCommandId === commandId) update({ unknownCommandId: null });
    },
    setTheme(theme) {
      update({ settings: { ...state.settings, theme } });
    },
    setAccent(accent) {
      update({ settings: { ...state.settings, accent } });
    },
    disconnectHost(hostId) {
      void forgetHost(hostId, { revoke: true });
    },
    logoutBrowser() {
      void (async () => {
        ++accountGeneration;
        ++navigationGeneration;
        ++pairingGeneration;
        ++fileGeneration;
        cancelReconnect();
        if (pollTimer) clearTimeout(pollTimer);
        if (state.currentHostId) retireHostSession(state.currentHostId, 'disconnected');
        update({ signingOut: true });
        // Signing out deletes this browser's keys, so its pairings could
        // never be used or revoked again: revoke each one first, so no
        // orphaned pairing keeps counting against the computer's devices.
        for (const hostId of await identity.listHostIds().catch(() => [] as string[])) {
          await selfRevokeHost(hostId).catch(() => undefined);
        }
        accountPending = null;
        if (accountSession) await http.request('/api/v1/account/logout', { protocol: ACCOUNT_PROTOCOL }, accountSession.account_token).catch(() => undefined);
        accountSession = null;
        http.setAccountToken?.(null);
        cancelReconnect();
        if (state.currentHostId) bumpEpoch(state.currentHostId);
        try {
          await auth.logout().catch(() => undefined);
          // Each store is cleared even when another fails.
          await cache.clear().catch(() => undefined);
          await translationDraftStore.clearAll().catch(() => undefined);
          await identity.clearAll().catch(() => undefined);
        } finally {
          clearServerIdentityPin(options.storageScope);
          serverPinVerifiedAt = 0;
          hostSelection.set(null);
          hostSessions.clear();
          hostDrafts.clear();
          hostRuntimes.clear();
          cancelDirectoryTimers();
          stateRefresh = null;
          thumbnailQueue.length = 0;
          sendingSessions.clear();
          abortAllDownloads();
          relay?.close('logout');
          clearRelayBinding();
          // Nothing from the signed-out pairings stays on screen: a shared
          // computer must not keep showing earlier conversations.
          state = { ...emptyUiState(), settings: state.settings, account: { status: 'signed_out' } };
          emit();
        }
      })();
    },
    trustServerIdentity() {
      if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'failed'
        && state.auth.pairing.reason === 'server-changed') {
        clearServerIdentityPin(options.storageScope);
        serverPinVerifiedAt = 0;
        actions.restartPairing();
        return;
      }
      const hostId = state.currentHostId;
      if (state.connection.kind !== 'server_changed') return;
      clearServerIdentityPin(options.storageScope);
      serverPinVerifiedAt = 0;
      if (!hostId) {
        update({ connection: { kind: 'browser_offline' } });
        return;
      }
      update({ connection: { kind: 'resyncing', synced: 0, total: 1 } });
      void connectHost(hostId).catch(() => undefined);
    },
    submitPairingCode(code) {
      if (state.auth.kind !== 'pairing' || state.auth.pairing.kind !== 'enter-code') return;
      let formatted: string;
      try {
        formatted = formatPairingCode(code);
      } catch {
        const attemptsLeft = state.auth.pairing.attemptsLeft - 1;
        setPairingFailure(attemptsLeft <= 0 ? 'attempt-limit' : 'invalid');
        return;
      }
      void claimAndWait(formatted, 'This browser');
    },
    setPairingDeviceName(name) {
      if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        update({ auth: { kind: 'pairing', pairing: { ...state.auth.pairing, deviceName: name } } });
      }
    },
    confirmQrPairing() {
      if (qrNonce && state.auth.kind === 'pairing' && state.auth.pairing.kind === 'qr-confirm') {
        const nonce = qrNonce;
        dismissPairingLink();
        void claimAndWait(undefined, state.auth.pairing.deviceName, nonce);
      }
    },
    cancelPairing() {
      dismissPairingLink();
      ++pairingGeneration;
      if (state.currentHostId) bumpEpoch(state.currentHostId);
      if (pollTimer) clearTimeout(pollTimer);
      if (state.addingHost) {
        cancelReconnect();
        if (state.currentHostId) retireHostSession(state.currentHostId, 'replaced');
        const hosts = state.hosts;
        const previous = pairingReturnHostId;
        pairingReturnHostId = null;
        update({ addingHost: false, currentHostId: null, mobilePage: 'chat', snapshotReceivedAt: null,
          auth: hosts.length ? { kind: 'challenge-login', hosts }
            : { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } });
        if (previous && hosts.some(host => host.id === previous)) actions.selectHost(previous);
        return;
      }
      setPairingFailure('cancelled');
    },
    restartPairing() {
      dismissPairingLink();
      if (state.addingHost) {
        ++pairingGeneration;
        cancelReconnect();
        if (pollTimer) clearTimeout(pollTimer);
        if (state.currentHostId) retireHostSession(state.currentHostId, 'replaced');
        update({ currentHostId: null, connection: { kind: 'browser_offline' },
          auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } });
        return;
      }
      const generation = ++pairingGeneration;
      const hostId = state.currentHostId;
      cancelReconnect();
      if (hostId) {
        bumpEpoch(hostId);
        retireHostSession(hostId, 'disconnected');
      }
      void (async () => {
        if (hostId) await clearHostPairingMaterial(hostId);
        if (closed || generation !== pairingGeneration) return;
        update({
          auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } },
          connection: { kind: 'browser_offline' },
          currentHostId: null,
          hosts: hostId ? state.hosts.filter((host) => host.id !== hostId) : state.hosts,
        });
      })();
    },
    challengeLogin(hostId) {
      ++navigationGeneration;
      hostSelection.set(hostId);
      if (state.currentHostId && state.currentHostId !== hostId) {
        retireHostSession(state.currentHostId, 'replaced');
      }
      prepareHostView(hostId);
      void connectHost(hostId).catch(() => undefined);
    },
  };

  if (options.autoRestore !== false) requestRestore();
  browserEvents?.addEventListener('offline', handleBrowserOffline);
  browserEvents?.addEventListener('online', handleBrowserOnline);

  return {
    get state() {
      return state;
    },
    actions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      cancelDirectoryTimers();
      for (const timer of logoRetryTimers) clearTimeout(timer);
      logoRetryTimers.clear();
      browserEvents?.removeEventListener('offline', handleBrowserOffline);
      browserEvents?.removeEventListener('online', handleBrowserOnline);
      ++pairingGeneration;
      cancelReconnect();
      for (const entry of snapshotAssemblies.values()) clearTimeout(entry.timer);
      snapshotAssemblies.clear();
      if (state.currentHostId) bumpEpoch(state.currentHostId);
      if (pollTimer) clearTimeout(pollTimer);
      abortAllDownloads();
      relay?.close('closed');
      clearRelayBinding();
    },
  };
}

function emptyUiState(): RemoteUiState {
  return {
    directory: emptyDirectoryState(),
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

function relayWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  url.search = '';
  return url.toString();
}

function detectPlatform(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  if (/mac/i.test(platform)) return 'macOS';
  if (/win/i.test(platform)) return 'Windows';
  if (/linux/i.test(platform)) return 'Linux';
  return 'Web';
}

function detectUserAgent(): string {
  return typeof navigator === 'undefined' ? 'GianRemote/1' : navigator.userAgent.slice(0, 256);
}

function errorCode(error: unknown): string {
  if (error instanceof RemoteProtocolError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'AUTH_REQUIRED';
}

/** Pages can repeat a row after a concurrent change; the later copy wins. */
function mergeDirectoryEntries(current: RemoteDirectoryEntry[], page: RemoteDirectoryEntry[]): RemoteDirectoryEntry[] {
  const byId = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of page) byId.set(entry.id, entry);
  return [...byId.values()];
}

function pairingLossReason(error: unknown): 'revoked' | 'key_missing' | 'host_key_changed' {
  if (error instanceof MissingHostKeyError) return 'key_missing';
  if (error instanceof HostKeyChangedError) return 'host_key_changed';
  return 'revoked';
}

function devicePairingWasLost(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'DEVICE_NOT_PAIRED' || code === 'DEVICE_REVOKED';
}

function omitKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function isReplaySafeRead(
  method: RemoteMethod,
): method is 'catalog.read' | 'state.refresh' | 'session.subscribe' | 'session.page' | 'proxy.logo' {
  return method === 'proxy.logo' || method === 'catalog.read'
    || method === 'state.refresh'
    || method === 'session.subscribe'
    || method === 'session.page';
}

function showsUnknownOutcome(method: RemoteMethod): boolean {
  return method === 'session.create'
    || method === 'session.update'
    || method === 'session.send'
    || method === 'session.stop'
    || method === 'queue.update'
    || method === 'queue.remove'
    || method === 'queue.clear'
    || method === 'queue.send_now'
    || method === 'interaction.respond'
    || method === 'translation.set_auto';
}

function connectionAfterFailure(error: unknown): RemoteUiState['connection'] {
  if (identityPinRejected(error)) return { kind: 'server_changed' };
  return devicePairingWasLost(error)
    ? { kind: 'device_revoked', reason: pairingLossReason(error) }
    : { kind: 'host_offline', lastSeenAt: Date.now() };
}

function saveBrowserFile(name: string, mime: string, bytes: Uint8Array): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([bytes.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  // Firefox needs the link in the document; Safari and Firefox read the
  // blob after click() returns, so an immediate revoke can cancel the save.
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function mapPairingFailure(error: unknown, current: RemoteUiState): PairingFailure {
  if (identityPinRejected(error)) return 'server-changed';
  const code = errorCode(error);
  if (code === 'HOST_OFFLINE') return 'host-offline';
  if (code === 'DEVICE_REVOKED') return 'rejected';
  if (code === 'RATE_LIMITED') return 'attempt-limit';
  if (current.auth.kind === 'pairing' && current.auth.pairing.kind === 'enter-code' && current.auth.pairing.attemptsLeft <= 1) {
    return 'attempt-limit';
  }
  return 'invalid';
}

export function resolveRemoteWebBoot(search: string): 'production' | { fixture: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fixture = params.get('fixture');
  return fixture ? { fixture } : 'production';
}

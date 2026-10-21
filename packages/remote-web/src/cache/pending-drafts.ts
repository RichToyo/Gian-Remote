/**
 * Host-scoped encrypted persistence for translation-gated pending drafts
 * (Issue #181). Remote's local-data contract prohibits plaintext business
 * content in localStorage; a gated send's original text is exactly that, so
 * it lives in the same AES-GCM + IndexedDB discipline as the snapshot cache.
 * Removal is tied to dispatch success, reclaim, logout and device
 * revocation — nothing survives them on disk.
 *
 * Ordering contract: every mutation runs on a per-Host serial chain behind a
 * generation fence, so a put that started before a remove/clear can never
 * land after it (no resurrected drafts), and concurrent first writes for one
 * Host share ONE key-generation flight (no undecryptable blobs). The payload
 * records the gate phase and the fixed dispatch command identity, so a
 * refresh after the real send (before its ACK) does not restore already-sent
 * text as an unsent draft — the restored path confirms the command's
 * terminal state first.
 */

import { asBufferSource, base64UrlToBytes, bytesToBase64Url } from '@gian/remote-protocol';
import type { DraftState } from '../controller/types.js';

export interface PendingDraftPayload {
  draft: DraftState;
  at: number;
  /** Gate phase at write time. 'translating' means the real send never
   *  happened; dispatching/unknown carry the fixed send command identity
   *  whose terminal state must be confirmed before any restore. */
  phase: 'translating' | 'dispatching' | 'unknown';
  sendCommandId?: string;
  deliveryId?: string;
}

export interface PendingDraftEntry {
  submissionId: string;
  payload: PendingDraftPayload;
}

/** Entries are keyed per Host + session + submission, so an older
 *  kept-aside draft and a newer in-flight gate never overwrite each other;
 *  restore consumes them oldest-first after terminal-state confirmation. */
export interface PendingDraftStore {
  put(hostId: string, sessionId: string, submissionId: string, payload: PendingDraftPayload): Promise<void>;
  get(hostId: string, sessionId: string, submissionId: string): Promise<PendingDraftPayload | null>;
  /** All entries for one session, oldest first. */
  list(hostId: string, sessionId: string): Promise<PendingDraftEntry[]>;
  remove(hostId: string, sessionId: string, submissionId: string): Promise<void>;
  clearHost(hostId: string): Promise<void>;
  clearAll(): Promise<void>;
}

interface SealedBlob {
  iv: string;
  ciphertext: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, value: unknown): Promise<SealedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(value)),
  ));
  return { iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) };
}

async function open<T>(key: CryptoKey, blob: SealedBlob): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(base64UrlToBytes(blob.iv)) },
    key,
    asBufferSource(base64UrlToBytes(blob.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

/** Shared core: in-memory blobs + serial fenced mutations; persistence
 *  hooks are no-ops for the memory-only store. */
class PendingDraftStoreCore implements PendingDraftStore {
  protected readonly keys = new Map<string, Promise<CryptoKey>>();
  protected readonly blobs = new Map<string, SealedBlob>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly hostEpochs = new Map<string, number>();
  private globalEpoch = 0;

  /** Persistence hooks (memory store: no-op). */
  protected persistBlob(_hostId: string, _sessionId: string, _submissionId: string, _blob: SealedBlob): Promise<void> {
    return Promise.resolve();
  }
  protected persistKey(_hostId: string, _key: CryptoKey): Promise<void> {
    return Promise.resolve();
  }
  protected deleteBlob(_hostId: string, _sessionId: string, _submissionId: string): Promise<void> {
    return Promise.resolve();
  }
  protected dropHostData(_hostId: string): Promise<void> {
    return Promise.resolve();
  }
  protected dropAllData(): Promise<void> {
    return Promise.resolve();
  }

  /** Memoized key flight: concurrent first writes share ONE generation. */
  protected keyFor(hostId: string): Promise<CryptoKey> {
    const existing = this.keys.get(hostId);
    if (existing) return existing;
    const flight = this.loadKey(hostId)
      .then(stored => stored ?? generateKey())
      .then(async key => {
        this.keys.set(hostId, Promise.resolve(key));
        await this.persistKey(hostId, key);
        return key;
      });
    this.keys.set(hostId, flight);
    return flight;
  }

  /** Override to load a persisted Host key (memory: none). */
  protected loadKey(_hostId: string): Promise<CryptoKey | null> {
    return Promise.resolve(null);
  }

  private fence(hostId: string): string {
    return `${this.globalEpoch}:${this.hostEpochs.get(hostId) ?? 0}`;
  }

  /** Serialize one mutation on the Host chain. The fence is checked at entry
   *  AND again right before the commit, so a write that is already in flight
   *  (blocked in seal/keyFor) when a clear starts never lands afterwards. */
  private runFenced<T>(hostId: string, fence: string, run: () => Promise<T>): Promise<T | undefined> {
    const op = async () => {
      if (this.fence(hostId) !== fence) return undefined;
      return run();
    };
    const chain = (this.chains.get(hostId) ?? Promise.resolve()).then(op, op);
    this.chains.set(hostId, chain.then(() => undefined, () => undefined));
    return chain;
  }

  private fencedOut(hostId: string, fence: string): boolean {
    return this.fence(hostId) !== fence;
  }

  put(hostId: string, sessionId: string, submissionId: string, payload: PendingDraftPayload): Promise<void> {
    const fence = this.fence(hostId);
    return this.runFenced(hostId, fence, async () => {
      const blob = await seal(await this.keyFor(hostId), payload);
      if (this.fencedOut(hostId, fence)) return; // a clear started mid-flight
      this.blobs.set(`${hostId}/${sessionId}/${submissionId}`, blob);
      await this.persistBlob(hostId, sessionId, submissionId, blob);
    }).then(() => undefined);
  }

  async get(hostId: string, sessionId: string, submissionId: string): Promise<PendingDraftPayload | null> {
    const blob = this.blobs.get(`${hostId}/${sessionId}/${submissionId}`)
      ?? await this.loadBlob(hostId, sessionId, submissionId);
    if (!blob) return null;
    const key = await this.keyFor(hostId).catch(() => null);
    if (!key) return null;
    try {
      return await open<PendingDraftPayload>(key, blob);
    } catch {
      return null;
    }
  }

  async list(hostId: string, sessionId: string): Promise<PendingDraftEntry[]> {
    const prefix = `${hostId}/${sessionId}/`;
    const entries: PendingDraftEntry[] = [];
    const keys = new Set([
      ...[...this.blobs.keys()].filter(key => key.startsWith(prefix)),
      ...await this.listPersisted(hostId, sessionId),
    ]);
    for (const key of keys) {
      const submissionId = key.slice(prefix.length);
      const payload = await this.get(hostId, sessionId, submissionId);
      if (payload) entries.push({ submissionId, payload });
    }
    return entries.sort((left, right) => left.payload.at - right.payload.at);
  }

  /** Override to enumerate persisted submission ids for a session. */
  protected listPersisted(_hostId: string, _sessionId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Override to load a persisted blob on a memory miss (memory: none). */
  protected loadBlob(_hostId: string, _sessionId: string, _submissionId: string): Promise<SealedBlob | null> {
    return Promise.resolve(null);
  }

  remove(hostId: string, sessionId: string, submissionId: string): Promise<void> {
    const fence = this.fence(hostId);
    return this.runFenced(hostId, fence, async () => {
      this.blobs.delete(`${hostId}/${sessionId}/${submissionId}`);
      await this.deleteBlob(hostId, sessionId, submissionId);
    }).then(() => undefined);
  }

  /** The returned Promise settles only when every earlier write has safely
   *  ended (fenced out or committed) and memory + disk are both clean. */
  async clearHost(hostId: string): Promise<void> {
    this.hostEpochs.set(hostId, (this.hostEpochs.get(hostId) ?? 0) + 1);
    await this.chains.get(hostId)?.catch(() => undefined);
    this.keys.delete(hostId);
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(`${hostId}/`)) this.blobs.delete(key);
    }
    await this.dropHostData(hostId);
  }

  async clearAll(): Promise<void> {
    this.globalEpoch += 1;
    this.hostEpochs.clear();
    await Promise.all([...this.chains.values()].map(chain => chain.catch(() => undefined)));
    this.keys.clear();
    this.blobs.clear();
    await this.dropAllData();
  }
}

export class MemoryPendingDraftStore extends PendingDraftStoreCore {
  /** Test/inspection hook: the raw sealed blob, proving nothing readable. */
  sealed(hostId: string, sessionId: string, submissionId: string): SealedBlob | undefined {
    return this.blobs.get(`${hostId}/${sessionId}/${submissionId}`);
  }

  /** Test/inspection hook: all currently held scope keys. */
  scopes(): string[] {
    return [...this.blobs.keys()];
  }
}

const DB_NAME = 'gian-remote-pending-drafts';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const DRAFT_STORE = 'drafts';

export class IndexedDbPendingDraftStore extends PendingDraftStoreCore {
  static available(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  protected override persistBlob(hostId: string, sessionId: string, submissionId: string, blob: SealedBlob): Promise<void> {
    if (!IndexedDbPendingDraftStore.available()) return Promise.resolve();
    return idbPut(DRAFT_STORE, `${hostId}/${sessionId}/${submissionId}`, blob);
  }

  protected override persistKey(hostId: string, key: CryptoKey): Promise<void> {
    if (!IndexedDbPendingDraftStore.available()) return Promise.resolve();
    return idbPut(KEY_STORE, hostId, key);
  }

  protected override deleteBlob(hostId: string, sessionId: string, submissionId: string): Promise<void> {
    if (!IndexedDbPendingDraftStore.available()) return Promise.resolve();
    return idbDelete(DRAFT_STORE, `${hostId}/${sessionId}/${submissionId}`);
  }

  protected override async dropHostData(hostId: string): Promise<void> {
    if (!IndexedDbPendingDraftStore.available()) return;
    await idbDelete(KEY_STORE, hostId);
    await idbDeletePrefix(DRAFT_STORE, `${hostId}/`);
  }

  protected override async dropAllData(): Promise<void> {
    if (!IndexedDbPendingDraftStore.available()) return;
    await idbClear(KEY_STORE);
    await idbClear(DRAFT_STORE);
  }

  protected override loadKey(hostId: string): Promise<CryptoKey | null> {
    if (!IndexedDbPendingDraftStore.available()) return Promise.resolve(null);
    return idbGet<CryptoKey>(KEY_STORE, hostId);
  }

  protected override loadBlob(hostId: string, sessionId: string, submissionId: string): Promise<SealedBlob | null> {
    if (!IndexedDbPendingDraftStore.available()) return Promise.resolve(null);
    return idbGet<SealedBlob>(DRAFT_STORE, `${hostId}/${sessionId}/${submissionId}`);
  }

  protected override async listPersisted(hostId: string, sessionId: string): Promise<string[]> {
    if (!IndexedDbPendingDraftStore.available()) return [];
    const keys = await idbKeys(DRAFT_STORE);
    const prefix = `${hostId}/${sessionId}/`;
    return keys
      .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
      .map(key => key.slice(prefix.length));
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openDb().then(db => new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => { db.close(); resolve((request.result as T | undefined) ?? null); };
    request.onerror = () => { db.close(); reject(request.error); };
  }));
}

function idbDelete(store: string, key: string): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function idbDeletePrefix(store: string, prefix: string): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const request = tx.objectStore(store).getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result) {
        if (typeof key === 'string' && key.startsWith(prefix)) tx.objectStore(store).delete(key);
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function idbKeys(store: string): Promise<IDBValidKey[]> {
  return openDb().then(db => new Promise<IDBValidKey[]>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAllKeys();
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  }));
}

function idbClear(store: string): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

export function createPendingDraftStore(): PendingDraftStore {
  return IndexedDbPendingDraftStore.available()
    ? new IndexedDbPendingDraftStore()
    : new MemoryPendingDraftStore();
}

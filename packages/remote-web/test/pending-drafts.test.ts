import { describe, expect, it } from 'vitest';
import { MemoryPendingDraftStore, type PendingDraftPayload } from '../src/cache/pending-drafts.js';

const hostId = '11111111-1111-4111-8111-111111111111';
const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function viWait(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

function payload(text: string, phase: PendingDraftPayload['phase'] = 'translating', sendCommandId?: string): PendingDraftPayload {
  return {
    draft: { text, attachments: [], contextItems: [], document: null },
    at: Date.now(),
    phase,
    ...(sendCommandId ? { sendCommandId } : {}),
  };
}

describe('pending draft store (encrypted, Host-scoped)', () => {
  it('stores nothing readable as plaintext and returns intact drafts', async () => {
    const store = new MemoryPendingDraftStore();
    await store.put(hostId, sessionA, 'sub-1', payload(String.fromCodePoint(0x673a, 0x5bc6, 0x8349, 0x7a3f, 0x20, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x2d, 0x74, 0x6f, 0x6b, 0x65, 0x6e)));
    const sealed = store.sealed(hostId, sessionA, 'sub-1');
    expect(sealed).toBeDefined();
    expect(sealed!.ciphertext).not.toContain(String.fromCodePoint(0x673a, 0x5bc6, 0x8349, 0x7a3f));
    expect(sealed!.ciphertext).not.toContain('secret-token');
    expect((await store.get(hostId, sessionA, 'sub-1'))?.draft.text).toBe(String.fromCodePoint(0x673a, 0x5bc6, 0x8349, 0x7a3f, 0x20, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x2d, 0x74, 0x6f, 0x6b, 0x65, 0x6e));
  });

  it('remove and clearHost leave nothing behind', async () => {
    const store = new MemoryPendingDraftStore();
    await store.put(hostId, sessionA, 'sub-1', payload('A'));
    await store.put(hostId, sessionB, 'sub-2', payload('B'));
    await store.remove(hostId, sessionA, 'sub-1');
    expect(await store.get(hostId, sessionA, 'sub-1')).toBeNull();
    expect((await store.get(hostId, sessionB, 'sub-2'))?.draft.text).toBe('B');
    await store.clearHost(hostId);
    expect(store.scopes()).toEqual([]);
    expect(await store.get(hostId, sessionB, 'sub-2')).toBeNull();
  });

  it('clearAll wipes every Host', async () => {
    const store = new MemoryPendingDraftStore();
    await store.put(hostId, sessionA, 'sub-1', payload('A'));
    await store.put('22222222-2222-4222-8222-222222222222', sessionA, 'sub-2', payload('B'));
    await store.clearAll();
    expect(store.scopes()).toEqual([]);
  });

  it('keeps multiple submissions per session and lists them oldest first', async () => {
    const store = new MemoryPendingDraftStore();
    await store.put(hostId, sessionA, 'sub-old', { ...payload(String.fromCodePoint(0x65e7, 0x41)), at: 1000 });
    await store.put(hostId, sessionA, 'sub-new', { ...payload(String.fromCodePoint(0x65b0, 0x42)), at: 2000 });
    const entries = await store.list(hostId, sessionA);
    expect(entries.map(entry => entry.submissionId)).toEqual(['sub-old', 'sub-new']);
    // Removing one never disturbs the other.
    await store.remove(hostId, sessionA, 'sub-old');
    expect((await store.list(hostId, sessionA)).map(entry => entry.payload.draft.text)).toEqual([String.fromCodePoint(0x65b0, 0x42)]);
  });

  it('a put blocked mid-flight at a key barrier is fenced out by clearHost, whose promise means fully clean', async () => {
    // The write has ENTERED its serial run and is blocked generating the key
    // when the clear starts — not merely queued.
    class KeyBarrierStore extends MemoryPendingDraftStore {
      barrier: Promise<void> | null = null;
      entered = 0;
      protected override async loadKey(): Promise<CryptoKey | null> {
        this.entered += 1;
        if (this.barrier) await this.barrier;
        return null;
      }
    }
    const store = new KeyBarrierStore();
    let release!: () => void;
    store.barrier = new Promise<void>(resolve => { release = resolve; });
    const put = store.put(hostId, sessionA, 'sub-1', payload(String.fromCodePoint(0x5728, 0x9014, 0x5199, 0x5165)));
    await viWait(() => store.entered === 1);
    const clearing = store.clearHost(hostId);
    release();
    await Promise.all([put, clearing]);
    // clearHost's promise settling means the earlier write ended safely and
    // memory is clean — no resurrected draft.
    expect(store.scopes()).toEqual([]);
    expect(await store.get(hostId, sessionA, 'sub-1')).toBeNull();
  });

  it('a put blocked at the persist barrier still leaves clearAll fully clean', async () => {
    class PersistBarrierStore extends MemoryPendingDraftStore {
      barrier: Promise<void> | null = null;
      persisted = 0;
      protected override async persistBlob(): Promise<void> {
        this.persisted += 1;
        if (this.barrier) await this.barrier;
      }
    }
    const store = new PersistBarrierStore();
    let release!: () => void;
    // The barrier holds BEFORE the put enters it, so the write is verifiably
    // blocked mid-commit when the clear starts.
    store.barrier = new Promise<void>(resolve => { release = resolve; });
    const put = store.put(hostId, sessionA, 'sub-1', payload(String.fromCodePoint(0x5728, 0x9014, 0x5199, 0x5165)));
    await viWait(() => store.persisted === 1);
    // The commit (blobs.set) happens before the barrier; clearAll must wait
    // for the chain and still end with a clean store.
    const clearing = store.clearAll();
    release();
    await Promise.all([put, clearing]);
    expect(store.scopes()).toEqual([]);
    expect(await store.get(hostId, sessionA, 'sub-1')).toBeNull();
  });

  it('concurrent first writes for one Host share one key flight', async () => {
    const store = new MemoryPendingDraftStore();
    await Promise.all([
      store.put(hostId, sessionA, 'sub-1', payload('A')),
      store.put(hostId, sessionB, 'sub-2', payload('B')),
    ]);
    expect((await store.get(hostId, sessionA, 'sub-1'))?.draft.text).toBe('A');
    expect((await store.get(hostId, sessionB, 'sub-2'))?.draft.text).toBe('B');
  });
});

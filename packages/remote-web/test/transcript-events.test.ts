import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, RemoteSession, RemoteStateSnapshot, RemoteTranscriptItem } from '@gian/remote-protocol';
import { generateCanonicalId } from '@gian/remote-protocol';

import {
  applyCanonicalEvent,
  applyRemoteTranscriptItem,
  applySnapshotToState,
  applyStatePatch,
  applyTranscriptPage,
  beginTranscriptLoad,
  failTranscriptLoad,
} from '../src/controller/apply-control.js';
import { createFixtureController } from '../src/controller/fixture.js';
import { sampleInteraction } from '../src/scenarios.js';

// remoteStableUuid('turn', 'turn-1') from Host projection.ts. The active
// fixture turn keeps its raw id 'turn-1'; these identities must not be equated.
const projectedActiveTurnId = '71f0a484-07e1-5920-9e94-3f9da1da7a8f';

function event(event: CanonicalEvent['event']): CanonicalEvent {
  return { type: 'event', host_generation: generateCanonicalId(), event_sequence: 0, event };
}

function snapshot(session: RemoteSession): RemoteStateSnapshot {
  return {
    type: 'state.snapshot', snapshot_id: generateCanonicalId(), host_generation: generateCanonicalId(),
    revision: 'rev-1', event_sequence: 0,
    host: { id: 'host-home', name: 'Home', online: true, version: '0.6.8' },
    workspaces: [], tasks: [], sessions: [session], interactions: [],
    capabilities: {}, attention: [], catalog_revision: 'cat-1',
  };
}

function common(id = generateCanonicalId()) {
  return {
    id,
    turn_id: generateCanonicalId(),
    turn: 7,
    ts: 1_789_000_000_000,
  };
}

describe('Remote transcript projection', () => {
  it('keeps one real turn and merges streaming updates by logical event identity', () => {
    const assistantId = generateCanonicalId();
    const commandId = generateCanonicalId();
    const turnId = generateCanonicalId();
    const items: RemoteTranscriptItem[] = [
      { ...common(), kind: 'user', text: 'Please inspect this.' },
      { ...common(assistantId), turn_id: turnId, kind: 'assistant', text: 'Working ', delta: true },
      { ...common(assistantId), turn_id: turnId, kind: 'assistant', text: 'on it.', delta: true },
      { ...common(commandId), turn_id: turnId, kind: 'command', status: 'running' },
      { ...common(commandId), turn_id: turnId, kind: 'command', status: 'success', exit_code: 0 },
      { ...common(), turn_id: turnId, kind: 'turn-end', outcome: 'worked' },
    ];

    const original = createFixtureController().state;
    const state = {
      ...original,
      sessions: original.sessions.map(session => session.id === 's-1'
        ? { ...session, active_turn: { id: 'turn-1', turn_number: 7 } }
        : session),
    };
    const next = applyTranscriptPage(state, 's-1', items, 'codex', true);
    const transcript = next.transcripts['s-1']!;

    expect(transcript.hasOlder).toBe(true);
    expect(transcript.streaming).toBe(false);
    expect(transcript.items.every((item) => item.turn === 7)).toBe(true);
    expect(transcript.items.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(transcript.items.find((item) => item.kind === 'assistant')).toMatchObject({
      text: 'Working on it.',
      exec: 'codex',
    });
    expect(transcript.items.filter((item) => item.kind === 'command')).toHaveLength(1);
    expect(transcript.items.find((item) => item.kind === 'command')).toMatchObject({
      status: 'success',
      exitCode: 0,
    });
  });

  it('stops the running transcript state on terminal event or Session update', () => {
    const controller = createFixtureController();
    const state = applyTranscriptPage(controller.state, 's-1', [], 'codex', false);
    const terminal = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: {
        kind: 'transcript.item',
        session_id: 's-1',
        item: { ...common(), turn: 3, turn_id: projectedActiveTurnId, kind: 'turn-end', outcome: 'worked' },
      },
    });
    expect(terminal.transcripts['s-1']!.streaming).toBe(false);

    const session = terminal.sessions.find((entry) => entry.id === 's-1')!;
    const updated = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 1,
      event: { kind: 'session.updated', session: { ...session, status: 'done' } },
    });
    expect(updated.transcripts['s-1']!.streaming).toBe(false);
  });

  it.each(['event', 'patch', 'snapshot', 'page'] as const)(
    '%s confirms active work before any process event and clears it on terminal Session state',
    path => {
      const original = createFixtureController().state;
      const active = original.sessions.find(session => session.id === 's-1')!;
      const idle = { ...active, status: 'done' as const, active_turn: undefined };
      const start = applyTranscriptPage({ ...original, sessions: [idle] }, active.id, [], 'codex', false);
      const apply = (state: typeof start, session: RemoteSession) => {
        if (path === 'event') return applyCanonicalEvent(state, event({ kind: 'session.updated', session }));
        if (path === 'patch') return applyStatePatch(state, {
          type: 'state.patch', host_generation: generateCanonicalId(), event_sequence: 0,
          base_revision: 'rev-0', revision: 'rev-1',
          patch: { sessions: { upsert: [session], remove_ids: [] } },
        });
        if (path === 'snapshot') return applySnapshotToState(state, snapshot(session));
        return applyTranscriptPage({ ...state, sessions: [session] }, session.id, [], 'codex', false);
      };
      const running = apply(start, active);
      expect(running.transcripts[active.id]!.items).toEqual([]);
      expect(running.transcripts[active.id]!.streaming).toBe(true);
      expect(apply(running, idle).transcripts[active.id]!.streaming).toBe(false);
    },
  );

  it('initializes activity for the viewed Session even before its first history page', () => {
    const state = createFixtureController().state;
    const session = state.sessions.find(entry => entry.id === 's-1')!;
    const next = applyCanonicalEvent({ ...state, transcripts: {} }, event({ kind: 'session.updated', session }));
    expect(next.transcripts[session.id]).toMatchObject({ items: [], streaming: true, hydrated: false });
  });

  it.each(['worked', 'failed', 'stopped'] as const)(
    'matches a projected %s terminal by Session turn number and never reopens it on a late item or page',
    outcome => {
      const original = createFixtureController().state;
      const active = original.sessions.find(session => session.id === 's-1')!;
      expect(active.active_turn!.id).not.toBe(projectedActiveTurnId);
      const start = applyTranscriptPage(original, active.id, [], 'codex', false);
      const terminal = applyCanonicalEvent(start, event({
        kind: 'transcript.item', session_id: active.id,
        item: { ...common(), turn: 3, turn_id: projectedActiveTurnId, kind: 'turn-end', outcome },
      }));
      expect(terminal.transcripts[active.id]!.streaming).toBe(false);
      const reply = applyCanonicalEvent(terminal, event({
        kind: 'transcript.item', session_id: active.id,
        item: { ...common(), turn: 3, kind: 'assistant', text: 'Final reply', delta: false },
      }));
      expect(reply.transcripts[active.id]!.streaming).toBe(false);
      expect(reply.transcripts[active.id]!.items).toContainEqual(expect.objectContaining({ text: 'Final reply' }));
      const stalePage = applyTranscriptPage(reply, active.id, [], 'codex', false);
      expect(stalePage.transcripts[active.id]!.streaming).toBe(false);
      expect(stalePage.transcripts[active.id]!.items).toContainEqual(expect.objectContaining({ text: 'Final reply' }));
      expect(applyCanonicalEvent(stalePage, event({ kind: 'session.updated', session: active }))
        .transcripts[active.id]!.streaming).toBe(false);
      const newer = { ...active, active_turn: { id: generateCanonicalId(), turn_number: 4 } };
      expect(applyCanonicalEvent(reply, event({ kind: 'session.updated', session: newer }))
        .transcripts[active.id]!.streaming).toBe(true);
    },
  );

  it('does not turn idle or disconnected historical items into active model work', () => {
    const original = createFixtureController().state;
    const active = original.sessions.find(session => session.id === 's-1')!;
    const user: RemoteTranscriptItem = { ...common(), kind: 'user', text: 'Late user echo' };
    for (const state of [
      { ...original, sessions: [{ ...active, status: 'done' as const, active_turn: undefined }] },
      { ...original, sessions: [{ ...active, active_turn: undefined }] },
      { ...original, connection: { kind: 'relay_reconnecting' as const, attempt: 1 } },
      { ...original, connection: { kind: 'resyncing' as const, synced: 0, total: 1 } },
    ]) {
      expect(applyCanonicalEvent(state, event({ kind: 'transcript.item', session_id: active.id, item: user }))
        .transcripts[active.id]!.streaming).toBe(false);
      expect(applyTranscriptPage(state, active.id, [user], 'codex', false)
        .transcripts[active.id]!.streaming).toBe(false);
    }
    const ended = applyCanonicalEvent(original, event({
      kind: 'transcript.item', session_id: active.id,
      item: { ...common(), turn: 3, kind: 'error' },
    }));
    expect(ended.transcripts[active.id]!.streaming).toBe(false);
  });

  it('suppresses pending approval and failed/loading history, then resumes only from fresh canonical state', () => {
    const state = createFixtureController().state;
    const active = state.sessions.find(session => session.id === 's-1')!;
    const interaction = sampleInteraction({ session_id: active.id });
    const waiting = applyCanonicalEvent(state, event({ kind: 'interaction.updated', interaction }));
    expect(waiting.transcripts[active.id]!.streaming).toBe(false);
    const resolved = applyStatePatch(waiting, {
      type: 'state.patch', host_generation: generateCanonicalId(), event_sequence: 1,
      base_revision: 'rev-0', revision: 'rev-1',
      patch: { interactions: { upsert: [], remove_ids: [interaction.id] } },
    });
    expect(resolved.transcripts[active.id]!.streaming).toBe(true);
    const loading = beginTranscriptLoad(resolved, active.id, 'initial');
    expect(loading.transcripts[active.id]!.streaming).toBe(false);
    const failed = failTranscriptLoad(loading, active.id, 'initial');
    expect(applyCanonicalEvent(failed, event({ kind: 'session.updated', session: active }))
      .transcripts[active.id]!.streaming).toBe(false);
    expect(applyTranscriptPage(failed, active.id, [], 'codex', false)
      .transcripts[active.id]!.streaming).toBe(true);
  });

  it('uses the selected Session executor for live deltas and does not invent notice rows', () => {
    const controller = createFixtureController();
    const state = applyTranscriptPage(controller.state, 's-1', [], 'codex', false);
    const item: RemoteTranscriptItem = {
      ...common(),
      kind: 'assistant',
      text: 'Hello',
      delta: true,
    };
    const next = applyCanonicalEvent(state, {
      type: 'event',
      host_generation: generateCanonicalId(),
      event_sequence: 0,
      event: { kind: 'transcript.item', session_id: 's-1', item },
    });

    expect(next.transcripts['s-1']!.items).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello', exec: 'codex', turn: 7 }),
    ]);
    expect(next.transcripts['s-1']!.items.some((entry) => entry.kind === 'auto-notice')).toBe(false);
  });

  it('maps historical attachment metadata without inventing a Host URL', () => {
    const attachmentId = generateCanonicalId();
    const next = applyRemoteTranscriptItem([], {
      ...common(),
      kind: 'user',
      text: 'see file',
      attachments: [{
        id: attachmentId,
        session_id: generateCanonicalId(),
        name: 'notes.md',
        mime: 'text/markdown',
        size: 42,
        revision: 'event:0',
        previewable: true,
        downloadable: true,
        expires_at: new Date().toISOString(),
      }],
    }, 'codex');

    expect(next[0]).toMatchObject({
      kind: 'user',
      attachments: [{ name: 'notes.md', mime: 'text/markdown', url: attachmentId, size: 42 }],
    });
  });

  it('drops a legacy or malformed runtime row instead of fabricating Turn Failed', () => {
    const before = [{
      kind: 'user' as const,
      id: generateCanonicalId(),
      text: 'kept',
      exec: 'codex',
      ts: 1,
      turn: 1,
    }];
    const legacy = {
      id: generateCanonicalId(),
      turn_id: generateCanonicalId(),
      category: 'notice',
      text: 'notice',
    } as unknown as RemoteTranscriptItem;

    expect(applyRemoteTranscriptItem(before, legacy, 'codex')).toBe(before);
  });
});

export function occupiesCanonicalSequence(
  type: string,
  eventKind?: string,
): boolean {
  if (type === 'state.patch') return true;
  // transcript.item and translation.updated ride the live connection only:
  // they are recovered by session.subscribe/session.page reads after a
  // reconnect, never by the canonical replay sequence.
  if (type === 'event') return eventKind !== 'transcript.item' && eventKind !== 'translation.updated';
  return false;
}

export function advanceCanonicalSequence(last: number, incoming: number): 'ok' | 'gap' {
  if (last >= 0 && incoming !== last + 1) return 'gap';
  return 'ok';
}

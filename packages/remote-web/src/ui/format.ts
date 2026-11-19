/** Short relative time for list rows: now, 5m, 3h, Yesterday, 4d, Nov 2. */
export function formatRelativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const then = new Date(ts);
  const today = new Date(now);
  const sameDay = then.toDateString() === today.toDateString();
  if (sameDay || diff < 6 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h`;
  const yesterday = new Date(now - 86_400_000);
  if (then.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (diff < 7 * 86_400_000) return `${Math.max(2, Math.floor(diff / 86_400_000))}d`;
  return then.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/** A repository path reads by its last segment; the full path stays in the
 *  tooltip. `~/Coding/Gian-Dev` → `Gian-Dev`. */
export function workspaceLabel(name: string): string {
  const trimmed = name.replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/]/).pop();
  return last && last !== '~' ? last : trimmed || name;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

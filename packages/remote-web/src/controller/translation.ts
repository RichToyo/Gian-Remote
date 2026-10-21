/**
 * Pure conversation-translation state transitions for the Remote Web UI
 * controller. The Host stays the source of truth; these helpers only merge
 * negotiated wire DTOs into the per-session UI projection. No transport,
 * no React — production.ts and the fixtures drive them.
 */

import type {
  RemoteTranslation,
  RemoteTranslationAutomatic,
  RemoteTranslationState,
} from '@gian/remote-protocol';
import type {
  ReadingTranslationRecord,
  RemoteTranslationUiState,
} from './types.js';
import { emptyTranslationUiState } from './types.js';

export function translationUiFor(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
): RemoteTranslationUiState {
  return translations[sessionId] ?? emptyTranslationUiState();
}

function patch(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  change: Partial<RemoteTranslationUiState>,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  return { ...translations, [sessionId]: { ...current, ...change } };
}

function projectRecord(dto: RemoteTranslation): ReadingTranslationRecord {
  return {
    id: dto.id,
    targetLanguage: dto.target_language,
    ...(dto.text !== undefined ? { text: dto.text } : {}),
    textLength: dto.text_length,
    textSha256: dto.text_sha256,
    sourceSha256: dto.source_sha256,
  };
}

/** session.subscribe result / translation.set_auto result /
 *  translation.updated `state`. A state whose revision is older than the
 *  current one is a stale response (delayed ACK, replayed event) and must
 *  never roll the UI back (F6). */
export function applyTranslationState(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  state: RemoteTranslationState,
  options?: { authoritativeBaseline?: boolean },
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  // Stale in EITHER dimension (switch revision or Host config revision)
  // must not roll the UI back — delayed ACKs and replayed events included.
  if (current.supported
    && (state.revision < current.revision || state.config_revision < current.configRevision)) {
    return translations;
  }
  // `automatic` is wholesale-replaced only when the SAME epoch's ordered
  // version is not older, or when an authoritative current-state read (a
  // live subscribe/state push on this connection) establishes or replaces
  // the epoch baseline. A historical mutation receipt (ledger-replayed
  // command.status result) or a retired-epoch packet can never preempt the
  // baseline — including an empty one awaiting its authoritative sync.
  const sameEpoch = state.automatic_epoch === current.automaticEpoch;
  const acceptAutomatic = !current.supported
    || (sameEpoch && state.automatic_revision >= current.automaticRevision)
    || (options?.authoritativeBaseline === true
      && (current.automaticEpoch === '' || !sameEpoch));
  const change: Partial<RemoteTranslationUiState> = {
    supported: true,
    enabled: state.enabled,
    configured: state.configured,
    sendingLanguage: state.sending_language,
    readingLanguage: state.reading_language,
    revision: state.revision,
    configRevision: state.config_revision,
    error: '',
  };
  if (acceptAutomatic) {
    const automatic: RemoteTranslationUiState['automatic'] = {};
    for (const entry of state.automatic) {
      automatic[entry.source_id] = {
        pending: entry.pending,
        ...(entry.error ? { error: entry.error } : {}),
      };
    }
    change.automatic = automatic;
    change.automaticRevision = state.automatic_revision;
    change.automaticEpoch = state.automatic_epoch;
  }
  return patch(translations, sessionId, change);
}

/** A legacy Host (or an exported execution) carries no translation state:
 *  every translation affordance hides, plain chat continues. */
export function markTranslationUnsupported(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
): Record<string, RemoteTranslationUiState> {
  if (!(sessionId in translations)) return translations;
  return patch(translations, sessionId, { supported: false, enabled: false, send: null });
}

export function applyTranslationAutomatic(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  entry: RemoteTranslationAutomatic,
  version?: { revision: number; epoch: string },
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  let advance: { revision: number; epoch: string } | undefined = version;
  if (version) {
    if (current.automaticEpoch === '') {
      // No baseline yet: apply the progress entry but do NOT establish the
      // epoch — only an authoritative current-state read may do that, so a
      // stale delta cannot preempt the pending baseline sync.
      advance = undefined;
    } else if (version.epoch !== current.automaticEpoch) {
      // A delta from a retired Host epoch can never roll back the live one —
      // epoch adoption happens only at the authoritative sync baseline.
      return translations;
    } else if (version.revision < current.automaticRevision) {
      return translations; // stale delta
    }
  }
  const automatic = { ...current.automatic };
  if (!entry.pending && !entry.error) delete automatic[entry.source_id];
  else automatic[entry.source_id] = {
    pending: entry.pending,
    ...(entry.error ? { error: entry.error } : {}),
  };
  return patch(translations, sessionId, {
    automatic,
    // Every accepted delta advances the ordered version, keeping snapshots
    // and deltas on the same comparable scale.
    ...(advance ? {
      automaticRevision: Math.max(current.automaticRevision, advance.revision),
      automaticEpoch: advance.epoch,
    } : {}),
  });
}

/** Upsert one settled record (read results render under the original; a
 *  duplicate event — live + settled ack — is idempotent by record id). A
 *  descriptor-only record (no inline text) keeps any previously fetched full
 *  text; the controller pages it through translation.result_text. */
export function applyTranslationUpsert(
  translations: Record<string, RemoteTranslationUiState>,
  dto: RemoteTranslation,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, dto.session_id);
  if (dto.purpose !== 'read' || !dto.source_id) return translations;
  const existing = current.results[dto.source_id] ?? [];
  const without = existing.filter(record => record.id !== dto.id);
  const results = { ...current.results, [dto.source_id]: [...without, projectRecord(dto)] };
  const reading = { ...current.reading };
  // A settled record ends the manual pending row for the same source.
  if (reading[dto.source_id]?.pending) delete reading[dto.source_id];
  return patch(translations, dto.session_id, { results, reading });
}

/** History pages carry the reading translations for their turns. */
export function applyTranslationPage(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  page: readonly RemoteTranslation[],
): Record<string, RemoteTranslationUiState> {
  let next = translations;
  for (const dto of page) {
    next = applyTranslationUpsert(next, { ...dto, session_id: sessionId });
  }
  return next;
}

/** Mark a descriptor paging failure: the row shows an actionable error with
 *  in-place retry instead of an endless Translating state. */
export function applyTranslationFullTextError(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  recordId: string,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  return patch(translations, sessionId, {
    fullTextErrors: { ...current.fullTextErrors, [recordId]: true },
  });
}

/** Clear the paging-failure mark before a retry / on success. */
export function clearTranslationFullTextError(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  recordId: string,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  if (!current.fullTextErrors[recordId]) return translations;
  const fullTextErrors = { ...current.fullTextErrors };
  delete fullTextErrors[recordId];
  return patch(translations, sessionId, { fullTextErrors });
}

/** Store one paged full text (verified by the caller against text_sha256). */
export function applyTranslationFullText(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  recordId: string,
  text: string,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  const fullTextErrors = { ...current.fullTextErrors };
  delete fullTextErrors[recordId];
  return patch(translations, sessionId, {
    fullTexts: { ...current.fullTexts, [recordId]: text },
    fullTextErrors,
  });
}

export function applyTranslationReadError(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  sourceId: string,
  error: string,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  return patch(translations, sessionId, {
    reading: { ...current.reading, [sourceId]: { pending: false, error } },
  });
}

/** Drop an abandoned manual-read pending row (its terminal status was lost);
 *  the next globe click starts a fresh request instead of waiting forever. */
export function resetTranslationRead(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  sourceId: string,
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  if (!current.reading[sourceId]) return translations;
  const reading = { ...current.reading };
  delete reading[sourceId];
  return patch(translations, sessionId, { reading });
}

/** Restore a pending row that a just-applied older record cleared: the NEW
 *  request generation for the same source keeps ownership of the row. */
export function restoreTranslationReading(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  sourceId: string,
  entry: { pending: boolean; requestId?: string; error?: string },
): Record<string, RemoteTranslationUiState> {
  const current = translationUiFor(translations, sessionId);
  return patch(translations, sessionId, {
    reading: { ...current.reading, [sourceId]: entry },
  });
}

export function applyTranslationNote(
  translations: Record<string, RemoteTranslationUiState>,
  sessionId: string,
  error: string,
): Record<string, RemoteTranslationUiState> {
  return patch(translations, sessionId, { error });
}

/** The current display value for one globe block: a fresh manual request wins
 *  over a cached record (it was kicked off exactly because the cache did not
 *  match), then the newest record in the current reading language, then the
 *  automatic progress entry. A descriptor-only record reads as pending until
 *  its full text arrives. */
export function readingValue(
  ui: RemoteTranslationUiState,
  sourceId: string,
): { pending: boolean; error?: string; recordId?: string; record?: ReadingTranslationRecord & { text: string } } {
  const manual = ui.reading[sourceId];
  if (manual) return manual;
  const record = [...(ui.results[sourceId] ?? [])].reverse()
    .find(candidate => candidate.targetLanguage === ui.readingLanguage);
  if (record) {
    const text = record.text ?? ui.fullTexts[record.id];
    if (text !== undefined) return { pending: false, record: { ...record, text } };
    if (ui.fullTextErrors[record.id]) return { pending: false, error: 'translation.loadFailed', recordId: record.id };
    return { pending: true };
  }
  const auto = ui.automatic[sourceId];
  if (auto) return { pending: auto.pending, ...(auto.error ? { error: auto.error } : {}) };
  return { pending: false };
}

/** Default follows the session switch; a manual click overrides per view. */
export function isReadExpanded(ui: RemoteTranslationUiState, sourceId: string): boolean {
  return ui.expandOverrides[sourceId] ?? ui.enabled;
}

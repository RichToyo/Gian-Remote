/**
 * Conversation-translation presentation components, shared by Gian Web and
 * Remote Web. These accept ONLY display models and callbacks — no HTTP,
 * toast, router, store, or Provider dependency — so each app wires its own
 * translation controller behind the same visuals. The matching styles live
 * in `styles/chat-ui.css` (`.translation-*`).
 */

import { TRANSLATION_LANGUAGES } from '@gian/shared';
import { useChatUiT } from './i18n.js';
import { MarkdownText } from './markdown.js';

export function languageName(code: string): string {
  return TRANSLATION_LANGUAGES.find(([id]) => id === code)?.[1] ?? code;
}

/** Display model for one reading/sent translation block. */
export interface TranslationDisplayState {
  pending: boolean;
  error?: string;
  text?: string;
  targetLanguage?: string;
}

/** Send-gate phase: the send stays unsettled across 'translating' and
 *  'failed' — only the user (retry / send original / reclaim) or a
 *  successful translation settles it. 'dispatching' means the real send is
 *  in flight under a fixed command identity; 'unknown' means its ACK is in
 *  doubt and command.status owns the recovery — neither allows another
 *  dispatch action. */
export type TranslationSendPhase =
  | { phase: 'translating' }
  | { phase: 'dispatching' }
  | { phase: 'unknown' }
  | { phase: 'failed'; error: string; timedOut: boolean }
  | null;

/**
 * Shared "Translating" indicator: a quiet label plus three permanent dots
 * running a staggered wave keyframe (see chat-ui.css; the animation
 * degrades to static dots under prefers-reduced-motion).
 */
export function TranslatingIndicator() {
  const t = useChatUiT();
  return <span className="translation-pending">
    <span>{t('translation.inProgress')}</span>
    <span className="translation-dots" aria-hidden="true"><span /><span /><span /></span>
  </span>;
}

/** globe reading-translation toggle. Not disabled while pending: the toggle
 *  must stay clickable so the user can collapse a slow translation. */
export function TranslationToggleButton({ expanded, ready, title, onClick }: {
  expanded: boolean;
  ready: boolean;
  title: string;
  onClick: () => void;
}) {
  return <button type="button" className={`translation-action${expanded ? ' on' : ''}`} title={title} aria-label={title}
    aria-expanded={expanded} aria-pressed={expanded}
    disabled={!ready} onClick={onClick}>
    <svg data-icon="globe" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  </button>;
}

/**
 * The assistant message's translation block. Rendering is owned by the globe
 * toggle (`expanded`): collapsed renders nothing — even when a record is
 * already cached. The heading is skipped while pending; it appears with the
 * record (`Translation · Chinese (Simplified)`) or an error.
 */
export function TranslationResultBlock({ value, expanded, onRetry }: {
  value: TranslationDisplayState;
  expanded: boolean;
  onRetry: () => void;
}) {
  const t = useChatUiT();
  if (!expanded || (!value.pending && !value.error && !value.text)) return null;
  return <div className="translation-block" aria-busy={value.pending}>
    {!value.pending && (
      <div className="translation-heading">
        {t('translation.title')}{value.text && value.targetLanguage ? ` · ${languageName(value.targetLanguage)}` : ''}
      </div>
    )}
    {value.pending && <TranslatingIndicator />}
    {value.error && <div className="translation-error" role="alert">{value.error}
      <button type="button" className="btn xs secondary" onClick={onRetry}>{t('translation.retry')}</button>
    </div>}
    {value.text && <div className="translation-bubble md"><MarkdownText>{value.text}</MarkdownText></div>}
  </div>;
}

/**
 * Inline progress row under a pending send echo while its translation runs.
 * Translating: dots + a "Send original" shortcut. Dispatching: a quiet
 * status, no alternative dispatch actions. Unknown: the outcome is being
 * recovered — only a state refresh is offered. Failed (error or the hard
 * timeout): the message plus Retry / Send original / Take text back. There
 * is deliberately no way to silently drop the message — reclaim hands the
 * text back to the composer instead.
 */
export function TranslationSendRow({ sending, timeoutSeconds, onRetry, onSendOriginal, onReclaim, onRefreshState }: {
  sending: TranslationSendPhase;
  timeoutSeconds: number;
  onRetry: () => void;
  onSendOriginal: () => void;
  onReclaim: () => void;
  /** Offered in the unknown phase: re-read canonical state (command.status
   *  recovery) instead of allowing another dispatch. */
  onRefreshState?: () => void;
}) {
  const t = useChatUiT();
  if (!sending) return null;
  if (sending.phase === 'translating') {
    return <div className="translation-send-row" role="status">
      <TranslatingIndicator />
      <button type="button" className="translation-link" onClick={onSendOriginal}>
        {t('translation.sendOriginal')}
      </button>
    </div>;
  }
  if (sending.phase === 'dispatching') {
    return <div className="translation-send-row" role="status">
      <span className="translation-pending"><span>{t('translation.sending')}</span>
        <span className="translation-dots" aria-hidden="true"><span /><span /><span /></span></span>
    </div>;
  }
  if (sending.phase === 'unknown') {
    // Identity-preserving recovery only: refresh resolves the fixed command
    // through command.status. No take-back/retry here — those would discard
    // the dispatch identity while the outcome is still in doubt.
    return <div className="translation-send-row" role="alert">
      <span className="translation-error">{t('translation.sendUnknown')}</span>
      {onRefreshState && (
        <button type="button" className="translation-link" onClick={onRefreshState}>
          {t('translation.refreshState')}
        </button>
      )}
    </div>;
  }
  return <div className="translation-send-row" role="alert">
    <span className="translation-error">{sending.timedOut
      ? t('translation.sendTimeout').replace('{s}', String(timeoutSeconds))
      : sending.error}</span>
    <button type="button" className="translation-link" onClick={onRetry}>
      {t('translation.retry')}
    </button>
    <button type="button" className="translation-link" onClick={onSendOriginal}>
      {t('translation.sendOriginal')}
    </button>
    <button type="button" className="translation-link" onClick={onReclaim}>
      {t('translation.reclaim')}
    </button>
  </div>;
}

/** Bare pending row for a translation send echo whose flow has no
 *  controller send state (the new-session first message). */
export function TranslationEchoPendingRow() {
  return <div className="translation-send-row" role="status"><TranslatingIndicator /></div>;
}

/** lucide.dev `book-type` (24-grid, project 1.5px stroke) — the Auto
 * translate chip is icon-only; the label stays on title/aria. */
const BOOK_TYPE_PATHS = ['M10 13h4', 'M12 6v7', 'M16 8V6H8v2',
  'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20'];

/** Pure presentational auto-translate chip, shared by the session underbar,
 *  the new-session form, and Remote Web. */
export function AutoTranslationChip({ on, disabled, onClick, title, testId }: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  testId?: string;
}) {
  return <button type="button"
    className={`translation-auto${on ? ' on' : ''}`}
    title={title}
    aria-label={title}
    aria-pressed={on}
    disabled={disabled}
    onClick={onClick}
    {...(testId ? { 'data-testid': testId } : {})}>
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {BOOK_TYPE_PATHS.map(d => <path key={d} d={d} />)}
    </svg>
  </button>;
}

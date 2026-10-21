/**
 * Chat page (B5): transcript via `@gian/chat-ui` only — no simplified local
 * renderer. Connection banners sit above the transcript; while stale, the
 * transcript dims and never pretends to stream. Pending interactions render
 * as cards at the end of the transcript.
 */

import { useMemo } from 'react';
import {
  ChatPanelOpenContext,
  LinkBehaviorContext,
  MessageAttachmentOpenContext,
  SEND_TRANSLATE_TIMEOUT_MS,
  Transcript,
  TranslationResultBlock,
  TranslationSendRow,
  TranslationTextRetryContext,
  TranslationToggleButton,
  languageName,
  renderChatItem,
} from '@gian/chat-ui';
import type { TranscriptItem } from '@gian/chat-ui';
import type { RemoteSession } from '@gian/remote-protocol';
import { mutationsEnabled } from '../controller/types.js';
import { isReadExpanded, readingValue, translationUiFor } from '../controller/translation.js';
import { useT } from '../i18n/index.js';
import { createRemoteLinkBehavior } from '../links/link-behavior.js';
import { ConnectionBanner, UnknownOutcomeBanner } from './banners.js';
import { Composer } from './composer.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { interactionResponder, projectInteraction } from './interaction.js';
import { QueueCollapsedRow, QueueDrawer } from './queue.js';
import { useViewportMode } from './viewport.js';

export function ChatPage({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();

  const transcript = state.transcripts[session.id];
  const online = mutationsEnabled(state.connection);
  const stale = !online;
  const translationUi = translationUiFor(state.translations, session.id);
  const translation = translationUi.supported ? translationUi : null;

  const items = useMemo<TranscriptItem[]>(() => {
    const base = transcript?.items ?? [];
    const projected = state.interactions
      .filter((i) => i.session_id === session.id)
      .map((i) => {
        const phase = state.interactionPhases[i.id] ?? 'pending';
        const label =
          phase === 'resolved-here' ? t('interaction.resolvedHere')
          : phase === 'resolved-elsewhere' ? t('interaction.resolvedElsewhere')
          : phase === 'expired' ? t('interaction.expired')
          : undefined;
        return projectInteraction(i, phase, label);
      });
    return [...base, ...projected];
  }, [transcript, state.interactions, state.interactionPhases, session.id, t]);

  // A stale snapshot never looks live: suppress streaming affordances.
  const streaming = online && (transcript?.streaming ?? false);
  const responding = new Set(
    Object.entries(state.interactionPhases)
      .filter(([, phase]) => phase === 'responding')
      .map(([interactionId]) => interactionId),
  );
  // Failed `interaction.respond` results surface inline under the transcript
  // so the card never looks like the click did nothing.
  const sessionInteractionErrors = Object.entries(state.interactionErrors)
    .filter(([interactionId]) => state.interactions.some(
      interaction => interaction.id === interactionId && interaction.session_id === session.id,
    ));

  const linkBehavior = useMemo(
    () =>
      createRemoteLinkBehavior({
        openFile: path =>
          actions.openFile({ id: path, sessionId: session.id, label: path.split('/').pop() ?? path }),
      }),
    [actions, session.id],
  );

  // The pending original bubble carries the gate's inline status row right
  // beneath it (same layout contract as local Gian's send echo).
  const sendGate = translation?.send ?? null;
  const echoTs = sendGate
    ? transcript?.items.find(item => item.id === `translation-echo:${sendGate.submissionId}`)?.ts
    : undefined;
  const translationExtras = sendGate && echoTs !== undefined
    ? [{
      id: `translation-send-row:${sendGate.requestId}`,
      afterTs: echoTs,
      node: (
        <TranslationSendRow
          sending={sendGate.phase === 'translating'
            ? { phase: 'translating' as const }
            : sendGate.phase === 'dispatching'
              ? { phase: 'dispatching' as const }
              : sendGate.phase === 'unknown'
                ? { phase: 'unknown' as const }
                : { phase: 'failed' as const, error: sendGate.error, timedOut: sendGate.timedOut }}
          timeoutSeconds={SEND_TRANSLATE_TIMEOUT_MS / 1000}
          onRetry={() => actions.retryTranslationSend(session.id)}
          onSendOriginal={() => actions.sendOriginalTranslation(session.id)}
          onReclaim={() => actions.reclaimTranslationSend(session.id)}
          onRefreshState={() => actions.refreshState()}
        />
      ),
    }]
    : undefined;

  return (
    <div className={`rw-chat-root${stale ? ' rw-stale' : ''}`}>
      <ConnectionBanner connection={state.connection} />
      {state.unknownCommandId && <UnknownOutcomeBanner commandId={state.unknownCommandId} />}
      <div className="main-scroll transcript-scroll">
        <div className="rw-chat">
          {!transcript?.hydrated && !transcript?.historyError && (
            <div className="rw-history-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('chat.history.loading')}
            </div>
          )}
          <LinkBehaviorContext.Provider value={linkBehavior}>
            <MessageAttachmentOpenContext.Provider
              value={(attachment) => actions.openFile({
                id: attachment.url,
                sessionId: session.id,
                label: attachment.name,
              })}
            >
              <ChatPanelOpenContext.Provider value={null}>
                <TranslationTextRetryContext.Provider
                  value={(recordId) => actions.retryTranslationText(session.id, recordId)}
                >
                <Transcript
                  items={items}
                  pending={streaming}
                  hydrated={transcript?.hydrated ?? false}
                  hasOlder={transcript?.hasOlder ?? false}
                  loadingOlder={transcript?.loadingOlder ?? false}
                  historyError={transcript?.historyError}
                  onLoadOlder={() => actions.loadOlderTranscript(session.id)}
                  onRetryHistory={() => actions.retryTranscript(session.id)}
                  {...(translationExtras ? { extras: translationExtras } : {})}
                  onApprove={interactionResponder((interactionId, actionId, values) => {
                    if (!online || responding.has(interactionId)) return;
                    actions.respondToInteraction(interactionId, actionId, values);
                  })}
                  renderAssistantFooterActions={translation
                    ? (item) => {
                      const key = `turn:${item.turn}`;
                      const expanded = isReadExpanded(translationUi, key);
                      const title = t('translation.to', { language: languageName(translationUi.readingLanguage) });
                      return (
                        <TranslationToggleButton
                          expanded={expanded}
                          ready
                          title={title}
                          onClick={() => actions.toggleReadTranslation(session.id, key, item.text)}
                        />
                      );
                    }
                    : undefined}
                  renderAssistantTranslation={translation
                    ? (item) => {
                      const key = `turn:${item.turn}`;
                      const value = readingValue(translationUi, key);
                      return (
                        <TranslationResultBlock
                          value={{
                            pending: value.pending,
                            ...(value.error
                              ? {
                                error: value.error === 'translation.loadFailed'
                                  ? t('translation.loadFailed')
                                  : value.error,
                              }
                              : {}),
                            ...(value.record
                              ? { text: value.record.text, targetLanguage: value.record.targetLanguage }
                              : {}),
                          }}
                          expanded={isReadExpanded(translationUi, key)}
                          onRetry={() => {
                            // A descriptor paging failure retries the fetch in
                            // place; a translation failure re-requests.
                            if (value.error === 'translation.loadFailed' && value.recordId) {
                              actions.retryTranslationText(session.id, value.recordId);
                              return;
                            }
                            actions.retryReadTranslation(session.id, key, item.text);
                          }}
                        />
                      );
                    }
                    : undefined}
                  renderItem={(item, ctx) =>
                    renderChatItem(item, {
                      ...ctx,
                      // `responding` renders the card disabled with the
                      // resolving affordance until the canonical result lands.
                      isApprovalResolving: (approvalId) => responding.has(approvalId),
                    })
                  }
                />
                </TranslationTextRetryContext.Provider>
              </ChatPanelOpenContext.Provider>
            </MessageAttachmentOpenContext.Provider>
          </LinkBehaviorContext.Provider>
          {sessionInteractionErrors.map(([interactionId, message]) => (
            <div key={interactionId} className="session-banner rw-danger" role="alert">
              {t('interaction.respondFailed')}: {message}
            </div>
          ))}
        </div>
      </div>
      <div className={mode === 'narrow' ? 'rw-m-bottom' : 'rw-bottom'}>
        {mode === 'narrow' ? <QueueCollapsedRow session={session} /> : <QueueDrawer session={session} />}
        <Composer session={session} />
        {stale && <div className="rw-offline-note">{t('chat.stale.note')}</div>}
      </div>
    </div>
  );
}

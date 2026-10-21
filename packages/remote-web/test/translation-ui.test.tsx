import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranscriptItem } from '@gian/chat-ui';
import { renderApp } from './render-app.js';
import { sampleCapabilities, sampleSessions, sampleTasks } from '../src/controller/fixture.js';
import { emptyDraft, type RemoteTranslationUiState } from '../src/controller/types.js';

const base = Date.now() - 600_000;

function transcript(): TranscriptItem[] {
  return [
    { kind: 'user', id: 'u-1', text: String.fromCodePoint(0x4f60, 0x597d, 0xff0c, 0x4e16, 0x754c), exec: 'codex', ts: base, turn: 1 },
    { kind: 'assistant', id: 'a-1', text: 'Hello back', exec: 'codex', ts: base + 1_000, turn: 1 },
    { kind: 'turn-end', id: 'te-1', text: '', outcome: 'worked', turn_id: 't-1', ts: base + 2_000, turn: 1 },
  ];
}

function hostData(translations?: Record<string, Partial<RemoteTranslationUiState>>) {
  return { 'host-home': {
    capabilities: sampleCapabilities(),
    tasks: sampleTasks(),
    sessions: sampleSessions(),
    transcripts: { 's-1': transcript() },
    ...(translations ? { translations } : {}),
  } };
}

const supported: Partial<RemoteTranslationUiState> = {
  supported: true,
  enabled: false,
  configured: true,
  sendingLanguage: 'en',
  readingLanguage: 'zh-CN',
};

describe('conversation translation UI', () => {
  it('hides every translation affordance when the Host did not negotiate the feature', () => {
    renderApp({ scenario: { hostData: hostData() }, viewport: 'wide' });
    expect(screen.queryByTestId('rw-translation-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: /Translate to/ })).toBeNull();
  });

  it('renders the Auto chip with the same icon/ARIA and flips only after the Host confirms', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { hostData: hostData({ 's-1': supported }) },
      viewport: 'wide',
    });
    const chip = screen.getByTestId('rw-translation-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveAttribute('title', 'Auto translate');
    await user.click(chip);
    expect(controller.state.translations['s-1']?.enabled).toBe(true);
    expect(screen.getByTestId('rw-translation-chip')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the configure-first hint instead of enabling when the Host reports no model', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: { hostData: hostData({ 's-1': { ...supported, configured: false } }) },
      viewport: 'wide',
    });
    await user.click(screen.getByTestId('rw-translation-chip'));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an available local translation Agent and model in Settings first.');
  });

  it('expands a cached reading translation under the original via the globe toggle and collapses it again', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { hostData: hostData({ 's-1': {
        ...supported,
        results: { 'turn:1': [{ id: 'tr-1', targetLanguage: 'zh-CN', text: String.fromCodePoint(0x8bd1, 0x6587, 0x5185, 0x5bb9), textLength: 4, textSha256: 'x', sourceSha256: 'x' }] },
      } }) },
      viewport: 'wide',
    });
    const toggle = screen.getByRole('button', { name: /Translate to/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.querySelector('svg[data-icon="globe"]')).not.toBeNull();
    expect(document.querySelector('.translation-block')).toBeNull();
    await user.click(toggle);
    expect(controller.state.translations['s-1']?.expandOverrides['turn:1']).toBe(true);
    const block = document.querySelector('.translation-block');
    expect(block).not.toBeNull();
    expect(block).toHaveTextContent(String.fromCodePoint(0x8bd1, 0x6587, 0x5185, 0x5bb9));
    expect(block).toHaveTextContent('Translation · Chinese (Simplified)');
    await user.click(screen.getByRole('button', { name: /Translate to/ }));
    expect(document.querySelector('.translation-block')).toBeNull();
  });

  it('renders the pending original bubble with the inline gate row, and reclaim removes both', async () => {
    const user = userEvent.setup();
    const withEcho: TranscriptItem[] = [
      ...transcript(),
      { kind: 'user', id: 'translation-echo:sub-1', text: String.fromCodePoint(0x539f, 0x6587, 0x6d88, 0x606f), exec: 'codex', ts: base + 3_000, turn: 2, pending: true, failed: true },
    ];
    const { controller } = renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: sampleCapabilities(),
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': withEcho },
        translations: { 's-1': {
          ...supported,
          enabled: true,
          send: { phase: 'failed', submissionId: 'sub-1', requestId: 'r-1', draft: { ...emptyDraft(), text: String.fromCodePoint(0x539f, 0x6587, 0x6d88, 0x606f) }, error: String.fromCodePoint(0x6a21, 0x578b, 0x9519, 0x8bef), timedOut: false },
        } },
      } } },
      viewport: 'wide',
    });
    // The pending original bubble is in the transcript and carries the
    // inline translation status row right beneath it (local-parity layout).
    expect(Array.from(document.querySelectorAll('.msg.user .msg-text')).some(node => node.textContent === String.fromCodePoint(0x539f, 0x6587, 0x6d88, 0x606f))).toBe(true);
    const row = document.querySelector('.translation-send-row');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent(String.fromCodePoint(0x6a21, 0x578b, 0x9519, 0x8bef));
    expect(row).toHaveTextContent('Retry translation');
    expect(row).toHaveTextContent('Send original');
    expect(row).toHaveTextContent('Take text back');
    await user.click(screen.getByRole('button', { name: 'Take text back' }));
    expect(controller.state.drafts['s-1']?.text).toBe(String.fromCodePoint(0x539f, 0x6587, 0x6d88, 0x606f));
    expect(controller.state.translations['s-1']?.send).toBeNull();
    expect(document.querySelector('.translation-send-row')).toBeNull();
    expect(Array.from(document.querySelectorAll('.msg.user .msg-text')).some(node => node.textContent === String.fromCodePoint(0x539f, 0x6587, 0x6d88, 0x606f))).toBe(false);
  });

  it('shows the translating echo row with the Send original shortcut (no failure actions)', () => {
    const withEcho: TranscriptItem[] = [
      ...transcript(),
      { kind: 'user', id: 'translation-echo:sub-2', text: String.fromCodePoint(0x6392, 0x961f, 0x7ffb, 0x8bd1), exec: 'codex', ts: base + 3_000, turn: 2, pending: true },
    ];
    renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: sampleCapabilities(),
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': withEcho },
        translations: { 's-1': {
          ...supported,
          enabled: true,
          send: { phase: 'translating', submissionId: 'sub-2', requestId: 'r-2', draft: { ...emptyDraft(), text: String.fromCodePoint(0x6392, 0x961f, 0x7ffb, 0x8bd1) } },
        } },
      } } },
      viewport: 'wide',
    });
    const row = document.querySelector('.translation-send-row');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('role', 'status');
    expect(row).toHaveTextContent('Translating');
    expect(row).toHaveTextContent('Send original');
    expect(row).not.toHaveTextContent('Retry translation');
  });

  it('shows the sent translation under the original user bubble', () => {
    const sent: TranscriptItem[] = [
      { kind: 'user', id: 'u-1', text: String.fromCodePoint(0x4f60, 0x597d, 0xff0c, 0x4e16, 0x754c), exec: 'codex', ts: base, turn: 1,
        translation: { text: 'Hello, world', targetLanguage: 'en' } },
      { kind: 'assistant', id: 'a-1', text: 'Hi', exec: 'codex', ts: base + 1_000, turn: 1 },
      { kind: 'turn-end', id: 'te-1', text: '', outcome: 'worked', turn_id: 't-1', ts: base + 2_000, turn: 1 },
    ];
    renderApp({
      scenario: { hostData: { 'host-home': {
        capabilities: sampleCapabilities(),
        tasks: sampleTasks(),
        sessions: sampleSessions(),
        transcripts: { 's-1': sent },
        translations: { 's-1': supported },
      } } },
      viewport: 'wide',
    });
    const sentBlock = document.querySelector('.translation-sent');
    expect(sentBlock).not.toBeNull();
    expect(sentBlock).toHaveTextContent('The translated text sent to the LM is shown below');
    expect(sentBlock).toHaveTextContent('Hello, world');
  });
});

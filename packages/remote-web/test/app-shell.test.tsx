import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('app shell', () => {
  it('the chat header names the conversation, where it lives and its state', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const header = document.querySelector('.main .rw-head') as HTMLElement;
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Wire verify:quick into the pre-push hook');
    expect(header).toHaveTextContent('Gian 0.5.4 release · Gian-Dev · gpt-5.3-codex');
    expect(header).toHaveTextContent('Running');
    // The computer appears in the switcher only, never in the header.
    expect(header).not.toHaveTextContent('MacBook Pro');
  });

  it('has no top bar with dead back/forward buttons and no icon dock', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(document.querySelector('.topbar, .dock, .icon-dock, .nav-dock')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });

  it('the computer switcher carries a textual state, not just a colored dot', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const selector = screen.getByRole('button', { name: 'Switch computer' });
    expect(selector.textContent).toContain('connected');
  });

  it('switching computer swaps sessions/tasks (state partitioned per computer)', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: 'Switch computer' }));
    await user.click(screen.getByRole('menuitemradio', { name: /iMac · Office/ }));
    expect(controller.state.currentHostId).toBe('host-work');
    // host-work fixtures have no sessions — home sessions must not leak over.
    expect(screen.queryAllByText('Wire verify:quick into the pre-push hook')).toHaveLength(0);
    expect(screen.getByText('No conversation open')).toBeInTheDocument();
    // switching back restores them
    await user.click(screen.getByRole('button', { name: 'Switch computer' }));
    await user.click(screen.getByRole('menuitemradio', { name: /MacBook Pro/ }));
    expect(controller.state.currentHostId).toBe('host-home');
    expect(screen.getAllByText('Wire verify:quick into the pre-push hook').length).toBeGreaterThan(0);
  });

  it('offline computer rows are marked with text in the switcher', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: 'Switch computer' }));
    const row = screen.getByRole('menuitemradio', { name: /Old ThinkPad/ });
    expect(row.textContent).toContain('offline');
  });

  it('nothing open: says what to do and offers New chat', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'empty' } }, viewport: 'wide' });
    expect(screen.getByText('No conversation open')).toBeInTheDocument();
    await user.click(within(document.querySelector('.main') as HTMLElement).getByRole('button', { name: 'New chat' }));
    expect(controller.state.view).toEqual({ kind: 'new-chat', presetTaskId: '' });
  });

  it('narrow chat header has the list button and the connection dot', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'narrow' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wire verify:quick into the pre-push hook');
    await user.click(screen.getByRole('button', { name: /Switch computer — connected/ }));
    expect(controller.state.mobilePage).toBe('rail');
  });
});

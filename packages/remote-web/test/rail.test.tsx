import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import { sampleCapabilities, sampleCatalog, sampleSessions, sampleTasks } from '../src/controller/fixture.js';

function sidebar(): HTMLElement {
  return document.querySelector('.sidebar') as HTMLElement;
}

describe('conversation rail', () => {
  it('starts with the computer switcher, New chat, search and the Tasks / Recent views', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const rail = within(sidebar());
    expect(rail.getByRole('button', { name: 'Switch computer' })).toBeInTheDocument();
    expect(rail.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(rail.getByRole('searchbox', { name: 'Search conversations' })).toBeInTheDocument();
    expect(rail.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    expect(rail.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'false');
    expect(rail.queryByText('Unassigned')).toBeNull();
  });

  it('Tasks lists every conversation of each open Task, finished ones too', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const rail = within(sidebar());
    expect(rail.getByText('Gian 0.5.4 release')).toBeInTheDocument();
    // Finished: never in the Doing snapshot, listed by the directory.
    expect(rail.getByText('Changelog draft for 0.5.4')).toBeInTheDocument();
    // A chat outside any Task and a closed Task's chat stay out of Tasks.
    expect(rail.queryByText('Why does the cache miss on cold start?')).toBeNull();
    expect(rail.queryByText('Notarization fix')).toBeNull();
  });

  it('Recent groups the last 7 days by repository', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('tab', { name: 'Recent' }));
    const rail = within(sidebar());
    expect(rail.getByText('Gian-Dev')).toHaveAttribute('class', 'rw-group-name');
    expect(rail.getByText('notes')).toBeInTheDocument();
    expect(rail.getByText('Why does the cache miss on cold start?')).toBeInTheDocument();
    expect(rail.queryByText('Notarization fix')).toBeNull();
  });

  it('search lists matches across Tasks and repositories, and Escape clears it', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    await user.type(search, 'notar');
    const rail = within(sidebar());
    expect(rail.queryByRole('tab', { name: 'Tasks' })).toBeNull();
    const hit = rail.getByRole('button', { name: /Notarization fix/ });
    expect(hit).toHaveTextContent('Gian 0.5.3 release · Gian-Dev');
    await user.type(search, 'zzz');
    expect(rail.getByText('No conversations match “notarzzz”.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(controller.state.directory?.query).toBe('');
    expect(rail.getByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens a conversation the snapshot does not carry', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('tab', { name: 'Recent' }));
    await user.click(screen.getByRole('button', { name: /Why does the cache miss on cold start\?/ }));
    expect(controller.state.view).toEqual({ kind: 'chat', sessionId: 's-5' });
    expect(controller.state.directory?.pinned).toContain('s-5');
    expect(screen.getByRole('heading', { level: 1, name: 'Why does the cache miss on cold start?' })).toBeInTheDocument();
  });

  it('a Host without the directory keeps the Doing Tasks only, without search or Recent', () => {
    const catalog = sampleCatalog();
    renderApp({
      scenario: { hostData: { 'host-home': { catalog, workspaces: catalog.workspaces, tasks: sampleTasks(),
        sessions: sampleSessions(), capabilities: sampleCapabilities() } } },
      viewport: 'wide',
    });
    const rail = within(sidebar());
    expect(rail.queryByRole('searchbox')).toBeNull();
    expect(rail.queryByRole('tab')).toBeNull();
    expect(rail.getByText('Gian 0.5.4 release')).toBeInTheDocument();
    expect(rail.getByText('Wire verify:quick into the pre-push hook')).toBeInTheDocument();
    expect(rail.queryByText('Changelog draft for 0.5.4')).toBeNull();
  });

  it('no task menu / pin / complete / archive actions exist', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(screen.queryByRole('button', { name: /Pinned|Pin|Mark complete|Archive/i })).toBeNull();
    expect(document.querySelector('.task-menu, .sb-menu, .sb-group-menu')).toBeNull();
  });

  it('task header + opens New chat with the task preselected', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getAllByTitle('New chat in this Task')[0]!);
    expect(controller.state.view).toEqual({ kind: 'new-chat', presetTaskId: 'task-1' });
  });

  it('the New chat button opens the form without a Task', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(within(sidebar()).getByRole('button', { name: 'New chat' }));
    expect(controller.state.view).toEqual({ kind: 'new-chat', presetTaskId: '' });
  });

  it('groups collapse with the disclosure pattern and show their count', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    const rail = within(sidebar());
    const task = rail.getByText('Gian 0.5.4 release').closest('.rw-group-head')!;
    expect(task).toHaveAttribute('aria-expanded', 'true');
    await user.click(task);
    expect(task).toHaveAttribute('aria-expanded', 'false');
    expect(rail.queryByText('Wire verify:quick into the pre-push hook')).toBeNull();
    expect(task).toHaveTextContent('3');
  });

  it('session rows carry an accessible status label', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const running = screen.getByRole('button', { name: /Wire verify:quick into the pre-push hook — Running/ });
    const pending = screen.getByRole('button', { name: /Remote Web protocol §12 review — Needs approval/ });
    const done = screen.getByRole('button', { name: /Model result review — Done/ });
    expect(running.querySelector('.gico.ring')).not.toBeNull();
    expect(pending.querySelector('.gico.unread.pend .gfill')).not.toBeNull();
    expect(done.querySelector('.gico.unread.done .gfill')).not.toBeNull();
    expect(done).not.toHaveTextContent('Done');
    // Rows without a state glyph show when they were last active instead.
    expect(screen.getByRole('button', { name: /Changelog draft for 0.5.4 — Done/ })).toHaveTextContent('Yesterday');
  });

  it('clicking a session navigates into chat', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: /Remote Web protocol §12 review/ }));
    expect(controller.state.view).toEqual({ kind: 'chat', sessionId: 's-2' });
  });

  it('narrow layout renders the rail as a full-screen page with a back button', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'narrow' });
    await user.click(screen.getByRole('button', { name: 'Conversations' }));
    expect(controller.state.mobilePage).toBe('rail');
    const page = document.querySelector('.rw-page[data-page="rail"]') as HTMLElement;
    expect(page).toBeInTheDocument();
    expect(within(page).getByRole('heading', { name: 'Conversations' })).toBeInTheDocument();
    expect(within(page).getByRole('button', { name: 'Switch computer' })).toBeInTheDocument();
    await user.click(within(page).getByRole('button', { name: 'Back' }));
    expect(controller.state.mobilePage).toBe('chat');
  });
});

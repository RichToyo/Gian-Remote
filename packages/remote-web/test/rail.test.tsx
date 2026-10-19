import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('conversation rail (B3)', () => {
  it('renders only the Doing Task hierarchy without an Unassigned surface', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const sidebar = document.querySelector('.sidebar')!;
    const rows = within(sidebar as HTMLElement);
    expect(rows.getByText('Doing')).toBeInTheDocument();
    expect(rows.queryByText('Unassigned')).toBeNull();
    // The sticky list heading replaces the obsolete Chats dropdown + global +.
    const first = sidebar.querySelector('.sb-scroll')!.firstElementChild!;
    expect(first).toHaveClass('sb-toprow');
    expect(first.textContent).toContain('Tasks');
    expect(rows.getByText('Gian 0.5.4 release')).toBeInTheDocument();
    expect(rows.queryByText('Weekend release checklist draft')).toBeNull();
    expect(sidebar.querySelector('.rw-newchat')).toBeNull();
  });

  it('no task menu / pin / complete / archive actions exist', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(screen.queryByRole('button', { name: /Pinned|Pin|Mark complete|Archive|Archive/i })).toBeNull();
    expect(document.querySelector('.task-menu, .sb-menu, .sb-group-menu')).toBeNull();
  });

  it('task header + opens New Chat with the task preselected', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getAllByTitle('New Chat (preselect this Task)')[0]!);
    expect(controller.state.view).toEqual({ kind: 'new-chat', presetTaskId: 'task-1' });
  });

  it('section and Task collapse state use the same disclosure pattern as local rails', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const rows = within(sidebar);

    const doing = screen.getByTestId('remote-section-doing');
    expect(doing).toHaveAttribute('aria-expanded', 'true');
    await user.click(doing);
    expect(doing).toHaveAttribute('aria-expanded', 'false');
    expect(rows.queryByText('Gian 0.5.4 release')).toBeNull();

    await user.click(doing);
    const task = rows.getByText('Gian 0.5.4 release').closest('.task-group')!;
    expect(task).toHaveAttribute('aria-expanded', 'true');
    await user.click(task);
    expect(task).toHaveAttribute('aria-expanded', 'false');
    expect(rows.queryByText('Wire verify:quick into the pre-push hook')).toBeNull();
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
    await user.click(screen.getByRole('button', { name: 'Session list' }));
    expect(controller.state.mobilePage).toBe('rail');
    const page = document.querySelector('.rw-page[data-page="rail"]')!;
    expect(page).toBeInTheDocument();
    expect(within(page as HTMLElement).getByText('Tasks', { selector: '.rw-page-title' })).toBeInTheDocument();
    await user.click(within(page as HTMLElement).getByRole('button', { name: 'Back' }));
    expect(controller.state.mobilePage).toBe('chat');
  });
});

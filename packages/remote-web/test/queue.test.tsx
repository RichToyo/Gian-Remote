import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import { sampleQueueEntry, sampleSession } from '../src/controller/fixture.js';
import type { RemoteQueueEntry } from '@gian/remote-protocol';

function queueDrawer(): HTMLElement {
  const el = document.querySelector('[data-testid="queue-drawer"]');
  if (!el) throw new Error('queue drawer not rendered');
  return el as HTMLElement;
}

function sampleQueueSessionWith(entry: RemoteQueueEntry) {
  return sampleSession({
    id: 's-1',
    name: 'Wire verify:quick into the pre-push hook',
    status: 'running',
    active_turn: { id: 'turn-1', turn_number: 3 },
    queue: { revision: 'qrev-1', entries: [entry] },
  });
}

describe('queue UI (B6)', () => {
  it('renders queued entries with stable height + internal scroll container', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const drawer = queueDrawer();
    expect(within(drawer).getByText("Don't forget the --base flag in the hook")).toBeInTheDocument();
    expect(drawer.querySelector('.qd-body')).not.toBeNull();
  });

  it('shows attachment/context/document summary chips', () => {
    const entry = {
      ...sampleQueueEntry('entry with attachments', 's-1'),
      items: [{ type: 'attachment' as const, attachment_id: 'a-1' }],
      context_items: [{ type: 'pasted_text' as const, text: 'snippet' }],
      composer_document: { type: 'document' as const, nodes: [{ type: 'text' as const, text: 'x' }] },
    };
    renderApp({
      scenario: {
        hostData: {
          'host-home': {
            sessions: [
              sampleQueueSessionWith(entry),
            ],
            tasks: [],
            transcripts: {},
          },
        },
        view: { kind: 'chat', sessionId: 's-1' },
      },
      viewport: 'wide',
    });
    const drawer = queueDrawer();
    expect(within(drawer).getByText('📎 1')).toBeInTheDocument();
    expect(within(drawer).getByText('@ 1')).toBeInTheDocument();
    expect(within(drawer).getByText('▤ doc')).toBeInTheDocument();
  });

  it('edit keeps the entry position and issues queue.update', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const drawer = queueDrawer();
    const rows = within(drawer).getAllByRole('button', { name: 'Edit' });
    await user.click(rows[1]!);
    const edit = within(drawer).getByRole('textbox', { name: 'Edit' });
    await user.clear(edit);
    await user.type(edit, 'rewritten second entry');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    controller.test.resolveAll();
    const entries = controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]!.text).toBe('rewritten second entry');
    expect(entries[0]!.text).toBe("Don't forget the --base flag in the hook");
  });

  it('remove / clear / send now map to their commands', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const drawer = queueDrawer();
    await user.click(within(drawer).getAllByRole('button', { name: 'Remove' })[0]!);
    controller.test.resolveAll();
    expect(controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries).toHaveLength(1);

    await user.click(within(queueDrawer()).getByRole('button', { name: 'Send now' }));
    controller.test.resolveAll();
    expect(controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries).toHaveLength(0);

    // queue emptied → drawer collapses
    expect(document.querySelector('[data-testid="queue-drawer"]')).toBeNull();
  });

  it('clear empties the queue', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(within(queueDrawer()).getByRole('button', { name: 'Clear' }));
    controller.test.resolveAll();
    expect(controller.state.sessions.find((s) => s.id === 's-1')!.queue.entries).toHaveLength(0);
  });

  it('a pending queue mutation disables queue actions (no double submit)', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    const drawer = queueDrawer();
    await user.click(within(drawer).getAllByRole('button', { name: 'Remove' })[0]!);
    expect(within(queueDrawer()).getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(within(queueDrawer()).getByRole('button', { name: 'Send now' })).toBeDisabled();
    expect(within(queueDrawer()).getAllByRole('button', { name: 'Remove' })[0]).toBeDisabled();
    controller.test.resolveAll();
    expect(within(queueDrawer()).getByRole('button', { name: 'Clear' })).toBeEnabled();
  });

  it('PRECONDITION_FAILED replaces the queue wholesale and shows the notice', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    controller.test.failNextQueueMutation(
      [
        sampleQueueEntry("Don't forget the --base flag in the hook; use it in the worktree", 's-1'),
        sampleQueueEntry('README Verification section edit (edited on iPhone)', 's-1'),
        sampleQueueEntry('Also clear the sample files under .git/hooks (from iPhone)', 's-1'),
      ],
      'qrev-2',
    );
    await user.click(within(queueDrawer()).getAllByRole('button', { name: 'Remove' })[0]!);
    controller.test.resolveAll();
    const session = controller.state.sessions.find((s) => s.id === 's-1')!;
    expect(session.queue.revision).toBe('qrev-2');
    expect(session.queue.entries).toHaveLength(3);
    expect(screen.getByText('Queue was updated elsewhere — refreshed')).toBeInTheDocument();
  });

  it('the replaced-remotely notice clears after the next queue change', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    controller.test.failNextQueueMutation([sampleQueueEntry('new queue', 's-1')], 'qrev-2');
    await user.click(within(queueDrawer()).getByRole('button', { name: 'Clear' }));
    controller.test.resolveAll();
    expect(screen.getByText('Queue was updated elsewhere — refreshed')).toBeInTheDocument();
    await user.click(within(queueDrawer()).getByRole('button', { name: 'Send now' }));
    controller.test.resolveAll();
    expect(screen.queryByText('Queue was updated elsewhere — refreshed')).toBeNull();
  });

  it('narrow layout collapses the queue into one summary row', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'narrow' });
    expect(document.querySelector('[data-testid="queue-drawer"]')).toBeNull();
    const collapsed = screen.getByRole('button', { name: /2 queued messages/ });
    await user.click(collapsed);
    expect(document.querySelector('[data-testid="queue-drawer"]')).not.toBeNull();
  });
});

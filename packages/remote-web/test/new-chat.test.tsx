import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import { sampleCatalog, sampleTasks } from '../src/controller/fixture.js';

function openNewChat() {
  return renderApp({
    scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } },
    viewport: 'wide',
  });
}

describe('new chat (B4)', () => {
  it('sends the selected catalog thinking level and resets it when the Agent changes', async () => {
    const user = userEvent.setup();
    const { controller } = openNewChat();
    const create = vi.spyOn(controller.actions, 'createSession');
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    const thinking = screen.getByRole('combobox', { name: 'Thinking' });
    await user.selectOptions(thinking, 'high');
    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByRole('combobox', { name: 'Thinking' })).toHaveValue('');
    const explicitHigh = Array.from((screen.getByRole('combobox', { name: 'Thinking' }) as HTMLSelectElement).options)
      .find(option => option.value === 'high')!;
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking' }), explicitHigh);
    await user.click(screen.getByRole('button', { name: 'Create and start' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-claude', thinking: 'high' }));
  });
  it('accepts an Agent catalog without the optional model list without crashing', async () => {
    const catalog = sampleCatalog();
    catalog.agents = catalog.agents.map(({ models: _models, ...agent }) => agent);
    renderApp({ scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' },
      hostData: { 'host-home': { catalog, workspaces: catalog.workspaces, tasks: sampleTasks() } } }, viewport: 'wide' });
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();
  });
  it('workspace + agent + Doing Task are required', async () => {
    const user = userEvent.setup();
    openNewChat();
    const create = screen.getByRole('button', { name: 'Create and start' });
    // workspace defaults to the first catalog workspace; agent is required
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(create).toBeEnabled();
  });

  it('cannot create an Unassigned Remote Session', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: { view: { kind: 'new-chat', presetTaskId: '' } },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByLabelText('Task')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeDisabled();
  });

  it('defaults come from the agent catalog (no guessed previous config)', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } }, viewport: 'wide' });
    const taskSelect = screen.getByLabelText('Task');
    expect((taskSelect as HTMLSelectElement).value).toBe('task-1');
    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByText(/claude-sonnet-4.6/)).toBeInTheDocument();
  });

  it('an unavailable agent cannot be selected', () => {
    openNewChat();
    expect(screen.getByRole('radio', { name: 'Kimi' })).toBeDisabled();
  });

  it('catalog invalidated blocks create until refreshed', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { view: { kind: 'new-chat', presetTaskId: 'task-1' } },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    controller.test.invalidateCatalog();
    expect(screen.getByText(/catalog changed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeDisabled();
    // crafted direct call is refused while invalidated
    controller.actions.createSession({ workspaceId: 'ws-1', agentId: 'agent-codex', taskId: 'task-1' });
    expect(controller.test.pendingCommandIds()).toHaveLength(0);
    controller.test.refreshCatalogResult(sampleCatalog());
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeEnabled();
  });

  it('host offline blocks create', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: {
        view: { kind: 'new-chat', presetTaskId: 'task-1' },
        connection: { kind: 'host_offline', lastSeenAt: Date.now() },
      },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByText('Host offline — sessions cannot be created right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeDisabled();
  });

  it('create pending → success enters chat only with the canonical session', async () => {
    const user = userEvent.setup();
    const { controller } = openNewChat();
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: 'Create and start' }));
    // pending: still on the form, button shows the waiting copy
    expect(screen.getByRole('button', { name: /Creating —/ })).toBeDisabled();
    expect(controller.state.view.kind).toBe('new-chat');
    controller.test.resolveAll();
    expect(controller.state.view.kind).toBe('chat');
    const view = controller.state.view as { sessionId: string };
    expect(controller.state.sessions.some((s) => s.id === view.sessionId)).toBe(true);
  });

  it('create error renders the failure and stays on the form', async () => {
    const user = userEvent.setup();
    const { controller } = openNewChat();
    controller.test.scriptCreate('error', 'workspace not available');
    await user.click(screen.getByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('button', { name: 'Create and start' }));
    controller.test.resolveAll();
    expect(controller.state.view.kind).toBe('new-chat');
    expect(screen.getByText('Create failed: workspace not available')).toBeInTheDocument();
  });
});

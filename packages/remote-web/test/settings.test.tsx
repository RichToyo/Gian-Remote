import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('remote settings (B9)', () => {
  it('adds a computer from Settings without disconnecting existing pairings', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'settings' } } });
    const hosts = controller.state.hosts;
    await user.click(screen.getByRole('button', { name: 'Add computer' }));
    expect(controller.state.addingHost).toBe(true);
    expect(controller.state.hosts).toEqual(hosts);
  });
  it('theme + accent controls apply to the document', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(document.body.dataset.theme).toBe('light');
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.body.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'rose' }));
    expect(document.body.dataset.accent).toBe('rose');
  });

  it('system theme resolves from the OS preference (jsdom stub reports light)', async () => {
    const user = userEvent.setup();
    renderApp({
      scenario: { view: { kind: 'settings' }, settings: { theme: 'dark', accent: 'azure' } },
      viewport: 'wide',
    });
    expect(document.body.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.body.dataset.theme).toBe('light');
  });

  it('lists host pairings; current host is badged', () => {
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(screen.getAllByText('MacBook Pro · Home').length).toBeGreaterThan(0);
    expect(screen.getByText('this one')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(3);
  });

  it('disconnect requires a second confirmation and removes the host', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    const row = document.querySelector('[data-host-id="host-lab"]')! as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    // first click only asks
    expect(controller.state.hosts.find((h) => h.id === 'host-lab')).toBeTruthy();
    expect(screen.getByText(/Remove Old ThinkPad · Lab\?/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(controller.state.hosts.find((h) => h.id === 'host-lab')).toBeUndefined();
  });

  it('disconnecting the current host switches to another online host', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    const row = document.querySelector('[data-host-id="host-home"]')! as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(controller.state.currentHostId).toBe('host-work');
  });

  it('sign out asks first, then leaves nothing of the pairings on screen', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { view: { kind: 'settings' }, snapshotReceivedAt: Date.now() },
      viewport: 'wide',
    });
    expect(screen.getByText(/Removes this browser from all your computers/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out of this browser' }));
    expect(controller.state.auth.kind).toBe('authenticated');
    expect(screen.getByRole('alertdialog', { name: 'Sign out of this browser' })).toHaveTextContent('has to be paired again');
    await user.click(screen.getAllByRole('button', { name: 'Sign out of this browser' })[0]!);
    expect(controller.state.auth.kind).toBe('pairing');
    expect(controller.state.hosts).toEqual([]);
    expect(controller.state.sessions).toEqual([]);
    expect(screen.queryByText('Wire verify:quick into the pre-push hook')).toBeNull();
  });

  it('no account section, no other-device management', () => {
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(screen.queryByText(/GitHub|Account|Account/i)).toBeNull();
    expect(screen.queryByText(/Other devices/i)).toBeNull();
  });

  it('narrow layout renders settings as a full-screen page', () => {
    renderApp({ scenario: { view: { kind: 'settings' }, mobilePage: 'settings' }, viewport: 'narrow' });
    expect(document.querySelector('.rw-page[data-page="settings"]')).not.toBeNull();
  });
});

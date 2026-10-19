import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import type { PairingFailure } from '../src/controller/types.js';

describe('pairing / auth pages (B1)', () => {
  it('offers Add computer in the selector and returns to existing pairings on cancel', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({});
    const hosts = controller.state.hosts;
    await user.click(screen.getByRole('button', { name: 'Switch Host' }));
    await user.click(screen.getByRole('menuitem', { name: 'Add computer' }));
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(controller.state.hosts).toEqual(hosts);
    expect(screen.getByRole('button', { name: 'Switch Host' })).toBeInTheDocument();
  });

  it('distinguishes computers with the same name and prompts for selection', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {
      currentHostId: null, snapshotReceivedAt: null,
      auth: { kind: 'challenge-login', hosts: [] },
      hosts: [
        { id: 'aaaaaaaa-1111', name: 'Gian Host', online: true, sessionCount: 0 },
        { id: 'bbbbbbbb-2222', name: 'Gian Host', online: true, sessionCount: 0 },
      ],
    } });
    expect(screen.getByText(/Choose a paired computer from the menu above/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch Host' }));
    expect(screen.getByRole('menuitemradio', { name: /Gian Host · aaaaaaaa/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Gian Host · bbbbbbbb/ })).toBeInTheDocument();
  });
  it('PC short-code page: 8 segmented boxes, security copy, no app shell', () => {
    renderApp({ scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } } });
    expect(document.querySelector('.topbar')).toBeNull();
    expect(document.querySelectorAll('.rw-code-ch')).toHaveLength(8);
    expect(screen.getByText(/still have to confirm in Gian on the Mac/)).toBeInTheDocument();
    expect(screen.queryByText(/access is granted as soon as you enter/)).toBeNull();
  });

  it('submitting a malformed code fails with invalid; exhausting attempts locks', async () => {
    const user = userEvent.setup();
    const { controller, unmount } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 2 } } },
    });
    await user.type(screen.getByRole('textbox', { name: 'Pairing code' }), 'notvalid');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'invalid' } });
    unmount();
    // Last remaining attempt → invalid code locks the flow.
    const second = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 1 } } },
    });
    await user.type(screen.getByRole('textbox', { name: 'Pairing code' }), 'stillbad');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(second.controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'attempt-limit' } });
    expect(screen.getByRole('button', { name: 'Try later' })).toBeDisabled();
  });

  it('valid code moves to waiting with cancel and a countdown', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } },
    });
    await user.type(screen.getByRole('textbox', { name: 'Pairing code' }), 'K7DM-F2Q9');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'waiting' } });
    expect(screen.getByText(/Waiting for Gian/)).toBeInTheDocument();
    expect(screen.getByText(/\d+:\d{2}/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'cancelled' } });
  });

  it('QR landing: host + editable device name, confirm then wait', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: {
        auth: { kind: 'pairing', pairing: { kind: 'qr-confirm', hostName: 'MacBook Pro · Home', deviceName: 'iPhone 17 Pro' } },
      },
    });
    expect(screen.getByText('MacBook Pro · Home')).toBeInTheDocument();
    const nameInput = screen.getByLabelText('Name of this device');
    await user.clear(nameInput);
    await user.type(nameInput, 'My phone');
    expect(controller.state.auth).toMatchObject({ pairing: { deviceName: 'My phone' } });
    await user.click(screen.getByRole('button', { name: 'Confirm pairing' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'waiting', deviceName: 'My phone' } });
  });

  it.each([false, true])('QR invitation copies the full link without claiming; clipboard failure=%s', async fail => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    if (fail) writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    else writeText.mockResolvedValueOnce(undefined);
    const pairingUrl = 'https://remote.test/#nonce=unclaimed-invitation-nonce';
    const { controller } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: {
        kind: 'qr-confirm', hostName: 'Home Mac', deviceName: 'This browser', pairingUrl,
      } } },
    });
    try {
      const link = screen.getByRole('textbox', { name: 'Pairing link' });
      expect(link).toHaveValue(pairingUrl);
      expect(link).toHaveAttribute('readonly');
      await user.click(screen.getByRole('button', { name: 'Copy pairing link' }));
      expect(writeText).toHaveBeenCalledWith(pairingUrl);
      expect(await screen.findByText(fail ? 'Could not copy. Select the link and copy it manually.' : 'Pairing link copied.')).toBeInTheDocument();
      expect(controller.state.auth).toMatchObject({ pairing: { kind: 'qr-confirm' } });
      await user.click(screen.getByRole('button', { name: 'Confirm pairing' }));
      expect(screen.queryByRole('textbox', { name: 'Pairing link' })).toBeNull();
    } finally { writeText.mockRestore(); }
  });

  it.each<[PairingFailure, string, string]>([
    ['cancelled', 'Pairing cancelled', 'Start over'],
    ['expired', 'Code expired', 'Re-enter code'],
    ['rejected', 'Pairing rejected', 'Start over'],
    ['attempt-limit', 'Too many attempts', 'Try later'],
    ['already-claimed', 'Code already used', 'Start over'],
    ['host-offline', 'Host is offline', 'Try again'],
  ])('failure terminal %s renders its own copy and action', async (reason, title, action) => {
    const user = userEvent.setup();
    const { controller, unmount } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'failed', reason } } },
    });
    expect(screen.getByText(title)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: action });
    if (reason === 'attempt-limit') {
      expect(button).toBeDisabled();
    } else {
      await user.click(button);
      expect(controller.state.auth).toMatchObject({ pairing: { kind: 'enter-code' } });
    }
    unmount();
  });

  it('challenge login stays in the shell instead of showing a standalone Host chooser', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { auth: { kind: 'challenge-login', hosts: [
        { id: 'host-home', name: 'MacBook Pro · Home', online: true, sessionCount: 6 },
      ] }, connection: { kind: 'resyncing', synced: 0, total: 1 }, snapshotReceivedAt: null },
    });
    expect(screen.queryByText('Sign in again in this browser')).toBeNull();
    expect(document.querySelector('.rw-app')).not.toBeNull();
    expect(screen.getByRole('status', { name: 'Connecting to Gian…' }))
      .toHaveTextContent('Restoring your secure Remote session.');
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Attach verify:quick to the pre-push hook')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Switch Host' }));
    await user.click(screen.getByRole('menuitemradio', { name: /MacBook Pro · Home/ }));
    expect(controller.state.auth.kind).toBe('authenticated');
  });
});

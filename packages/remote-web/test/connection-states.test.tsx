import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from './render-app.js';

describe('connection state matrix (B10)', () => {
  it('browser_offline: danger banner, wifi-off, offline tag', () => {
    renderApp({ scenario: { connection: { kind: 'browser_offline' } }, viewport: 'wide' });
    const banner = document.querySelector('[data-conn="browser_offline"]')!;
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain("You're offline");
    expect(banner.textContent).toContain('offline');
  });

  it('relay_reconnecting: info banner with attempt count', () => {
    renderApp({ scenario: { connection: { kind: 'relay_reconnecting', attempt: 2 } }, viewport: 'wide' });
    const banner = document.querySelector('[data-conn="relay_reconnecting"]')!;
    expect(banner.textContent).toContain('attempt 2');
    expect(banner.textContent).toContain('reconnecting');
  });

  it('host_offline: warn banner + not-live tag with time', () => {
    renderApp({
      scenario: { connection: { kind: 'host_offline', lastSeenAt: new Date(2026, 8, 1, 21, 2).getTime() } },
      viewport: 'wide',
    });
    const banner = document.querySelector('[data-conn="host_offline"]')!;
    expect(banner.textContent).toContain('21:02');
    expect(banner.textContent).toContain('not live');
  });

  it('resyncing: progress + mutations stay disabled', () => {
    renderApp({ scenario: { connection: { kind: 'resyncing', synced: 3, total: 8 } }, viewport: 'wide' });
    const banner = document.querySelector('[data-conn="resyncing"]')!;
    expect(banner.textContent).toContain('catching up');
    expect(screen.getByRole('button', { name: /Stop/ })).toBeDisabled();
  });

  it('version_mismatch: warn banner with versions + upgrade action', () => {
    renderApp({
      scenario: { connection: { kind: 'version_mismatch', requiredVersion: '0.5.4', hostVersion: '0.5.2' } },
      viewport: 'wide',
    });
    const banner = document.querySelector('[data-conn="version_mismatch"]')!;
    expect(banner.textContent).toContain('0.5.4');
    expect(banner.textContent).toContain('0.5.2');
    expect(screen.getByRole('button', { name: 'How to upgrade' })).toBeInTheDocument();
  });

  it('device_revoked: full-page card, no app shell, re-pair path', () => {
    renderApp({ scenario: { connection: { kind: 'device_revoked' } }, viewport: 'wide' });
    expect(document.querySelector('.rw-app')).toBeNull();
    expect(document.querySelector('[data-conn="device_revoked"]')).not.toBeNull();
    expect(screen.getByText('Pairing for this device was revoked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument();
  });

  it('device_revoked explains a lost browser key and a changed computer key differently', () => {
    const { unmount } = renderApp({ scenario: { connection: { kind: 'device_revoked', reason: 'key_missing' } }, viewport: 'wide' });
    expect(screen.getByText('This browser no longer has its key')).toBeInTheDocument();
    unmount();
    renderApp({ scenario: { connection: { kind: 'device_revoked', reason: 'host_key_changed' } }, viewport: 'wide' });
    expect(screen.getByText("The computer's encryption key changed")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument();
  });

  it('server_changed: full page with an explicit trust decision', async () => {
    const { controller } = renderApp({ scenario: { connection: { kind: 'server_changed' } }, viewport: 'wide' });
    expect(document.querySelector('.rw-app')).toBeNull();
    expect(screen.getByText('The Remote Server changed')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Trust the new server' }).click();
    expect(controller.state.connection.kind).toBe('online');
  });

  it('taken_over: says another tab holds the connection and offers to use it here', () => {
    const { controller } = renderApp({ scenario: { connection: { kind: 'taken_over' } }, viewport: 'wide' });
    const banner = document.querySelector('[data-conn="taken_over"]')!;
    expect(banner.textContent).toContain('open in another tab');
    expect(screen.getByRole('button', { name: 'Switch computer' }).textContent).toContain('paused in this tab');
    screen.getByRole('button', { name: 'Use here' }).click();
    expect(controller.state.connection.kind).toBe('online');
  });

  it('each non-online state renders a visually distinct banner (no collapse into host_offline)', () => {
    const kinds = [
      { scenario: { connection: { kind: 'browser_offline' } } as const, key: 'browser_offline' },
      { scenario: { connection: { kind: 'relay_reconnecting', attempt: 1 } } as const, key: 'relay_reconnecting' },
      { scenario: { connection: { kind: 'host_offline', lastSeenAt: Date.now() } } as const, key: 'host_offline' },
      { scenario: { connection: { kind: 'resyncing', synced: 1, total: 4 } } as const, key: 'resyncing' },
      { scenario: { connection: { kind: 'version_mismatch', requiredVersion: '0.5.4', hostVersion: '0.5.2' } } as const, key: 'version_mismatch' },
      { scenario: { connection: { kind: 'taken_over' } } as const, key: 'taken_over' },
    ];
    for (const { scenario, key } of kinds) {
      const { unmount } = renderApp({ scenario, viewport: 'wide' });
      const banner = document.querySelector(`[data-conn="${key}"]`);
      expect(banner, key).not.toBeNull();
      unmount();
    }
  });

  it('online state renders no connection banner', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(document.querySelector('[data-conn]')).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTH_PROTOCOL, generateCanonicalId } from '@gian/remote-protocol';
import { EnrollmentPage } from '../src/ui/enrollment.js';
import { LocaleProvider } from '../src/i18n/index.js';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

const show = () => render(<LocaleProvider locale="en"><EnrollmentPage /></LocaleProvider>);

type Call = { path: string; body?: Record<string, unknown>; csrf?: string | null };

function installFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      path,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      csrf: headers.get('x-gian-csrf'),
    };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

describe('password enrollment page', () => {
  it('asks for the deployer password and does not start GitHub or store the CSRF token', async () => {
    const calls = installFetch(call => {
      if (call.path.endsWith('/csrf')) return Response.json({ protocol: AUTH_PROTOCOL, csrf_token: 'csrf-raw' });
      return new Response('{}', { status: 401 });
    });
    show();
    const unlock = await screen.findByRole('button', { name: 'Unlock enrollment' });
    expect(unlock).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Remote control' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Generate enrollment token' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.map(call => call.path)).toEqual(['/api/v1/enrollment/csrf', '/api/v1/enrollment/session']);
    expect(calls.some(call => call.path.includes('account') || call.path.includes('github'))).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('rejects a wrong password, a disabled server, and a rate limit without issuing a token', async () => {
    const calls = installFetch(call => {
      if (call.path.endsWith('/csrf')) return Response.json({ protocol: AUTH_PROTOCOL, csrf_token: 'csrf-raw' });
      if (call.path.endsWith('/session')) return new Response('{}', { status: 401 });
      if (call.body?.password === 'nope') return new Response('{}', { status: 401 });
      if (call.body?.password === 'limited') return Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429 });
      return Response.json({ error: { code: 'ENROLLMENT_DISABLED' } }, { status: 403 });
    });
    show();
    const password = await screen.findByLabelText('Enrollment password');
    fireEvent.change(password, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock enrollment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That password was not accepted.');
    expect(calls.at(-1)?.csrf).toBe('csrf-raw');
    expect(calls.at(-1)?.body).toEqual({ protocol: AUTH_PROTOCOL, password: 'nope' });
    fireEvent.change(screen.getByLabelText('Enrollment password'), { target: { value: 'limited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock enrollment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    fireEvent.change(screen.getByLabelText('Enrollment password'), { target: { value: 'unset' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock enrollment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured');
    expect(calls.some(call => call.path.endsWith('/tokens'))).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('issues one token, shows expiry, and signs out only the enrollment session', async () => {
    let issued = 0;
    const calls = installFetch(call => {
      if (call.path.endsWith('/csrf')) return Response.json({ protocol: AUTH_PROTOCOL, csrf_token: 'csrf-raw' });
      if (call.path.endsWith('/session')) return new Response('{}', { status: 401 });
      if (call.path.endsWith('/login')) return Response.json({ protocol: AUTH_PROTOCOL, ok: true });
      if (call.path.endsWith('/logout')) return Response.json({ ok: true });
      issued += 1;
      return Response.json({
        protocol: AUTH_PROTOCOL,
        enrollment_id: generateCanonicalId(),
        enrollment_token: issued === 1 ? 'one-time-enrollment-secret' : 'second-secret',
        expires_at: issued === 1 ? Date.now() + 120_000 : Date.now() - 1,
      });
    });
    show();
    fireEvent.change(await screen.findByLabelText('Enrollment password'), { target: { value: 'page-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock enrollment' }));
    await screen.findByText('Enrollment unlocked');
    fireEvent.click(screen.getByRole('button', { name: 'Generate enrollment token' }));
    expect(await screen.findByDisplayValue('one-time-enrollment-secret')).toBeInTheDocument();
    expect(screen.getByText(/Single use/)).toBeInTheDocument();
    const mint = calls.find(call => call.path.endsWith('/tokens'));
    expect(mint?.csrf).toBe('csrf-raw');
    expect(mint?.body).toEqual({ protocol: AUTH_PROTOCOL });
    expect(mint?.body).not.toHaveProperty('github_account_id');
    fireEvent.click(screen.getByRole('button', { name: 'Generate another token' }));
    await waitFor(() => expect(screen.getByLabelText('Enrollment token')).toHaveValue(''));
    expect(screen.getByText('Expired')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Unlock enrollment' })).toBeDisabled();
    expect(calls.some(call => call.path.includes('account') || call.path.includes('github'))).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});

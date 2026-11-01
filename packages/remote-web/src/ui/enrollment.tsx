import { useEffect, useRef, useState } from 'react';
import { AUTH_PROTOCOL, adminCreateEnrollmentResultSchema, type AdminCreateEnrollmentResult } from '@gian/remote-protocol';
import { useT } from '../i18n/index.js';
import { Icon } from './icons.js';

const PREFIX = '/api/v1/enrollment';

class EnrollmentRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function request(path: string, body?: unknown, csrf?: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${PREFIX}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { 'x-gian-csrf': csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new EnrollmentRequestError('failed'); }
  if (response.ok) return response.json() as Promise<Record<string, unknown>>;
  let code = '';
  try { code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? ''; } catch { /* empty body */ }
  if (response.status === 429 || code === 'RATE_LIMITED') throw new EnrollmentRequestError('rateLimited');
  if (code === 'ENROLLMENT_DISABLED') throw new EnrollmentRequestError('disabled');
  if (response.status === 401) throw new EnrollmentRequestError('passwordRejected');
  if (response.status === 403) throw new EnrollmentRequestError('denied');
  throw new EnrollmentRequestError('failed');
}

function systemDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function EnrollmentPage() {
  const t = useT();
  const [signedIn, setSignedIn] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [token, setToken] = useState<AdminCreateEnrollmentResult | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState('');
  const csrf = useRef('');
  const generation = useRef(0);

  async function loadCsrf(): Promise<string> {
    const result = await request('/csrf');
    const next = String(result.csrf_token ?? '');
    csrf.current = next;
    return next;
  }

  useEffect(() => {
    const apply = () => {
      document.body.dataset.theme = systemDark() ? 'dark' : 'light';
      document.body.dataset.accent = 'azure';
    };
    apply();
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    query?.addEventListener('change', apply);
    const current = ++generation.current;
    void (async () => {
      try {
        await loadCsrf();
        await request('/session');
        if (current === generation.current) setSignedIn(true);
      } catch (reason) {
        if (current !== generation.current) return;
        if (reason instanceof EnrollmentRequestError && reason.code !== 'passwordRejected') setError(reason.code);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    })();
    return () => { ++generation.current; query?.removeEventListener('change', apply); };
  }, []);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [token]);

  async function unlock() {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const current = generation.current;
    try {
      const tokenValue = csrf.current || await loadCsrf();
      await request('/login', { protocol: AUTH_PROTOCOL, password }, tokenValue);
      if (current !== generation.current) return;
      setPassword('');
      setSignedIn(true);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof EnrollmentRequestError ? reason.code : 'failed');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError('');
    setToken(null);
    setCopied('');
    try {
      const tokenValue = csrf.current || await loadCsrf();
      const issued = adminCreateEnrollmentResultSchema.parse(await request('/tokens', { protocol: AUTH_PROTOCOL }, tokenValue));
      setNow(Date.now());
      setToken(issued);
    } catch (reason) {
      const code = reason instanceof EnrollmentRequestError ? reason.code : 'failed';
      setError(code);
      if (code === 'passwordRejected' || code === 'denied') setSignedIn(false);
    } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    setToken(null);
    setCopied('');
    try {
      const tokenValue = csrf.current || await loadCsrf();
      await request('/logout', {}, tokenValue);
      setSignedIn(false);
    } catch (reason) {
      setError(reason instanceof EnrollmentRequestError ? reason.code : 'failed');
    } finally { setBusy(false); }
  }

  async function copy(value: string, name: string) {
    try { await navigator.clipboard.writeText(value); setCopied(name); }
    catch { setError('copyFailed'); }
  }

  const seconds = token ? Math.max(0, Math.ceil((token.expires_at - now) / 1000)) : 0;
  const ttl = token ? Math.max(1, Math.round((seconds / 300) * 100)) : 0;

  return <main className="rw-enroll">
    <header className="rw-enroll-top">
      <a href="/" className="rw-enroll-back"><Icon name="back" size={14} />{t('enrollment.remote')}</a>
    </header>
    <section className="rw-enroll-card">
      <span className="rw-enroll-brand">Gian Remote</span>
      <h1 className="rw-enroll-title">{t('enrollment.title')}</h1>
      <p className="rw-enroll-sub">{t('enrollment.subtitle')}</p>

      <div className="rw-enroll-server">
        <span className="rw-enroll-server-url" title={window.location.origin}>{window.location.origin}</span>
        <button type="button" className="btn xs secondary" onClick={() => void copy(window.location.origin, 'server')}>
          {copied === 'server' ? t('enrollment.copied') : t('enrollment.copy')}
        </button>
      </div>

      {busy && !signedIn && <span role="status" className="spinner" aria-label={t('enrollment.pending')} />}
      {error && <p role="alert" className="rw-enroll-error">{t(`enrollment.${error}`)}</p>}

      {!busy && !signedIn && (
        <form className="rw-enroll-login" onSubmit={event => { event.preventDefault(); void unlock(); }}>
          <label className="rw-enroll-token-label" htmlFor="enrollment-password">{t('enrollment.password')}</label>
          <input id="enrollment-password" className="input" type="password" autoComplete="current-password"
            value={password} onChange={event => setPassword(event.target.value)} />
          <button type="submit" className="btn primary rw-enroll-cta" disabled={!password}>
            {t('enrollment.unlock')}
          </button>
        </form>
      )}

      {signedIn && (
        <div className="rw-enroll-account">
          <span className="rw-enroll-account-name">{t('enrollment.unlocked')}</span>
          <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void signOut()}>{t('enrollment.signOut')}</button>
        </div>
      )}

      {signedIn && !token && (
        <button type="button" className="btn primary rw-enroll-cta" disabled={busy} onClick={() => void generate()}>
          <Icon name="plus" size={13} />{t('enrollment.generate')}
        </button>
      )}

      {signedIn && token && (
        <div className="rw-enroll-token">
          <label className="rw-enroll-token-label" htmlFor="enrollment-token">Enrollment token</label>
          <div className="rw-enroll-token-row">
            <textarea id="enrollment-token" className="rw-enroll-token-value" readOnly rows={2}
              value={seconds > 0 ? token.enrollment_token : ''} aria-label="Enrollment token" />
            <button type="button" className="btn xs secondary" disabled={seconds === 0}
              onClick={() => void copy(token.enrollment_token, 'token')}>
              {copied === 'token' ? t('enrollment.copied') : t('enrollment.copy')}
            </button>
          </div>
          <div className="rw-enroll-ttl">
            <div className="rw-enroll-ttl-bar" aria-hidden="true">
              <div className="rw-enroll-ttl-fill" style={{ width: `${ttl}%` }} />
            </div>
            <span role="status" className="rw-enroll-ttl-text">
              {seconds > 0
                ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · ${t('enrollment.singleUse')}`
                : t('enrollment.expired')}
            </span>
          </div>
          <p className="rw-enroll-note">{t('enrollment.tokenHint')}</p>
          <button type="button" className="btn secondary rw-enroll-cta" disabled={busy} onClick={() => void generate()}>
            <Icon name="plus" size={13} />{t('enrollment.generateAgain')}
          </button>
        </div>
      )}
    </section>
  </main>;
}

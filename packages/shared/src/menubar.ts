import { FRAME_OPACITY_MIN, FRAME_OPACITY_MAX, type Accent } from './model.js';

/** Menubar v1. This boundary contains no credentials, native paths or transcript. */
export interface UsageSelection {
  mode: 'calendar' | 'rolling';
  period: 'day' | 'week' | 'month';
}

export type UsageCoverage = 'complete' | 'partial' | 'no_data';
export interface UsageTotals {
  totalTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface UsageGroup extends UsageTotals {
  /** null means unknown model or removed/unknown Agent, never the selected alias. */
  id: string | null;
  label: string;
  /** Actual execution Proxy identity; null selects the generic Agent icon. */
  pluginId: string | null;
}

export interface UsageBucket {
  from: number;
  to: number;
  tokens: number | null;
  coverage: UsageCoverage;
}

export interface UsageSummary extends UsageTotals {
  selection: UsageSelection;
  from: number;
  to: number;
  timezone: string;
  asOf: number;
  trackingStartedAt: number;
  generation: number;
  revision: number;
  coverage: UsageCoverage;
  byAgent: UsageGroup[];
  byModel: UsageGroup[];
  buckets: UsageBucket[];
}

export interface MenubarTodo {
  sessionId: string;
  /** Opaque freshness token; send back unchanged on navigation. */
  revision: string;
  title: string;
  agentId: string | null;
  pluginId: string | null;
  reason: 'approval' | 'reply' | 'failed' | 'unread';
}

export interface MenubarPending {
  pendingTotal: number;
  /** Snapshot defaults to 3 rows. getPending returns the full local projection. */
  pending: MenubarTodo[];
}

export interface MenubarSnapshot extends MenubarPending {
  asOf: number;
  today: UsageSummary;
  selectedRange: UsageSummary;
}

/** Whole Host refresh budget, including waiting for a query slot. */
export const OFFICIAL_QUOTA_REFRESH_TIMEOUT_MS = 35_000;

export interface OfficialQuotaWindow {
  id: string;
  label: string;
  usedRatio: number | null;
  resetAt: number | null;
  windowDurationMinutes: number | null;
}

export interface OfficialQuotaBalance {
  currency: string;
  total: string;
  granted: string | null;
  toppedUp: string | null;
}

export interface OfficialQuotaAccount {
  /** Explicitly separate the helper CLI login from the session Runtime login. */
  source?: 'cli';
  accountKey: string;
  agentIds: string[];
  pluginId: string;
  label: string;
  eligibility: 'eligible' | 'unverified' | 'auth_required' | 'unsupported' | 'not_implemented';
  status: 'ready' | 'unverified' | 'loading' | 'stale' | 'auth_required' | 'unsupported' | 'not_implemented' | 'error';
  fetchedAt: number | null;
  freshness: 'fresh' | 'stale' | 'none';
  /** Bounded English error code, not a Provider response or exception message. */
  error: 'unavailable' | 'auth_required' | 'rate_limited' | 'timeout' | 'invalid_response' | null;
  windows: OfficialQuotaWindow[];
  balances: OfficialQuotaBalance[];
}

export interface OfficialQuotaSnapshot {
  asOf: number;
  /** Installed official Proxy candidates are unverified until queried.
   * Positively identified third-party configurations are excluded. */
  accounts: OfficialQuotaAccount[];
}

export interface MenubarPreferences {
  showTokens: boolean;
  showTodoCount: boolean;
  selection: UsageSelection;
}

export interface MenubarAppearance {
  theme: 'light' | 'warm' | 'dark';
  accent: Accent;
  frameOpacity: number;
}

export type MenubarChange =
  | { type: 'local' }
  | { type: 'quota' }
  | { type: 'opened' }
  | { type: 'appearance'; appearance: MenubarAppearance };

/** Renderer cache reads are passive. refreshQuota explicitly queries one
 * account; the Host independently schedules background account refreshes. */
export interface GianMenubarBridge {
  getSnapshot(selection: UsageSelection): Promise<MenubarSnapshot>;
  getPending(): Promise<MenubarPending>;
  getQuota(): Promise<OfficialQuotaSnapshot>;
  refreshQuota(agentId: string): Promise<OfficialQuotaSnapshot>;
  getPreferences(): Promise<MenubarPreferences>;
  setPreferences(preferences: MenubarPreferences): Promise<MenubarPreferences>;
  getAppearance(): Promise<MenubarAppearance>;
  navigate(input: { sessionId: string; revision: string }): Promise<boolean>;
  clearUsage(input: { generation: number; idempotencyKey: string }): Promise<{ generation: number }>;
  hide(): Promise<void>;
  onChanged(listener: (change: MenubarChange) => void): () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => key in value);
}

export function isUsageSelection(value: unknown): value is UsageSelection {
  return record(value) && exact(value, ['mode', 'period'])
    && (value.mode === 'calendar' || value.mode === 'rolling')
    && (value.period === 'day' || value.period === 'week' || value.period === 'month');
}

export function isMenubarPreferences(value: unknown): value is MenubarPreferences {
  return record(value) && exact(value, ['showTokens', 'showTodoCount', 'selection'])
    && typeof value.showTokens === 'boolean' && typeof value.showTodoCount === 'boolean'
    && isUsageSelection(value.selection);
}

export function isMenubarNavigation(value: unknown): value is { sessionId: string; revision: string } {
  return record(value) && exact(value, ['sessionId', 'revision'])
    && isMenubarId(value.sessionId) && typeof value.revision === 'string'
    && value.revision.length > 0 && value.revision.length <= 256 && !value.revision.includes('\0');
}

export function isMenubarId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
}

export function isUsageClearRequest(value: unknown): value is { generation: number; idempotencyKey: string } {
  return record(value) && exact(value, ['generation', 'idempotencyKey'])
    && Number.isSafeInteger(value.generation) && (value.generation as number) >= 1
    && isMenubarId(value.idempotencyKey);
}

const MENUBAR_ACCENTS = {
  rose: true, ember: true, citron: true, moss: true,
  teal: true, azure: true, ink: true, plum: true,
} satisfies Record<Accent, boolean>;

export function isMenubarAppearance(value: unknown): value is MenubarAppearance {
  return record(value) && exact(value, ['theme', 'accent', 'frameOpacity'])
    && (value.theme === 'light' || value.theme === 'warm' || value.theme === 'dark')
    && typeof value.accent === 'string' && Object.hasOwn(MENUBAR_ACCENTS, value.accent)
    && typeof value.frameOpacity === 'number' && Number.isInteger(value.frameOpacity)
    && value.frameOpacity >= FRAME_OPACITY_MIN && value.frameOpacity <= FRAME_OPACITY_MAX;
}

export function isMenubarChange(value: unknown): value is MenubarChange {
  if (!record(value)) return false;
  return value.type === 'appearance'
    ? exact(value, ['type', 'appearance']) && isMenubarAppearance(value.appearance)
    : exact(value, ['type']) && (value.type === 'local' || value.type === 'quota' || value.type === 'opened');
}

/** Shared attention semantics; a domain projection can supply actual interaction facts. */
export function sessionNeedsAttention(
  session: { status: string; unread: number },
  hasPendingInteraction = session.status === 'pending',
): boolean {
  return hasPendingInteraction
    || ((session.status === 'done' || session.status === 'error') && session.unread === 1);
}

const TOTAL_KEYS = ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && Array.from(value).length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function totals(value: Record<string, unknown>): boolean {
  return integer(value.totalTokens) && TOTAL_KEYS.slice(1).every(key => value[key] === null || integer(value[key]));
}
function coverage(value: unknown): boolean { return value === 'complete' || value === 'partial' || value === 'no_data'; }

export function isMenubarPending(value: unknown): value is MenubarPending {
  return record(value) && exact(value, ['pendingTotal', 'pending']) && integer(value.pendingTotal)
    && Array.isArray(value.pending) && value.pending.length <= value.pendingTotal
    && value.pending.every(item => record(item) && exact(item, ['sessionId', 'revision', 'title', 'agentId', 'pluginId', 'reason'])
      && isMenubarNavigation({ sessionId: item.sessionId, revision: item.revision }) && text(item.title, 120)
      && (item.agentId === null || isMenubarId(item.agentId)) && (item.pluginId === null || isMenubarId(item.pluginId))
      && ['approval', 'reply', 'failed', 'unread'].includes(String(item.reason)));
}

export function isUsageSummary(value: unknown): value is UsageSummary {
  if (!record(value) || !exact(value, [...TOTAL_KEYS, 'selection', 'from', 'to', 'timezone', 'asOf', 'trackingStartedAt', 'generation', 'revision', 'coverage', 'byAgent', 'byModel', 'buckets'])
    || !totals(value) || !isUsageSelection(value.selection) || !integer(value.from) || !integer(value.to)
    || value.to < value.from || !text(value.timezone, 64) || !integer(value.asOf) || value.asOf !== value.to
    || !integer(value.trackingStartedAt) || !integer(value.generation) || value.generation < 1
    || !integer(value.revision) || !coverage(value.coverage)) return false;
  const group = (item: unknown) => record(item) && exact(item, [...TOTAL_KEYS, 'id', 'label', 'pluginId'])
    && totals(item) && (item.id === null || text(item.id)) && text(item.label)
    && (item.pluginId === null || isMenubarId(item.pluginId));
  if (!Array.isArray(value.byAgent) || !value.byAgent.every(group) || !Array.isArray(value.byModel) || !value.byModel.every(group)
    || !Array.isArray(value.buckets) || value.buckets.length > 800) return false;
  let end = value.from;
  let sum = 0;
  for (const bucket of value.buckets) {
    if (!record(bucket) || !exact(bucket, ['from', 'to', 'tokens', 'coverage'])
      || bucket.from !== end || !integer(bucket.to) || bucket.to < end || bucket.to > value.to
      || (bucket.tokens !== null && !integer(bucket.tokens)) || !coverage(bucket.coverage)
      || (bucket.tokens === null && bucket.coverage !== 'no_data')) return false;
    end = bucket.to;
    sum += (bucket.tokens as number | null) ?? 0;
  }
  return end === value.to && integer(sum) && sum === value.totalTokens;
}

export function isMenubarSnapshot(value: unknown): value is MenubarSnapshot {
  return record(value) && exact(value, ['asOf', 'today', 'selectedRange', 'pendingTotal', 'pending']) && integer(value.asOf)
    && isUsageSummary(value.today) && isUsageSummary(value.selectedRange)
    && value.today.asOf === value.asOf && value.selectedRange.asOf === value.asOf
    && value.today.generation === value.selectedRange.generation && value.today.revision === value.selectedRange.revision
    && isMenubarPending({ pendingTotal: value.pendingTotal, pending: value.pending });
}

const DECIMAL = /^-?\d{1,30}(?:\.\d{1,12})?$/u;
export function isOfficialQuotaData(value: unknown): value is { windows: OfficialQuotaWindow[]; balances: OfficialQuotaBalance[] } {
  return record(value) && exact(value, ['windows', 'balances']) && Array.isArray(value.windows) && value.windows.length <= 64
    && value.windows.every(window => record(window) && exact(window, ['id', 'label', 'usedRatio', 'resetAt', 'windowDurationMinutes'])
      && text(window.id) && text(window.label)
      && (window.usedRatio === null || typeof window.usedRatio === 'number' && Number.isFinite(window.usedRatio) && window.usedRatio >= 0 && window.usedRatio <= 1)
      && (window.resetAt === null || integer(window.resetAt)) && (window.windowDurationMinutes === null || integer(window.windowDurationMinutes)))
    && Array.isArray(value.balances) && value.balances.length <= 16
    && value.balances.every(balance => record(balance) && exact(balance, ['currency', 'total', 'granted', 'toppedUp'])
      && typeof balance.currency === 'string' && /^[A-Z]{3}$/u.test(balance.currency)
      && typeof balance.total === 'string' && DECIMAL.test(balance.total)
      && [balance.granted, balance.toppedUp].every(amount => amount === null || typeof amount === 'string' && DECIMAL.test(amount)));
}

export function isOfficialQuotaSnapshot(value: unknown): value is OfficialQuotaSnapshot {
  return record(value) && exact(value, ['asOf', 'accounts']) && integer(value.asOf) && Array.isArray(value.accounts)
    && value.accounts.length <= 1_000 && value.accounts.every(account => record(account)
      && exact(account, ['accountKey', 'agentIds', 'pluginId', 'label', 'eligibility', 'status', 'fetchedAt', 'freshness', 'error', 'windows', 'balances',
        ...(Object.hasOwn(account, 'source') ? ['source'] : [])])
      && (!Object.hasOwn(account, 'source') || account.source === 'cli')
      && isMenubarId(account.accountKey) && Array.isArray(account.agentIds) && account.agentIds.every(isMenubarId)
      && isMenubarId(account.pluginId) && text(account.label)
      && ['eligible', 'unverified', 'auth_required', 'unsupported', 'not_implemented'].includes(String(account.eligibility))
      && ['ready', 'unverified', 'loading', 'stale', 'auth_required', 'unsupported', 'not_implemented', 'error'].includes(String(account.status))
      && (account.fetchedAt === null || integer(account.fetchedAt))
      && ['fresh', 'stale', 'none'].includes(String(account.freshness))
      && (account.error === null || ['unavailable', 'auth_required', 'rate_limited', 'timeout', 'invalid_response'].includes(String(account.error)))
      && isOfficialQuotaData({ windows: account.windows, balances: account.balances })
      && (!['unverified', 'not_implemented', 'unsupported', 'auth_required'].includes(String(account.status))
        || Array.isArray(account.windows) && Array.isArray(account.balances)
          && account.windows.length + account.balances.length === 0));
}

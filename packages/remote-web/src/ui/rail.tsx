/**
 * Conversation rail. The computer switcher sits on top, then New chat,
 * search and two views over the Host's conversation directory:
 *
 * - Tasks: every conversation of each open Task, finished ones included.
 * - Recent: conversations with activity in the last 7 days (or still
 *   running / waiting), grouped by repository.
 *
 * Hosts that predate the directory (wire.session_directory_v1) keep the old
 * behaviour: only the Doing snapshot's open Tasks, no Recent, no search.
 * Narrow layouts show the same body as a full page, not a drawer.
 */

import { useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { RemoteDirectoryEntry, RemoteSession } from '@gian/remote-protocol';
import type { DirectoryListState, RemoteUiState } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { formatRelativeTime, workspaceLabel } from './format.js';
import { HostSelector } from './host-selector.js';
import { Icon } from './icons.js';
import { HeaderButton, PageHeader } from './page.js';
import { ProxyLogo } from './proxy-logo.js';
import { RemoteStatusIcon, remoteStatusGlyphShown } from './session-status.js';
import { useViewportMode } from './viewport.js';

interface RowModel {
  id: string;
  name: string;
  status: RemoteSession['status'];
  unread: boolean;
  waiting: boolean;
  proxy: string;
  agentName: string;
  activity: number | null;
  taskId: string | null;
  taskName: string | null;
  workspaceId: string;
  workspaceName: string;
}

function pendingInteraction(state: RemoteUiState, sessionId: string): boolean {
  return state.interactions.some(interaction => interaction.session_id === sessionId
    && (state.interactionPhases[interaction.id] ?? 'pending') === 'pending');
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Directory rows are a read at one moment; the live snapshot wins for the
 *  sessions it carries (status, unread, name, waiting). */
function rowFromEntry(state: RemoteUiState, entry: RemoteDirectoryEntry): RowModel {
  const live = state.sessions.find(session => session.id === entry.id);
  return {
    id: entry.id,
    name: live?.name ?? entry.name ?? 'Untitled chat',
    status: live?.status ?? entry.status,
    unread: live?.unread ?? entry.unread,
    waiting: pendingInteraction(state, entry.id) || (!live && entry.waiting_for_user),
    proxy: entry.agent.proxy,
    agentName: entry.agent.name,
    activity: entry.last_activity_at,
    taskId: entry.task?.id ?? null,
    taskName: entry.task?.name ?? null,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.name,
  };
}

function rowFromSession(state: RemoteUiState, session: RemoteSession): RowModel {
  const task = session.task_id ? state.tasks.find(item => item.id === session.task_id) : undefined;
  const workspace = state.workspaces.find(item => item.id === session.workspace_id);
  return {
    id: session.id,
    name: session.name ?? 'Untitled chat',
    status: session.status,
    unread: session.unread === true,
    waiting: pendingInteraction(state, session.id),
    proxy: session.agent.proxy,
    agentName: session.agent.name,
    activity: parseTime(session.updated_at),
    taskId: session.task_id,
    taskName: task?.name ?? null,
    workspaceId: session.workspace_id,
    workspaceName: workspace?.name ?? '',
  };
}

const byActivity = (left: RowModel, right: RowModel) => (right.activity ?? 0) - (left.activity ?? 0);

function statusLabelKey(row: RowModel, stale: boolean): string {
  if (stale) return 'session.status.stale';
  if (row.status === 'running') return 'session.status.running';
  if (row.status === 'pending') return 'session.status.pending';
  if (row.waiting) return 'session.status.waiting';
  if (row.status === 'error') return 'session.status.error';
  return 'session.status.done';
}

function SessionRow({ row, stale, subtitle }: { row: RowModel; stale: boolean; subtitle?: string }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const active = state.view.kind === 'chat' && state.view.sessionId === row.id;
  const glyphStatus: RemoteSession['status'] = row.waiting && row.status !== 'running' ? 'pending' : row.status;
  const showStatus = remoteStatusGlyphShown(glyphStatus, row.unread, stale);
  const open = () => {
    actions.selectSession(row.id);
    if (mode === 'narrow') actions.openMobilePage('chat');
  };
  return (
    <div
      className={`rw-row${active ? ' active' : ''}${row.status === 'running' && !stale ? ' is-running' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      aria-label={`${row.name} — ${t(statusLabelKey(row, stale))}`}
      data-session-id={row.id}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      <ProxyLogo proxy={row.proxy} name={row.agentName} size={14} />
      <span className="rw-row-main">
        <span className="rw-row-title">{row.name}</span>
        {subtitle && <span className="rw-row-sub">{subtitle}</span>}
      </span>
      <span className="rw-row-side">
        {showStatus
          ? <RemoteStatusIcon status={glyphStatus} unread={row.unread || row.waiting} />
          : <span className="rw-row-time">{formatRelativeTime(row.activity)}</span>}
      </span>
    </div>
  );
}

const TASKS_COLLAPSED_KEY = 'gian.remote.rail.tasks.collapsed';
const REPOS_COLLAPSED_KEY = 'gian.remote.rail.repos.collapsed';

function storedSet(key: string): Set<string> {
  try {
    const value = localStorage.getItem(key);
    return new Set<string>(value ? JSON.parse(value) as string[] : []);
  } catch {
    return new Set();
  }
}

function toggleStored(id: string, key: string, setter: Dispatch<SetStateAction<Set<string>>>): void {
  setter((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });
}

function useStoredSet(key: string): [Set<string>, (id: string) => void] {
  const [value, setValue] = useState<Set<string>>(() => storedSet(key));
  return [value, (id: string) => toggleStored(id, key, setValue)];
}

function Group({
  label,
  title,
  rows,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  stale,
  emptyLabel,
}: {
  label: string;
  title?: string;
  rows: RowModel[];
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  stale: boolean;
  emptyLabel?: string;
}) {
  return (
    <div className="rw-group">
      <div
        className={`rw-group-head${collapsed ? '' : ' open'}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={title}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="rw-group-caret" aria-hidden="true">
          <Icon name={collapsed ? 'caret-right' : 'caret-down'} size={11} />
        </span>
        <span className="rw-group-name">{label}</span>
        {collapsed && rows.length > 0 && <span className="rw-group-count">{rows.length}</span>}
        {onAdd && (
          <button
            type="button"
            className="rw-group-add"
            title={addTitle}
            aria-label={addTitle}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {!collapsed && rows.map(row => <SessionRow key={row.id} row={row} stale={stale} />)}
      {!collapsed && rows.length === 0 && emptyLabel && <div className="rw-group-empty">{emptyLabel}</div>}
    </div>
  );
}

function ListStatus({ list, onRetry, onMore }: { list: DirectoryListState; onRetry: () => void; onMore: () => void }) {
  const t = useT();
  if (list.status === 'loading') {
    return (
      <div className="rw-list-status" role="status">
        <span className="spinner" aria-hidden="true" />
        {t('rail.loading')}
      </div>
    );
  }
  if (list.status === 'error') {
    return (
      <div className="rw-list-status error" role="alert">
        <span>{t('rail.loadFailed')}</span>
        <button type="button" className="btn xs secondary" onClick={onRetry}>{t('common.retry')}</button>
      </div>
    );
  }
  if (list.status === 'incomplete') {
    return (
      <div className="rw-list-status">
        <button type="button" className="btn xs ghost" onClick={onMore}>{t('rail.loadMore')}</button>
      </div>
    );
  }
  return null;
}

function TasksView({ stale }: { stale: boolean }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const [collapsed, toggle] = useStoredSet(TASKS_COLLAPSED_KEY);
  const directory = state.directory;
  const supported = directory?.supported === true;
  const list = supported ? directory!.lists.tasks : undefined;

  const groups = useMemo(() => {
    const byTask = new Map<string, { id: string; name: string; rows: RowModel[]; updated: number }>();
    const ensure = (id: string, name: string, updated = 0) => {
      const existing = byTask.get(id);
      if (existing) return existing;
      const created = { id, name, rows: [] as RowModel[], updated };
      byTask.set(id, created);
      return created;
    };
    // Open Tasks from the snapshot, even before (or without) conversations.
    for (const task of state.tasks) ensure(task.id, task.name, parseTime(task.updated_at) ?? 0);
    const seen = new Set<string>();
    for (const entry of list?.entries ?? []) {
      if (!entry.task || entry.task.status !== 'open') continue;
      ensure(entry.task.id, entry.task.name).rows.push(rowFromEntry(state, entry));
      seen.add(entry.id);
    }
    // Live sessions the last directory read has not caught up with yet.
    for (const session of state.sessions) {
      if (seen.has(session.id) || !session.task_id) continue;
      const task = state.tasks.find(item => item.id === session.task_id);
      if (!task) continue;
      ensure(task.id, task.name).rows.push(rowFromSession(state, session));
    }
    const result = [...byTask.values()];
    if (!supported) return result;
    for (const group of result) {
      group.rows.sort(byActivity);
      group.updated = Math.max(group.updated, ...group.rows.map(row => row.activity ?? 0));
    }
    return result.sort((left, right) => right.updated - left.updated);
  }, [state, supported, list?.entries]);

  const status = list && list.status !== 'complete' && list.status !== 'idle'
    ? <ListStatus list={list} onRetry={() => actions.refreshDirectory()} onMore={() => actions.loadMoreDirectory('tasks')} />
    : null;
  if (groups.length === 0) {
    return status ?? <div className="rw-rail-empty">{t('rail.tasks.empty')}</div>;
  }
  return (
    <>
      {groups.map(group => (
        <Group
          key={group.id}
          label={group.name}
          rows={group.rows}
          collapsed={collapsed.has(group.id)}
          onToggle={() => toggle(group.id)}
          onAdd={state.capabilities['session.create']?.state === 'supported' ? () => {
            actions.openNewChat(group.id);
            if (mode === 'narrow') actions.openMobilePage('new-chat');
          } : undefined}
          addTitle={t('rail.newChatForTask')}
          stale={stale}
          emptyLabel={t('rail.task.empty')}
        />
      ))}
      {status}
    </>
  );
}

function RecentView({ stale }: { stale: boolean }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [collapsed, toggle] = useStoredSet(REPOS_COLLAPSED_KEY);
  const list = state.directory?.lists.repos;
  const groups = useMemo(() => {
    const byWorkspace = new Map<string, { id: string; name: string; rows: RowModel[] }>();
    for (const entry of list?.entries ?? []) {
      const group = byWorkspace.get(entry.workspace.id)
        ?? { id: entry.workspace.id, name: entry.workspace.name, rows: [] };
      group.rows.push(rowFromEntry(state, entry));
      byWorkspace.set(entry.workspace.id, group);
    }
    const result = [...byWorkspace.values()];
    for (const group of result) group.rows.sort(byActivity);
    return result.sort((left, right) => (right.rows[0]?.activity ?? 0) - (left.rows[0]?.activity ?? 0));
  }, [state, list?.entries]);
  return (
    <>
      {groups.map(group => (
        <Group
          key={group.id}
          label={workspaceLabel(group.name)}
          title={group.name}
          rows={group.rows}
          collapsed={collapsed.has(group.id)}
          onToggle={() => toggle(group.id)}
          stale={stale}
        />
      ))}
      {groups.length === 0 && list?.status === 'complete' && <div className="rw-rail-empty">{t('rail.recent.empty')}</div>}
      {list && <ListStatus list={list} onRetry={() => actions.refreshDirectory()} onMore={() => actions.loadMoreDirectory('repos')} />}
    </>
  );
}

function SearchView({ stale }: { stale: boolean }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const directory = state.directory!;
  const list = directory.lists.search;
  const rows = useMemo(() => list.entries.map(entry => rowFromEntry(state, entry)).sort(byActivity),
    [state, list.entries]);
  const current = list.query === directory.query.trim();
  return (
    <div className="rw-search-results" aria-live="polite">
      {rows.map(row => {
        const subtitle = [row.taskName, workspaceLabel(row.workspaceName)].filter(Boolean).join(' · ');
        return <SessionRow key={row.id} row={row} stale={stale} subtitle={subtitle} />;
      })}
      {rows.length === 0 && list.status === 'complete' && current && (
        <div className="rw-rail-empty">{t('rail.search.empty', { query: directory.query.trim() })}</div>
      )}
      <ListStatus list={list} onRetry={() => actions.setDirectoryQuery(directory.query)} onMore={() => actions.loadMoreDirectory('search')} />
    </div>
  );
}

function SearchField() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const query = state.directory?.query ?? '';
  return (
    <label className="rw-search">
      <Icon name="search" size={13} />
      <input
        type="search"
        value={query}
        placeholder={t('rail.search.placeholder')}
        aria-label={t('rail.search.placeholder')}
        maxLength={256}
        onChange={(event) => actions.setDirectoryQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.preventDefault();
            actions.setDirectoryQuery('');
          }
        }}
      />
      {query && (
        <button type="button" className="rw-search-clear" aria-label={t('rail.search.clear')}
          onClick={() => actions.setDirectoryQuery('')}>
          <Icon name="close" size={11} />
        </button>
      )}
    </label>
  );
}

export function RailBody() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const stale = state.connection.kind !== 'online';
  const directory = state.directory;
  const supported = directory?.supported === true;
  const searching = supported && Boolean(directory?.query.trim());
  const view = supported ? directory!.view : 'tasks';
  const canCreate = state.capabilities['session.create']?.state === 'supported';

  return (
    <>
      <div className="rw-rail-top">
        <HostSelector variant="rail" />
        {canCreate && (
          <button
            type="button"
            className="rw-newchat"
            onClick={() => {
              actions.openNewChat('');
              if (mode === 'narrow') actions.openMobilePage('new-chat');
            }}
          >
            <Icon name="compose" size={14} />
            <span>{t('rail.newChat.title')}</span>
          </button>
        )}
        {supported && <SearchField />}
        {supported && !searching && (
          <div className="rw-tabs" role="tablist" aria-label={t('rail.views')}>
            {(['tasks', 'repos'] as const).map(name => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={view === name}
                className={`rw-tab${view === name ? ' on' : ''}`}
                onClick={() => actions.setDirectoryView(name)}
              >
                {t(name === 'tasks' ? 'rail.tasks' : 'rail.recent')}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="rw-rail-scroll">
        {searching ? <SearchView stale={stale} />
          : view === 'repos' ? <RecentView stale={stale} />
            : <TasksView stale={stale} />}
      </div>
      <div className="rw-rail-foot">
        <button
          type="button"
          className={`rw-foot-btn${state.view.kind === 'settings' ? ' active' : ''}`}
          onClick={() => {
            actions.openSettings();
            if (mode === 'narrow') actions.openMobilePage('settings');
          }}
        >
          <Icon name="settings" size={15} />
          <span>{t('rail.settings')}</span>
        </button>
      </div>
    </>
  );
}

/** Desktop sidebar wrapper. */
export function Rail() {
  const t = useT();
  return (
    <aside className="sidebar rw-rail" aria-label={t('rail.title')}>
      <RailBody />
    </aside>
  );
}

/** Narrow full-screen rail page — a real page, not a drawer. */
export function RailPage() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const hasChat = state.view.kind === 'chat';
  return (
    <div className="rw-page rw-rail" data-page="rail" aria-label={t('rail.title')}>
      {hasChat && (
        <PageHeader
          title={t('rail.title')}
          leading={<HeaderButton icon="back" label={t('shell.back')} onClick={() => actions.openMobilePage('chat')} />}
        />
      )}
      <RailBody />
    </div>
  );
}

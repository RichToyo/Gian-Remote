/**
 * Chat header: the conversation's name, where it lives (Task · repository ·
 * Agent) and its state in words. Narrow layouts add the list button and the
 * computer's connection dot, which opens the list where the switcher lives.
 */

import type { RemoteSession } from '@gian/remote-protocol';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { workspaceLabel } from './format.js';
import { HeaderButton, PageHeader } from './page.js';
import { useViewportMode } from './viewport.js';

function useSessionPlace(session: RemoteSession): { task: string | null; workspace: string | null } {
  const state = useRemoteState();
  const entry = state.directory
    ? Object.values(state.directory.lists).flatMap(list => list.entries).find(item => item.id === session.id)
    : undefined;
  const task = (session.task_id ? state.tasks.find(item => item.id === session.task_id)?.name : undefined)
    ?? entry?.task?.name ?? null;
  const workspace = state.workspaces.find(item => item.id === session.workspace_id)?.name
    ?? state.catalog?.workspaces.find(item => item.id === session.workspace_id)?.name
    ?? entry?.workspace.name ?? null;
  return { task, workspace };
}

function StatusPill({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const waiting = state.interactions.some(interaction => interaction.session_id === session.id
    && (state.interactionPhases[interaction.id] ?? 'pending') === 'pending');
  if (state.connection.kind !== 'online') return null;
  const tone = waiting || session.status === 'pending' ? 'attention'
    : session.status === 'running' ? 'running'
      : session.status === 'error' ? 'error' : null;
  if (!tone) return null;
  const label = tone === 'attention' ? t('session.status.waiting')
    : tone === 'running' ? t('session.status.running') : t('session.status.error');
  return <span className={`rw-pill ${tone}`}>{label}</span>;
}

export function ChatHeader({ session }: { session: RemoteSession }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const place = useSessionPlace(session);
  const model = session.model || session.agent.name;
  const subtitle = [
    place.task,
    place.workspace ? workspaceLabel(place.workspace) : null,
    model,
  ].filter(Boolean).join(' · ');
  const online = state.connection.kind === 'online';
  return (
    <PageHeader
      title={session.name ?? t('chat.untitled')}
      subtitle={subtitle}
      leading={mode === 'narrow'
        ? <HeaderButton icon="menu" label={t('shell.menu')} onClick={() => actions.openMobilePage('rail')} />
        : undefined}
      trailing={(
        <>
          <StatusPill session={session} />
          {mode === 'narrow' && (
            <button
              type="button"
              className="rw-head-conn"
              title={online ? t('host.status.connected') : t('host.status.offline')}
              aria-label={`${t('host.selector.label')} — ${online ? t('host.status.connected') : t('host.status.offline')}`}
              onClick={() => actions.openMobilePage('rail')}
            >
              <span className={`rw-host-dot${online ? ''
                : state.connection.kind === 'taken_over' ? ' paused'
                  : state.connection.kind === 'relay_reconnecting' || state.connection.kind === 'resyncing' ? ' busy'
                    : ' off'}`} aria-hidden="true" />
            </button>
          )}
        </>
      )}
    />
  );
}

/**
 * Shared page chrome: one header shape for chat, New chat, Settings and the
 * file viewer, on both layouts. Wide layouts put it at the top of the main
 * card; narrow layouts use it as the screen header.
 */

import type { ReactNode } from 'react';
import { Icon } from './icons.js';

export function PageHeader({
  title,
  subtitle,
  leading,
  trailing,
  titleId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Back or menu button. */
  leading?: ReactNode;
  trailing?: ReactNode;
  titleId?: string;
}) {
  return (
    <header className="rw-head">
      {leading}
      <div className="rw-head-text">
        <h1 className="rw-head-title" id={titleId}>{title}</h1>
        {subtitle && <div className="rw-head-sub">{subtitle}</div>}
      </div>
      {trailing && <div className="rw-head-actions">{trailing}</div>}
    </header>
  );
}

export function HeaderButton({
  icon,
  label,
  onClick,
}: {
  icon: 'back' | 'menu' | 'close' | 'refresh';
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="rw-head-btn" title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  );
}

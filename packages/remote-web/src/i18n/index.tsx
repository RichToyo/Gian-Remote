import { createContext, useCallback, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChatUiI18nContext } from '@gian/chat-ui';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';

/** First-party copy is English. Legacy Host locale fields remain valid wire
 * input; conversation, task, repository and Host names remain user data. */
export const REMOTE_WEB_LOCALE = 'en' as const;

export function resolveRemoteWebLocale(_legacyLocale?: string | null): Locale {
  return REMOTE_WEB_LOCALE;
}

interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

const Ctx = createContext<LocaleCtx>({
  locale: 'en',
  t: (k, vars) => interpolate(EN[k] ?? k, vars),
});

export function LocaleProvider({
  locale: _legacyLocale,
  children,
}: {
  /** Legacy callers may still pass zh-CN. The product context is always English. */
  locale?: Locale;
  children: ReactNode;
}) {
  void _legacyLocale;
  const t = useCallback(
    (k: MessageKey, vars?: Record<string, string | number>) =>
      interpolate(EN[k] ?? k, vars),
    [],
  );
  useEffect(() => {
    document.documentElement.lang = REMOTE_WEB_LOCALE;
  }, []);
  // chat-ui components read copy through their own context; feed them the
  // English table (remote-web's table is a superset of the chat-ui keys).
  return (
    <Ctx.Provider value={{ locale: 'en', t }}>
      <ChatUiI18nContext.Provider value={t}>{children}</ChatUiI18nContext.Provider>
    </Ctx.Provider>
  );
}

export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  return useContext(Ctx).t;
}

export function useLocale(): Locale {
  return useContext(Ctx).locale;
}

export type { Locale, MessageKey };

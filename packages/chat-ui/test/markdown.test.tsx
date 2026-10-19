// chat-ui markdown: GFM rendering, fenced-code copy button, and the safe
// link contract — external links and file references only travel through the
// app-provided `LinkBehavior`; the package never opens a URL by itself.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MarkdownText, FileLink } from '../src/markdown.js';
import { LinkBehaviorContext } from '../src/links/LinkBehaviorContext.js';
import type { LinkBehavior } from '../src/links/LinkBehaviorContext.js';

describe('MarkdownText', () => {
  it('renders GFM tables and inline code', () => {
    const { container } = render(
      <MarkdownText>{'| a | b |\n| --- | --- |\n| 1 | 2 |\n\nuse `foo()` here'}</MarkdownText>,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('foo()');
  });

  it('wraps tables in a scroll container so wide tables scroll on their own', () => {
    const { container } = render(
      <MarkdownText>{'| a | b |\n| --- | --- |\n| 1 | 2 |'}</MarkdownText>,
    );
    const wrapper = container.querySelector('.md-table-scroll');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('table')).not.toBeNull();
  });

  it('repairs a glued list/table and still renders the table', () => {
    const { container } = render(
      <MarkdownText>{'- item\n| a |\n| --- |\n| 1 |'}</MarkdownText>,
    );
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('wraps a fenced block with a copy button (trailing newline trimmed)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<MarkdownText>{'```js\nconst x = 1;\n```'}</MarkdownText>);
    const btn = container.querySelector('.code-block .code-copy');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
  });

  it('copies intentional trailing blank lines inside a code fence', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<MarkdownText>{'```js\nconst x = 1;\n\n\n```'}</MarkdownText>);
    fireEvent.click(container.querySelector('.code-copy')!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;\n\n'));
  });

  it('routes external links through the app callback instead of navigating', () => {
    const openWebUrl = vi.fn();
    const { container } = render(
      <LinkBehaviorContext.Provider value={{ openWebUrl }}>
        <MarkdownText>{'[site](https://example.com)'}</MarkdownText>
      </LinkBehaviorContext.Provider>,
    );
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBeNull(); // in-app routing: no _blank
    expect(fireEvent.click(link)).toBe(false);
    expect(openWebUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('opens external links in a new tab when no browser callback is mounted', () => {
    const { container } = render(<MarkdownText>{'[site](https://example.com)'}</MarkdownText>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders unresolved relative links as inert spans (no dead <a>, no swallowed click) when no fallback is mounted', () => {
    const { container } = render(<MarkdownText>{'[missing](./missing.md)'}</MarkdownText>);
    expect(container.querySelector('a')).toBeNull();
    const span = container.querySelector('span.link-inert')!;
    expect(span.textContent).toContain('missing');
    expect(span.getAttribute('title')).toContain('./missing.md');
  });

  it('routes unresolved relative links to the click-time fallback when mounted', () => {
    const openRelative = vi.fn();
    const { container } = render(
      <LinkBehaviorContext.Provider value={{ openRelative }}>
        <MarkdownText>{'[missing](./missing.md)'}</MarkdownText>
      </LinkBehaviorContext.Provider>,
    );
    expect(fireEvent.click(container.querySelector('a')!)).toBe(false);
    expect(openRelative).toHaveBeenCalledWith('./missing.md');
  });

  // CommonMark right-flanking rules reject a closing `**` that sits between
  // CJK fullwidth punctuation and a CJK character, so the bold markers leaked
  // as literal text; remark-cjk-friendly relaxes those rules.
  it.each([
    [("**" + String.fromCodePoint(0x5728, 0x666e, 0x901a) + " ChatGPT " + String.fromCodePoint(0x5bf9, 0x8bdd, 0x91cc, 0x76f4, 0x63a5, 0x5f00, 0x542f) + " Decisions " + String.fromCodePoint(0x6a21, 0x5f0f) + "：**" + String.fromCodePoint(0x6211, 0x6ca1, 0x6709, 0x67e5, 0x5230)), (String.fromCodePoint(0x5728, 0x666e, 0x901a) + " ChatGPT " + String.fromCodePoint(0x5bf9, 0x8bdd, 0x91cc, 0x76f4, 0x63a5, 0x5f00, 0x542f) + " Decisions " + String.fromCodePoint(0x6a21, 0x5f0f) + "：")],
    [("**" + String.fromCodePoint(0x8ba9) + " ChatGPT " + String.fromCodePoint(0x628a, 0x5b83, 0x5f53, 0x5de5, 0x5177, 0x8c03, 0x7528) + "：" + String.fromCodePoint(0x53ef, 0x4ee5, 0x505a) + "。**" + String.fromCodePoint(0x628a) + " Decisions API"), (String.fromCodePoint(0x8ba9) + " ChatGPT " + String.fromCodePoint(0x628a, 0x5b83, 0x5f53, 0x5de5, 0x5177, 0x8c03, 0x7528) + "：" + String.fromCodePoint(0x53ef, 0x4ee5, 0x505a) + "。")],
    [("**" + String.fromCodePoint(0x667a, 0x80fd, 0x4f53, 0x7684, 0x8868, 0x73b0, 0x5177, 0x6709, 0x968f, 0x673a, 0x6027) + "。**" + String.fromCodePoint(0x6bcf, 0x4e2a, 0x4efb, 0x52a1, 0x8fd0, 0x884c) + " k " + String.fromCodePoint(0x6b21)), (String.fromCodePoint(0x667a, 0x80fd, 0x4f53, 0x7684, 0x8868, 0x73b0, 0x5177, 0x6709, 0x968f, 0x673a, 0x6027) + "。")],
    [("**" + String.fromCodePoint(0x9759, 0x6001, 0x68c0, 0x67e5, 0x548c, 0x72b6, 0x6001, 0x68c0, 0x67e5) + "：**" + String.fromCodePoint(0x6784, 0x5efa) + "、lint"), (String.fromCodePoint(0x9759, 0x6001, 0x68c0, 0x67e5, 0x548c, 0x72b6, 0x6001, 0x68c0, 0x67e5) + "：")],
  ])('renders CJK-adjacent bold as <strong>: %s', (source, boldText) => {
    const { container } = render(<MarkdownText>{source}</MarkdownText>);
    expect(container.querySelector('strong')?.textContent).toBe(boldText);
    expect(container.textContent).not.toContain('**');
  });

  it('keeps non-CJK bold rendering unchanged', () => {
    const { container } = render(<MarkdownText>{'**mode:** rest'}</MarkdownText>);
    expect(container.querySelector('strong')?.textContent).toBe('mode:');
  });

  it('keeps plain CJK bold rendering unchanged', () => {
    const { container } = render(<MarkdownText>{("**" + String.fromCodePoint(0x52a0, 0x7c97) + "**" + String.fromCodePoint(0x540e, 0x7eed))}</MarkdownText>);
    expect(container.querySelector('strong')?.textContent).toBe((String.fromCodePoint(0x52a0, 0x7c97)));
  });

  it('leaves spaced double asterisks literal', () => {
    const { container } = render(<MarkdownText>{'2 ** 3'}</MarkdownText>);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('2 ** 3');
  });

  it('leaves asterisks inside inline code literal', () => {
    const { container } = render(<MarkdownText>{("`**" + String.fromCodePoint(0x4e0d, 0x662f, 0x52a0, 0x7c97) + "：**x`")}</MarkdownText>);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(("**" + String.fromCodePoint(0x4e0d, 0x662f, 0x52a0, 0x7c97) + "：**x"));
  });
});

describe('FileLink', () => {
  function withBehavior(behavior: LinkBehavior, ui: React.ReactElement) {
    return <LinkBehaviorContext.Provider value={behavior}>{ui}</LinkBehaviorContext.Provider>;
  }

  it('routes clicks through the app open callback, never a synthesized URL', () => {
    const openFile = vi.fn();
    const { container } = render(
      withBehavior({ openFile }, <FileLink path="/repo/src/a.ts" line={12} />),
    );
    const link = container.querySelector('a.file-link')!;
    expect(fireEvent.click(link)).toBe(false);
    expect(openFile).toHaveBeenCalledWith('/repo/src/a.ts', 12);
  });

  it('never fabricates an editor-scheme href by itself — and never renders a dead <a>', () => {
    const { container } = render(<FileLink path="/repo/src/a.ts" />);
    expect(container.querySelector('a')).toBeNull();
    const span = container.querySelector('span.file-link')!;
    expect(span.getAttribute('title')).toBe('/repo/src/a.ts');
  });

  it('uses the app-supplied href factory when one is mounted', () => {
    const { container } = render(
      withBehavior(
        { openFile: vi.fn(), fileHref: (p, line) => `app://open${p}${line ? `:${line}` : ''}` },
        <FileLink path="/repo/src/a.ts" line={3} />,
      ),
    );
    expect(container.querySelector('a.file-link')!.getAttribute('href')).toBe('app://open/repo/src/a.ts:3');
  });
});

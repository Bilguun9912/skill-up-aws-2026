import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Citation } from '../api/types';
import { I18nProvider } from '../i18n';
import { splitCitationText } from '../lib/remarkCitations';
import { Markdown } from './Markdown';

const citations: Citation[] = [
  {
    n: 1,
    source: 'pmbok',
    edition: '7',
    title: 'PMBOK Guide 7th Edition',
    page: 42,
    excerpt: 'Tailoring is the deliberate adaptation of approach.',
  },
  {
    n: 2,
    source: 'pmbok',
    edition: '6',
    title: 'PMBOK Guide 6th Edition',
    excerpt: 'Perform Integrated Change Control.',
  },
];

function renderMd(content: string, lang: 'en' | 'ja' = 'en') {
  return render(
    <I18nProvider lang={lang}>
      <Markdown content={content} citations={citations} />
    </I18nProvider>,
  );
}

describe('splitCitationText', () => {
  it('splits markers into link nodes', () => {
    const nodes = splitCitationText('a [1] b [2, 3]');
    expect(nodes.map((n) => n.type)).toEqual(['text', 'link', 'text', 'link', 'link']);
    expect(nodes.filter((n) => n.type === 'link').map((n) => n.url)).toEqual([
      '#cite-1',
      '#cite-2',
      '#cite-3',
    ]);
  });

  it('leaves text without markers alone', () => {
    expect(splitCitationText('no refs here')).toEqual([{ type: 'text', value: 'no refs here' }]);
  });
});

describe('Markdown citations', () => {
  it('renders [n] markers as chips', () => {
    renderMd('Use tailoring [1] and change control [2].');
    const chips = screen.getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['1', '2']);
    expect(screen.queryByText(/\[1\]/)).not.toBeInTheDocument();
  });

  it('renders adjacent markers [1][2] and Japanese text', () => {
    renderMd('スコープ変更は統合変更管理で扱います[1][2]。');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText(/統合変更管理/)).toBeInTheDocument();
  });

  it('shows edition, title, page and excerpt on click', () => {
    renderMd('See [1].');
    fireEvent.click(screen.getByRole('button', { name: /Source 1/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('PMBOK Guide 7th Edition');
    expect(dialog).toHaveTextContent('PMBOK 7th ed.');
    expect(dialog).toHaveTextContent('p. 42');
    expect(dialog).toHaveTextContent('Tailoring is the deliberate adaptation');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('localises citation metadata in Japanese', () => {
    renderMd('参照 [1]', 'ja');
    fireEvent.click(screen.getByRole('button', { name: /出典 1/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('PMBOK 第7版');
    expect(screen.getByRole('dialog')).toHaveTextContent('42ページ');
  });

  it('renders unknown citation numbers as plain text', () => {
    renderMd('Unknown [9].');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('[9]')).toBeInTheDocument();
  });

  it('does not touch markers in code', () => {
    renderMd('Use `arr[1]` here.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('arr[1]')).toBeInTheDocument();
  });

  it('keeps normal links as external links', () => {
    renderMd('[PMI](https://www.pmi.org) [1]');
    const link = screen.getByRole('link', { name: 'PMI' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

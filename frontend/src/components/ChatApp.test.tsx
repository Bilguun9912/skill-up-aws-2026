import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, type ApiClient } from '../api/client';
import type { ChatEvent } from '../api/types';
import { I18nProvider } from '../i18n';
import { ChatApp } from './ChatApp';

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getMe: vi.fn(async () => ({
      sub: 's',
      username: 'u',
      usage: { date: '2026-10-06', count: 12, limit: 30 },
    })),
    listSessions: vi.fn(async () => ({
      sessions: [{ sessionId: 'old', title: 'Old chat', createdAt: 'x', updatedAt: 'x' }],
    })),
    getSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    streamChat: vi.fn(async (_req, handlers: { onEvent: (e: ChatEvent) => void }) => {
      handlers.onEvent({ type: 'session', sessionId: 'new1', title: 'Scope creep' });
      handlers.onEvent({
        type: 'citations',
        citations: [{ n: 1, source: 'pmbok', edition: '7', title: 'PMBOK Guide 7th Edition', excerpt: 'e' }],
      });
      handlers.onEvent({ type: 'delta', text: 'Use change ' });
      handlers.onEvent({ type: 'delta', text: 'control [1].' });
      handlers.onEvent({ type: 'done', messageId: 'm1' });
    }),
    ...overrides,
  };
}

function renderApp(api: ApiClient) {
  return render(
    <I18nProvider lang="en">
      <ChatApp api={api} onSignOut={() => undefined} />
    </I18nProvider>,
  );
}

describe('ChatApp', () => {
  it('shows usage, streams an answer with citations and adds the session to the sidebar', async () => {
    const api = fakeApi();
    renderApp(api);
    expect(await screen.findByText('12 / 30 questions today')).toBeInTheDocument();
    expect(await screen.findByText('Old chat')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'How to handle scope creep?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(await screen.findByText(/Use change control/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Source 1/ })).toBeInTheDocument();
    expect(screen.getByText('Sources (1)')).toBeInTheDocument();
    const titles = screen.getAllByRole('button', { name: /chat|Scope creep/ }).map((b) => b.textContent);
    expect(titles.indexOf('Scope creep')).toBeLessThan(titles.indexOf('Old chat'));
    expect(api.streamChat).toHaveBeenCalledWith(
      { sessionId: undefined, message: 'How to handle scope creep?' },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('shows a friendly daily-limit message on 429', async () => {
    const api = fakeApi({
      streamChat: vi.fn(async () => {
        throw new ApiError(429, 'quota_exceeded', 'limit');
      }),
    });
    renderApp(api);
    await screen.findByText('12 / 30 questions today');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'q' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(await screen.findByText(/Daily limit reached \(30 questions per day\)/)).toBeInTheDocument();
  });

  it('deletes a session after confirmation', async () => {
    const api = fakeApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp(api);
    fireEvent.click(await screen.findByRole('button', { name: /Delete conversation: Old chat/ }));
    await waitFor(() => expect(screen.queryByText('Old chat')).not.toBeInTheDocument());
    expect(api.deleteSession).toHaveBeenCalledWith('old');
    confirm.mockRestore();
  });
});

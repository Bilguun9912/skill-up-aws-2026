import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, type ApiClient } from '../api/client';
import type { MeResponse, Message, SessionSummary } from '../api/types';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/en';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { LangToggle } from './LangToggle';
import { MessageView, type UiMessage } from './MessageView';
import { Sidebar } from './Sidebar';

interface Props {
  api: ApiClient;
  userLabel?: string;
  onSignOut: () => void;
}

export function describeError(err: unknown, t: Dict, limit?: number): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'quota_exceeded':
        return t.quotaExceeded(limit);
      case 'unauthorized':
        return t.sessionExpired;
      case 'not_found':
        return t.notFound;
      case 'bad_request':
        return `${t.badRequest} ${err.message}`;
      default:
        return t.genericError;
    }
  }
  return t.genericError;
}

function toUiMessage(m: Message): UiMessage {
  return { id: m.messageId, role: m.role, content: m.content, citations: m.citations, status: 'done' };
}

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function ChatApp({ api, userLabel, onSignOut }: Props) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>();

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const limitRef = useRef<number | undefined>(undefined);
  limitRef.current = me?.usage.limit;

  const refreshMe = useCallback(() => {
    api.getMe().then(setMe, () => undefined);
  }, [api]);

  const refreshSessions = useCallback(() => {
    api.listSessions().then(
      (r) => {
        setSessions(r.sessions);
        setSessionsError(null);
      },
      (err: unknown) => {
        if (!isAbortError(err)) setSessionsError(t.loadSessionsError);
      },
    );
  }, [api, t]);

  useEffect(() => {
    refreshMe();
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the view pinned to the bottom while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    stop();
    setActiveId(null);
    setMessages([]);
    setBanner(null);
    setMenuOpen(false);
  };

  const selectSession = async (id: string) => {
    setMenuOpen(false);
    if (id === activeId && !loadingSession) return;
    stop();
    setActiveId(id);
    setMessages([]);
    setBanner(null);
    setLoadingSession(true);
    try {
      const r = await api.getSession(id);
      setMessages(r.messages.map(toUiMessage));
      stickToBottom.current = true;
    } catch (err) {
      setBanner(describeError(err, t, limitRef.current));
      if (err instanceof ApiError && err.code === 'not_found') {
        setSessions((prev) => prev.filter((s) => s.sessionId !== id));
      }
    } finally {
      setLoadingSession(false);
    }
  };

  const deleteSession = async (s: SessionSummary) => {
    if (!window.confirm(t.confirmDelete(s.title))) return;
    try {
      await api.deleteSession(s.sessionId);
      setSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId));
      if (s.sessionId === activeId) newChat();
    } catch (err) {
      setBanner(describeError(err, t, limitRef.current));
    }
  };

  const updateAssistant = (id: string, fn: (m: UiMessage) => UiMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  const send = async (text: string) => {
    if (streaming) return;
    setBanner(null);
    const userMsg: UiMessage = { id: nextLocalId(), role: 'user', content: text, status: 'done' };
    const asstId = nextLocalId();
    const asstMsg: UiMessage = { id: asstId, role: 'assistant', content: '', status: 'streaming' };
    setMessages((prev) => [...prev, userMsg, asstMsg]);
    stickToBottom.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let gotDone = false;

    try {
      await api.streamChat(
        { sessionId: activeId ?? undefined, message: text },
        {
          onEvent: (ev) => {
            switch (ev.type) {
              case 'session': {
                setActiveId(ev.sessionId);
                const now = new Date().toISOString();
                setSessions((prev) => {
                  const existing = prev.find((s) => s.sessionId === ev.sessionId);
                  const updated: SessionSummary = existing
                    ? { ...existing, title: ev.title || existing.title, updatedAt: now }
                    : { sessionId: ev.sessionId, title: ev.title, createdAt: now, updatedAt: now };
                  return [updated, ...prev.filter((s) => s.sessionId !== ev.sessionId)];
                });
                break;
              }
              case 'citations':
                updateAssistant(asstId, (m) => ({ ...m, citations: ev.citations }));
                break;
              case 'delta':
                updateAssistant(asstId, (m) => ({ ...m, content: m.content + ev.text }));
                break;
              case 'done':
                gotDone = true;
                updateAssistant(asstId, (m) => ({ ...m, status: 'done' }));
                break;
              case 'error':
                gotDone = true;
                updateAssistant(asstId, (m) => ({
                  ...m,
                  status: 'error',
                  error: `${t.streamError} ${ev.message}`,
                }));
                break;
            }
          },
        },
        controller.signal,
      );
      if (!gotDone) {
        // Stream ended without a terminal event.
        updateAssistant(asstId, (m) => ({ ...m, status: 'error', error: t.genericError }));
      }
    } catch (err) {
      if (isAbortError(err)) {
        updateAssistant(asstId, (m) => ({ ...m, status: 'stopped' }));
      } else {
        const msg = describeError(err, t, limitRef.current);
        // Show the error inline in the assistant bubble (e.g. 429 daily limit before streaming).
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId ? { ...m, status: 'error', error: m.content ? `${t.streamError} ${msg}` : msg } : m,
          ),
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      refreshMe();
    }
  };

  const usage = me?.usage;
  const atLimit = usage ? usage.count >= usage.limit : false;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        open={menuOpen}
        error={sessionsError}
        onNew={newChat}
        onSelect={(id) => void selectSession(id)}
        onDelete={(s) => void deleteSession(s)}
        onClose={() => setMenuOpen(false)}
      />
      <main className="main">
        <header className="header">
          <button
            type="button"
            className="icon-btn only-mobile"
            onClick={() => setMenuOpen(true)}
            aria-label={t.openMenu}
          >
            ☰
          </button>
          <h1 className="header-title">{t.appName}</h1>
          <div className="header-right">
            {usage && (
              <span className={`usage${atLimit ? ' at-limit' : ''}`} title={usage.date}>
                {t.usage(usage.count, usage.limit)}
              </span>
            )}
            <LangToggle />
            {userLabel && <span className="user hide-mobile">{userLabel}</span>}
            <button type="button" className="btn btn-ghost" onClick={onSignOut}>
              {t.signOut}
            </button>
          </div>
        </header>

        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          <div className="messages-inner">
            {loadingSession && <p className="muted center">{t.loading}</p>}
            {!loadingSession && messages.length === 0 && (
              <EmptyState onPick={(q) => setPrefill({ text: q, nonce: Date.now() })} />
            )}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
          </div>
        </div>

        <div className="composer-wrap">
          {banner && (
            <div className="banner" role="alert">
              <span>{banner}</span>
              <button type="button" className="icon-btn" onClick={() => setBanner(null)} aria-label={t.dismiss}>
                ×
              </button>
            </div>
          )}
          {atLimit && !streaming && <div className="banner warn">{t.quotaExceeded(usage?.limit)}</div>}
          <Composer
            streaming={streaming}
            disabled={loadingSession}
            onSend={(text) => void send(text)}
            onStop={stop}
            prefill={prefill}
          />
        </div>
      </main>
    </div>
  );
}

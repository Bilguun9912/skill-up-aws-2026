import type { SessionSummary } from '../api/types';
import { useI18n } from '../i18n';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  open: boolean;
  error?: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (s: SessionSummary) => void;
  onClose: () => void;
}

export function Sidebar({ sessions, activeId, open, error, onNew, onSelect, onDelete, onClose }: Props) {
  const { t } = useI18n();
  return (
    <>
      <div className={`backdrop${open ? ' show' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-top">
          <button type="button" className="btn btn-new" onClick={onNew}>
            + {t.newChat}
          </button>
          <button type="button" className="icon-btn only-mobile" onClick={onClose} aria-label={t.closeMenu}>
            ×
          </button>
        </div>
        <h3 className="sidebar-heading">{t.history}</h3>
        {error && <p className="sidebar-error">{error}</p>}
        {sessions.length === 0 && !error && <p className="muted small pad">{t.noSessions}</p>}
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.sessionId} className={s.sessionId === activeId ? 'active' : undefined}>
              <button
                type="button"
                className="session-title"
                title={s.title}
                onClick={() => onSelect(s.sessionId)}
              >
                {s.title || '…'}
              </button>
              <button
                type="button"
                className="icon-btn session-delete"
                aria-label={`${t.deleteSession}: ${s.title}`}
                title={t.deleteSession}
                onClick={() => onDelete(s)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h-2"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}

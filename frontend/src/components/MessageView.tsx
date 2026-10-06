import type { Citation } from '../api/types';
import { useI18n } from '../i18n';
import { Markdown } from './Markdown';
import { SourcesList } from './SourcesList';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
}

export function MessageView({ message }: { message: UiMessage }) {
  const { t } = useI18n();
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble">{message.content}</div>
      </div>
    );
  }
  const waiting = message.status === 'streaming' && message.content === '';
  return (
    <div className="msg msg-assistant">
      <div className="avatar" aria-hidden="true">
        PM
      </div>
      <div className="msg-body">
        {waiting ? (
          <p className="muted thinking">{t.thinking}</p>
        ) : (
          <Markdown content={message.content} citations={message.citations} />
        )}
        {message.status === 'streaming' && !waiting && <span className="cursor" aria-hidden="true" />}
        {message.status === 'stopped' && <p className="muted small">{t.stopped}</p>}
        {message.error && <p className="msg-error">{message.error}</p>}
        {message.citations && message.citations.length > 0 && message.status !== 'streaming' && (
          <SourcesList citations={message.citations} />
        )}
      </div>
    </div>
  );
}

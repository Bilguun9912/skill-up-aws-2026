import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_MESSAGE_LENGTH } from '../api/types';
import { useI18n } from '../i18n';
import { charCount } from '../lib/text';

interface Props {
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** When set, replaces the input value (e.g. an example question was clicked). */
  prefill?: { text: string; nonce: number };
}

/**
 * Enter sends, Shift+Enter inserts a newline. Never send while an IME composition is
 * active (Japanese input confirms conversions with Enter): `isComposing`, plus the legacy
 * keyCode 229 that Safari reports for the confirming keydown.
 */
export function shouldSubmitOnKeyDown(e: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;
  return true;
}

export function Composer({ streaming, disabled, onSend, onStop, prefill }: Props) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const count = charCount(text);
  const tooLong = count > MAX_MESSAGE_LENGTH;
  const canSend = !streaming && !disabled && text.trim() !== '' && !tooLong;

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    ref.current?.focus();
  }, [prefill]);

  // Auto-grow up to a max height (CSS caps it).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitOnKeyDown(e)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={`composer-box${tooLong ? ' over' : ''}`}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={t.inputPlaceholder}
          aria-label={t.inputPlaceholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        <div className="composer-actions">
          <span className={`counter${tooLong ? ' over' : ''}`} aria-live="polite">
            {count} / {MAX_MESSAGE_LENGTH}
          </span>
          {streaming ? (
            <button type="button" className="btn btn-stop" onClick={onStop}>
              {t.stop}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!canSend}>
              {t.send}
            </button>
          )}
        </div>
      </div>
      {tooLong && <p className="composer-error">{t.tooLong(MAX_MESSAGE_LENGTH)}</p>}
    </form>
  );
}

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { Composer, shouldSubmitOnKeyDown } from './Composer';

function setup(streaming = false) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(
    <I18nProvider lang="en">
      <Composer streaming={streaming} onSend={onSend} onStop={onStop} />
    </I18nProvider>,
  );
  const textarea = screen.getByRole('textbox');
  return { onSend, onStop, textarea };
}

describe('shouldSubmitOnKeyDown', () => {
  const base = { key: 'Enter', shiftKey: false, nativeEvent: {} };
  it('submits on plain Enter', () => expect(shouldSubmitOnKeyDown(base)).toBe(true));
  it('not on Shift+Enter', () => expect(shouldSubmitOnKeyDown({ ...base, shiftKey: true })).toBe(false));
  it('not while IME composing', () =>
    expect(shouldSubmitOnKeyDown({ ...base, nativeEvent: { isComposing: true } })).toBe(false));
  it('not on keyCode 229 (Safari IME)', () =>
    expect(shouldSubmitOnKeyDown({ ...base, nativeEvent: { keyCode: 229 } })).toBe(false));
  it('not on other keys', () => expect(shouldSubmitOnKeyDown({ ...base, key: 'a' })).toBe(false));
});

describe('Composer', () => {
  it('sends on Enter', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not send on Enter during IME composition', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'すこーぷ' } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('すこーぷ');
  });

  it('does not send on Shift+Enter', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'line' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('counts Japanese and emoji as one character each and blocks over-limit', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '日本語😀' } });
    expect(screen.getByText('4 / 4000')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: 'あ'.repeat(4001) } });
    expect(screen.getByText('4001 / 4000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows Stop while streaming', () => {
    const { onStop } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });
});

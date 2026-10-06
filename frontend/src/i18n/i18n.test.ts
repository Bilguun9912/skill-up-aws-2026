import { describe, expect, it } from 'vitest';
import { detectLang } from './index';
import { en } from './en';
import { ja } from './ja';

describe('i18n', () => {
  it('detects Japanese from navigator.language', () => {
    expect(detectLang('ja')).toBe('ja');
    expect(detectLang('ja-JP')).toBe('ja');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });

  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it('includes the Japanese example question', () => {
    expect(en.examples).toContain('スポンサーがスプリント途中でスコープを変更し続けます。どうすればいいですか？');
    expect(ja.examples).toContain('スポンサーがスプリント途中でスコープを変更し続けます。どうすればいいですか？');
  });
});

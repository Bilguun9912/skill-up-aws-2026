/** Unicode-aware text helpers (lengths counted in code points, not UTF-16 units). */

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** First `max` code points; appends `ellipsis` when truncated (ellipsis counts toward `max`). */
export function truncateCodePoints(s: string, max: number, ellipsis = '…'): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  const keep = Math.max(0, max - [...ellipsis].length);
  return cps.slice(0, keep).join('').trimEnd() + ellipsis;
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const JAPANESE_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ーｦ-ﾟ]/u;

/** True when the text contains Hiragana, Katakana (incl. half-width) or CJK ideographs. */
export function containsJapanese(s: string): boolean {
  return JAPANESE_RE.test(s);
}

export const SESSION_TITLE_MAX = 40;

export function makeSessionTitle(message: string): string {
  return truncateCodePoints(collapseWhitespace(message), SESSION_TITLE_MAX);
}

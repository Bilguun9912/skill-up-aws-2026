/** Length in Unicode code points (so Japanese/emoji count as one character each). */
export function charCount(s: string): number {
  return [...s].length;
}

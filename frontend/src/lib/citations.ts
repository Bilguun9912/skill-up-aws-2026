import type { Citation } from '../api/types';
import type { Dict } from '../i18n/en';

export function citationLabel(c: Citation, t: Dict): string {
  const parts: string[] = [];
  if (c.source === 'pmbok' && c.edition) parts.push(t.edition(c.edition));
  if (c.page !== undefined) parts.push(t.page(c.page));
  return parts.join(' · ');
}

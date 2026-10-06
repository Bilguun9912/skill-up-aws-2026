import { useEffect, useId, useRef, useState } from 'react';
import type { Citation } from '../api/types';
import { citationLabel } from '../lib/citations';
import { useI18n } from '../i18n';

interface Props {
  n: number;
  citation?: Citation;
}

/** Inline `[n]` marker. Click/tap toggles a popover with the source details. */
export function CitationChip({ n, citation }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popId = useId();
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!citation) {
    return <span className="cite-missing">[{n}]</span>;
  }

  const meta = citationLabel(citation, t);
  return (
    <span className="cite" ref={ref}>
      <button
        type="button"
        className="cite-chip"
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`${t.source(n)}: ${citation.title}${meta ? `, ${meta}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {n}
      </button>
      {open && (
        <span className="cite-pop" role="dialog" id={popId}>
          <span className="cite-pop-title">
            [{n}] {citation.title}
          </span>
          {meta && <span className="cite-pop-meta">{meta}</span>}
          <span className="cite-pop-excerpt">{citation.excerpt}</span>
        </span>
      )}
    </span>
  );
}

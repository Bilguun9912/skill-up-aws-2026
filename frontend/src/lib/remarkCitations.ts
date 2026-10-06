/**
 * Remark plugin: turns inline citation markers like `[1]`, `[1, 3]` or `[1][2]` in text
 * into link nodes with url `#cite-<n>`, which the Markdown renderer shows as citation chips.
 * Code spans/blocks are untouched (they're not `text` nodes). Existing links are skipped.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

export const CITE_HREF_PREFIX = '#cite-';

const MARKER_RE = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\]/g;

export function splitCitationText(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    const nums = (m[1] ?? '').split(/\s*[,，、]\s*/);
    for (const n of nums) {
      out.push({
        type: 'link',
        url: `${CITE_HREF_PREFIX}${Number(n)}`,
        children: [{ type: 'text', value: String(Number(n)) }],
      });
    }
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [{ type: 'text', value }];
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function transform(node: MdNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitCitationText(child.value));
    } else {
      transform(child);
      next.push(child);
    }
  }
  node.children = next;
}

export default function remarkCitations() {
  return (tree: MdNode): void => {
    transform(tree);
  };
}

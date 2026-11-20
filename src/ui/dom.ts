/** Minimal DOM helpers and a hand-drawn icon set (24×24, stroke-based). */

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const P: Record<string, string> = {
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  outline: '<path d="M7 4c4-2 10 0 12 4s0 9-4 11-10 2-12-2S3 6 7 4z" stroke-dasharray="3 2.5"/>',
  mesh: '<path d="M4 18L12 4l8 14H4z"/><path d="M8 11h8M12 18l-4-7M12 18l4-7"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-1.5V4.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V12m0-3.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1.5a6 6 0 01-4.6-2.2L4 15.5a1.6 1.6 0 012.4-2.1L8 15"/>',
  pin: '<path d="M12 21v-6"/><path d="M8 3h8l-1 6 3 3H6l3-3-1-6z"/>',
  pinOff: '<path d="M12 21v-6"/><path d="M8 3h8l-1 6 3 3H6l3-3-1-6z"/><path d="M3 3l18 18"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  wand: '<path d="M4 20L16 8"/><path d="M14 6l4 4"/><path d="M18 2v3M21 5h-3M20 9v2M10 3v2"/>',
  brush: '<path d="M14 4l6 6-8.5 8.5a3 3 0 01-4.2 0l-1.8-1.8a3 3 0 010-4.2z"/><path d="M4 20c1.5 0 3-1 3-2.5"/>',
  eraser: '<path d="M16 3l5 5-11 11H5l-2-2 8-8z"/><path d="M9 10l5 5M14 21h7"/>',
  lasso: '<ellipse cx="12" cy="9" rx="8" ry="5"/><path d="M7 13c-1 2 0 4 2 4s2 3 0 4"/>',
  lassoMinus: '<ellipse cx="12" cy="9" rx="8" ry="5"/><path d="M7 13c-1 2 0 4 2 4s2 3 0 4"/><path d="M16 18h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  minusCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  reset: '<path d="M4 12a8 8 0 108-8 8.5 8.5 0 00-6 2.5L4 8"/><path d="M4 3v5h5"/>',
  jelly: '<path d="M5 18c0-6 2-12 7-12s7 6 7 12"/><path d="M3 18h18"/><path d="M9 11c0-1 .5-2 1.5-2"/>',
  pad: '<path d="M12 3l9 16H3z"/><circle cx="11" cy="13" r="2.5" fill="currentColor"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5"/><path d="M5 4h14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8 11h6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  broom: '<path d="M14 3l-4 9"/><path d="M6 12h8l2 9H4z"/><path d="M8 16v5M12 16v5"/>',
  vertexMove: '<circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  vertexAdd: '<path d="M4 19L12 5l8 14z"/><circle cx="12" cy="14" r="2" fill="currentColor"/>',
  vertexRemove: '<path d="M4 19L12 5l8 14z" stroke-dasharray="2 2"/><path d="M9 14h6"/>',
  turn: '<path d="M20 12a8 8 0 11-3-6.2"/><path d="M20 4v5h-5"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z"/>',
};

export function icon(name: keyof typeof P | string, size = 22): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
  return wrap.firstChild as SVGSVGElement;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function clamp(x: number, a: number, b: number) {
  return x < a ? a : x > b ? b : x;
}

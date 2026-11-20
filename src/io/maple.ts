/**
 * Import / export of the Maple data format used by the 2012 worksheets:
 *   p := [[[x, y], ...], [[x, y], ...], ...]:   (one list of vertices per shape)
 *   T := [[i, j, k], ...]:                       (1-based triangles)
 */

type V = number | V[];

function parseList(src: string): V {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const num = (): number => {
    ws();
    let sign = 1;
    while (src[i] === '-' || src[i] === '+') {
      if (src[i] === '-') sign = -sign;
      i++;
      ws();
    }
    const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`Unexpected "${src.slice(i, i + 12)}"`);
    i += m[0].length;
    let v = parseFloat(m[0]);
    ws();
    if (src[i] === '/') {
      i++;
      v /= num();
    }
    return sign * v;
  };
  const val = (): V => {
    ws();
    if (src[i] === '[') {
      i++;
      const out: V[] = [];
      ws();
      if (src[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(val());
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === ']') {
          i++;
          return out;
        }
        throw new Error(`Expected , or ] at "${src.slice(i, i + 12)}"`);
      }
    }
    return num();
  };
  return val();
}

function grab(text: string, name: string): string | null {
  const re = new RegExp(`(?:^|[;:\\s])${name}\\s*:=\\s*\\[`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface MapleData {
  frames: [number, number][][];
  tris: [number, number, number][];
}

export function parseMaple(text: string): MapleData {
  const clean = text.replace(/\\\r?\n/g, '');
  const ps = grab(clean, 'p'), ts = grab(clean, 'T');
  if (!ps || !ts) throw new Error('p := [...] and T := [...] are required');
  if (/seq\s*\(/.test(ps) || /seq\s*\(/.test(ts)) throw new Error('seq(...) expressions are not supported — evaluate them in Maple first');
  let p = parseList(ps) as V[];
  const T = parseList(ts) as number[][];
  if (typeof (p[0] as V[])[0] === 'number') p = [p];
  const frames = (p as number[][][]).map((f) => f.map((q) => [q[0], q[1]] as [number, number]));
  const n = frames[0].length;
  if (!frames.every((f) => f.length === n)) throw new Error('all shapes must have the same number of vertices');
  const tris = T.map((t) => [t[0] - 1, t[1] - 1, t[2] - 1] as [number, number, number]);
  if (tris.some((t) => t.some((v) => v < 0 || v >= n || !Number.isInteger(v)))) throw new Error('triangle index out of range');
  return { frames, tris };
}

/** Export frames (world coordinates, y down) in Maple syntax, normalised and y-up. */
export function toMaple(frames: ArrayLike<number>[], tris: ArrayLike<number>, comment = ''): string {
  // normalise so the rest shape fits in [-10, 10]
  const r = frames[0];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  const s = 20 / Math.max(x1 - x0, y1 - y0, 1e-9), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const f = (v: number) => (Math.abs(v) < 5e-7 ? '0.' : v.toFixed(6));
  const shapes = frames.map((fr) => {
    const pts: string[] = [];
    for (let i = 0; i < fr.length; i += 2) pts.push(`[${f((fr[i] - cx) * s)}, ${f(-(fr[i + 1] - cy) * s)}]`);
    return `[${pts.join(', ')}]`;
  });
  const T: string[] = [];
  for (let k = 0; k < tris.length; k += 3) T.push(`[${tris[k] + 1}, ${tris[k + 1] + 1}, ${tris[k + 2] + 1}]`);
  return `# ${comment}\n# p[j][i]: i-th vertex of the j-th shape (j = 1 is the rest shape); T: 1-based triangles\np := [\n${shapes.join(',\n')}\n]:\nT := [${T.join(', ')}]:\n`;
}

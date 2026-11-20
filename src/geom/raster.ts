/** Raster helpers shared by contour detection and mesh sizing. */

/** Squared Euclidean distance to the nearest "on" pixel (Felzenszwalb–Huttenlocher). */
export function edt(on: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = on[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n), out = new Float64Array(n);
  const dt1 = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    dt1(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    dt1(w);
    for (let x = 0; x < w; x++) d[y * w + x] = out[x];
  }
  return d;
}

/**
 * Tiny 2×2 matrix toolkit.  A matrix [[a, b], [c, d]] is stored as a tuple
 * (a, b, c, d); a symmetric matrix [[p, q], [q, r]] as (p, q, r).
 */

export const TAU = Math.PI * 2;

/** Wrap an angle to (-π, π]. */
export function wrapPi(x: number): number {
  x = x % TAU;
  if (x <= -Math.PI) x += TAU;
  else if (x > Math.PI) x -= TAU;
  return x;
}

/** Rotation angle of the closest rotation to [[a,b],[c,d]] (polar decomposition, det > 0 case). */
export function polarAngle(a: number, b: number, c: number, d: number): number {
  return Math.atan2(c - b, a + d);
}

/**
 * Symmetric stretch S = R(-θ)·A, symmetrised (exact when A = R(θ)S with S symmetric).
 * Writes (p, q, r) into out[o..o+2].
 */
export function stretchAfterRotation(a: number, b: number, c: number, d: number, theta: number, out: Float64Array, o: number) {
  const co = Math.cos(theta);
  const si = Math.sin(theta);
  // R(-θ) = [[co, si], [-si, co]]
  const s00 = co * a + si * c;
  const s01 = co * b + si * d;
  const s10 = -si * a + co * c;
  const s11 = -si * b + co * d;
  out[o] = s00;
  out[o + 1] = 0.5 * (s01 + s10);
  out[o + 2] = s11;
}

/** Eigen-decomposition helpers for symmetric 2×2 [[p,q],[q,r]]: returns mean m and half-gap d (λ = m ± d). */
function symEig(p: number, q: number, r: number) {
  const m = 0.5 * (p + r);
  const h = 0.5 * (p - r);
  const d = Math.sqrt(h * h + q * q);
  return { m, d };
}

/**
 * Matrix logarithm of an SPD 2×2 matrix (eigenvalues are clamped to `minEig`
 * so flipped / degenerate triangles do not produce NaNs).
 */
export function symLog(p: number, q: number, r: number, out: Float64Array, o: number, minEig = 1e-4) {
  const { m, d } = symEig(p, q, r);
  const l1 = Math.max(m + d, minEig);
  const l2 = Math.max(m - d, minEig);
  const g1 = Math.log(l1);
  const g2 = Math.log(l2);
  const mean = 0.5 * (g1 + g2);
  if (d < 1e-12) {
    out[o] = mean;
    out[o + 1] = 0;
    out[o + 2] = mean;
    return;
  }
  const k = (g1 - g2) / (2 * d); // scale of the traceless part
  out[o] = mean + k * (p - m);
  out[o + 1] = k * q;
  out[o + 2] = mean + k * (r - m);
}

/** Matrix exponential of a symmetric 2×2 matrix. */
export function symExp(p: number, q: number, r: number, out: Float64Array, o: number) {
  const { m, d } = symEig(p, q, r);
  const em = Math.exp(m);
  const ch = Math.cosh(d);
  const sh = d < 1e-12 ? 1 : Math.sinh(d) / d;
  out[o] = em * (ch + sh * (p - m));
  out[o + 1] = em * sh * q;
  out[o + 2] = em * (ch + sh * (r - m));
}

/** Singular values (σ1 ≥ σ2, signed σ2 = det/σ1) of [[a,b],[c,d]]. */
export function singularValues(a: number, b: number, c: number, d: number): [number, number] {
  const e = 0.5 * (a + d);
  const f = 0.5 * (a - d);
  const g = 0.5 * (c + b);
  const h = 0.5 * (c - b);
  const qq = Math.hypot(e, h);
  const rr = Math.hypot(f, g);
  return [qq + rr, qq - rr];
}

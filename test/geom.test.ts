import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, meshQuality, vcount, tcount, type Pt, locate, signedArea } from '../src/geom/mesh.ts';
import { MeshOperator, Deformer } from '../src/geom/arap.ts';
import { Interpolator, timelineWeights, padWeights } from '../src/geom/interp.ts';
import { EnvelopeCholesky } from '../src/geom/sparse.ts';
import { symExp, symLog, singularValues } from '../src/geom/mat2.ts';

const circle = (r: number, n: number, cx = 0, cy = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as Pt);
const rect = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]];

test('envelope Cholesky solves a 1D Laplacian', () => {
  const n = 50;
  const nb = Array.from({ length: n }, (_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < n));
  const ch = new EnvelopeCholesky(n, nb);
  for (let i = 0; i < n; i++) {
    ch.addSym(i, i, 2.01);
    if (i + 1 < n) ch.addSym(i, i + 1, -1);
  }
  assert.ok(ch.factor());
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = 2.01 * x[i] - (i > 0 ? x[i - 1] : 0) - (i < n - 1 ? x[i + 1] : 0);
  const y = new Float64Array(n);
  ch.solve(b, y);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(y[i] - x[i]) < 1e-9);
});

test('sym log/exp round-trip and singular values', () => {
  const o = new Float64Array(3), e = new Float64Array(3);
  symLog(2, 0.5, 1.2, o, 0);
  symExp(o[0], o[1], o[2], e, 0);
  assert.ok(Math.abs(e[0] - 2) < 1e-12 && Math.abs(e[1] - 0.5) < 1e-12 && Math.abs(e[2] - 1.2) < 1e-12);
  const [s1, s2] = singularValues(3, 0, 0, 2);
  assert.ok(Math.abs(s1 - 3) < 1e-12 && Math.abs(s2 - 2) < 1e-12);
});

test('mesh of a disc with a hole is valid', () => {
  const mesh = buildMesh([circle(100, 80), circle(30, 30).reverse()], { edge: 12, relax: 3, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 1 });
  assert.equal(mesh.failed, 0);
  assert.ok(vcount(mesh) > 100 && tcount(mesh) > 150);
  for (let t = 0; t < tcount(mesh); t++) assert.ok(signedArea(mesh.rest, mesh.tris, t) > 0);
  const q = meshQuality(mesh.rest, mesh.tris);
  assert.ok(q.minAngle > 15, `min angle ${q.minAngle}`);
  // nothing inside the hole
  assert.equal(locate(mesh.rest, mesh.tris, 0, 0), null);
  const total = Array.from({ length: tcount(mesh) }, (_, t) => signedArea(mesh.rest, mesh.tris, t)).reduce((a, b) => a + b);
  const expected = Math.PI * (100 * 100 - 30 * 30);
  assert.ok(Math.abs(total - expected) / expected < 0.02);
});

test('ARAP: two pins rotate a bar rigidly', () => {
  const mesh = buildMesh([rect(200, 40)], { edge: 10, relax: 2, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 2 });
  const op = new MeshOperator(mesh);
  const d = new Deformer(op, { iterations: 30 });
  const p1 = locate(mesh.rest, mesh.tris, 5, 20)!;
  const p2 = locate(mesh.rest, mesh.tris, 195, 20)!;
  // rotate the bar by 90° about (5,20)
  d.addPin({ id: 1, tri: p1.tri, b: p1.b, x: 5, y: 20 });
  d.addPin({ id: 2, tri: p2.tri, b: p2.b, x: 5, y: 210 });
  for (let i = 0; i < 20; i++) d.update(1 / 60);
  assert.ok(d.stats.energy < 1e-3, `energy ${d.stats.energy}`);
  assert.equal(d.stats.flipped, 0);
  const mid = d.pinPosition({ id: 3, ...locate(mesh.rest, mesh.tris, 100, 20)!, x: 0, y: 0 });
  assert.ok(Math.abs(mid[0] - 5) < 1 && Math.abs(mid[1] - 115) < 1, `mid ${mid}`);
  // rotation tracked
  assert.ok(Math.abs(d.theta[0] - Math.PI / 2) < 0.05, `theta ${d.theta[0]}`);
});

test('interpolation: a 270° turn goes the long (consistent) way and stays rigid', () => {
  const mesh = buildMesh([rect(100, 30)], { edge: 10, relax: 1, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 3 });
  const op = new MeshOperator(mesh);
  const ip = new Interpolator(op);
  const rot = (ang: number) => {
    const out = new Float64Array(mesh.rest.length);
    for (let i = 0; i < out.length; i += 2) {
      const x = mesh.rest[i] - 50, y = mesh.rest[i + 1] - 15;
      out[i] = 50 + Math.cos(ang) * x - Math.sin(ang) * y;
      out[i + 1] = 15 + Math.sin(ang) * x + Math.cos(ang) * y;
    }
    return out;
  };
  const target = rot((3 * Math.PI) / 2);
  const theta = new Float64Array(op.m).fill((3 * Math.PI) / 2);
  for (const method of ['polar-log', 'polar-linear'] as const) {
    ip.setPoses([{ pos: mesh.rest }, { pos: target, theta }], 'tracked');
    const out = new Float64Array(mesh.rest.length);
    ip.blend([0.5, 0.5], method, out);
    const expect = rot((3 * Math.PI) / 4);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - expect[i]));
    assert.ok(err < 1e-6, `${method} err ${err}`);
  }
  // principal branch takes the short way (−90°)
  ip.setPoses([{ pos: mesh.rest }, { pos: target }], 'principal');
  const out = new Float64Array(mesh.rest.length);
  ip.blend([0.5, 0.5], 'polar-log', out);
  const expect = rot(-Math.PI / 4);
  let err = 0;
  for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - expect[i]));
  assert.ok(err < 1e-6, `principal err ${err}`);
});

test('polar-log blends stretches geometrically', () => {
  const mesh = buildMesh([rect(40, 40)], { edge: 10, relax: 0, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 4 });
  const op = new MeshOperator(mesh);
  const ip = new Interpolator(op);
  const target = Float64Array.from(mesh.rest, (v, i) => (i % 2 === 0 ? v * 4 : v));
  ip.setPoses([{ pos: mesh.rest }, { pos: target }], 'consistent');
  const out = new Float64Array(mesh.rest.length);
  ip.blend([0.5, 0.5], 'polar-log', out);
  // width should be 40·√4 = 80 (geometric mean), not 100 (arithmetic)
  let x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < out.length; i += 2) { x0 = Math.min(x0, out[i]); x1 = Math.max(x1, out[i]); }
  assert.ok(Math.abs(x1 - x0 - 80) < 1e-6, `width ${x1 - x0}`);
  ip.blend([0.5, 0.5], 'polar-linear', out);
  x0 = Infinity; x1 = -Infinity;
  for (let i = 0; i < out.length; i += 2) { x0 = Math.min(x0, out[i]); x1 = Math.max(x1, out[i]); }
  assert.ok(Math.abs(x1 - x0 - 100) < 1e-6, `width ${x1 - x0}`);
});

test('timeline and pad weights are partitions of unity', () => {
  for (const e of ['linear', 'smooth', 'spline'] as const)
    for (const l of ['loop', 'once', 'pingpong'] as const)
      for (let tau = 0; tau < 4; tau += 0.37) {
        const w = timelineWeights(tau, 4, e, l);
        assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
      }
  const pts: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const w = padWeights(pts, 0.3, 0.2);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const wx = padWeights(pts, 2, 2); // extrapolation
  assert.ok(Math.abs(wx.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.min(...wx) < 0);
});

test('jelly dynamics settles back towards the pins', () => {
  const mesh = buildMesh([rect(100, 20)], { edge: 8, relax: 1, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 5 });
  const op = new MeshOperator(mesh);
  const d = new Deformer(op, { jelly: true, stiffness: 80, damping: 2 });
  const p1 = locate(mesh.rest, mesh.tris, 2, 3)!;
  const p2 = locate(mesh.rest, mesh.tris, 2, 17)!;
  d.addPin({ id: 1, tri: p1.tri, b: p1.b, x: 2, y: 3 });
  d.addPin({ id: 2, tri: p2.tri, b: p2.b, x: 2, y: 17 });
  // kick the far end
  for (let i = 0; i < d.n; i++) if (mesh.rest[2 * i] > 90) d.vel[2 * i + 1] = 300;
  let maxDisp = 0;
  for (let f = 0; f < 600; f++) {
    d.update(1 / 60);
    for (let i = 0; i < d.n; i++) maxDisp = Math.max(maxDisp, Math.abs(d.pos[2 * i + 1] - mesh.rest[2 * i + 1]));
  }
  assert.ok(maxDisp > 5, `it should wobble (max ${maxDisp})`);
  let err = 0;
  for (let i = 0; i < d.pos.length; i++) err = Math.max(err, Math.abs(d.pos[i] - mesh.rest[i]));
  assert.ok(err < 1, `residual ${err}`);
});

test('thin parts get finer boundary sampling (no slivers)', () => {
  const thin: Pt[] = [[0, 0], [300, 0], [300, 8], [0, 8]];
  const blob = circle(80, 60, 150, 90);
  for (const loops of [[thin], [blob]]) {
    const mesh = buildMesh(loops, { edge: 25, relax: 3, pattern: 'hex', cornerAngle: 40, boundaryGap: 0.6, seed: 1 });
    assert.equal(mesh.failed, 0);
    const q = meshQuality(mesh.rest, mesh.tris);
    assert.ok(q.minAngle > 18, `min angle ${q.minAngle}`);
  }
});

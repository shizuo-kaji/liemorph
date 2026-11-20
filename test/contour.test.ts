import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMask, traceMask, defaultDetectOptions, marchingSquares } from '../src/geom/contour.ts';
import { polygonArea, buildMesh, defaultMeshOptions, vcount } from '../src/geom/mesh.ts';

function synth(w: number, h: number, inside: (x: number, y: number) => boolean, fg: number[], bg: number[], alpha = false) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x);
    const c = inside(x + 0.5, y + 0.5) ? fg : bg;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    data[i + 3] = alpha ? (inside(x + 0.5, y + 0.5) ? 255 : 0) : 255;
  }
  return { width: w, height: h, data };
}

test('marching squares traces a square', () => {
  const w = 10, h = 10, f = new Float32Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) f[y * w + x] = 1;
  const loops = marchingSquares(f, w, h);
  assert.equal(loops.length, 1);
  assert.ok(Math.abs(Math.abs(polygonArea(loops[0])) - 35.5) < 1e-9, `area ${polygonArea(loops[0])}`);
});

test('detects a coloured disc on a white background (and a ring with a hole)', () => {
  const img = synth(200, 160, (x, y) => (x - 100) ** 2 + (y - 80) ** 2 < 50 ** 2, [220, 60, 90], [250, 250, 248]);
  const r = detectMask(img, 2, { ...defaultDetectOptions, margin: 0 });
  assert.equal(r.mode, 'background');
  const loops = traceMask(r.mask, { smooth: 1, simplify: 0.5, minLoopArea: 10 });
  assert.equal(loops.length, 1);
  const area = Math.abs(polygonArea(loops[0]));
  const expect = Math.PI * 100 * 100; // radius 50 mask px → 100 image px
  assert.ok(Math.abs(area - expect) / expect < 0.03, `area ${area} vs ${expect}`);
  const mesh = buildMesh(loops, { ...defaultMeshOptions, edge: 12 });
  assert.equal(mesh.failed, 0);
  assert.ok(vcount(mesh) > 50);

  const ring = synth(200, 200, (x, y) => { const d = (x - 100) ** 2 + (y - 100) ** 2; return d < 80 ** 2 && d > 30 ** 2; }, [20, 20, 160], [255, 255, 255]);
  const r2 = detectMask(ring, 1, { ...defaultDetectOptions, fillHoles: false, margin: 0 });
  const loops2 = traceMask(r2.mask, { smooth: 1, simplify: 0.5, minLoopArea: 10 });
  assert.equal(loops2.length, 2);
  const r3 = detectMask(ring, 1, { ...defaultDetectOptions, fillHoles: true, margin: 0 });
  assert.equal(traceMask(r3.mask, { smooth: 1, simplify: 0.5, minLoopArea: 10 }).length, 1);
});

test('uses alpha when present', () => {
  const img = synth(100, 100, (x, y) => Math.abs(x - 50) < 20 && Math.abs(y - 50) < 30, [0, 0, 0], [0, 0, 0], true);
  const r = detectMask(img, 1, { ...defaultDetectOptions, margin: 0, close: 0, open: 0 });
  assert.equal(r.mode, 'alpha');
  const loops = traceMask(r.mask, { smooth: 0.5, simplify: 0.5, minLoopArea: 10 });
  assert.equal(loops.length, 1);
  assert.ok(Math.abs(Math.abs(polygonArea(loops[0])) - 40 * 60) < 60);
});

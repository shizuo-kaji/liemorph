import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseMaple, toMaple } from '../src/io/maple.ts';

test('parses Maple data with rationals and leading dots', () => {
  const d = parseMaple(`p := [[[-3.0, 18/5], [-.5, 3\\\n/5], [0., -1.2e-1]], [[1, 2], [3, 4], [5, 6]]]:\nT := [[1, 2, 3]];`);
  assert.equal(d.frames.length, 2);
  assert.deepEqual(d.frames[0][0], [-3, 3.6]);
  assert.ok(Math.abs(d.frames[0][1][1] - 0.6) < 1e-12);
  assert.deepEqual(d.tris, [[0, 1, 2]]);
});

test('round-trips through toMaple', () => {
  const frames = [Float64Array.from([0, 0, 10, 0, 0, 10]), Float64Array.from([0, 0, 20, 0, 0, 10])];
  const s = toMaple(frames, [0, 1, 2]);
  const d = parseMaple(s);
  assert.equal(d.frames.length, 2);
  assert.deepEqual(d.tris, [[0, 1, 2]]);
});

const old = '../old_maple/data_sgw.mpl';
test('parses the original 2012 data file', { skip: !existsSync(old) }, () => {
  const d = parseMaple(readFileSync(old, 'utf8'));
  assert.equal(d.frames.length, 3);
  assert.equal(d.frames[0].length, 16);
  assert.equal(d.tris.length, 14);
});

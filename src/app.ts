/**
 * Application controller: document state, the image → outline → mesh →
 * animation pipeline, interaction tools, playback, history and export.
 */
import { GLRenderer, type View } from './render/gl.ts';
import { Overlay, C, viridis, diverging } from './render/overlay.ts';
import { InputManager, type Tool, type PointerInfo, type DragHandler, clampZoom } from './ui/input.ts';
import { type Settings, loadSettings, saveSettings, schema, defaults } from './settings.ts';
import { t, tr } from './i18n.ts';
import {
  type Mesh, type Pt, type MeshQuality, buildMesh, retriangulate, relaxOnce, meshQuality, locate, nearestVertex,
  addVertex, removeVertex, polygonArea, loopLength, bbox, boundaryLoopsFromTris, vcount, insideLoops, triangulate,
} from './geom/mesh.ts';
import { detectMask, traceMask, type DetectResult, type Mask, paintSegment, fillPolygon, maskFromLoops, hasTransparency } from './geom/contour.ts';
import { MeshOperator, Deformer, type Pin } from './geom/arap.ts';
import { Interpolator, timelineWeights, timelinePosition, padWeights, transferPose } from './geom/interp.ts';
import { wrapPi, singularValues, polarAngle } from './geom/mat2.ts';
import { prepareClassic } from './samples/classic.ts';
import { parseMaple, toMaple } from './io/maple.ts';
import { kvSet, kvGet } from './io/store.ts';
import { downloadBlob } from './ui/dom.ts';

export type Step = 'image' | 'contour' | 'mesh' | 'animate';
export type ToolId = 'points' | 'brushAdd' | 'brushErase' | 'lassoAdd' | 'lassoErase' | 'vmove' | 'vadd' | 'vremove' | 'grab' | 'pin';
export type PlayMode = 'live' | 'timeline' | 'pad' | 'clip';

export interface Pose {
  id: number;
  pos: Float64Array;
  theta: Float64Array | null;
  turns: number;
  pad: [number, number];
  thumb: string;
}

export interface Clip {
  frames: Float32Array[];
  fps: number;
}

export interface UIHooks {
  update(): void;
  toast(msg: string, kind?: 'info' | 'warn'): void;
  hint(msg: string, once?: string): void;
  hideHint(): void;
  insets(): { top: number; right: number; bottom: number; left: number };
  stats(): void;
}

interface Snapshot {
  loops: Pt[][];
  mask: Uint8Array | null;
  mesh: Mesh | null;
  meshStale: boolean;
  poses: Pose[];
  pins: Pin[];
  pos: Float64Array | null;
}

const PAD_SLOTS = 6;

export class App {
  s: Settings = loadSettings();
  step: Step = 'image';
  tools: Record<Step, ToolId> = { image: 'grab', contour: 'points', mesh: 'vmove', animate: 'grab' };
  view: View = { zoom: 1, panX: 0, panY: 0 };
  W = 1;
  H = 1;
  dpr = 1;
  readonly stage: HTMLElement;
  readonly gl: GLRenderer;
  readonly ov: Overlay;
  readonly input: InputManager;
  ui!: UIHooks;

  // ---- document
  img: HTMLCanvasElement | null = null;
  imgW = 0;
  imgH = 0;
  imgName = '';
  hasAlpha = false;
  analysis: ImageData | null = null;
  aScale = 1;
  threshold: number | null = null;
  detect: DetectResult | null = null;
  mask: Mask | null = null;
  maskSynced = true; // mask agrees with loops
  loops: Pt[][] = [];
  meshStale = true;
  mesh: Mesh | null = null;
  op: MeshOperator | null = null;
  deformer: Deformer | null = null;
  interp: Interpolator | null = null;
  interpDirty = true;
  boundary: Uint8Array | null = null;
  quality: MeshQuality | null = null;
  poses: Pose[] = [];
  clip: Clip | null = null;
  private nextId = 1;

  // ---- playback
  mode: PlayMode = 'live';
  playing = false;
  playClock = 0;
  speed = 1;
  tau = 0;
  padPuck: [number, number] = [0, 0];
  blendBuf: Float64Array | null = null;
  blendTheta: Float64Array | null = null;
  private lastWeights: Float64Array | null = null;
  private cmpBuf: Float64Array | null = null;
  recording: { frames: Float32Array[]; acc: number; t: number } | null = null;
  exporting = false;

  // ---- transient interaction state
  brushPx = 26;
  hoverPoint: { li: number; pi: number } | null = null;
  hoverEdge: { li: number; pi: number; x: number; y: number } | null = null;
  hoverVertex = -1;
  hoverPin = -1;
  cursor: { x: number; y: number } | null = null;
  lasso: Pt[] | null = null;
  private maskTint: HTMLCanvasElement | null = null;
  private maskTintDirty = true;

  private dirty = true;
  private history: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastT = performance.now();
  fps = 60;
  private saveTimer = 0;
  private detectTimer = 0;
  private meshTimer = 0;
  private heatColors: Float32Array | null = null;

  constructor(stage: HTMLElement, glCanvas: HTMLCanvasElement, ovCanvas: HTMLCanvasElement) {
    this.stage = stage;
    this.gl = new GLRenderer(glCanvas);
    this.ov = new Overlay(ovCanvas);
    this.input = new InputManager(stage, () => this.view, (v) => (this.view = v), () => this.currentTool());
    this.input.onViewChange = () => this.requestRender();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  // =================================================================== basics

  requestRender() {
    this.dirty = true;
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.gl.resize(this.W, this.H, this.dpr);
    this.ov.resize(this.W, this.H, this.dpr);
    this.requestRender();
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (this.s[key] === value) return;
    this.s[key] = value;
    saveSettings(this.s);
    this.onSettingChanged(key);
    this.ui?.update();
  }

  resetSettings() {
    this.s = { ...defaults };
    saveSettings(this.s);
    for (const sec of schema) for (const f of sec.fields) this.onSettingChanged(f.key);
    this.ui.update();
  }

  private onSettingChanged(key: keyof Settings) {
    const sec = schema.find((s) => s.fields.some((f) => f.key === key));
    const effect = sec?.effect ?? (key.startsWith('det') ? 'detect' : 'display');
    if (effect === 'detect') {
      clearTimeout(this.detectTimer);
      this.detectTimer = window.setTimeout(() => {
        if (!this.analysis) return;
        if (key === 'detSmooth' || key === 'detSimplify') this.retrace();
        else this.runDetect();
        if (this.step === 'mesh' || this.step === 'animate') this.rebuildMesh();
        this.ui.update();
      }, 140);
    } else if (effect === 'mesh') {
      clearTimeout(this.meshTimer);
      this.meshTimer = window.setTimeout(() => {
        if (this.loops.length) this.rebuildMesh();
        this.ui.update();
      }, 160);
    } else if (effect === 'deform') {
      if (key === 'weighting' && this.mesh) this.setMesh(this.mesh, true);
      else this.deformer?.setOptions(this.deformOpts());
    } else if (effect === 'interp') {
      if (key === 'branch') this.interpDirty = true;
      this.refreshBlend();
    }
    this.requestRender();
  }

  deformOpts() {
    const s = this.s;
    return {
      rigidity: s.rigidity,
      iterations: s.iterations,
      jelly: s.jelly,
      stiffness: s.stiffness,
      damping: s.damping,
      gravity: s.gravity,
      floor: s.floor && this.imgH ? this.imgH : null,
    };
  }

  /** world rect of the content worth looking at */
  contentBounds(): [number, number, number, number] {
    if (this.step === 'animate' && this.mesh) {
      const P = this.shownPos();
      const [x0, y0, x1, y1] = bbox(P);
      const bw = x1 - x0, bh = y1 - y0;
      const m = 0.12 * Math.max(bw, bh);
      return [Math.min(x0 - m, 0), Math.min(y0 - m, 0), Math.max(x1 + m, this.imgW), Math.max(y1 + m, this.imgH)];
    }
    return [0, 0, this.imgW || 800, this.imgH || 600];
  }

  fitView(bounds = this.contentBounds()) {
    const ins = this.ui?.insets() ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const [x0, y0, x1, y1] = bounds;
    const aw = Math.max(50, this.W - ins.left - ins.right - 24), ah = Math.max(50, this.H - ins.top - ins.bottom - 24);
    const zoom = clampZoom(Math.min(aw / (x1 - x0 || 1), ah / (y1 - y0 || 1)));
    this.view = {
      zoom,
      panX: ins.left + 12 + (aw - (x1 - x0) * zoom) / 2 - x0 * zoom,
      panY: ins.top + 12 + (ah - (y1 - y0) * zoom) / 2 - y0 * zoom,
    };
    this.requestRender();
  }

  zoomBy(k: number) {
    const cx = this.W / 2, cy = this.H / 2;
    const v = this.view, zoom = clampZoom(v.zoom * k), r = zoom / v.zoom;
    this.view = { zoom, panX: cx - (cx - v.panX) * r, panY: cy - (cy - v.panY) * r };
    this.requestRender();
  }

  // ================================================================ loading

  async loadFile(file: File) {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.json') || file.type === 'application/json') {
        await this.loadProject(JSON.parse(await file.text()));
      } else if (name.endsWith('.mpl') || name.endsWith('.txt')) {
        const d = parseMaple(await file.text());
        this.loadClassic({ frames: d.frames, tris: d.tris }, file.name);
      } else {
        const bmp = await createImageBitmap(file);
        this.loadImage(bmp, bmp.width, bmp.height, file.name);
        bmp.close?.();
      }
    } catch (e) {
      console.error(e);
      this.ui.toast(`${t('loadFailed')}: ${(e as Error).message}`, 'warn');
    }
  }

  /** Load a picture and run the whole automatic pipeline. */
  loadImage(src: CanvasImageSource, w0: number, h0: number, name: string, auto = true) {
    const k = Math.min(1, Math.min(2048, this.gl.maxTexture) / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(src, 0, 0, w, h);
    this.resetDocument();
    this.img = c;
    this.imgW = w;
    this.imgH = h;
    this.imgName = name.replace(/\.[^.]+$/, '') || 'liemorph';
    this.gl.setImage(c, w, h);
    this.makeAnalysis();
    this.hasAlpha = !!this.analysis && hasTransparency(this.analysis);
    if (auto) {
      this.runDetect();
      if (this.loops.length) {
        this.rebuildMesh();
        this.autoPins();
        this.setStep('animate');
        this.ui.hint(t('hintGrab'));
      } else {
        this.setStep('contour');
        this.ui.toast(t('noShape'), 'warn');
      }
    }
    this.fitView();
    this.docChanged();
  }

  private makeAnalysis() {
    if (!this.img) return;
    const a = Math.min(1, this.s.detResolution / Math.max(this.imgW, this.imgH));
    const aw = Math.max(8, Math.round(this.imgW * a)), ah = Math.max(8, Math.round(this.imgH * a));
    const c = document.createElement('canvas');
    c.width = aw;
    c.height = ah;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.img, 0, 0, aw, ah);
    this.analysis = ctx.getImageData(0, 0, aw, ah);
    this.aScale = this.imgW / aw;
  }

  loadClassic(d: { frames: [number, number][][]; tris: number[][] }, name: string) {
    const { frames, tris, canvas } = prepareClassic(d);
    this.resetDocument();
    this.img = canvas;
    this.imgW = canvas.width;
    this.imgH = canvas.height;
    this.imgName = name;
    this.gl.setImage(canvas, canvas.width, canvas.height);
    this.makeAnalysis();
    const loopsIdx = boundaryLoopsFromTris(frames[0].length >> 1, tris);
    const mesh: Mesh = { rest: frames[0], tris, loops: loopsIdx };
    this.loops = loopsIdx.map((l) => l.map((i) => [frames[0][2 * i], frames[0][2 * i + 1]] as Pt));
    this.syncMaskFromLoops();
    this.setMesh(mesh, false);
    for (const f of frames.slice(1)) this.poses.push(this.makePose(f, null));
    this.interpDirty = true;
    this.setStep('animate');
    this.fitView();
    if (this.poses.length) {
      this.mode = 'timeline';
      this.playing = true;
      this.playClock = 0;
    }
    this.ui.hint(tr('2012 年の Maple データです。詳細設定の「形状補間」で手法を切り替えて比較できます', 'Data from the 2012 Maple worksheets — switch methods under “Shape interpolation” in the settings'));
    this.ui.update();
    this.docChanged();
  }

  resetDocument() {
    this.input.reset();
    this.img = null;
    this.analysis = null;
    this.threshold = null;
    this.detect = null;
    this.mask = null;
    this.maskSynced = true;
    this.loops = [];
    this.mesh = null;
    this.op = null;
    this.deformer = null;
    this.interp = null;
    this.interpDirty = true;
    this.poses = [];
    this.clip = null;
    this.mode = 'live';
    this.playing = false;
    this.recording = null;
    this.history = [];
    this.future = [];
    this.gl.clearMesh();
    this.meshStale = true;
    this.maskTintDirty = true;
  }

  // ============================================================== pipeline

  runDetect() {
    if (!this.analysis) return;
    const s = this.s;
    this.detect = detectMask(this.analysis, this.aScale, {
      mode: s.detMode,
      threshold: this.threshold,
      blur: s.detBlur,
      close: s.detClose,
      open: s.detOpen,
      margin: s.detMargin,
      fillHoles: s.detFillHoles,
      keepLargest: s.detKeepLargest,
      minArea: 0.002,
      smooth: s.detSmooth,
      simplify: s.detSimplify,
    });
    this.mask = { ...this.detect.mask, data: this.detect.mask.data.slice() };
    this.retrace();
  }

  retrace() {
    if (!this.mask) return;
    const m = this.mask;
    this.loops = traceMask(m, { smooth: this.s.detSmooth, simplify: this.s.detSimplify, minLoopArea: Math.max(12, m.w * m.h * 0.0004) });
    this.maskSynced = true;
    this.meshStale = true;
    this.maskTintDirty = true;
    this.requestRender();
  }

  /** rasterise the (hand-edited) loops back into the mask so brushes continue from them */
  syncMaskFromLoops() {
    if (!this.analysis) return;
    this.mask = maskFromLoops(this.loops, this.analysis.width, this.analysis.height, this.aScale);
    this.maskSynced = true;
    this.maskTintDirty = true;
  }

  shapeArea() {
    let a = 0;
    for (const l of this.loops) a += polygonArea(l);
    return Math.abs(a);
  }

  /** edge length h giving ≈ meshVertices vertices: (2A/√3)/h² + P/h = N */
  edgeLength() {
    const A = Math.max(1, this.shapeArea());
    const P = this.loops.reduce((s, l) => s + loopLength(l), 0);
    const N = Math.max(10, this.s.meshVertices);
    const a = (2 * A) / Math.sqrt(3);
    const u = (-P + Math.sqrt(P * P + 4 * a * N)) / (2 * a);
    return 1 / u;
  }

  rebuildMesh() {
    if (!this.loops.length) {
      this.mesh = null;
      this.op = this.deformer = this.interp = null;
      this.gl.clearMesh();
      return;
    }
    const s = this.s;
    const res = buildMesh(this.loops, {
      edge: this.edgeLength(),
      relax: s.meshRelax,
      pattern: s.meshPattern,
      cornerAngle: s.meshCorner,
      boundaryGap: s.meshGap,
      seed: 7,
    });
    if (res.tris.length < 3) {
      this.ui.toast(t('meshFailed'), 'warn');
      return;
    }
    if (res.failed) this.ui.toast(t('selfIntersect'), 'warn');
    this.setMesh({ rest: res.rest, tris: res.tris, loops: res.loops }, true);
  }

  /** Install a new rest mesh; poses, pins and the current pose are carried over through the rest shape. */
  setMesh(mesh: Mesh, transfer: boolean) {
    const old = transfer && this.mesh && this.deformer ? { mesh: this.mesh, pos: this.shownPos(), pins: this.deformer.pins, poses: this.poses } : null;
    this.mesh = mesh;
    this.meshStale = false;
    this.op = new MeshOperator(mesh, this.s.weighting);
    this.deformer = new Deformer(this.op, this.deformOpts());
    this.interp = null;
    this.interpDirty = true;
    this.boundary = new Uint8Array(vcount(mesh));
    for (const l of mesh.loops) for (const v of l) this.boundary[v] = 1;
    this.quality = meshQuality(mesh.rest, mesh.tris);
    this.gl.setMesh(mesh.rest, mesh.tris);
    this.blendBuf = new Float64Array(mesh.rest.length);
    this.cmpBuf = new Float64Array(mesh.rest.length);
    this.heatColors = null;
    if (old) {
      const mapPos = (P: Float64Array) => transferPose(old.mesh.rest, old.mesh.tris, P, mesh.rest, locate);
      const posNow = mapPos(old.pos);
      this.poses = old.poses.map((p) => ({ ...p, pos: mapPos(p.pos), theta: this.transferTheta(old.mesh, p.theta, mapPos(p.pos)) }));
      const pins: Pin[] = [];
      for (const p of old.pins) {
        if (p.temp) continue;
        const T = old.mesh.tris, R = old.mesh.rest;
        const a = T[3 * p.tri], b = T[3 * p.tri + 1], c = T[3 * p.tri + 2];
        const rx = p.b[0] * R[2 * a] + p.b[1] * R[2 * b] + p.b[2] * R[2 * c];
        const ry = p.b[0] * R[2 * a + 1] + p.b[1] * R[2 * b + 1] + p.b[2] * R[2 * c + 1];
        const hit = locate(mesh.rest, mesh.tris, rx, ry, 1e9);
        if (hit) pins.push({ id: p.id, tri: hit.tri, b: hit.b, x: p.x, y: p.y });
      }
      this.deformer.pins = pins;
      this.deformer.setPose(posNow); // also snaps pin targets onto the transferred pose
      this.deformer.pinsChanged();
    }
    if (this.mode !== 'clip') this.mode = 'live';
    if (this.clip && this.clip.frames[0]?.length !== mesh.rest.length) this.clip = null;
    this.requestRender();
  }

  private transferTheta(oldMesh: Mesh, theta: Float64Array | null, newPos: Float64Array): Float64Array | null {
    if (!theta || !this.op) return null;
    const op = this.op, m = op.m, T = op.mesh.tris, R = op.mesh.rest;
    const principal = op.principalAngles(newPos);
    const out = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
      const x = (R[2 * a] + R[2 * b] + R[2 * c]) / 3, y = (R[2 * a + 1] + R[2 * b + 1] + R[2 * c + 1]) / 3;
      const hit = locate(oldMesh.rest, oldMesh.tris, x, y, 1e9);
      const ref = hit ? theta[hit.tri] : 0;
      out[k] = ref + wrapPi(principal[k] - ref);
    }
    return out;
  }

  ensureMesh() {
    if ((this.meshStale || !this.mesh) && this.loops.length) this.rebuildMesh();
  }

  ensureInterp(): Interpolator | null {
    if (!this.op) return null;
    if (!this.interp) {
      this.interp = new Interpolator(this.op);
      this.interpDirty = true;
    }
    if (this.interpDirty) {
      this.interp.setPoses(
        [{ pos: this.op.mesh.rest, theta: new Float64Array(this.op.m) }, ...this.poses.map((p) => ({ pos: p.pos, theta: p.theta, turns: p.turns }))],
        this.s.branch,
      );
      this.interpDirty = false;
    }
    return this.interp;
  }

  // ================================================================ steps

  setStep(step: Step) {
    if (step === this.step) return;
    this.input.reset();
    this.lasso = null;
    this.hoverPoint = this.hoverEdge = null;
    this.hoverVertex = this.hoverPin = -1;
    if (this.recording) this.toggleRecord();
    if ((step === 'mesh' || step === 'animate') && (this.meshStale || !this.mesh)) this.ensureMesh();
    if (step === 'contour' && !this.maskSynced) this.syncMaskFromLoops();
    if (step === 'mesh' && this.mesh) this.gl.updatePositions(this.mesh.rest);
    this.step = step;
    this.ui.hideHint();
    if (step === 'animate' && this.deformer && !this.deformer.pins.length && this.poses.length === 0) this.autoPins();
    if (step !== 'animate') this.playing = false;
    this.requestRender();
    this.ui.update();
    if (step === 'contour') this.ui.hint(t('hintPoints'), 'contour');
    if (step === 'mesh') this.ui.hint(t('hintMesh'), 'mesh');
  }

  setTool(tool: ToolId) {
    this.tools[this.step] = tool;
    this.input.reset();
    this.lasso = null;
    this.cursor = null;
    if (tool.startsWith('brush')) this.ui.hint(t('hintBrush'), 'brush');
    if (tool.startsWith('lasso')) this.ui.hint(t('hintLasso'), 'lasso');
    this.ui.update();
    this.requestRender();
  }

  get tool(): ToolId {
    return this.tools[this.step];
  }

  // ============================================================ history

  private snapshot(): Snapshot {
    return {
      loops: this.loops.map((l) => l.map((p) => [p[0], p[1]] as Pt)),
      mask: this.mask ? this.mask.data.slice() : null,
      mesh: this.mesh,
      meshStale: this.meshStale,
      poses: this.poses.slice(),
      pins: this.deformer ? this.deformer.pins.filter((p) => !p.temp).map((p) => ({ ...p, b: [...p.b] as [number, number, number] })) : [],
      pos: this.deformer ? this.deformer.pos.slice() : null,
    };
  }

  pushHistory() {
    this.history.push(this.snapshot());
    if (this.history.length > 60) this.history.shift();
    this.future = [];
    this.docChanged();
  }

  private restore(s: Snapshot) {
    this.loops = s.loops;
    if (s.mask && this.mask && s.mask.length === this.mask.data.length) this.mask.data.set(s.mask);
    this.maskTintDirty = true;
    if (s.mesh !== this.mesh) {
      if (s.mesh) this.setMesh(s.mesh, false);
      else {
        this.mesh = null;
        this.gl.clearMesh();
      }
    }
    this.meshStale = s.meshStale;
    this.poses = s.poses;
    this.interpDirty = true;
    if (this.deformer) {
      this.deformer.pins = s.pins.map((p) => ({ ...p }));
      if (s.pos && s.pos.length === this.deformer.pos.length) this.deformer.setPose(s.pos);
      for (const p of this.deformer.pins) {
        const q = s.pins.find((x) => x.id === p.id);
        if (q) {
          p.x = q.x;
          p.y = q.y;
        }
      }
      this.deformer.pinsChanged();
    }
    this.mode = 'live';
    this.playing = false;
    this.requestRender();
    this.ui.update();
    this.docChanged();
  }

  undo() {
    const s = this.history.pop();
    if (!s) return;
    this.future.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.future.pop();
    if (!s) return;
    this.history.push(this.snapshot());
    this.restore(s);
  }

  get canUndo() {
    return this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  docChanged() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (!this.img) return;
      try {
        void kvSet('autosave', JSON.stringify(this.toProject(true)));
      } catch {
        /* ignore */
      }
    }, 1500);
  }

  // ============================================================ animate

  shownPos(): Float64Array {
    if (this.mode !== 'live' && this.blendBuf) return this.blendBuf;
    return this.deformer?.pos ?? this.mesh?.rest ?? new Float64Array(0);
  }

  /** hand control back to the interactive deformer, starting from what is on screen */
  goLive() {
    if (this.mode === 'live' || !this.deformer) return;
    this.deformer.setPose(this.shownPos(), this.mode === 'clip' ? undefined : this.blendTheta ?? undefined);
    this.mode = 'live';
    this.playing = false;
    this.ui.update();
  }

  makePose(pos: Float64Array, theta: Float64Array | null): Pose {
    const i = this.poses.length;
    const ring = Math.floor(i / PAD_SLOTS);
    const a = -Math.PI / 2 + ((i % PAD_SLOTS) + ring * 0.5) * ((2 * Math.PI) / PAD_SLOTS);
    const r = 1 + ring * 0.55;
    return { id: this.nextId++, pos: pos.slice(), theta: theta ? theta.slice() : null, turns: 0, pad: [r * Math.cos(a), r * Math.sin(a)], thumb: this.renderThumb(pos) };
  }

  addPose() {
    if (!this.deformer) return;
    this.pushHistory();
    const pos = this.shownPos();
    const theta = this.mode === 'live' ? this.deformer.theta : this.blendTheta;
    this.poses.push(this.makePose(pos, theta));
    this.interpDirty = true;
    navigator.vibrate?.(8);
    if (this.poses.length === 1) this.ui.hint(t('hintPoses'), 'poses');
    this.ui.update();
  }

  deletePose(id: number) {
    this.pushHistory();
    this.poses = this.poses.filter((p) => p.id !== id);
    this.interpDirty = true;
    if (this.mode !== 'live' && this.mode !== 'clip') this.goLive();
    this.ui.update();
  }

  updatePose(id: number) {
    const k = this.poses.findIndex((p) => p.id === id);
    if (k < 0 || !this.deformer) return;
    this.pushHistory();
    const theta = this.mode === 'live' ? this.deformer.theta : this.blendTheta;
    const pos = this.shownPos();
    this.poses[k] = { ...this.poses[k], pos: pos.slice(), theta: theta ? theta.slice() : null, thumb: this.renderThumb(pos) };
    this.interpDirty = true;
    this.ui.update();
  }

  turnPose(id: number, d: number) {
    const p = this.poses.find((q) => q.id === id);
    if (!p) return;
    this.pushHistory();
    p.turns += d;
    this.interpDirty = true;
    this.refreshBlend();
    this.ui.update();
  }

  movePose(id: number, d: number) {
    const k = this.poses.findIndex((p) => p.id === id);
    const j = k + d;
    if (k < 0 || j < 0 || j >= this.poses.length) return;
    this.pushHistory();
    [this.poses[k], this.poses[j]] = [this.poses[j], this.poses[k]];
    this.interpDirty = true;
    this.ui.update();
  }

  /** show a stored pose (or the rest shape) and continue live from it */
  gotoPose(id: number | 'rest') {
    if (!this.deformer || !this.op) return;
    this.playing = false;
    this.mode = 'live';
    if (id === 'rest') this.deformer.resetPose();
    else {
      const ip = this.ensureInterp();
      const k = this.poses.findIndex((p) => p.id === id);
      if (k < 0) return;
      this.deformer.setPose(this.poses[k].pos, ip ? ip.poses[k + 1].theta : undefined);
    }
    this.requestRender();
    this.ui.update();
  }

  resetPose() {
    if (!this.deformer) return;
    this.pushHistory();
    this.mode = 'live';
    this.playing = false;
    this.deformer.resetPose();
    this.requestRender();
    this.ui.update();
  }

  /** keyframes on the timeline as indices into the interpolator's pose list (0 = rest) */
  timelineKeys(): number[] {
    const keys = this.poses.map((_, i) => i + 1);
    return this.s.includeRest ? [0, ...keys] : keys;
  }

  togglePlay() {
    if (this.mode === 'clip' && this.clip) {
      this.playing = !this.playing;
      this.ui.update();
      return;
    }
    if (this.timelineKeys().length < 2) {
      this.ui.toast(t('hintPoses'));
      return;
    }
    if (this.mode !== 'timeline') {
      this.mode = 'timeline';
      this.playClock = 0;
      this.playing = true;
    } else this.playing = !this.playing;
    if (this.playing && this.s.loopMode === 'once' && this.tau >= this.timelineKeys().length - 1 - 1e-6) this.playClock = 0;
    this.requestRender();
    this.ui.update();
  }

  /** scrub the timeline to τ (keyframe units) */
  scrub(tau: number) {
    if (this.timelineKeys().length < 2) return;
    this.mode = 'timeline';
    this.playing = false;
    this.tau = tau;
    this.playClock = tau * this.s.secondsPerKey;
    this.applyTimeline();
    this.ui.update();
  }

  get timelineSegments() {
    const k = this.timelineKeys().length;
    return this.s.loopMode === 'loop' ? k : k - 1;
  }

  private applyTimeline() {
    const ip = this.ensureInterp();
    if (!ip || !this.blendBuf) return;
    const keys = this.timelineKeys();
    const wk = timelineWeights(this.tau, keys.length, this.s.easing, this.s.loopMode);
    const w = new Float64Array(ip.count);
    keys.forEach((k, i) => (w[k] += wk[i]));
    this.applyWeights(w);
  }

  private applyWeights(w: Float64Array) {
    const ip = this.ensureInterp();
    if (!ip || !this.blendBuf) return;
    ip.blend(w, this.s.interpMethod, this.blendBuf);
    this.blendTheta = ip.blendTheta(w);
    this.lastWeights = w;
    this.requestRender();
  }

  setPad(x: number, y: number) {
    if (!this.op) return;
    this.padPuck = [x, y];
    this.mode = 'pad';
    this.playing = false;
    const pts: [number, number][] = [[0, 0], ...this.poses.map((p) => p.pad)];
    this.applyWeights(padWeights(pts, x, y));
  }

  padWeightsNow(): Float64Array {
    return padWeights([[0, 0], ...this.poses.map((p) => p.pad)], this.padPuck[0], this.padPuck[1]);
  }

  refreshBlend() {
    if (this.mode === 'timeline') this.applyTimeline();
    else if (this.mode === 'pad') this.setPad(this.padPuck[0], this.padPuck[1]);
    this.requestRender();
  }

  toggleRecord() {
    if (this.recording) {
      const frames = this.recording.frames;
      this.recording = null;
      if (frames.length > 5) {
        this.clip = { frames, fps: 30 };
        this.mode = 'clip';
        this.playClock = 0;
        this.playing = true;
      }
      this.ui.update();
      return;
    }
    this.goLive();
    this.recording = { frames: [], acc: 1, t: 0 };
    this.ui.update();
  }

  playClip() {
    if (!this.clip) return;
    this.mode = 'clip';
    this.playing = true;
    this.playClock = 0;
    this.ui.update();
  }

  deleteClip() {
    this.clip = null;
    if (this.mode === 'clip') this.goLive();
    this.mode = 'live';
    this.ui.update();
  }

  // --------------------------------------------------------------- pins

  private pinRadiusWorld() {
    return 22 / this.view.zoom;
  }

  pickPin(x: number, y: number): Pin | null {
    if (!this.deformer) return null;
    let best: Pin | null = null, bd = this.pinRadiusWorld() ** 2;
    for (const p of this.deformer.pins) {
      if (p.temp) continue;
      const [px, py] = this.mode === 'live' ? [p.x, p.y] : this.pinPosOn(p, this.shownPos());
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  pinPosOn(p: Pin, P: ArrayLike<number>): [number, number] {
    const T = this.mesh!.tris;
    const a = T[3 * p.tri], b = T[3 * p.tri + 1], c = T[3 * p.tri + 2];
    return [p.b[0] * P[2 * a] + p.b[1] * P[2 * b] + p.b[2] * P[2 * c], p.b[0] * P[2 * a + 1] + p.b[1] * P[2 * b + 1] + p.b[2] * P[2 * c + 1]];
  }

  addPinAt(x: number, y: number): boolean {
    if (!this.deformer || !this.mesh) return false;
    const P = this.shownPos();
    const hit = locate(P, this.mesh.tris, x, y, 8 / this.view.zoom);
    if (!hit) return false;
    this.pushHistory();
    this.goLive();
    const [px, py] = this.pinPosOn({ id: 0, tri: hit.tri, b: hit.b, x: 0, y: 0 }, this.deformer.pos);
    this.deformer.addPin({ id: this.nextId++, tri: hit.tri, b: hit.b, x: px, y: py });
    navigator.vibrate?.(10);
    this.requestRender();
    this.ui.update();
    return true;
  }

  removePin(id: number) {
    if (!this.deformer) return;
    this.pushHistory();
    this.deformer.removePin(id);
    this.requestRender();
    this.ui.update();
  }

  clearPins() {
    if (!this.deformer) return;
    this.pushHistory();
    this.deformer.pins = [];
    this.deformer.pinsChanged();
    this.requestRender();
    this.ui.update();
  }

  /** Pins at the "centre" and the geodesically farthest extremities. */
  autoPins() {
    if (!this.deformer || !this.mesh || !this.op) return;
    const mesh = this.mesh, op = this.op, n = op.n;
    const P = this.deformer.pos;
    const nb = op.neighbors;
    const dijkstra = (sources: number[]) => {
      const d = new Float64Array(n).fill(Infinity);
      const heap: [number, number][] = [];
      const push = (v: number, dv: number) => {
        heap.push([dv, v]);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      const pop = () => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]];
            i = m;
          }
        }
        return top;
      };
      for (const s of sources) {
        d[s] = 0;
        push(s, 0);
      }
      while (heap.length) {
        const [dv, v] = pop();
        if (dv > d[v]) continue;
        for (const u of nb[v]) {
          const w = dv + Math.hypot(P[2 * u] - P[2 * v], P[2 * u + 1] - P[2 * v + 1]);
          if (w < d[u]) {
            d[u] = w;
            push(u, w);
          }
        }
      }
      return d;
    };
    const bverts: number[] = [];
    for (let i = 0; i < n; i++) if (this.boundary?.[i]) bverts.push(i);
    const fromB = dijkstra(bverts);
    const pins: number[] = [];
    // centre of each component = farthest from the boundary
    for (let c = 0; c < op.compCount; c++) {
      let best = -1;
      for (let i = 0; i < n; i++) if (op.comp[i] === c && (best < 0 || fromB[i] > fromB[best])) best = i;
      if (best >= 0) pins.push(best);
    }
    // extremities of the largest component
    let big = 0;
    const sizes = new Array(op.compCount).fill(0);
    for (let i = 0; i < n; i++) sizes[op.comp[i]]++;
    sizes.forEach((sz, c) => sz > sizes[big] && (big = c));
    const chosen = [pins[big] ?? pins[0]];
    let first = 0;
    for (let k = 0; k < 5; k++) {
      const d = dijkstra(chosen);
      let far = -1;
      for (let i = 0; i < n; i++) if (op.comp[i] === big && isFinite(d[i]) && (far < 0 || d[i] > d[far])) far = i;
      if (far < 0) break;
      if (k === 0) first = d[far];
      else if (d[far] < 0.42 * first) break;
      chosen.push(far);
      pins.push(far);
    }
    this.deformer.pins = [];
    for (const v of [...new Set(pins)]) {
      // a triangle containing v, with barycentric 1 at v
      let tri = -1, k = 0;
      for (let t2 = 0; t2 < op.m && tri < 0; t2++)
        for (let j = 0; j < 3; j++)
          if (mesh.tris[3 * t2 + j] === v) {
            tri = t2;
            k = j;
          }
      if (tri < 0) continue;
      const b: [number, number, number] = [0, 0, 0];
      b[k] = 1;
      this.deformer.pins.push({ id: this.nextId++, tri, b, x: P[2 * v], y: P[2 * v + 1] });
    }
    this.deformer.pinsChanged();
    this.requestRender();
    this.ui?.update();
  }

  // ============================================================== tools

  currentTool(): Tool {
    if (!this.img && this.step !== 'image') return {};
    switch (this.step) {
      case 'contour':
        return this.tool === 'points' ? this.pointsTool() : this.tool.startsWith('brush') ? this.brushTool(this.tool === 'brushAdd' ? 1 : 0) : this.lassoTool(this.tool === 'lassoAdd' ? 1 : 0);
      case 'mesh':
        return this.meshTool();
      case 'animate':
        return this.animTool();
      default:
        return {};
    }
  }

  private nearestControlPoint(x: number, y: number, rPx = 14) {
    const r2 = (rPx / this.view.zoom) ** 2;
    let best: { li: number; pi: number } | null = null, bd = r2;
    this.loops.forEach((l, li) =>
      l.forEach((p, pi) => {
        const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = { li, pi };
        }
      }),
    );
    return best as { li: number; pi: number } | null;
  }

  private nearestEdge(x: number, y: number, rPx = 12) {
    const r = rPx / this.view.zoom;
    let best: { li: number; pi: number; x: number; y: number } | null = null, bd = r * r;
    this.loops.forEach((l, li) => {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        let u = L ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0;
        u = Math.max(0, Math.min(1, u));
        const qx = a[0] + u * dx, qy = a[1] + u * dy;
        const d = (qx - x) ** 2 + (qy - y) ** 2;
        if (d < bd) {
          bd = d;
          best = { li, pi: i, x: qx, y: qy };
        }
      }
    });
    return best as { li: number; pi: number; x: number; y: number } | null;
  }

  private loopsEdited() {
    this.maskSynced = false;
    this.meshStale = true;
    this.docChanged();
    this.requestRender();
  }

  private pointsTool(): Tool {
    return {
      down: (p) => {
        const hit = this.nearestControlPoint(p.x, p.y, p.type === 'touch' ? 22 : 14);
        if (!hit) return null;
        let pushed = false;
        const pt = this.loops[hit.li][hit.pi];
        const ox = pt[0] - p.x, oy = pt[1] - p.y;
        return {
          move: (q) => {
            if (!pushed) {
              this.pushHistory();
              pushed = true;
            }
            const l = this.loops[hit.li];
            if (!l) return;
            l[hit.pi] = [q.x + ox, q.y + oy];
            this.hoverPoint = hit;
            this.requestRender();
          },
          up: () => this.loopsEdited(),
        };
      },
      tap: (p) => {
        if (this.nearestControlPoint(p.x, p.y, p.type === 'touch' ? 22 : 14)) return;
        const e = this.nearestEdge(p.x, p.y, p.type === 'touch' ? 20 : 12);
        if (e) {
          this.pushHistory();
          this.loops[e.li].splice(e.pi + 1, 0, [e.x, e.y]);
          this.loopsEdited();
        }
      },
      doubleTap: (p) => {
        const hit = this.nearestControlPoint(p.x, p.y, p.type === 'touch' ? 22 : 14);
        if (!hit) return;
        this.pushHistory();
        const l = this.loops[hit.li];
        if (l.length > 3) l.splice(hit.pi, 1);
        else this.loops.splice(hit.li, 1);
        this.hoverPoint = null;
        this.loopsEdited();
      },
      hover: (p) => {
        this.hoverPoint = p ? this.nearestControlPoint(p.x, p.y) : null;
        this.hoverEdge = p && !this.hoverPoint ? this.nearestEdge(p.x, p.y) : null;
        this.stage.style.cursor = this.hoverPoint ? 'grab' : this.hoverEdge ? 'copy' : '';
        this.requestRender();
      },
    };
  }

  private ensureMask() {
    if (!this.mask) {
      if (!this.analysis) return false;
      this.mask = { w: this.analysis.width, h: this.analysis.height, data: new Uint8Array(this.analysis.width * this.analysis.height), scale: this.aScale };
    }
    if (!this.maskSynced) this.syncMaskFromLoops();
    return true;
  }

  private brushTool(value: 0 | 1): Tool {
    const radius = (p: PointerInfo) => (this.brushPx * (p.type === 'pen' ? 0.4 + 1.2 * p.pressure : 1)) / this.view.zoom / this.aScale;
    const paint = (a: PointerInfo, b: PointerInfo) => {
      const m = this.mask!;
      paintSegment(m, a.x / this.aScale, a.y / this.aScale, b.x / this.aScale, b.y / this.aScale, radius(b), value);
      this.maskTintDirty = true;
      this.requestRender();
    };
    return {
      panOnEmpty: false,
      down: (p) => {
        if (!this.ensureMask()) return null;
        let last = p;
        let pushed = false;
        const begin = () => {
          if (!pushed) {
            this.pushHistory();
            pushed = true;
          }
        };
        return {
          move: (q) => {
            begin();
            paint(last, q);
            last = q;
            this.cursor = { x: q.x, y: q.y };
          },
          up: () => this.retrace(),
          cancel: () => {
            if (pushed) this.undo();
          },
        };
      },
      tap: (p) => {
        if (!this.ensureMask()) return;
        this.pushHistory();
        paint(p, p);
        this.retrace();
      },
      hover: (p) => {
        this.cursor = p ? { x: p.x, y: p.y } : null;
        this.stage.style.cursor = p ? 'none' : '';
        this.requestRender();
      },
    };
  }

  private lassoTool(value: 0 | 1): Tool {
    return {
      panOnEmpty: false,
      down: (p) => {
        if (!this.ensureMask()) return null;
        this.lasso = [[p.x, p.y]];
        return {
          move: (q) => {
            this.lasso?.push([q.x, q.y]);
            this.requestRender();
          },
          up: () => {
            const poly = this.lasso;
            this.lasso = null;
            if (poly && poly.length > 3) {
              this.pushHistory();
              fillPolygon(this.mask!, poly.map(([x, y]) => [x / this.aScale, y / this.aScale] as Pt), value);
              this.retrace();
            }
            this.requestRender();
          },
          cancel: () => {
            this.lasso = null;
            this.requestRender();
          },
        };
      },
    };
  }

  private meshTool(): Tool {
    const tool = this.tool;
    const pick = (p: PointerInfo) => (this.mesh ? nearestVertex(this.mesh.rest, p.x, p.y, (p.type === 'touch' ? 20 : 12) / this.view.zoom) : -1);
    return {
      down: (p) => {
        if (tool !== 'vmove' || !this.mesh) return null;
        const v = pick(p);
        if (v < 0) return null;
        let pushed = false;
        return {
          move: (q) => {
            if (!this.mesh) return;
            if (!pushed) {
              this.pushHistory();
              pushed = true;
              // copy-on-write so the history snapshot keeps the old positions
              this.mesh = { ...this.mesh, rest: this.mesh.rest.slice() };
            }
            this.mesh.rest[2 * v] = q.x;
            this.mesh.rest[2 * v + 1] = q.y;
            this.hoverVertex = v;
            this.gl.setMesh(this.mesh.rest, this.mesh.tris);
            this.requestRender();
          },
          up: () => {
            if (!this.mesh) return;
            const m = retriangulate(this.mesh);
            if (m.failed) this.ui.toast(t('selfIntersect'), 'warn');
            this.setMesh(m, true);
            this.docChanged();
            this.ui.update();
          },
        };
      },
      tap: (p) => {
        if (!this.mesh) return;
        if (tool === 'vadd') {
          const m = addVertex(this.mesh, p.x, p.y, 3 / this.view.zoom);
          if (m) {
            this.pushHistory();
            this.setMesh(m, true);
          }
        } else if (tool === 'vremove') {
          const v = pick(p);
          if (v >= 0) {
            const m = removeVertex(this.mesh, v);
            if (m && m.tris.length) {
              this.pushHistory();
              this.setMesh(m, true);
            }
          }
        }
        this.docChanged();
        this.ui.update();
      },
      doubleTap: (p) => {
        if (tool !== 'vmove' || !this.mesh) return;
        const v = pick(p);
        if (v >= 0) {
          const m = removeVertex(this.mesh, v);
          if (m && m.tris.length) {
            this.pushHistory();
            this.setMesh(m, true);
            this.ui.update();
          }
        }
      },
      hover: (p) => {
        this.hoverVertex = p ? pick(p) : -1;
        this.stage.style.cursor = this.hoverVertex >= 0 ? (tool === 'vremove' ? 'not-allowed' : 'grab') : tool === 'vadd' ? 'copy' : '';
        this.requestRender();
      },
    };
  }

  private animTool(): Tool {
    const pinOnly = this.tool === 'pin';
    return {
      multiTouch: true,
      down: (p) => {
        if (!this.deformer || !this.mesh) return null;
        const pin = this.pickPin(p.x, p.y);
        if (pin) {
          let ox = 0, oy = 0, started = false;
          return {
            move: (q) => {
              if (!started) {
                this.goLive();
                ox = pin.x - p.x;
                oy = pin.y - p.y;
                started = true;
              }
              pin.x = q.x + ox;
              pin.y = q.y + oy;
              this.deformer!.wake();
            },
            up: () => this.docChanged(),
          };
        }
        if (pinOnly) return null;
        const hit = locate(this.shownPos(), this.mesh.tris, p.x, p.y, 6 / this.view.zoom);
        if (!hit) return null;
        let temp: Pin | null = null;
        const drop = () => {
          if (temp) this.deformer?.removePin(temp.id);
          temp = null;
          this.requestRender();
        };
        return {
          move: (q) => {
            if (!this.deformer) return;
            if (!temp) {
              this.goLive();
              const [px, py] = this.pinPosOn({ id: 0, tri: hit.tri, b: hit.b, x: 0, y: 0 }, this.deformer.pos);
              temp = { id: -1 - p.id, tri: hit.tri, b: hit.b, x: px, y: py, temp: true };
              this.deformer.addPin(temp);
              if (this.deformer.pins.length === 1 && !this.s.jelly) this.ui.hint(t('hintNoPins'), 'nopins');
            }
            temp.x = q.x;
            temp.y = q.y;
            this.deformer.wake();
          },
          up: drop,
          cancel: drop,
        };
      },
      tap: (p) => {
        const pin = this.pickPin(p.x, p.y);
        if (pin) this.removePin(pin.id);
        else this.addPinAt(p.x, p.y);
      },
      longPress: (p) => {
        if (!this.pickPin(p.x, p.y)) this.addPinAt(p.x, p.y);
      },
      hover: (p) => {
        const pin = p ? this.pickPin(p.x, p.y) : null;
        this.hoverPin = pin ? pin.id : -1;
        const onShape = p && this.mesh ? !!locate(this.shownPos(), this.mesh.tris, p.x, p.y) : false;
        this.stage.style.cursor = pin ? 'grab' : onShape && !pinOnly ? 'grab' : onShape ? 'copy' : '';
        this.requestRender();
      },
    };
  }

  // ============================================================== frame

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    if (this.step === 'animate' && this.deformer) {
      if (this.mode === 'live') {
        if (this.deformer.update(dt)) this.dirty = true;
      } else if (this.playing) {
        this.playClock += dt * this.speed;
        if (this.mode === 'timeline') {
          const k = this.timelineKeys().length;
          if (k < 2) this.goLive();
          else {
            const { tau, done } = timelinePosition(this.playClock, this.s.secondsPerKey, k, this.s.loopMode);
            this.tau = tau;
            this.applyTimeline();
            if (done) {
              this.playing = false;
              this.ui.update();
            }
          }
        } else if (this.mode === 'clip' && this.clip && this.blendBuf) {
          const f = this.clip.frames[Math.floor(this.playClock * this.clip.fps) % this.clip.frames.length];
          if (f.length === this.blendBuf.length) this.blendBuf.set(f);
          this.dirty = true;
        }
        this.ui.stats();
      }
      if (this.recording) {
        // fixed 30 fps clip: repeat the current frame when the display runs slower
        this.recording.acc += dt;
        if (this.recording.acc >= 1 / 30) {
          const f = Float32Array.from(this.deformer.pos);
          while (this.recording.acc >= 1 / 30) {
            this.recording.acc -= 1 / 30;
            this.recording.frames.push(f);
          }
          if (this.recording.frames.length > 30 * 60) this.toggleRecord();
        }
      }
      if (this.dirty) this.ui.stats();
    }
    if (this.dirty) {
      this.dirty = false;
      this.render();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  backdropColor(): [number, number, number, number] {
    const dark = this.s.backdrop === 'dark';
    return dark ? [0.11, 0.1, 0.16, 1] : [0.98, 0.96, 0.95, 1];
  }

  render() {
    const gl = this.gl, ov = this.ov, s = this.s;
    const clear: [number, number, number, number] = this.exporting ? this.backdropColor() : [0, 0, 0, 0];
    const flat: [number, number, number, number] = [1, 0.62, 0.74, 1];
    ov.begin(this.view);
    if (!this.img) {
      gl.draw(this.view, this.W, this.H, { image: false, imageAlpha: 0, mesh: false, texture: false, heat: false, heatAlpha: 0, clear, flat });
      return;
    }
    if (this.step === 'image') {
      gl.draw(this.view, this.W, this.H, { image: true, imageAlpha: 0.35, mesh: false, texture: true, heat: false, heatAlpha: 0, clear, flat });
      return;
    }
    if (this.step === 'contour') {
      gl.draw(this.view, this.W, this.H, { image: true, imageAlpha: 1, mesh: false, texture: true, heat: false, heatAlpha: 0, clear, flat });
      const brushy = this.tool !== 'points';
      if (brushy && this.mask) {
        this.updateMaskTint();
        if (this.maskTint) ov.image(this.maskTint, 0, 0, this.mask.w * this.aScale, this.mask.h * this.aScale, 0.9);
      } else ov.dimOutside(this.loops, this.imgW, this.imgH, 0.5);
      ov.strokeLoops(this.loops, brushy ? C.ink : C.accent, 2.5);
      if (this.tool === 'points') {
        for (const [li, l] of this.loops.entries()) ov.points(l, C.blue, 4, this.hoverPoint?.li === li ? this.hoverPoint.pi : -1);
        if (this.hoverEdge) ov.circle(this.hoverEdge.x, this.hoverEdge.y, ov.px(5), C.accent2, 2, 'rgba(46,196,166,0.5)');
      }
      if (this.lasso) ov.polyline(this.lasso, this.tool === 'lassoAdd' ? C.accent2 : C.accent, 2, true, [6, 5]);
      if (this.cursor && this.tool.startsWith('brush')) ov.circle(this.cursor.x, this.cursor.y, ov.px(this.brushPx), this.tool === 'brushAdd' ? C.accent2 : C.accent, 1.5);
      return;
    }
    if (!this.mesh) {
      gl.draw(this.view, this.W, this.H, { image: true, imageAlpha: 1, mesh: false, texture: true, heat: false, heatAlpha: 0, clear, flat });
      return;
    }
    if (this.step === 'mesh') {
      const heat = s.heatmap === 'quality';
      if (heat) this.computeHeat(this.mesh.rest, 'quality');
      gl.draw(this.view, this.W, this.H, { image: true, imageAlpha: 0.3, mesh: true, texture: true, heat, heatAlpha: 0.7, clear, flat });
      ov.wireframe(this.mesh.rest, this.mesh.tris, 'rgba(255,255,255,0.9)', 1);
      ov.indexLoopsPath(this.mesh.rest, this.mesh.loops);
      ov.ctx.strokeStyle = C.accent;
      ov.ctx.lineWidth = ov.px(2.5);
      ov.ctx.stroke();
      ov.vertices(this.mesh.rest, this.boundary, 3, this.hoverVertex);
      return;
    }
    // ---- animate
    const P = this.shownPos();
    gl.updatePositions(P);
    const heat = s.heatmap !== 'none';
    if (heat) this.computeHeat(P, s.heatmap);
    gl.draw(this.view, this.W, this.H, {
      image: s.ghost && !this.exporting,
      imageAlpha: 0.22,
      mesh: true,
      texture: s.showTexture,
      heat,
      heatAlpha: s.showTexture ? 0.72 : 1,
      clear,
      flat,
    });
    if (this.exporting) return;
    if (s.onion) {
      for (const p of this.poses) {
        ov.indexLoopsPath(p.pos, this.mesh.loops);
        ov.ctx.strokeStyle = 'rgba(255,93,143,0.45)';
        ov.ctx.lineWidth = ov.px(1.5);
        ov.ctx.stroke();
      }
      ov.indexLoopsPath(this.mesh.rest, this.mesh.loops);
      ov.ctx.strokeStyle = 'rgba(80,80,120,0.35)';
      ov.ctx.stroke();
    }
    if (s.compare !== 'none' && (this.mode === 'timeline' || this.mode === 'pad') && this.lastWeights && this.cmpBuf) {
      const ip = this.ensureInterp();
      if (ip) {
        ip.blend(this.lastWeights, s.compare, this.cmpBuf);
        ov.indexLoopsPath(this.cmpBuf, this.mesh.loops);
        ov.ctx.setLineDash([ov.px(6), ov.px(4)]);
        ov.ctx.strokeStyle = C.blue;
        ov.ctx.lineWidth = ov.px(2.5);
        ov.ctx.stroke();
        ov.ctx.setLineDash([]);
      }
    }
    if (s.showWire) ov.wireframe(P, this.mesh.tris, 'rgba(255,255,255,0.85)', 1);
    if (s.showVerts) ov.vertices(P, this.boundary, 2.4);
    if (s.showPins && this.deformer) {
      for (const pin of this.deformer.pins) {
        const [x, y] = this.mode === 'live' ? [pin.x, pin.y] : this.pinPosOn(pin, P);
        ov.pin(x, y, pin.temp ? 'grab' : pin.id === this.hoverPin ? 'hover' : 'pin');
      }
    }
  }

  private updateMaskTint() {
    if (!this.mask || !this.maskTintDirty) return;
    const m = this.mask;
    if (!this.maskTint || this.maskTint.width !== m.w || this.maskTint.height !== m.h) {
      this.maskTint = document.createElement('canvas');
      this.maskTint.width = m.w;
      this.maskTint.height = m.h;
    }
    const ctx = this.maskTint.getContext('2d')!;
    const id = ctx.createImageData(m.w, m.h);
    for (let i = 0; i < m.w * m.h; i++) {
      if (m.data[i]) {
        id.data[4 * i] = 46; id.data[4 * i + 1] = 196; id.data[4 * i + 2] = 166; id.data[4 * i + 3] = 90;
      } else {
        id.data[4 * i] = 20; id.data[4 * i + 1] = 16; id.data[4 * i + 2] = 40; id.data[4 * i + 3] = 120;
      }
    }
    ctx.putImageData(id, 0, 0);
    this.maskTintDirty = false;
  }

  private computeHeat(P: ArrayLike<number>, kind: string) {
    if (!this.op || !this.mesh) return;
    const op = this.op, m = op.m;
    if (!this.heatColors || this.heatColors.length !== 4 * m) this.heatColors = new Float32Array(4 * m);
    const col = this.heatColors, J = new Float64Array(4);
    const T = this.mesh.tris, R = this.mesh.rest;
    const theta = this.mode === 'live' ? this.deformer?.theta : this.blendTheta;
    for (let k = 0; k < m; k++) {
      op.jacobian(P, k, J);
      if (kind === 'stretch') {
        const [s1, s2] = singularValues(J[0], J[1], J[2], J[3]);
        viridis(s2 > 1e-9 ? Math.log(s1 / s2) / Math.log(3) : 1, col, 4 * k);
      } else if (kind === 'area') {
        const det = J[0] * J[3] - J[1] * J[2];
        diverging(det > 0 ? Math.log(det) / Math.log(2.5) : -1, col, 4 * k);
      } else if (kind === 'rotation') {
        const th = theta && theta.length === m ? theta[k] : polarAngle(J[0], J[1], J[2], J[3]);
        diverging(th / Math.PI, col, 4 * k);
      } else {
        const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
        const la = Math.hypot(R[2 * b] - R[2 * c], R[2 * b + 1] - R[2 * c + 1]);
        const lb = Math.hypot(R[2 * a] - R[2 * c], R[2 * a + 1] - R[2 * c + 1]);
        const lc = Math.hypot(R[2 * a] - R[2 * b], R[2 * a + 1] - R[2 * b + 1]);
        const q = (4 * Math.sqrt(3) * op.area[k]) / (la * la + lb * lb + lc * lc || 1);
        viridis(q, col, 4 * k);
      }
    }
    this.gl.setHeat(P, T, col);
  }

  // ============================================================== export

  /** Render a pose into a small thumbnail (data URL) using the GL canvas. */
  renderThumb(pos: Float64Array, size = 96): string {
    if (!this.mesh) return '';
    const [x0, y0, x1, y1] = bbox(pos);
    const span = Math.max(x1 - x0, y1 - y0) || 1;
    const css = size;
    const zoom = (css * 0.86) / span;
    const view = { zoom, panX: (css - (x1 - x0) * zoom) / 2 - x0 * zoom, panY: (css - (y1 - y0) * zoom) / 2 - y0 * zoom };
    this.gl.updatePositions(pos);
    this.gl.draw(view, this.W, this.H, {
      image: false, imageAlpha: 0, mesh: true, texture: true, heat: false, heatAlpha: 0, clear: [0, 0, 0, 0], flat: [1, 0.62, 0.74, 1],
    });
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const ctx = c.getContext('2d')!;
    const d = this.dpr;
    ctx.drawImage(this.gl.canvas, 0, 0, css * d, css * d, 0, 0, size * 2, size * 2);
    this.requestRender();
    return c.toDataURL('image/png');
  }

  exportPNG() {
    if (!this.mesh) return;
    const P = this.step === 'animate' ? this.shownPos() : this.mesh.rest;
    let [x0, y0, x1, y1] = bbox(P);
    const pad = 4;
    x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
    const k = Math.min(1, 4096 / Math.max(x1 - x0, y1 - y0));
    const w = Math.round((x1 - x0) * k), h = Math.round((y1 - y0) * k);
    const gl = this.gl;
    gl.canvas.width = w;
    gl.canvas.height = h;
    gl.updatePositions(P);
    gl.draw({ zoom: k, panX: -x0 * k, panY: -y0 * k }, w, h, {
      image: false, imageAlpha: 0, mesh: true, texture: true, heat: false, heatAlpha: 0, clear: [0, 0, 0, 0], flat: [1, 0.62, 0.74, 1],
    });
    const url = gl.canvas.toDataURL('image/png');
    this.resize();
    this.render();
    fetch(url)
      .then((r) => r.blob())
      .then((b) => downloadBlob(b, `${this.imgName}-pose.png`));
  }

  async exportVideo(): Promise<void> {
    const canvas = this.gl.canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream };
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      this.ui.toast(t('videoUnsupported'), 'warn');
      return;
    }
    let duration: number;
    if (this.mode === 'clip' && this.clip) duration = this.clip.frames.length / this.clip.fps;
    else {
      if (this.timelineKeys().length < 2) {
        this.ui.toast(t('videoNeedsAnim'), 'warn');
        return;
      }
      this.mode = 'timeline';
      const segs = this.timelineSegments;
      duration = segs * this.s.secondsPerKey * (this.s.loopMode === 'pingpong' ? 2 : 1);
    }
    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mime = types.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    const stream = canvas.captureStream(60);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    this.exporting = true;
    this.playClock = 0;
    this.playing = true;
    this.speed = 1;
    this.fitView();
    this.ui.toast(`${t('recording')} ${duration.toFixed(1)}s`);
    rec.start();
    await new Promise((r) => setTimeout(r, duration * 1000 + 150));
    rec.stop();
    await done;
    this.exporting = false;
    this.requestRender();
    const ext = (rec.mimeType || mime).includes('mp4') ? 'mp4' : 'webm';
    downloadBlob(new Blob(chunks, { type: rec.mimeType || 'video/webm' }), `${this.imgName}.${ext}`);
    this.ui.update();
  }

  exportOBJ() {
    if (!this.mesh) return;
    const P = this.step === 'animate' ? this.shownPos() : this.mesh.rest;
    const lines = [`# LieMorph mesh: ${vcount(this.mesh)} vertices, ${this.mesh.tris.length / 3} triangles`, `mtllib ${this.imgName}.mtl`];
    for (let i = 0; i < P.length; i += 2) lines.push(`v ${P[i].toFixed(4)} ${(-P[i + 1]).toFixed(4)} 0`);
    for (let i = 0; i < this.mesh.rest.length; i += 2) lines.push(`vt ${(this.mesh.rest[i] / this.imgW).toFixed(6)} ${(1 - this.mesh.rest[i + 1] / this.imgH).toFixed(6)}`);
    const T = this.mesh.tris;
    // y is flipped above, so reverse the winding to keep normals facing +z
    for (let k = 0; k < T.length; k += 3) lines.push(`f ${T[k] + 1}/${T[k] + 1} ${T[k + 2] + 1}/${T[k + 2] + 1} ${T[k + 1] + 1}/${T[k + 1] + 1}`);
    downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }), `${this.imgName}.obj`);
  }

  exportSVG() {
    if (!this.mesh) return;
    const P = this.step === 'animate' ? this.shownPos() : this.mesh.rest;
    const [x0, y0, x1, y1] = bbox(P);
    const pad = 10, T = this.mesh.tris;
    const f = (v: number) => v.toFixed(2);
    let tri = '';
    for (let k = 0; k < T.length; k += 3) tri += `M${f(P[2 * T[k]])} ${f(P[2 * T[k] + 1])}L${f(P[2 * T[k + 1]])} ${f(P[2 * T[k + 1] + 1])}L${f(P[2 * T[k + 2]])} ${f(P[2 * T[k + 2] + 1])}Z`;
    let bd = '';
    for (const l of this.mesh.loops) bd += 'M' + l.map((v) => `${f(P[2 * v])} ${f(P[2 * v + 1])}`).join('L') + 'Z';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0 - pad)} ${f(y0 - pad)} ${f(x1 - x0 + 2 * pad)} ${f(y1 - y0 + 2 * pad)}">
<path d="${tri}" fill="#ffe3ec" stroke="#4f7dff" stroke-width="0.8" stroke-linejoin="round"/>
<path d="${bd}" fill="none" stroke="#ff5d8f" stroke-width="2" stroke-linejoin="round"/>
</svg>`;
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${this.imgName}-mesh.svg`);
  }

  exportMaple() {
    if (!this.mesh) return;
    const frames = [this.mesh.rest, ...this.poses.map((p) => p.pos)];
    const txt = toMaple(frames, this.mesh.tris, `exported from LieMorph (${new Date().toISOString().slice(0, 10)}) — ${this.imgName}`);
    downloadBlob(new Blob([txt], { type: 'text/plain' }), `${this.imgName}.mpl`);
  }

  exportPosesJSON() {
    if (!this.mesh) return;
    const r = (a: ArrayLike<number>) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
    const ip = this.ensureInterp();
    const data = {
      format: 'liemorph-poses',
      description: 'rest: rest vertex positions (x,y interleaved, image pixels, y down); tris: 0-based triangles; poses[j].pos: vertex positions; poses[j].theta: per-triangle rotation angles (radians, branch-resolved).',
      rest: r(this.mesh.rest),
      tris: Array.from(this.mesh.tris),
      boundary: this.mesh.loops,
      poses: this.poses.map((p, j) => ({ pos: r(p.pos), theta: ip ? r(ip.poses[j + 1].theta) : null, turns: p.turns })),
      settings: { method: this.s.interpMethod, branch: this.s.branch, weighting: this.s.weighting },
    };
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${this.imgName}-poses.json`);
  }

  toProject(compact = false) {
    const r = (a: ArrayLike<number>, d = 100) => Array.from(a, (v) => Math.round(v * d) / d);
    const imgType = this.hasAlpha ? 'image/png' : 'image/jpeg';
    return {
      format: 'liemorph-project',
      version: 1,
      name: this.imgName,
      image: this.img ? this.img.toDataURL(imgType, 0.92) : null,
      threshold: this.threshold,
      loops: this.loops.map((l) => l.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100])),
      mesh: this.mesh ? { rest: r(this.mesh.rest), tris: Array.from(this.mesh.tris), loops: this.mesh.loops } : null,
      poses: this.poses.map((p) => ({ pos: r(p.pos), theta: p.theta ? r(p.theta, 1e4) : null, turns: p.turns, pad: p.pad })),
      pins: this.deformer ? this.deformer.pins.filter((p) => !p.temp).map((p) => ({ tri: p.tri, b: r(p.b, 1e6), x: p.x, y: p.y })) : [],
      clip: this.clip && !compact ? { fps: this.clip.fps, frames: this.clip.frames.map((f) => r(f, 10)) } : null,
      settings: this.s,
    };
  }

  saveProject() {
    const json = JSON.stringify(this.toProject());
    downloadBlob(new Blob([json], { type: 'application/json' }), `${this.imgName}.liemorph.json`);
  }

  async loadProject(p: ReturnType<App['toProject']>) {
    if (p.format !== 'liemorph-project' || !p.image) throw new Error('not a LieMorph project');
    const img = new Image();
    img.src = p.image;
    await img.decode();
    if (p.settings) {
      this.s = { ...defaults, ...p.settings };
      saveSettings(this.s);
    }
    this.loadImage(img, img.naturalWidth, img.naturalHeight, p.name ?? 'project', false);
    this.threshold = p.threshold ?? null;
    this.loops = (p.loops ?? []).map((l) => l.map((q) => [q[0], q[1]] as Pt));
    this.syncMaskFromLoops();
    if (p.mesh) {
      this.setMesh({ rest: Float64Array.from(p.mesh.rest), tris: Uint32Array.from(p.mesh.tris), loops: p.mesh.loops }, false);
      this.poses = p.poses.map((q) => {
        const pos = Float64Array.from(q.pos);
        return { id: this.nextId++, pos, theta: q.theta ? Float64Array.from(q.theta) : null, turns: q.turns ?? 0, pad: q.pad ?? [1, 0], thumb: this.renderThumb(pos) };
      });
      if (this.deformer) {
        this.deformer.pins = p.pins.map((q) => ({ id: this.nextId++, tri: q.tri, b: q.b as [number, number, number], x: q.x, y: q.y }));
        this.deformer.pinsChanged();
      }
      if (p.clip) this.clip = { fps: p.clip.fps, frames: p.clip.frames.map((f) => Float32Array.from(f)) };
      this.setStep('animate');
    } else this.setStep('contour');
    this.fitView();
    this.ui.update();
  }

  async resume(): Promise<boolean> {
    const s = await kvGet<string>('autosave');
    if (!s) return false;
    try {
      await this.loadProject(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  }

  /** is the point inside the current outline? (used by the UI for hints) */
  insideShape(x: number, y: number) {
    return insideLoops(x, y, this.loops);
  }

  relaxMesh() {
    if (!this.mesh) return;
    this.pushHistory();
    const m = { ...this.mesh, rest: this.mesh.rest.slice() };
    for (let i = 0; i < 3; i++) {
      relaxOnce(m);
      m.tris = triangulate(m.rest, m.loops).tris;
    }
    this.setMesh(retriangulate(m), true);
    this.ui.update();
  }
}

/** Advanced settings: schema (drives the settings drawer), defaults and persistence. */
import type { InterpMethod, BranchMode, Easing, LoopMode } from './geom/interp.ts';
import { tr } from './i18n.ts';

export type Heatmap = 'none' | 'stretch' | 'area' | 'rotation' | 'quality';
export type Backdrop = 'checker' | 'light' | 'dark';

export interface Settings {
  // detection
  detMode: 'auto' | 'alpha' | 'background';
  detResolution: number;
  detBlur: number;
  detClose: number;
  detOpen: number;
  detMargin: number;
  detFillHoles: boolean;
  detKeepLargest: boolean;
  detSmooth: number;
  detSimplify: number;
  // mesh
  meshVertices: number;
  meshPattern: 'hex' | 'poisson' | 'none';
  meshRelax: number;
  meshCorner: number;
  meshGap: number;
  // deformation
  rigidity: number;
  weighting: 'area' | 'uniform';
  iterations: number;
  jelly: boolean;
  stiffness: number;
  damping: number;
  gravity: number;
  floor: boolean;
  // interpolation
  interpMethod: InterpMethod;
  branch: BranchMode;
  easing: Easing;
  loopMode: LoopMode;
  secondsPerKey: number;
  includeRest: boolean;
  compare: 'none' | InterpMethod;
  // display
  showTexture: boolean;
  showWire: boolean;
  showVerts: boolean;
  showPins: boolean;
  heatmap: Heatmap;
  ghost: boolean;
  onion: boolean;
  backdrop: Backdrop;
}

export const defaults: Settings = {
  detMode: 'auto',
  detResolution: 512,
  detBlur: 1,
  detClose: 2,
  detOpen: 1,
  detMargin: 1.5,
  detFillHoles: true,
  detKeepLargest: true,
  detSmooth: 1.2,
  detSimplify: 0.8,
  meshVertices: 350,
  meshPattern: 'hex',
  meshRelax: 3,
  meshCorner: 40,
  meshGap: 0.6,
  rigidity: 1,
  weighting: 'area',
  iterations: 8,
  jelly: false,
  stiffness: 80,
  damping: 1.5,
  gravity: 0,
  floor: true,
  interpMethod: 'polar-log',
  branch: 'tracked',
  easing: 'smooth',
  loopMode: 'pingpong',
  secondsPerKey: 1.2,
  includeRest: true,
  compare: 'none',
  showTexture: true,
  showWire: false,
  showVerts: false,
  showPins: true,
  heatmap: 'none',
  ghost: false,
  onion: false,
  backdrop: 'checker',
};

type Opt<T extends string> = { value: T; label: () => string };

export type Field =
  | { key: keyof Settings; kind: 'range'; label: () => string; min: number; max: number; step: number; log?: boolean; fmt?: (v: number) => string; help?: () => string }
  | { key: keyof Settings; kind: 'toggle'; label: () => string; help?: () => string }
  | { key: keyof Settings; kind: 'select'; label: () => string; options: Opt<string>[]; help?: () => string };

export interface Section {
  id: string;
  title: () => string;
  /** which pipeline stage must be recomputed when a field changes */
  effect: 'detect' | 'mesh' | 'deform' | 'interp' | 'display';
  fields: Field[];
}

const methodOpts: Opt<InterpMethod>[] = [
  { value: 'polar-log', label: () => tr('極分解＋対数 (Kaji+ 2012)', 'Polar + log (Kaji+ 2012)') },
  { value: 'polar-linear', label: () => tr('極分解＋線形 (Alexa+ 2000)', 'Polar + linear (Alexa+ 2000)') },
  { value: 'affine-linear', label: () => tr('アフィン線形', 'Affine linear') },
  { value: 'vertex-linear', label: () => tr('頂点の線形補間', 'Vertex linear') },
];

export const schema: Section[] = [
  {
    id: 'detect',
    title: () => tr('輪郭検出', 'Outline detection'),
    effect: 'detect',
    fields: [
      {
        key: 'detMode', kind: 'select', label: () => tr('方式', 'Mode'),
        options: [
          { value: 'auto', label: () => tr('自動', 'Auto') },
          { value: 'alpha', label: () => tr('透明度 (PNG)', 'Alpha (PNG)') },
          { value: 'background', label: () => tr('背景色との差 (CIELAB ΔE)', 'Background colour distance (CIELAB ΔE)') },
        ],
      },
      { key: 'detResolution', kind: 'range', label: () => tr('解析解像度', 'Analysis resolution'), min: 128, max: 1024, step: 32, fmt: (v) => `${v}px` },
      { key: 'detBlur', kind: 'range', label: () => tr('前処理ぼかし', 'Pre-blur'), min: 0, max: 6, step: 0.5 },
      { key: 'detClose', kind: 'range', label: () => tr('クロージング半径', 'Closing radius'), min: 0, max: 12, step: 0.5, help: () => tr('隙間を埋める', 'bridges small gaps') },
      { key: 'detOpen', kind: 'range', label: () => tr('オープニング半径', 'Opening radius'), min: 0, max: 8, step: 0.5, help: () => tr('細いノイズを消す', 'removes thin specks') },
      { key: 'detMargin', kind: 'range', label: () => tr('余白（膨張）', 'Margin (dilation)'), min: 0, max: 8, step: 0.5 },
      { key: 'detFillHoles', kind: 'toggle', label: () => tr('穴を埋める', 'Fill holes') },
      { key: 'detKeepLargest', kind: 'toggle', label: () => tr('最大の部分だけ残す', 'Keep largest part only') },
      { key: 'detSmooth', kind: 'range', label: () => tr('輪郭の平滑化 σ', 'Outline smoothing σ'), min: 0, max: 5, step: 0.1 },
      { key: 'detSimplify', kind: 'range', label: () => tr('単純化 (Douglas–Peucker ε)', 'Simplify (Douglas–Peucker ε)'), min: 0, max: 5, step: 0.1 },
    ],
  },
  {
    id: 'mesh',
    title: () => tr('メッシュ生成', 'Mesh generation'),
    effect: 'mesh',
    fields: [
      { key: 'meshVertices', kind: 'range', label: () => tr('目標頂点数', 'Target vertices'), min: 30, max: 3000, step: 1, log: true, fmt: (v) => `≈${Math.round(v)}` },
      {
        key: 'meshPattern', kind: 'select', label: () => tr('内部点の配置', 'Interior points'),
        options: [
          { value: 'hex', label: () => tr('六角格子', 'Hexagonal lattice') },
          { value: 'poisson', label: () => tr('ポアソンディスク', 'Poisson disk') },
          { value: 'none', label: () => tr('なし（境界のみ）', 'None (boundary only)') },
        ],
      },
      { key: 'meshRelax', kind: 'range', label: () => tr('緩和の回数', 'Relaxation sweeps'), min: 0, max: 15, step: 1 },
      { key: 'meshCorner', kind: 'range', label: () => tr('角として残す角度', 'Corner angle kept'), min: 10, max: 120, step: 1, fmt: (v) => `${v}°` },
      { key: 'meshGap', kind: 'range', label: () => tr('境界からの距離', 'Boundary gap'), min: 0.3, max: 1.2, step: 0.05, fmt: (v) => `${v.toFixed(2)}h` },
    ],
  },
  {
    id: 'deform',
    title: () => tr('変形 (ARAP)', 'Deformation (ARAP)'),
    effect: 'deform',
    fields: [
      { key: 'rigidity', kind: 'range', label: () => tr('剛性 (ASAP ↔ ARAP)', 'Rigidity (ASAP ↔ ARAP)'), min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      {
        key: 'weighting', kind: 'select', label: () => tr('重み', 'Weights'),
        options: [
          { value: 'area', label: () => tr('面積（余接ラプラシアン）', 'Area (cotangent Laplacian)') },
          { value: 'uniform', label: () => tr('一様 (Alexa 2000)', 'Uniform (Alexa 2000)') },
        ],
      },
      { key: 'iterations', kind: 'range', label: () => tr('局所–大域反復 / フレーム', 'Local–global iterations / frame'), min: 1, max: 50, step: 1 },
      { key: 'jelly', kind: 'toggle', label: () => tr('ぷるぷる（動力学）', 'Jelly (dynamics)') },
      { key: 'stiffness', kind: 'range', label: () => tr('硬さ k', 'Stiffness k'), min: 5, max: 2000, step: 1, log: true, fmt: (v) => v.toFixed(0) },
      { key: 'damping', kind: 'range', label: () => tr('減衰', 'Damping'), min: 0, max: 10, step: 0.1 },
      { key: 'gravity', kind: 'range', label: () => tr('重力', 'Gravity'), min: 0, max: 6, step: 0.1 },
      { key: 'floor', kind: 'toggle', label: () => tr('床（画像の下端）', 'Floor (image bottom)') },
    ],
  },
  {
    id: 'interp',
    title: () => tr('形状補間', 'Shape interpolation'),
    effect: 'interp',
    fields: [
      { key: 'interpMethod', kind: 'select', label: () => tr('補間法', 'Method'), options: methodOpts },
      {
        key: 'branch', kind: 'select', label: () => tr('回転角の分枝', 'Rotation branch'),
        options: [
          { value: 'tracked', label: () => tr('追跡（操作どおり）', 'Tracked (as manipulated)') },
          { value: 'consistent', label: () => tr('隣接で一貫 (BFS)', 'Consistent over adjacency (BFS)') },
          { value: 'principal', label: () => tr('主値 (−π, π]', 'Principal (−π, π]') },
        ],
      },
      {
        key: 'easing', kind: 'select', label: () => tr('時間補間', 'Timing'),
        options: [
          { value: 'linear', label: () => tr('線形', 'Linear') },
          { value: 'smooth', label: () => tr('イーズ（smoothstep）', 'Ease (smoothstep)') },
          { value: 'spline', label: () => tr('スプライン（Catmull–Rom）', 'Spline (Catmull–Rom)') },
        ],
      },
      {
        key: 'loopMode', kind: 'select', label: () => tr('ループ', 'Loop'),
        options: [
          { value: 'pingpong', label: () => tr('往復', 'Ping-pong') },
          { value: 'loop', label: () => tr('ループ', 'Loop') },
          { value: 'once', label: () => tr('1回', 'Once') },
        ],
      },
      { key: 'secondsPerKey', kind: 'range', label: () => tr('1区間の秒数', 'Seconds per segment'), min: 0.2, max: 5, step: 0.1, fmt: (v) => `${v.toFixed(1)}s` },
      { key: 'includeRest', kind: 'toggle', label: () => tr('基本形から始める', 'Start from rest shape') },
      {
        key: 'compare', kind: 'select', label: () => tr('比較表示（輪郭）', 'Compare (outline)'),
        options: [{ value: 'none', label: () => tr('なし', 'None') }, ...methodOpts],
      },
    ],
  },
  {
    id: 'display',
    title: () => tr('表示', 'Display'),
    effect: 'display',
    fields: [
      { key: 'showTexture', kind: 'toggle', label: () => tr('テクスチャ', 'Texture') },
      { key: 'showWire', kind: 'toggle', label: () => tr('ワイヤーフレーム', 'Wireframe') },
      { key: 'showVerts', kind: 'toggle', label: () => tr('頂点', 'Vertices') },
      { key: 'showPins', kind: 'toggle', label: () => tr('ピン', 'Pins') },
      {
        key: 'heatmap', kind: 'select', label: () => tr('ヒートマップ', 'Heatmap'),
        options: [
          { value: 'none', label: () => tr('なし', 'None') },
          { value: 'stretch', label: () => tr('歪み σ₁/σ₂', 'Distortion σ₁/σ₂') },
          { value: 'area', label: () => tr('面積比 det J', 'Area ratio det J') },
          { value: 'rotation', label: () => tr('回転角 θ', 'Rotation θ') },
          { value: 'quality', label: () => tr('三角形の品質', 'Triangle quality') },
        ],
      },
      { key: 'ghost', kind: 'toggle', label: () => tr('元画像を薄く表示', 'Ghost of original image') },
      { key: 'onion', kind: 'toggle', label: () => tr('オニオンスキン（ポーズ）', 'Onion skin (poses)') },
      {
        key: 'backdrop', kind: 'select', label: () => tr('背景', 'Backdrop'),
        options: [
          { value: 'checker', label: () => tr('市松', 'Checker') },
          { value: 'light', label: () => tr('明るい', 'Light') },
          { value: 'dark', label: () => tr('暗い', 'Dark') },
        ],
      },
    ],
  },
];

const KEY = 'liemorph.settings.v1';

export function loadSettings(): Settings {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return { ...defaults, ...JSON.parse(s) };
  } catch {
    /* private mode etc. */
  }
  return { ...defaults };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

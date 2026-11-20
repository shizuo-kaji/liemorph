export type Lang = 'ja' | 'en';

const dict = {
  appTagline: { ja: '絵をぷにぷに動かそう', en: 'Bring pictures to life' },
  stepImage: { ja: '画像', en: 'Image' },
  stepContour: { ja: '輪郭', en: 'Outline' },
  stepMesh: { ja: 'メッシュ', en: 'Mesh' },
  stepAnimate: { ja: '動かす', en: 'Animate' },
  dropTitle: { ja: '画像をドロップ', en: 'Drop a picture here' },
  dropSub: { ja: '輪郭と三角形分割は自動。すぐに動かせます', en: 'Outline and triangulation are automatic — start playing right away' },
  chooseFile: { ja: 'ファイルを選ぶ', en: 'Choose file' },
  camera: { ja: 'カメラで撮る', en: 'Take a photo' },
  paste: { ja: '貼り付け', en: 'Paste' },
  orTrySample: { ja: 'サンプルで遊ぶ', en: 'Or try a sample' },
  classicTitle: { ja: 'クラシック例（SCA 2012 の Maple データ）', en: 'Classic examples (Maple data from SCA 2012)' },
  resume: { ja: '前回の続きから', en: 'Resume last session' },
  undo: { ja: '元に戻す', en: 'Undo' },
  redo: { ja: 'やり直す', en: 'Redo' },
  settings: { ja: '詳細設定', en: 'Advanced settings' },
  help: { ja: 'ヘルプ', en: 'Help' },
  file: { ja: 'ファイル', en: 'File' },
  fit: { ja: '全体を表示', en: 'Fit to view' },
  zoomIn: { ja: '拡大', en: 'Zoom in' },
  zoomOut: { ja: '縮小', en: 'Zoom out' },
  next: { ja: '次へ', en: 'Next' },
  // contour
  autoDetect: { ja: '自動検出', en: 'Auto detect' },
  threshold: { ja: 'しきい値', en: 'Threshold' },
  auto: { ja: '自動', en: 'auto' },
  smoothness: { ja: 'なめらかさ', en: 'Smoothness' },
  detail: { ja: '細かさ', en: 'Detail' },
  brushSize: { ja: 'ブラシ', en: 'Brush' },
  toolPoints: { ja: '点を編集', en: 'Edit points' },
  toolBrushAdd: { ja: '塗って追加', en: 'Paint to add' },
  toolBrushErase: { ja: '塗って削除', en: 'Paint to erase' },
  toolLassoAdd: { ja: '囲んで追加', en: 'Lasso add' },
  toolLassoErase: { ja: '囲んで削除', en: 'Lasso erase' },
  hintPoints: { ja: '点をドラッグ／線をタップで点を追加／点をダブルタップで削除', en: 'Drag points · tap an edge to insert · double-tap a point to delete' },
  hintBrush: { ja: 'なぞって塗る。2本指でズーム', en: 'Paint with one finger · pinch to zoom' },
  hintLasso: { ja: 'ぐるっと囲む', en: 'Draw a loop around the area' },
  // mesh
  density: { ja: '頂点数', en: 'Vertices' },
  regenerate: { ja: '作り直す', en: 'Rebuild' },
  relax: { ja: '整える', en: 'Relax' },
  toolMove: { ja: '頂点を動かす', en: 'Move vertex' },
  toolAddVertex: { ja: '頂点を追加', en: 'Add vertex' },
  toolRemoveVertex: { ja: '頂点を削除', en: 'Remove vertex' },
  hintMesh: { ja: '頂点をドラッグ。離すと再分割されます', en: 'Drag vertices — the mesh re-triangulates on release' },
  minAngle: { ja: '最小角', en: 'min ∠' },
  // animate
  toolGrab: { ja: 'つまむ', en: 'Grab' },
  toolPin: { ja: 'ピン', en: 'Pin' },
  clearPins: { ja: 'ピンを全部外す', en: 'Remove all pins' },
  autoPins: { ja: 'おまかせピン', en: 'Auto pins' },
  resetPose: { ja: 'リセット', en: 'Reset' },
  jelly: { ja: 'ぷるぷる', en: 'Jelly' },
  addPose: { ja: 'ポーズ', en: 'Pose' },
  rest: { ja: '基本形', en: 'Rest' },
  play: { ja: '再生', en: 'Play' },
  pause: { ja: '停止', en: 'Pause' },
  record: { ja: '録画', en: 'Record' },
  stopRecord: { ja: '録画終了', en: 'Stop' },
  blendPad: { ja: 'ブレンド', en: 'Blend' },
  export: { ja: '書き出し', en: 'Export' },
  speed: { ja: '速さ', en: 'Speed' },
  hintGrab: { ja: 'つまんで動かそう！ タップでピン（固定点）を追加', en: 'Grab and drag! Tap to add a pin (fixed point)' },
  hintNoPins: { ja: 'ピンが無いと平行移動だけ。タップでピンを置くか「おまかせピン」', en: 'Without pins it only slides — tap to add pins or use “Auto pins”' },
  hintPoses: { ja: '形を作って「＋ポーズ」→ 2つ以上で ▶ 再生', en: 'Make a shape, press “+ Pose”, then ▶ with two or more' },
  hintPad: { ja: '丸をドラッグ：ポーズを混ぜる（外側は誇張）', en: 'Drag the puck to mix poses (outside = exaggerate)' },
  poseMenuTurnPlus: { ja: '+1回転', en: '+1 turn' },
  poseMenuTurnMinus: { ja: '−1回転', en: '−1 turn' },
  poseMenuUpdate: { ja: '今の形で上書き', en: 'Overwrite with current' },
  poseMenuDelete: { ja: '削除', en: 'Delete' },
  poseMenuLeft: { ja: '左へ', en: 'Move left' },
  poseMenuRight: { ja: '右へ', en: 'Move right' },
  recording: { ja: '録画中…', en: 'Recording…' },
  clip: { ja: '録画', en: 'Clip' },
  // export
  exportPng: { ja: '画像 (PNG・透過)', en: 'Image (PNG, transparent)' },
  exportVideo: { ja: '動画 (再生中のアニメ)', en: 'Video (current animation)' },
  exportProject: { ja: 'プロジェクト (.json)', en: 'Project (.json)' },
  importProject: { ja: '開く (画像/プロジェクト/.mpl)', en: 'Open (image / project / .mpl)' },
  exportObj: { ja: 'メッシュ (.obj)', en: 'Mesh (.obj)' },
  exportSvg: { ja: 'ワイヤーフレーム (.svg)', en: 'Wireframe (.svg)' },
  exportMaple: { ja: 'Maple 形式 (.mpl)', en: 'Maple format (.mpl)' },
  exportPosesJson: { ja: 'ポーズデータ (.json)', en: 'Pose data (.json)' },
  newProject: { ja: '新しい画像', en: 'New image' },
  videoNeedsAnim: { ja: '動画にはポーズ2つ以上か録画が必要です', en: 'Video needs two or more poses, or a recorded clip' },
  videoUnsupported: { ja: 'このブラウザは動画書き出しに未対応です', en: 'Video export is not supported in this browser' },
  saved: { ja: '保存しました', en: 'Saved' },
  loadFailed: { ja: '読み込めませんでした', en: 'Could not load the file' },
  selfIntersect: { ja: '輪郭が自己交差している箇所があります', en: 'The outline crosses itself somewhere' },
  meshFailed: { ja: 'メッシュを作れませんでした。輪郭を確認してください', en: 'Could not build a mesh — check the outline' },
  noShape: { ja: '形が見つかりません。しきい値を変えるか、塗って追加してください', en: 'No shape found — adjust the threshold or paint it in' },
  // help
  helpTitle: { ja: '使い方', en: 'How to use' },
  helpMouse: { ja: 'マウス', en: 'Mouse' },
  helpTouch: { ja: 'タッチ・ペン', en: 'Touch & pen' },
  helpKeys: { ja: 'キーボード', en: 'Keyboard' },
  helpAbout: { ja: 'このアプリについて', en: 'About' },
  close: { ja: '閉じる', en: 'Close' },
  resetDefaults: { ja: '既定値に戻す', en: 'Reset to defaults' },
  stats: { ja: '統計', en: 'Statistics' },
  language: { ja: 'English', en: '日本語' },
};

export type Key = keyof typeof dict;

let lang: Lang = (() => {
  try {
    const s = localStorage.getItem('liemorph.lang');
    if (s === 'ja' || s === 'en') return s;
  } catch {
    /* ignore */
  }
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('ja') ? 'ja' : 'en';
})();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem('liemorph.lang', l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l;
}

export function t(key: Key): string {
  return dict[key][lang];
}

/** Inline bilingual string helper for one-off labels. */
export function tr(ja: string, en: string): string {
  return lang === 'ja' ? ja : en;
}

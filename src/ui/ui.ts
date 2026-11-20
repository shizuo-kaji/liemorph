/** All the DOM chrome around the stage. */
import type { App, Step, ToolId, Pose } from '../app.ts';
import { h, icon, clamp } from './dom.ts';
import { t, tr, getLang, setLang, type Key } from '../i18n.ts';
import { schema, type Field, type Settings } from '../settings.ts';
import { samples, renderSample } from '../samples/procedural.ts';
import { classics } from '../samples/classic.ts';
import { kvGet } from '../io/store.ts';
import { delaunaySmall } from '../geom/interp.ts';

const STEPS: { id: Step; key: Key; ic: string }[] = [
  { id: 'image', key: 'stepImage', ic: 'image' },
  { id: 'contour', key: 'stepContour', ic: 'outline' },
  { id: 'mesh', key: 'stepMesh', ic: 'mesh' },
  { id: 'animate', key: 'stepAnimate', ic: 'hand' },
];

const TOOLS: Record<Step, { id: ToolId; key: Key; ic: string }[]> = {
  image: [],
  contour: [
    { id: 'points', key: 'toolPoints', ic: 'vertexMove' },
    { id: 'brushAdd', key: 'toolBrushAdd', ic: 'brush' },
    { id: 'brushErase', key: 'toolBrushErase', ic: 'eraser' },
    { id: 'lassoAdd', key: 'toolLassoAdd', ic: 'lasso' },
    { id: 'lassoErase', key: 'toolLassoErase', ic: 'lassoMinus' },
  ],
  mesh: [
    { id: 'vmove', key: 'toolMove', ic: 'vertexMove' },
    { id: 'vadd', key: 'toolAddVertex', ic: 'vertexAdd' },
    { id: 'vremove', key: 'toolRemoveVertex', ic: 'vertexRemove' },
  ],
  animate: [
    { id: 'grab', key: 'toolGrab', ic: 'hand' },
    { id: 'pin', key: 'toolPin', ic: 'pin' },
  ],
};

export class UI {
  app: App;
  root: HTMLElement;
  private top = h('header', { class: 'topbar' });
  private rail = h('nav', { class: 'rail' });
  private dock = h('footer', { class: 'dock' });
  private drawer = h('aside', { class: 'drawer', 'aria-hidden': 'true' });
  private drop = h('div', { class: 'dropzone' });
  private zoom = h('div', { class: 'zoomctl' });
  private hintEl = h('div', { class: 'hint' });
  private toasts = h('div', { class: 'toasts' });
  private pad = h('div', { class: 'padpanel' });
  private menuEl: HTMLElement | null = null;
  private keyTop = '';
  private keyRail = '';
  private keyDock = '';
  private keyDrop = '';
  private syncs: (() => void)[] = [];
  private dockSyncs: (() => void)[] = [];
  private statEls: Record<string, HTMLElement> = {};
  private lastStats = 0;
  private hintTimer = 0;
  drawerOpen = false;
  padOpen = false;
  private fileInput = h('input', { type: 'file', accept: 'image/*,.json,.mpl,.txt', style: 'display:none' });
  private cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' });
  private padSvg: SVGSVGElement | null = null;

  constructor(app: App, root: HTMLElement, stage: HTMLElement) {
    this.app = app;
    this.root = root;
    root.prepend(this.top);
    stage.append(this.drop, this.rail, this.zoom, this.hintEl, this.pad);
    root.append(this.dock, this.drawer, this.toasts, this.fileInput, this.cameraInput);
    for (const inp of [this.fileInput, this.cameraInput]) {
      inp.addEventListener('change', () => {
        const f = inp.files?.[0];
        if (f) void app.loadFile(f);
        inp.value = '';
      });
    }
    this.installGlobalHandlers();
    this.buildDrawer();
    this.buildZoom();
    document.documentElement.lang = getLang();
  }

  // ------------------------------------------------------------ hooks

  insets() {
    // offset* sizes ignore CSS transforms, so this is stable during panel animations
    const top = this.top.offsetTop + this.top.offsetHeight;
    const dockH = this.dock.classList.contains('empty') ? 0 : this.dock.offsetHeight + 12;
    const left = this.rail.classList.contains('show') ? this.rail.offsetLeft + this.rail.offsetWidth : 0;
    const right = this.drawerOpen && window.innerWidth > 900 ? this.drawer.offsetWidth : 0;
    return { top: top + 4, right, bottom: dockH + 8, left };
  }

  toast(msg: string, kind: 'info' | 'warn' = 'info') {
    const el = h('div', { class: `toast ${kind}` }, msg);
    this.toasts.append(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  hint(msg: string, once?: string) {
    if (once) {
      try {
        const k = `liemorph.hint.${once}`;
        if (sessionStorage.getItem(k)) return;
        sessionStorage.setItem(k, '1');
      } catch {
        /* ignore */
      }
    }
    this.hintEl.replaceChildren(h('span', null, msg), h('button', { class: 'x', 'aria-label': t('close'), onclick: () => this.hintEl.classList.remove('show') }, icon('close', 16)));
    this.hintEl.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hintEl.classList.remove('show'), 7000);
  }

  hideHint() {
    clearTimeout(this.hintTimer);
    this.hintEl.classList.remove('show');
  }

  update() {
    const a = this.app;
    if (!a.poses.length) this.padOpen = false;
    const stageEl = a.stage;
    stageEl.dataset.backdrop = a.s.backdrop;
    stageEl.dataset.step = a.step;
    stageEl.style.cursor = '';
    const topKey = `${a.step}|${a.canUndo}|${a.canRedo}|${!!a.img}|${getLang()}|${this.drawerOpen}`;
    if (topKey !== this.keyTop) {
      this.keyTop = topKey;
      this.buildTop();
    }
    const railKey = `${a.step}|${a.tool}|${!!a.img}|${getLang()}|${a.s.jelly}|${a.deformer?.pins.length ?? 0}`;
    if (railKey !== this.keyRail) {
      this.keyRail = railKey;
      this.buildRail();
    }
    const dockKey = [
      a.step, a.tool, !!a.img, getLang(), a.mode, a.playing, !!a.recording, !!a.clip, this.padOpen,
      a.poses.map((p) => `${p.id}:${p.turns}`).join(','), a.timelineKeys().length,
    ].join('|');
    if (dockKey !== this.keyDock) {
      this.keyDock = dockKey;
      this.buildDock();
    }
    const dropKey = `${a.step}|${!!a.img}|${getLang()}`;
    if (dropKey !== this.keyDrop) {
      this.keyDrop = dropKey;
      void this.buildDrop();
    }
    document.documentElement.style.setProperty('--dock-h', `${this.dock.classList.contains('empty') ? 0 : this.dock.offsetHeight}px`);
    const dropShown = a.step === 'image' || !a.img;
    this.drop.classList.toggle('show', dropShown);
    this.drop.inert = !dropShown;
    this.zoom.classList.toggle('show', !!a.img && a.step !== 'image');
    this.drawer.classList.toggle('open', this.drawerOpen);
    this.drawer.setAttribute('aria-hidden', String(!this.drawerOpen));
    this.root.classList.toggle('drawer-open', this.drawerOpen);
    this.pad.classList.toggle('show', this.padOpen && a.step === 'animate');
    if (this.padOpen && a.step === 'animate') this.drawPad();
    for (const s of this.syncs) s();
    for (const s of this.dockSyncs) s();
    this.stats(true);
  }

  // ------------------------------------------------------------- top bar

  private buildTop() {
    const a = this.app;
    const steps = h(
      'nav',
      { class: 'steps', role: 'tablist' },
      STEPS.map((s, i) =>
        h(
          'button',
          {
            class: `step ${a.step === s.id ? 'active' : ''}`,
            role: 'tab',
            'aria-selected': String(a.step === s.id),
            disabled: !a.img && s.id !== 'image',
            title: `${t(s.key)} (${i + 1})`,
            onclick: () => a.setStep(s.id),
          },
          h('span', { class: 'num' }, String(i + 1)),
          icon(s.ic, 20),
          h('span', { class: 'lbl' }, t(s.key)),
        ),
      ),
    );
    const btn = (ic: string, title: string, on: () => void, opts: { disabled?: boolean; active?: boolean } = {}) =>
      h('button', { class: `iconbtn ${opts.active ? 'active' : ''}`, title, 'aria-label': title, disabled: opts.disabled, onclick: on }, icon(ic, 21));
    this.top.replaceChildren(
      h('div', { class: 'brand', title: t('appTagline') }, logo(), h('span', { class: 'name' }, 'Lie', h('b', null, 'Morph'))),
      steps,
      h(
        'div',
        { class: 'actions' },
        btn('undo', `${t('undo')} (⌘Z)`, () => a.undo(), { disabled: !a.canUndo }),
        btn('redo', `${t('redo')} (⇧⌘Z)`, () => a.redo(), { disabled: !a.canRedo }),
        btn('file', t('file'), (e?: unknown) => this.fileMenu(e as MouseEvent)),
        btn('gear', t('settings'), () => this.toggleDrawer(), { active: this.drawerOpen }),
        btn('help', t('help'), () => this.showHelp()),
      ),
    );
  }

  toggleDrawer(open = !this.drawerOpen) {
    this.drawerOpen = open;
    this.update();
    setTimeout(() => this.app.resize(), 260);
  }

  private fileMenu(e: MouseEvent) {
    const a = this.app;
    const has = !!a.mesh;
    this.openMenu(e.currentTarget as HTMLElement, [
      { label: t('importProject'), ic: 'upload', on: () => this.fileInput.click() },
      { label: t('newProject'), ic: 'image', on: () => a.setStep('image') },
      null,
      { label: t('exportPng'), ic: 'image', on: () => a.exportPNG(), disabled: !has },
      { label: t('exportVideo'), ic: 'play', on: () => void a.exportVideo(), disabled: !has },
      { label: t('exportProject'), ic: 'download', on: () => a.saveProject(), disabled: !a.img },
      null,
      { label: t('exportObj'), ic: 'mesh', on: () => a.exportOBJ(), disabled: !has },
      { label: t('exportSvg'), ic: 'outline', on: () => a.exportSVG(), disabled: !has },
      { label: t('exportPosesJson'), ic: 'file', on: () => a.exportPosesJSON(), disabled: !has },
      { label: t('exportMaple'), ic: 'file', on: () => a.exportMaple(), disabled: !has },
      null,
      { label: t('language'), ic: 'globe', on: () => this.setLanguage(getLang() === 'ja' ? 'en' : 'ja') },
    ]);
  }

  setLanguage(l: 'ja' | 'en') {
    setLang(l);
    this.keyTop = this.keyRail = this.keyDock = this.keyDrop = '';
    this.buildDrawer();
    this.buildZoom();
    this.update();
  }

  openMenu(anchor: HTMLElement, items: ({ label: string; ic?: string; on: () => void; disabled?: boolean; danger?: boolean } | null)[]) {
    this.closeMenu();
    const m = h(
      'div',
      { class: 'menu', role: 'menu' },
      items.map((it) =>
        it
          ? h(
              'button',
              {
                role: 'menuitem',
                class: it.danger ? 'danger' : '',
                disabled: it.disabled,
                onclick: () => {
                  this.closeMenu();
                  it.on();
                },
              },
              it.ic ? icon(it.ic, 18) : null,
              h('span', null, it.label),
            )
          : h('hr'),
      ),
    );
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = r.right - mw, y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) y = r.top - mh - 6;
    x = clamp(x, 8, window.innerWidth - mw - 8);
    y = clamp(y, 8, window.innerHeight - mh - 8);
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    this.menuEl = m;
    setTimeout(() => {
      const off = (ev: Event) => {
        if (!m.contains(ev.target as Node)) {
          this.closeMenu();
          window.removeEventListener('pointerdown', off, true);
        }
      };
      window.addEventListener('pointerdown', off, true);
    });
  }

  closeMenu() {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  // ---------------------------------------------------------------- rail

  private buildRail() {
    const a = this.app;
    const tools = a.img ? TOOLS[a.step] : [];
    this.rail.replaceChildren(
      ...tools.map((tl) =>
        h(
          'button',
          {
            class: `tool ${a.tool === tl.id ? 'active' : ''}`,
            title: t(tl.key),
            'aria-label': t(tl.key),
            'aria-pressed': String(a.tool === tl.id),
            onclick: () => a.setTool(tl.id),
          },
          icon(tl.ic, 24),
          h('span', null, t(tl.key)),
        ),
      ),
    );
    if (a.img && a.step === 'animate') {
      const act = (ic: string, label: string, on: () => void, opts: { active?: boolean; disabled?: boolean; title?: string } = {}) =>
        h('button', { class: `tool action ${opts.active ? 'on' : ''}`, title: opts.title ?? label, 'aria-label': label, disabled: opts.disabled, onclick: on }, icon(ic, 22), h('span', null, label));
      this.rail.append(
        h('hr'),
        act('reset', t('resetPose'), () => a.resetPose(), { title: `${t('resetPose')} (R)` }),
        act('sparkle', t('autoPins'), () => {
          a.pushHistory();
          a.autoPins();
        }),
        act('pinOff', t('clearPins'), () => a.clearPins(), { disabled: !a.deformer?.pins.length }),
        act('jelly', t('jelly'), () => a.setSetting('jelly', !a.s.jelly), { active: a.s.jelly, title: `${t('jelly')} (J)` }),
      );
    }
    this.rail.classList.toggle('show', tools.length > 0);
  }

  private buildZoom() {
    const a = this.app;
    this.zoom.replaceChildren(
      h('button', { class: 'iconbtn', title: t('zoomOut'), onclick: () => a.zoomBy(1 / 1.3) }, icon('zoomOut', 20)),
      h('button', { class: 'iconbtn', title: `${t('fit')} (F)`, onclick: () => a.fitView() }, icon('fit', 20)),
      h('button', { class: 'iconbtn', title: t('zoomIn'), onclick: () => a.zoomBy(1.3) }, icon('zoomIn', 20)),
    );
  }

  // ---------------------------------------------------------------- dock

  private slider(label: string, value: number, min: number, max: number, step: number, on: (v: number) => void, fmt = (v: number) => String(Math.round(v * 100) / 100), log = false, sync?: () => number) {
    const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
    const fromPos = (p: number) => {
      const v = log ? min * Math.pow(max / min, p) : min + p * (max - min);
      return Math.round(v / step) * step;
    };
    const out = h('output', null, fmt(value));
    const inp = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: String(toPos(value)), 'aria-label': label });
    inp.addEventListener('input', () => {
      const v = fromPos(parseFloat(inp.value));
      out.textContent = fmt(v);
      on(v);
    });
    if (sync)
      this.dockSyncs.push(() => {
        if (document.activeElement === inp) return;
        const v = sync();
        inp.value = String(toPos(v));
        out.textContent = fmt(v);
      });
    return h('label', { class: 'slider' }, h('span', { class: 'lbl' }, label), inp, out);
  }

  private chip(ic: string, label: string, on: () => void, opts: { active?: boolean; primary?: boolean; disabled?: boolean; title?: string; cls?: string } = {}) {
    return h(
      'button',
      { class: `chip ${opts.active ? 'active' : ''} ${opts.primary ? 'primary' : ''} ${opts.cls ?? ''}`, disabled: opts.disabled, title: opts.title ?? label, onclick: on },
      icon(ic, 20),
      label ? h('span', null, label) : null,
    );
  }

  private buildDock() {
    const a = this.app;
    this.dockSyncs = [];
    this.dock.className = `dock step-${a.step}`;
    if (!a.img || a.step === 'image') {
      this.dock.replaceChildren();
      this.dock.classList.add('empty');
      return;
    }
    const next = (step: Step) => this.chip('arrowRight', t('next'), () => a.setStep(step), { primary: true, cls: 'next' });
    if (a.step === 'contour') {
      const thr = a.detect;
      const isAuto = a.threshold === null;
      const max = thr?.mode === 'alpha' ? 255 : 80;
      const thrSlider = this.slider(
        t('threshold'),
        a.threshold ?? thr?.autoThreshold ?? 20,
        1,
        max,
        0.5,
        (v) => {
          a.threshold = v;
          a.runDetect();
          a.docChanged();
        },
        (v) => (a.threshold === null ? `${t('auto')} ${v.toFixed(0)}` : v.toFixed(0)),
        false,
        () => a.threshold ?? a.detect?.autoThreshold ?? 20,
      );
      this.dock.replaceChildren(
        h(
          'div',
          { class: 'group' },
          this.chip('wand', t('autoDetect'), () => {
            a.pushHistory();
            a.threshold = null;
            a.runDetect();
            this.keyDock = '';
            this.update();
          }, { active: isAuto }),
          thrSlider,
          this.slider(t('smoothness'), a.s.detSmooth, 0, 5, 0.1, (v) => a.setSetting('detSmooth', v), (v) => v.toFixed(1), false, () => a.s.detSmooth),
          this.slider(t('detail'), 5 - a.s.detSimplify, 0, 5, 0.1, (v) => a.setSetting('detSimplify', Math.round((5 - v) * 10) / 10), (v) => v.toFixed(1), false, () => 5 - a.s.detSimplify),
          a.tool.startsWith('brush')
            ? this.slider(t('brushSize'), a.brushPx, 4, 120, 1, (v) => {
                a.brushPx = v;
                a.requestRender();
              }, (v) => `${v.toFixed(0)}px`, true, () => a.brushPx)
            : null,
        ),
        next('mesh'),
      );
      return;
    }
    if (a.step === 'mesh') {
      const q = a.quality;
      this.dock.replaceChildren(
        h(
          'div',
          { class: 'group' },
          this.slider(t('density'), a.s.meshVertices, 30, 3000, 1, (v) => a.setSetting('meshVertices', v), (v) => `≈${Math.round(v)}`, true, () => a.s.meshVertices),
          this.chip('reset', t('regenerate'), () => {
            a.pushHistory();
            a.rebuildMesh();
            this.update();
          }),
          this.chip('sparkle', t('relax'), () => a.relaxMesh()),
          q
            ? h('div', { class: 'meshstats' },
                h('span', null, h('b', null, String(q.vertices)), ' V'),
                h('span', null, h('b', null, String(q.triangles)), ' T'),
                h('span', null, `${t('minAngle')} `, h('b', null, `${q.minAngle.toFixed(1)}°`)),
              )
            : null,
        ),
        next('animate'),
      );
      return;
    }
    // ---- animate
    const keys = a.timelineKeys().length;
    const strip = h('div', { class: 'poses', role: 'list' });
    strip.append(this.poseCard(null));
    a.poses.forEach((p, i) => strip.append(this.poseCard(p, i)));
    strip.append(h('button', { class: 'addpose', title: `${t('addPose')} (P)`, onclick: () => a.addPose() }, icon('plus', 22), h('span', null, t('addPose'))));
    if (a.clip) {
      strip.append(
        h(
          'div',
          { class: `clipchip ${a.mode === 'clip' ? 'active' : ''}` },
          h('button', { class: 'play', onclick: () => a.playClip(), title: t('play') }, icon('play', 16), `${(a.clip.frames.length / a.clip.fps).toFixed(1)}s`),
          h('button', { class: 'x', onclick: () => a.deleteClip(), title: t('poseMenuDelete') }, icon('close', 14)),
        ),
      );
    }
    const playing = a.playing && (a.mode === 'timeline' || a.mode === 'clip');
    const controls = h(
      'div',
      { class: 'group transport' },
      this.chip(playing ? 'pause' : 'play', playing ? t('pause') : t('play'), () => a.togglePlay(), { primary: true, disabled: keys < 2 && !a.clip, title: `${t('play')} (Space)` }),
      this.chip(a.recording ? 'stop' : 'rec', a.recording ? t('stopRecord') : t('record'), () => a.toggleRecord(), { active: !!a.recording, cls: 'rec' }),
      this.chip('pad', t('blendPad'), () => {
        this.padOpen = !this.padOpen;
        if (this.padOpen) this.hint(t('hintPad'), 'pad');
        this.update();
      }, { active: this.padOpen, disabled: a.poses.length < 1 }),
    );
    const scrub =
      keys >= 2 && !a.recording
        ? h(
            'div',
            { class: 'scrubber' },
            this.slider('τ', a.tau, 0, Math.max(1, a.timelineSegments), 0.001, (v) => a.scrub(v), (v) => v.toFixed(2), false, () => a.tau),
            h(
              'select',
              {
                class: 'speed',
                title: t('speed'),
                onchange: (e: Event) => (a.speed = parseFloat((e.target as HTMLSelectElement).value)),
              },
              ...[0.25, 0.5, 1, 1.5, 2].map((v) => h('option', { value: String(v), selected: a.speed === v }, `${v}×`)),
            ),
          )
        : null;
    this.dock.replaceChildren(
      strip,
      controls,
      ...(scrub ? [scrub] : []),
    );
    if (a.recording) this.dock.append(h('div', { class: 'recbadge' }, h('i'), t('recording')));
  }

  private poseCard(p: Pose | null, i = 0) {
    const a = this.app;
    const card = h(
      'button',
      { class: `posecard ${p ? '' : 'rest'}`, role: 'listitem', title: p ? `#${i + 1}` : t('rest') },
      p ? h('img', { src: p.thumb, alt: '', draggable: false }) : h('div', { class: 'restic' }, icon('heart', 22)),
      h('span', { class: 'idx' }, p ? String(i + 1) : t('rest')),
      p && p.turns ? h('span', { class: 'turns' }, `${p.turns > 0 ? '+' : ''}${p.turns}⟳`) : null,
    );
    let timer = 0, long = false;
    card.addEventListener('pointerdown', () => {
      long = false;
      if (!p) return;
      timer = window.setTimeout(() => {
        long = true;
        navigator.vibrate?.(10);
        this.poseMenu(card, p, i);
      }, 500);
    });
    const cancel = () => clearTimeout(timer);
    card.addEventListener('pointerup', cancel);
    card.addEventListener('pointerleave', cancel);
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (p) this.poseMenu(card, p, i);
    });
    card.addEventListener('click', () => {
      if (long) return;
      a.gotoPose(p ? p.id : 'rest');
    });
    if (p) {
      card.append(
        h('span', {
          class: 'more',
          onclick: (e: Event) => {
            e.stopPropagation();
            this.poseMenu(card, p, i);
          },
        }, icon('dots', 16)),
      );
    }
    return card;
  }

  private poseMenu(anchor: HTMLElement, p: Pose, i: number) {
    const a = this.app;
    this.openMenu(anchor, [
      { label: t('poseMenuUpdate'), ic: 'download', on: () => a.updatePose(p.id) },
      { label: t('poseMenuTurnPlus'), ic: 'turn', on: () => a.turnPose(p.id, 1) },
      { label: t('poseMenuTurnMinus'), ic: 'undo', on: () => a.turnPose(p.id, -1) },
      { label: t('poseMenuLeft'), ic: 'undo', on: () => a.movePose(p.id, -1), disabled: i === 0 },
      { label: t('poseMenuRight'), ic: 'redo', on: () => a.movePose(p.id, 1), disabled: i === a.poses.length - 1 },
      null,
      { label: t('poseMenuDelete'), ic: 'close', on: () => a.deletePose(p.id), danger: true },
    ]);
  }

  // ------------------------------------------------------------ dropzone

  private async buildDrop() {
    const a = this.app;
    const sampleCards = samples.map((s) => {
      const c = renderSample(s, 160);
      const b = h(
        'button',
        {
          class: 'sample',
          'aria-label': s.label(),
          onclick: () => {
            const full = renderSample(s, 900);
            a.loadImage(full, full.width, full.height, s.label());
          },
        },
        c,
        h('span', null, s.label()),
      );
      return b;
    });
    const classicBtns = classics.map((d) =>
      h('button', { class: 'classic', title: `old_maple/${d.source}`, onclick: () => a.loadClassic(d, d.label) }, d.label),
    );
    const resume = h('button', { class: 'chip resume', style: 'display:none', onclick: () => void a.resume().then((ok) => !ok && this.toast(t('loadFailed'), 'warn')) }, icon('reset', 18), h('span', null, t('resume')));
    const card = h(
      'div',
      { class: 'dropcard' },
      h('div', { class: 'drophero' }, blobArt(), h('h1', null, t('dropTitle')), h('p', null, t('dropSub'))),
      h(
        'div',
        { class: 'dropbtns' },
        h('button', { class: 'chip primary', onclick: () => this.fileInput.click() }, icon('upload', 20), h('span', null, t('chooseFile'))),
        h('button', { class: 'chip', onclick: () => this.cameraInput.click() }, icon('camera', 20), h('span', null, t('camera'))),
        h('button', { class: 'chip', onclick: () => void this.pasteFromClipboard() }, icon('clipboard', 20), h('span', null, t('paste'))),
        resume,
      ),
      h('div', { class: 'samples-title' }, t('orTrySample')),
      h('div', { class: 'samples' }, sampleCards),
      h('details', { class: 'classics' }, h('summary', null, t('classicTitle')), h('div', { class: 'classic-list' }, classicBtns)),
      a.img ? h('button', { class: 'chip ghostbtn', onclick: () => a.setStep('contour') }, icon('arrowRight', 18), h('span', null, tr('今の画像に戻る', 'Back to current image'))) : null,
    );
    this.drop.replaceChildren(card);
    if (!a.img) {
      const s = await kvGet<string>('autosave');
      if (s) resume.style.display = '';
    }
  }

  private async pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((x) => x.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          await this.app.loadFile(new File([blob], 'pasted', { type }));
          return;
        }
      }
      this.toast(tr('クリップボードに画像がありません', 'No image on the clipboard'), 'warn');
    } catch {
      this.toast(tr('⌘V / Ctrl+V で貼り付けてください', 'Press ⌘V / Ctrl+V to paste'), 'warn');
    }
  }

  // -------------------------------------------------------------- drawer

  private buildDrawer() {
    const a = this.app;
    this.syncs = [];
    const sections = schema.map((sec) =>
      h(
        'details',
        { class: 'sec', open: sec.id === 'interp' || sec.id === 'deform' },
        h('summary', null, sec.title()),
        h('div', { class: 'fields' }, sec.fields.map((f) => this.field(f))),
      ),
    );
    this.statEls = {};
    const stat = (k: string, label: string) => {
      const v = h('b', null, '–');
      this.statEls[k] = v;
      return h('div', { class: 'stat' }, h('span', null, label), v);
    };
    this.drawer.replaceChildren(
      h('div', { class: 'drawerhead' }, h('h2', null, t('settings')), h('button', { class: 'iconbtn', title: t('close'), onclick: () => this.toggleDrawer(false) }, icon('close', 20))),
      h('div', { class: 'drawerbody' },
        ...sections,
        h('details', { class: 'sec', open: true },
          h('summary', null, t('stats')),
          h('div', { class: 'stats' },
            stat('v', tr('頂点', 'Vertices')),
            stat('t', tr('三角形', 'Triangles')),
            stat('minA', tr('最小角', 'Min angle')),
            stat('q', tr('平均品質', 'Mean quality')),
            stat('env', tr('包絡サイズ', 'Envelope nnz')),
            stat('fac', tr('分解 [ms]', 'Factor [ms]')),
            stat('solve', tr('求解 [ms/frame]', 'Solve [ms/frame]')),
            stat('E', tr('ARAP エネルギー', 'ARAP energy')),
            stat('flip', tr('反転三角形', 'Flipped triangles')),
            stat('fps', 'FPS'),
          ),
        ),
        h('div', { class: 'drawerfoot' },
          h('button', { class: 'chip', onclick: () => a.resetSettings() }, icon('reset', 18), h('span', null, t('resetDefaults'))),
          h('button', { class: 'chip', onclick: () => this.setLanguage(getLang() === 'ja' ? 'en' : 'ja') }, icon('globe', 18), h('span', null, t('language'))),
        ),
      ),
    );
  }

  private field(f: Field) {
    const a = this.app;
    const key = f.key;
    const label = h('span', { class: 'lbl' }, f.label(), f.help ? h('small', null, f.help()) : null);
    if (f.kind === 'toggle') {
      const inp = h('input', { type: 'checkbox', checked: !!a.s[key] });
      inp.addEventListener('change', () => a.setSetting(key, inp.checked as never));
      this.syncs.push(() => (inp.checked = !!a.s[key]));
      return h('label', { class: 'field toggle' }, label, inp, h('i', { class: 'switch' }));
    }
    if (f.kind === 'select') {
      const sel = h('select', null, f.options.map((o) => h('option', { value: o.value, selected: a.s[key] === o.value }, o.label())));
      sel.addEventListener('change', () => a.setSetting(key, sel.value as never));
      this.syncs.push(() => (sel.value = String(a.s[key])));
      return h('label', { class: 'field select' }, label, sel);
    }
    const { min, max, step, log } = f;
    const fmt = f.fmt ?? ((v: number) => String(Math.round(v * 1000) / 1000));
    const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
    const fromPos = (p: number) => {
      const v = log ? min * Math.pow(max / min, p) : min + p * (max - min);
      return Math.round(v / step) * step;
    };
    const out = h('output', null, fmt(a.s[key] as number));
    const inp = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: String(toPos(a.s[key] as number)), 'aria-label': f.label() });
    inp.addEventListener('input', () => {
      const v = fromPos(parseFloat(inp.value));
      out.textContent = fmt(v);
      a.setSetting(key, v as Settings[typeof key] as never);
    });
    this.syncs.push(() => {
      if (document.activeElement === inp) return;
      inp.value = String(toPos(a.s[key] as number));
      out.textContent = fmt(a.s[key] as number);
    });
    return h('label', { class: 'field range' }, label, out, inp);
  }

  stats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStats < 250) {
      this.syncScrub();
      return;
    }
    this.lastStats = now;
    this.syncScrub();
    if (!this.drawerOpen) return;
    const a = this.app, e = this.statEls, q = a.quality, d = a.deformer;
    const set = (k: string, v: string) => e[k] && (e[k].textContent = v);
    set('v', q ? String(q.vertices) : '–');
    set('t', q ? String(q.triangles) : '–');
    set('minA', q ? `${q.minAngle.toFixed(1)}°` : '–');
    set('q', q ? q.meanQuality.toFixed(3) : '–');
    set('env', d ? String(d.envelopeSize) : '–');
    set('fac', d ? d.stats.factorMs.toFixed(1) : '–');
    set('solve', d ? (a.mode === 'live' ? d.stats.solveMs : a.interp?.stats.solveMs ?? 0).toFixed(2) : '–');
    set('E', d ? d.stats.energy.toExponential(2) : '–');
    set('flip', d ? String(d.stats.flipped) : '–');
    set('fps', a.fps.toFixed(0));
  }

  private syncScrub() {
    if (this.app.step === 'animate' && this.app.mode === 'timeline') for (const s of this.dockSyncs) s();
  }

  // ------------------------------------------------------------ blend pad

  private drawPad() {
    const a = this.app;
    const S = 230, R = 1.9;
    const toS = (x: number) => ((x + R) / (2 * R)) * S;
    const fromS = (v: number) => (v / S) * 2 * R - R;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
    svg.setAttribute('class', 'padsvg');
    const el = (tag: string, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      svg.append(e);
      return e;
    };
    el('circle', { cx: toS(0), cy: toS(0), r: (S / (2 * R)) * 1, class: 'ring' });
    el('circle', { cx: toS(0), cy: toS(0), r: (S / (2 * R)) * 1.55, class: 'ring faint' });
    const pts: [number, number][] = [[0, 0], ...a.poses.map((p) => p.pad)];
    // triangulation edges of pose space
    if (pts.length >= 3)
      for (const tri of delaunaySmall(pts)) {
        const d = tri.map((i) => `${toS(pts[i][0])},${toS(pts[i][1])}`).join(' ');
        const poly = document.createElementNS(ns, 'polygon');
        poly.setAttribute('points', d);
        poly.setAttribute('class', 'tri');
        svg.insertBefore(poly, svg.firstChild);
      }
    const w = a.mode === 'pad' ? a.padWeightsNow() : null;
    pts.forEach((p, i) => {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `node ${i === 0 ? 'rest' : ''}`);
      g.setAttribute('transform', `translate(${toS(p[0])},${toS(p[1])})`);
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('r', '17');
      g.append(c);
      if (i > 0) {
        const img = document.createElementNS(ns, 'image');
        img.setAttribute('href', a.poses[i - 1].thumb);
        img.setAttribute('x', '-15');
        img.setAttribute('y', '-15');
        img.setAttribute('width', '30');
        img.setAttribute('height', '30');
        g.append(img);
      } else {
        const tx = document.createElementNS(ns, 'text');
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('dy', '4');
        tx.textContent = t('rest');
        g.append(tx);
      }
      const wt = document.createElementNS(ns, 'text');
      wt.setAttribute('class', 'wt');
      wt.setAttribute('text-anchor', 'middle');
      wt.setAttribute('y', '30');
      wt.textContent = w ? w[i].toFixed(2) : '';
      g.append(wt);
      svg.append(g);
      if (i > 0) {
        g.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const r = svg.getBoundingClientRect();
          const move = (ev: PointerEvent) => {
            const x = fromS(((ev.clientX - r.left) / r.width) * S), y = fromS(((ev.clientY - r.top) / r.height) * S);
            a.poses[i - 1].pad = [clamp(x, -R, R), clamp(y, -R, R)];
            g.setAttribute('transform', `translate(${toS(a.poses[i - 1].pad[0])},${toS(a.poses[i - 1].pad[1])})`);
            if (a.mode === 'pad') a.setPad(a.padPuck[0], a.padPuck[1]);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            this.drawPad();
            a.docChanged();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
      }
    });
    const puck = el('circle', { cx: toS(a.padPuck[0]), cy: toS(a.padPuck[1]), r: 11, class: 'puck' });
    const drag = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = fromS(((ev.clientX - r.left) / r.width) * S), y = fromS(((ev.clientY - r.top) / r.height) * S);
      a.setPad(clamp(x, -R, R), clamp(y, -R, R));
      puck.setAttribute('cx', String(toS(a.padPuck[0])));
      puck.setAttribute('cy', String(toS(a.padPuck[1])));
      const ww = a.padWeightsNow();
      svg.querySelectorAll('text.wt').forEach((tx, i) => (tx.textContent = ww[i]?.toFixed(2) ?? ''));
    };
    svg.addEventListener('pointerdown', (ev) => {
      svg.setPointerCapture(ev.pointerId);
      drag(ev);
      const mv = (e: PointerEvent) => drag(e);
      const up = () => {
        svg.removeEventListener('pointermove', mv);
        svg.removeEventListener('pointerup', up);
      };
      svg.addEventListener('pointermove', mv);
      svg.addEventListener('pointerup', up);
    });
    this.padSvg = svg;
    this.pad.replaceChildren(
      h('div', { class: 'padhead' }, icon('pad', 18), h('span', null, t('blendPad')), h('small', null, tr('外側＝誇張', 'outside = exaggerate')),
        h('button', { class: 'iconbtn', title: t('close'), onclick: () => { this.padOpen = false; this.update(); } }, icon('close', 18))),
      svg,
    );
  }

  // ---------------------------------------------------------------- help

  showHelp() {
    const row = (k: string, v: string) => h('tr', null, h('th', null, k), h('td', null, v));
    const modal = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        { class: 'modalcard' },
        h('div', { class: 'drawerhead' }, h('h2', null, t('helpTitle')), h('button', { class: 'iconbtn', title: t('close'), onclick: () => modal.remove() }, icon('close', 20))),
        h('div', { class: 'helpgrid' },
          h('section', null,
            h('h3', null, t('helpTouch')),
            h('table', null,
              row('☝︎ ' + tr('ドラッグ', 'drag'), tr('つまんで動かす／点を動かす', 'grab & pull / move points')),
              row('☝︎ ' + tr('タップ', 'tap'), tr('ピンを付ける・外す', 'add / remove a pin')),
              row('☝︎ ' + tr('長押し', 'long-press'), tr('ピン（ポーズ: メニュー）', 'pin (on a pose: menu)')),
              row('✌︎ ' + tr('ピンチ', 'pinch'), tr('ズーム・移動', 'zoom & pan')),
              row(tr('複数の指', 'many fingers'), tr('同時に何か所もつまめます', 'grab several places at once')),
              row('✎ ' + tr('ペン', 'pen'), tr('筆圧でブラシの太さが変わる', 'pressure changes brush size')),
            ),
          ),
          h('section', null,
            h('h3', null, t('helpMouse')),
            h('table', null,
              row(tr('ホイール', 'wheel'), tr('ズーム', 'zoom')),
              row(tr('右／中ドラッグ, Space+ドラッグ', 'right / middle drag, Space+drag'), tr('移動', 'pan')),
              row(tr('ダブルクリック', 'double-click'), tr('点・頂点を削除', 'delete point / vertex')),
            ),
            h('h3', null, t('helpKeys')),
            h('table', null,
              row('1 – 4', tr('ステップ切替', 'switch step')),
              row('⌘Z / ⇧⌘Z', `${t('undo')} / ${t('redo')}`),
              row('Space', `${t('play')} / ${t('pause')}`),
              row('P', tr('ポーズを追加', 'add pose')),
              row('R / J / W / F', tr('リセット／ぷるぷる／ワイヤー／全体表示', 'reset / jelly / wireframe / fit')),
              row('B', t('blendPad')),
            ),
          ),
          h('section', { class: 'about' },
            h('h3', null, t('helpAbout')),
            h('p', null, tr(
              '画像から前景を自動抽出（CIELAB 色差＋大津法、または透明度）し、マーチングスクエアで輪郭を取り、制約付き Delaunay 三角形分割でメッシュを作ります。変形は局所–大域 ARAP（ぷるぷるモードは projective dynamics 風の陰的積分）、ポーズ間の補間は ARAP 形状補間です。',
              'The foreground is extracted automatically (CIELAB distance + Otsu, or alpha), traced with marching squares and meshed by constrained Delaunay triangulation. Deformation is local–global ARAP (jelly mode: implicit, projective-dynamics-style integration); poses are blended with ARAP shape interpolation.',
            )),
            h('p', { class: 'cite' },
              'S. Kaji, S. Hirose, S. Sakata, Y. Mizoguchi, K. Anjyo: ', h('i', null, 'Mathematical Analysis on Affine Maps for 2D Shape Interpolation'), ', Proc. SCA 2012, pp. 71–76. ',
              tr('（極分解＋対数ブレンド・回転角の一貫化・多ポーズ補間）', '(polar–log blending, consistent rotation angles, multi-pose blending)'),
            ),
            h('p', { class: 'cite' }, 'M. Alexa, D. Cohen-Or, D. Levin: As-rigid-as-possible shape interpolation, SIGGRAPH 2000. · T. Igarashi, T. Moscovich, J. F. Hughes: As-rigid-as-possible shape manipulation, SIGGRAPH 2005. · O. Sorkine, M. Alexa: As-rigid-as-possible surface modeling, SGP 2007.'),
          ),
        ),
      ),
    );
    modal.addEventListener('pointerdown', (e) => e.target === modal && modal.remove());
    document.body.append(modal);
  }

  // ------------------------------------------------------- global events

  private installGlobalHandlers() {
    const a = this.app;
    const root = document.body;
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('dragging');
    });
    root.addEventListener('dragleave', (e) => {
      if (e.target === root || !(e.relatedTarget as Node | null)) root.classList.remove('dragging');
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('dragging');
      const f = e.dataTransfer?.files?.[0];
      if (f) void a.loadFile(f);
    });
    window.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void a.loadFile(f);
    });
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt instanceof HTMLInputElement && tgt.type !== 'range' && tgt.type !== 'checkbox') return;
      if (tgt instanceof HTMLSelectElement || tgt instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) a.redo();
        else a.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        a.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        a.saveProject();
        return;
      }
      if (mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '4' && a.img) a.setStep(STEPS[+k - 1].id);
      else if (k === ' ' && a.step === 'animate') {
        e.preventDefault();
        a.togglePlay();
      } else if (k === 'p' && a.step === 'animate') a.addPose();
      else if (k === 'r' && a.step === 'animate') a.resetPose();
      else if (k === 'j') a.setSetting('jelly', !a.s.jelly);
      else if (k === 'w') a.setSetting('showWire', !a.s.showWire);
      else if (k === 'f') a.fitView();
      else if (k === 'b' && a.poses.length) {
        this.padOpen = !this.padOpen;
        this.update();
      } else if (k === '?' || k === 'h') this.showHelp();
      else if (k === 'escape') {
        this.closeMenu();
        document.querySelector('.modal')?.remove();
        if (this.drawerOpen) this.toggleDrawer(false);
      } else if (k === '[') a.brushPx = Math.max(4, a.brushPx / 1.2);
      else if (k === ']') a.brushPx = Math.min(160, a.brushPx * 1.2);
      a.requestRender();
    });
  }
}

function logo() {
  const s = document.createElement('span');
  s.className = 'logo';
  s.innerHTML = `<svg viewBox="0 0 40 40" width="30" height="30" aria-hidden="true">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8fab"/><stop offset="1" stop-color="#ff5d8f"/></linearGradient></defs>
  <path d="M6 28c-3-9 4-20 14-20s17 11 14 20c-1.5 4-7 5-14 5s-12.5-1-14-5z" fill="url(#lg)"/>
  <path d="M9 27l6-10 5 7 4-5 7 8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity=".85"/>
  <circle cx="15" cy="21" r="1.8" fill="#2a1d33"/><circle cx="25" cy="21" r="1.8" fill="#2a1d33"/>
  </svg>`;
  return s;
}

function blobArt() {
  const s = document.createElement('div');
  s.className = 'blobart';
  s.innerHTML = `<svg viewBox="0 0 160 110" width="160" height="110" aria-hidden="true">
  <g class="wobble">
    <path d="M22 86c-8-28 14-62 58-62s66 34 58 62c-4 12-28 16-58 16S26 98 22 86z" fill="#ffd1dc"/>
    <path d="M34 82L58 44l18 26 14-16 26 28z" fill="none" stroke="#ff5d8f" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M58 44l-6 38M76 70l-18 12M90 54l-14 16M90 54l26 28" stroke="#ff8fab" stroke-width="1.4" fill="none"/>
    <circle cx="62" cy="62" r="4" fill="#2a1d33"/><circle cx="98" cy="62" r="4" fill="#2a1d33"/>
    <path d="M74 72q6 6 12 0" stroke="#2a1d33" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  </g>
  <circle class="pinart" cx="34" cy="82" r="6" fill="#ff5d8f" stroke="#fff" stroke-width="2"/>
  <circle class="pinart" cx="116" cy="82" r="6" fill="#ff5d8f" stroke="#fff" stroke-width="2"/>
  </svg>`;
  return s;
}

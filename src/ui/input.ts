/**
 * Unified mouse / touch / pen input for the stage.
 *
 * Each pointer is first offered to the active tool (`down`).  A tool may claim
 * it by returning a DragHandler; otherwise the pointer drives the view
 * (one pointer pans, two pointers pinch-zoom).  Drag events start only after
 * the pointer leaves a small slop radius, so taps, double taps and long
 * presses are recognised for every tool.  A second finger landing before the
 * first one has moved turns both into a pinch — so two-finger zoom works
 * everywhere, even while painting.
 */
import type { View } from '../render/gl.ts';

export interface PointerInfo {
  id: number;
  /** CSS px relative to the stage */
  sx: number;
  sy: number;
  /** world coordinates */
  x: number;
  y: number;
  type: string;
  pressure: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

export interface DragHandler {
  /** called with the first move beyond the slop radius (and every move after) */
  move(p: PointerInfo): void;
  up(p: PointerInfo): void;
  cancel?(): void;
  /** begin immediately without waiting for the slop (painting) */
  immediate?: boolean;
}

export interface Tool {
  down?(p: PointerInfo): DragHandler | null;
  tap?(p: PointerInfo): void;
  doubleTap?(p: PointerInfo): void;
  longPress?(p: PointerInfo): void;
  hover?(p: PointerInfo | null): void;
  /** let one-finger/left-button drags on empty space pan the view (default true) */
  panOnEmpty?: boolean;
  /** several fingers may manipulate independently (no automatic pinch conversion) */
  multiTouch?: boolean;
}

interface Track {
  id: number;
  type: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  t0: number;
  handler: DragHandler | null;
  dragging: boolean;
  view: boolean;
  longTimer: number;
  longFired: boolean;
}

export class InputManager {
  private el: HTMLElement;
  private tracks = new Map<number, Track>();
  private getView: () => View;
  private setView: (v: View) => void;
  getTool: () => Tool;
  private lastTap = { t: 0, x: 0, y: 0 };
  private spaceDown = false;
  private pinch: { d: number; cx: number; cy: number; view: View } | null = null;
  slop = 6;
  onViewChange: () => void = () => {};

  constructor(el: HTMLElement, getView: () => View, setView: (v: View) => void, getTool: () => Tool) {
    this.el = el;
    this.getView = getView;
    this.setView = setView;
    this.getTool = getTool;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e, false));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.tracks.size) this.getTool().hover?.(null);
    });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari gesture events would otherwise zoom the page
    el.addEventListener('gesturestart', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) this.spaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  get spaceHeld() {
    return this.spaceDown;
  }

  info(e: PointerEvent): PointerInfo {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const v = this.getView();
    return {
      id: e.pointerId,
      sx,
      sy,
      x: (sx - v.panX) / v.zoom,
      y: (sy - v.panY) / v.zoom,
      type: e.pointerType,
      pressure: e.pressure || 0.5,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.metaKey || e.ctrlKey,
    };
  }

  private viewTracks() {
    return [...this.tracks.values()].filter((t) => t.view);
  }

  private startPinchIfNeeded() {
    const vt = this.viewTracks();
    if (vt.length >= 2) {
      const [a, b] = vt;
      this.pinch = {
        d: Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY) || 1,
        cx: (a.lastX + b.lastX) / 2,
        cy: (a.lastY + b.lastY) / 2,
        view: { ...this.getView() },
      };
    } else this.pinch = null;
  }

  /** only events on the stage itself (not on UI panels floating inside it) */
  private own(e: Event) {
    const t = e.target as HTMLElement | null;
    return t === this.el || t?.tagName === 'CANVAS' && t.parentElement === this.el;
  }

  private down(e: PointerEvent) {
    if (!this.own(e)) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const p = this.info(e);
    const tool = this.getTool();
    const track: Track = {
      id: e.pointerId,
      type: e.pointerType,
      startX: p.sx,
      startY: p.sy,
      lastX: p.sx,
      lastY: p.sy,
      t0: performance.now(),
      handler: null,
      dragging: false,
      view: false,
      longTimer: 0,
      longFired: false,
    };
    // a new finger while another finger is still "undecided" → both become a pinch
    if (e.pointerType === 'touch' && !tool.multiTouch) {
      for (const t of this.tracks.values()) {
        if (t.type === 'touch' && t.handler && !t.dragging) {
          t.handler.cancel?.();
          t.handler = null;
          t.view = true;
          clearTimeout(t.longTimer);
        }
      }
    }
    const panButton = e.button === 1 || e.button === 2 || (e.pointerType === 'mouse' && this.spaceDown);
    const othersPinching = e.pointerType === 'touch' && this.viewTracks().length > 0;
    if (!panButton && !othersPinching) track.handler = tool.down?.(p) ?? null;
    const busy = [...this.tracks.values()].some((t) => t.handler);
    if (!track.handler) {
      track.view = panButton || othersPinching || tool.panOnEmpty !== false || e.pointerType === 'touch';
      // a stray finger next to one that is manipulating something should not pan the view
      if (busy && e.pointerType === 'touch' && !panButton) track.view = false;
    } else if (track.handler.immediate) {
      track.dragging = true;
    }
    if (!track.view && tool.longPress && !track.handler?.immediate) {
      track.longTimer = window.setTimeout(() => {
        if (!track.dragging && this.tracks.has(track.id)) {
          track.longFired = true;
          track.handler?.cancel?.();
          track.handler = null;
          navigator.vibrate?.(12);
          tool.longPress?.(p);
        }
      }, 520);
    }
    this.tracks.set(e.pointerId, track);
    this.startPinchIfNeeded();
  }

  private move(e: PointerEvent) {
    const p = this.info(e);
    const track = this.tracks.get(e.pointerId);
    if (!track) {
      if (e.pointerType !== 'touch') this.getTool().hover?.(this.own(e) ? p : null);
      return;
    }
    const dx = p.sx - track.lastX, dy = p.sy - track.lastY;
    track.lastX = p.sx;
    track.lastY = p.sy;
    if (!track.dragging && Math.hypot(p.sx - track.startX, p.sy - track.startY) > this.slop) {
      track.dragging = true;
      clearTimeout(track.longTimer);
    }
    if (!track.dragging) return;
    if (track.handler) {
      track.handler.move(p);
      return;
    }
    if (track.view) {
      if (this.pinch) {
        const vt = this.viewTracks();
        if (vt.length >= 2) {
          const [a, b] = vt;
          const d = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY) || 1;
          const cx = (a.lastX + b.lastX) / 2, cy = (a.lastY + b.lastY) / 2;
          const s = d / this.pinch.d;
          const v0 = this.pinch.view;
          const zoom = clampZoom(v0.zoom * s);
          const k = zoom / v0.zoom;
          this.setView({ zoom, panX: cx - (this.pinch.cx - v0.panX) * k, panY: cy - (this.pinch.cy - v0.panY) * k });
          this.onViewChange();
        }
      } else {
        const v = this.getView();
        this.setView({ ...v, panX: v.panX + dx, panY: v.panY + dy });
        this.onViewChange();
      }
    }
  }

  private up(e: PointerEvent, cancelled: boolean) {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    clearTimeout(track.longTimer);
    this.tracks.delete(e.pointerId);
    const p = this.info(e);
    const tool = this.getTool();
    if (track.handler) {
      if (cancelled) track.handler.cancel?.();
      else if (track.dragging) track.handler.up(p);
      else track.handler.cancel?.();
    }
    const quick = performance.now() - track.t0 < 400;
    if (!cancelled && !track.dragging && !track.longFired && quick && !this.pinch) {
      const now = performance.now();
      const dbl = now - this.lastTap.t < 320 && Math.hypot(p.sx - this.lastTap.x, p.sy - this.lastTap.y) < 24;
      if (dbl && tool.doubleTap) {
        tool.doubleTap(p);
        this.lastTap.t = 0;
      } else {
        tool.tap?.(p);
        this.lastTap = { t: now, x: p.sx, y: p.sy };
      }
    }
    this.startPinchIfNeeded();
    if (!this.viewTracks().length) this.pinch = null;
  }

  private wheel(e: WheelEvent) {
    if (!this.own(e)) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const v = this.getView();
    const lineMode = e.deltaMode !== 0;
    const isZoom = e.ctrlKey || e.metaKey || lineMode || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY));
    if (isZoom) {
      const dy = lineMode ? e.deltaY * 16 : e.deltaY;
      const zoom = clampZoom(v.zoom * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
      const k = zoom / v.zoom;
      this.setView({ zoom, panX: sx - (sx - v.panX) * k, panY: sy - (sy - v.panY) * k });
    } else {
      this.setView({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY });
    }
    this.onViewChange();
  }

  /** cancel all ongoing interactions (e.g. when switching steps) */
  reset() {
    for (const t of this.tracks.values()) {
      clearTimeout(t.longTimer);
      t.handler?.cancel?.();
    }
    this.tracks.clear();
    this.pinch = null;
  }
}

export function clampZoom(z: number) {
  return Math.min(40, Math.max(0.02, z));
}

/** Procedurally drawn sample pictures (no external assets). */
import { tr } from '../i18n.ts';

export interface Sample {
  key: string;
  label: () => string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

function bg(ctx: CanvasRenderingContext2D, w: number, h: number, a: string, b: string) {
  const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.1, w / 2, h / 2, w * 0.75);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function face(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, cheek = '#ff8fab') {
  ctx.save();
  ctx.fillStyle = '#2a1d33';
  for (const dx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + dx * s * 0.42, y, s * 0.11, s * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  for (const dx of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dx * s * 0.42 + s * 0.035, y - s * 0.05, s * 0.04, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = cheek;
  for (const dx of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + dx * s * 0.66, y + s * 0.22, s * 0.14, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#2a1d33';
  ctx.lineWidth = s * 0.06;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x - s * 0.09, y + s * 0.17, s * 0.09, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.arc(x + s * 0.09, y + s * 0.17, s * 0.09, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

const gingerbread: Sample = {
  key: 'ginger',
  label: () => tr('ジンジャーマン', 'Gingerbread'),
  draw(ctx, w, h) {
    bg(ctx, w, h, '#e9fbf4', '#c9eee0');
    const cx = w / 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const body = '#c9773a';
    // limbs
    ctx.strokeStyle = body;
    ctx.lineWidth = w * 0.15;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.27, h * 0.43); ctx.lineTo(cx + w * 0.27, h * 0.43);
    ctx.moveTo(cx - w * 0.06, h * 0.6); ctx.lineTo(cx - w * 0.17, h * 0.84);
    ctx.moveTo(cx + w * 0.06, h * 0.6); ctx.lineTo(cx + w * 0.17, h * 0.84);
    ctx.stroke();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.53, w * 0.15, h * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, h * 0.24, w * 0.14, 0, Math.PI * 2);
    ctx.fill();
    // icing
    ctx.strokeStyle = '#fffaf3';
    ctx.lineWidth = w * 0.012;
    const zig = (x0: number, y0: number, x1: number, y1: number) => {
      ctx.beginPath();
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const nx = -(y1 - y0), ny = x1 - x0, l = Math.hypot(nx, ny);
        const o = (i % 2 ? 1 : -1) * w * 0.018;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x + (nx / l) * o, y + (ny / l) * o);
      }
      ctx.stroke();
    };
    zig(cx - w * 0.33, h * 0.4, cx - w * 0.33, h * 0.47);
    zig(cx + w * 0.33, h * 0.4, cx + w * 0.33, h * 0.47);
    zig(cx - w * 0.2, h * 0.86, cx - w * 0.13, h * 0.88);
    zig(cx + w * 0.13, h * 0.88, cx + w * 0.2, h * 0.86);
    const candy = ['#ff5d8f', '#2ec4a6', '#4f7dff'];
    candy.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(cx, h * (0.46 + i * 0.075), w * 0.022, 0, Math.PI * 2);
      ctx.fill();
    });
    face(ctx, cx, h * 0.23, w * 0.13, '#ff9fb5');
  },
};

const octopus: Sample = {
  key: 'octo',
  label: () => tr('たこ', 'Octopus'),
  draw(ctx, w, h) {
    bg(ctx, w, h, '#fff7da', '#ffe9a8');
    const cx = w / 2, cy = h * 0.4;
    const col = '#ff6f91';
    ctx.lineCap = 'round';
    ctx.strokeStyle = col;
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * (0.08 + (0.84 * i) / 7);
      const x0 = cx + Math.cos(a) * w * 0.14, y0 = cy + h * 0.12;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      const L = h * 0.38;
      const dir = Math.cos(a);
      for (let s = 1; s <= 24; s++) {
        const t = s / 24;
        const x = x0 + dir * L * 0.75 * t + Math.sin(t * 7 + i) * w * 0.03 * t;
        const y = y0 + L * t * (0.75 + 0.25 * Math.sin(a));
        ctx.lineWidth = w * (0.07 - 0.05 * t);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    }
    const g = ctx.createRadialGradient(cx - w * 0.08, cy - h * 0.1, w * 0.02, cx, cy, w * 0.3);
    g.addColorStop(0, '#ffb3c6');
    g.addColorStop(1, col);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.25, h * 0.23, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const [dx, dy, r] of [[-0.12, -0.1, 0.025], [0.1, -0.13, 0.018], [0.15, -0.02, 0.02]]) {
      ctx.beginPath();
      ctx.arc(cx + dx * w, cy + dy * h, r * w, 0, Math.PI * 2);
      ctx.fill();
    }
    face(ctx, cx, cy + h * 0.04, w * 0.15, '#ff3d6e');
  },
};

const snake: Sample = {
  key: 'snake',
  label: () => tr('へび', 'Snake'),
  draw(ctx, w, h) {
    bg(ctx, w, h, '#eef4ff', '#d4e2ff');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pts: [number, number][] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push([w * (0.12 + 0.72 * t), h * (0.55 + 0.16 * Math.sin(t * Math.PI * 2.2))]);
    }
    const stroke = (lw: number, c: string, dash?: number[]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineWidth = lw;
      ctx.strokeStyle = c;
      ctx.setLineDash(dash ?? []);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    stroke(w * 0.13, '#33b27b');
    stroke(w * 0.05, '#ffd166', [w * 0.04, w * 0.05]);
    const [hx, hy] = pts[pts.length - 1];
    ctx.fillStyle = '#33b27b';
    ctx.beginPath();
    ctx.ellipse(hx + w * 0.04, hy, w * 0.11, h * 0.09, -0.2, 0, Math.PI * 2);
    ctx.fill();
    face(ctx, hx + w * 0.05, hy - h * 0.01, w * 0.08, '#ff8fab');
    ctx.strokeStyle = '#e63950';
    ctx.lineWidth = w * 0.012;
    ctx.beginPath();
    ctx.moveTo(hx + w * 0.14, hy + h * 0.02);
    ctx.lineTo(hx + w * 0.19, hy + h * 0.03);
    ctx.lineTo(hx + w * 0.21, hy + h * 0.01);
    ctx.moveTo(hx + w * 0.19, hy + h * 0.03);
    ctx.lineTo(hx + w * 0.21, hy + h * 0.055);
    ctx.stroke();
  },
};

const star: Sample = {
  key: 'star',
  label: () => tr('ほし', 'Star'),
  draw(ctx, w, h) {
    bg(ctx, w, h, '#f4ecff', '#e2d3ff');
    const cx = w / 2, cy = h * 0.53;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? w * 0.17 : w * 0.38;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, cy - h * 0.35, 0, cy + h * 0.35);
    g.addColorStop(0, '#ffe066');
    g.addColorStop(1, '#ffb020');
    ctx.fillStyle = g;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = w * 0.06;
    ctx.stroke();
    ctx.fill();
    face(ctx, cx, cy, w * 0.12, '#ff7a59');
  },
};

const mochi: Sample = {
  key: 'mochi',
  label: () => tr('おもち', 'Mochi'),
  draw(ctx, w, h) {
    bg(ctx, w, h, '#ffeef3', '#ffd6e2');
    const cx = w / 2, cy = h * 0.56;
    ctx.fillStyle = 'rgba(120,60,90,0.12)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + h * 0.25, w * 0.3, h * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(cx - w * 0.1, cy - h * 0.12, w * 0.02, cx, cy, w * 0.38);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#f3e6dc');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.33, cy + h * 0.2);
    ctx.bezierCurveTo(cx - w * 0.4, cy - h * 0.05, cx - w * 0.25, cy - h * 0.3, cx, cy - h * 0.3);
    ctx.bezierCurveTo(cx + w * 0.25, cy - h * 0.3, cx + w * 0.4, cy - h * 0.05, cx + w * 0.33, cy + h * 0.2);
    ctx.quadraticCurveTo(cx, cy + h * 0.28, cx - w * 0.33, cy + h * 0.2);
    ctx.fill();
    ctx.strokeStyle = '#e8cdbb';
    ctx.lineWidth = w * 0.008;
    ctx.stroke();
    // a sakura leaf on top
    ctx.fillStyle = '#7cc47f';
    ctx.beginPath();
    ctx.ellipse(cx + w * 0.07, cy - h * 0.3, w * 0.09, h * 0.035, -0.5, 0, Math.PI * 2);
    ctx.fill();
    face(ctx, cx, cy, w * 0.14, '#ff9fb5');
  },
};

export const samples: Sample[] = [gingerbread, octopus, mochi, snake, star];

export function renderSample(s: Sample, size = 800): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  s.draw(c.getContext('2d')!, size, size);
  return c;
}

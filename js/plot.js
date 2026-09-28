/**
 * 折线图控件（对应桌面版 ui.py 的 ChartView）。
 *
 * 用 canvas 自绘：坐标轴、网格、刻度、图例、曲线、标注（叉号）与竖向参考线。
 * 支持高 DPI：外部按 devicePixelRatio 设置 canvas 尺寸，这里统一用 CSS 像素绘图。
 */
(function (PB) {
  'use strict';

  const UI_FONT = '"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

  const C = {
    canvas: '#ffffff', border: '#cfd8dc', grid: '#e3e8eb', axis: '#8d9aa5',
    text: '#263238', steel: '#546e7a', fail: '#c62828', guide: '#78909c',
  };

  /** 紧凑数字格式 */
  function fmt(v) {
    const a = Math.abs(v);
    if (v === 0) return '0';
    if (a < 1e-3 || a >= 1e5) return v.toExponential(1).replace('e+', 'e');
    if (a < 0.01) return v.toFixed(4);
    if (a < 1) return v.toFixed(3);
    if (a < 100) return v.toFixed(2);
    return v.toFixed(0);
  }

  /** 圆角矩形路径（不依赖 ctx.roundRect，老浏览器也能用） */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 在最接近 x 的样本点上吸附（用于悬停读数） */
  function nearestX(series, x) {
    let best = x, bestD = Infinity;
    series.forEach(function (s) {
      s.xs.forEach(function (v) {
        const d = Math.abs(v - x);
        if (d < bestD) { bestD = d; best = v; }
      });
    });
    return best;
  }

  class ChartView {
    constructor(canvas, title, xlabel, ylabel) {
      this.canvas = canvas;
      this.title = title;
      this.xlabel = xlabel;
      this.ylabel = ylabel;
      this.series = [];
      this.markers = [];
      this.guides = [];
      this.margin = { left: 64, right: 16, bottom: 38, top: 28 };
      this.hoverX = null;          // 鼠标指向的数据横坐标（null = 没有悬停）
      this._geo = null;            // 本次绘制的坐标映射，供悬停换算
      this.bindHover();
    }

    /** 悬停读数：十字准线 + 各曲线在该处的数值 */
    bindHover() {
      const self = this;
      const at = function (ev) {
        const r = self.canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      };
      this.canvas.addEventListener('mousemove', function (ev) {
        const g = self._geo;
        if (!g) return;
        const p = at(ev);
        if (p[0] < g.x0 - 2 || p[0] > g.x1 + 2 || p[1] < 0 || p[1] > self.canvas.clientHeight) {
          if (self.hoverX !== null) { self.hoverX = null; self.draw(); }
          return;
        }
        const t = g.xmin + (p[0] - g.x0) / (g.x1 - g.x0) * (g.xmax - g.xmin);
        const snapped = nearestX(self.series, t);
        if (self.hoverX === snapped) return;
        self.hoverX = snapped;
        self.draw();
      });
      this.canvas.addEventListener('mouseleave', function () {
        if (self.hoverX === null) return;
        self.hoverX = null;
        self.draw();
      });
    }

    /** series: [{name, xs, ys, color, width, point}]；markers: [{x, y, text, color}] */
    setData(series, markers, guides) {
      this.series = series || [];
      this.markers = markers || [];
      this.guides = guides || [];
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.canvas;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      if (w < 60 || h < 50) return;

      const m = this.margin;
      const x0 = m.left, x1 = w - m.right, y0 = h - m.bottom, y1 = m.top;

      ctx.fillStyle = C.text;
      ctx.font = 'bold 12px ' + UI_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(this.title, 10, 18);

      if (!this.series.length || !this.series.some(function (s) { return s.xs.length; })) {
        this._geo = null;
        ctx.fillStyle = C.axis;
        ctx.font = '12px ' + UI_FONT;
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', (x0 + x1) / 2, (y0 + y1) / 2);
        return;
      }

      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      this.series.forEach(function (s) {
        s.xs.forEach(function (v) { if (v < xmin) xmin = v; if (v > xmax) xmax = v; });
        s.ys.forEach(function (v) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; });
      });
      if (!(xmax - xmin > 1e-9)) xmax = xmin + 1.0;
      if (!(ymax - ymin > 1e-12)) ymax = ymin + 1.0;
      ymin = Math.min(ymin, 0.0);            // 纵轴总包含 0，便于读数
      const span = ymax - ymin;
      ymin -= 0.08 * span;
      ymax += 0.08 * span;

      const sx = (x) => x0 + (x - xmin) / (xmax - xmin) * (x1 - x0);
      const sy = (y) => y0 - (y - ymin) / (ymax - ymin) * (y0 - y1);

      // 记下本次映射，供鼠标悬停换算（数据坐标 ↔ 屏幕坐标）
      this._geo = { x0: x0, x1: x1, y0: y0, y1: y1, xmin: xmin, xmax: xmax,
        ymin: ymin, ymax: ymax, sx: sx, sy: sy };

      // 网格 + 刻度
      ctx.font = '10px ' + UI_FONT;
      for (let i = 0; i < 5; i++) {
        const gx = x0 + (x1 - x0) * i / 4;
        const gy = y0 - (y0 - y1) * i / 4;
        ctx.strokeStyle = C.grid;
        ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
        ctx.fillStyle = C.axis;
        ctx.textAlign = 'center';
        ctx.fillText(fmt(xmin + (xmax - xmin) * i / 4), gx, y0 + 14);
        ctx.textAlign = 'right';
        ctx.fillText(fmt(ymin + (ymax - ymin) * i / 4), x0 - 6, gy + 3);
      }

      ctx.strokeStyle = C.axis;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'right';
      ctx.fillText(this.xlabel, x1, y0 + 26);
      ctx.textAlign = 'left';
      ctx.fillText(this.ylabel, x0 - 52, y1 - 8);

      // 竖向参考线
      const self = this;
      this.guides.forEach(function (gv) {
        if (gv >= xmin && gv <= xmax) {
          ctx.strokeStyle = C.guide;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(sx(gv), y0); ctx.lineTo(sx(gv), y1); ctx.stroke();
          ctx.setLineDash([]);
        }
      });

      // 曲线
      this.series.forEach(function (s) {
        if (!s.xs.length) return;
        ctx.strokeStyle = s.color || C.steel;
        ctx.lineWidth = s.width || 2;
        ctx.lineJoin = 'round';
        if (s.xs.length >= 2) {
          ctx.beginPath();
          for (let i = 0; i < s.xs.length; i++) {
            const px = sx(s.xs[i]), py = sy(s.ys[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        if (s.point) {
          const px = sx(s.xs[s.xs.length - 1]), py = sy(s.ys[s.ys.length - 1]);
          ctx.fillStyle = s.color || C.steel;
          ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      });

      // 图例（右上）
      ctx.font = '10px ' + UI_FONT;
      ctx.textAlign = 'right';
      let ly = y1 + 10;
      this.series.forEach(function (s) {
        if (!s.name) return;
        const tw = ctx.measureText(s.name).width;
        ctx.strokeStyle = s.color || C.steel;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1 - tw - 22, ly - 3); ctx.lineTo(x1 - tw - 8, ly - 3); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(s.name, x1, ly);
        ly += 13;
      });

      // 标注（叉号 + 文本）
      ctx.textAlign = 'center';
      this.markers.forEach(function (mk) {
        const px = sx(mk.x), py = sy(mk.y);
        ctx.strokeStyle = mk.color || C.fail;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5);
        ctx.moveTo(px - 5, py + 5); ctx.lineTo(px + 5, py - 5);
        ctx.stroke();
        if (mk.text) {
          ctx.fillStyle = mk.color || C.fail;
          ctx.font = '10px ' + UI_FONT;
          ctx.fillText(mk.text, px, py - 9);
        }
      });

      this.drawHover(ctx);
    }

    /** 悬停读数：竖向准线 + 各曲线在该横坐标处的取值气泡 */
    drawHover(ctx) {
      const g = this._geo;
      if (!g || this.hoverX === null) return;
      const px = g.sx(this.hoverX);
      if (px < g.x0 - 1 || px > g.x1 + 1) return;

      const self = this;
      const rows = [];
      this.series.forEach(function (s) {
        if (!s.xs.length) return;
        let bi = 0, bd = Infinity;
        for (let i = 0; i < s.xs.length; i++) {
          const d = Math.abs(s.xs[i] - self.hoverX);
          if (d < bd) { bd = d; bi = i; }
        }
        rows.push({ name: s.name || '值', x: s.xs[bi], y: s.ys[bi], color: s.color || C.steel });
      });
      if (!rows.length) return;

      ctx.save();
      ctx.strokeStyle = C.guide;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, g.y0); ctx.lineTo(px, g.y1); ctx.stroke();
      ctx.setLineDash([]);

      // 曲线上的取样点
      rows.forEach(function (r) {
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(g.sx(r.x), g.sy(r.y), 3, 0, Math.PI * 2); ctx.fill();
      });

      // 气泡
      ctx.font = '10px ' + UI_FONT;
      const head = fmt(this.hoverX);
      let wMax = ctx.measureText(head).width;
      rows.forEach(function (r) {
        wMax = Math.max(wMax, ctx.measureText(r.name + ' ' + fmt(r.y)).width);
      });
      const pad = 7, lh = 13;
      const bw = wMax + pad * 2 + 10;
      const bh = lh * (rows.length + 1) + pad * 2 - 4;
      let bx = px + 12;
      if (bx + bw > g.x1) bx = px - 12 - bw;
      if (bx < g.x0 + 1) bx = g.x0 + 1;
      let by = g.y1 + 4;
      if (by + bh > g.y0 - 2) by = Math.max(g.y1 + 2, g.y0 - 2 - bh);

      ctx.fillStyle = 'rgba(255,255,255,.97)';
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = C.text;
      ctx.font = 'bold 10px ' + UI_FONT;
      ctx.fillText(head, bx + pad, by + pad + 8);
      let ly = by + pad + 8 + lh;
      rows.forEach(function (r) {
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(bx + pad + 3, ly - 3, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.text;
        ctx.font = '10px ' + UI_FONT;
        ctx.fillText(r.name + ' ' + fmt(r.y), bx + pad + 10, ly);
        ly += lh;
      });
      ctx.restore();
    }
  }

  PB.ChartView = ChartView;
})(globalThis.PB = globalThis.PB || {});

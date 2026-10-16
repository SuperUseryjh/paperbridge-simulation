/**
 * 桥体视图 / 自建结构编辑器（对应桌面版 ui.py 的 BridgeView）。
 *
 * 画布同时承担两件事：
 *  1) 展示分析结果：未变形虚线轮廓、按利用率着色的变形形状、支座、砝码、结论横幅；
 *  2) 自建结构编辑：五种鼠标模式（节点/杆件/支座/加载点/删除），网格吸附、拖动节点、
 *     待连杆件的橡皮筋、节点编号标注。
 *
 * 世界坐标：x 沿跨向右、y 向上；屏幕坐标 y 向下。映射用 _Mapper 双向换算，
 * 保证"看到哪里就点到哪里"。
 */
(function (PB) {
  'use strict';

  const UI_FONT = '"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
  const Custom = PB.Custom;

  const C = {
    canvas: '#ffffff', border: '#cfd8dc', text: '#263238',
    undeformed: '#c3ccd3', steel: '#546e7a', axis: '#8d9aa5',
    safe: '#2e7d32', warn: '#f9a825', high: '#ef6c00', fail: '#c62828',
    load: '#5d4037', loadFill: '#8d6e63', grid: '#eef2f4', node: '#37474f',
  };

  // 鼠标模式
  const MODE_NODE = 'node', MODE_MEMBER = 'member', MODE_SUPPORT = 'support',
    MODE_LOAD = 'load', MODE_DELETE = 'delete';
  const EDIT_MODES = [MODE_NODE, MODE_MEMBER, MODE_SUPPORT, MODE_LOAD, MODE_DELETE];
  const MODE_LABELS = {
    node: '节点', member: '杆件', support: '支座', load: '加载点', delete: '删除',
  };
  const MODE_HINTS = {
    node: '点空白处放置新节点；按住已有节点可拖动（自动吸附网格）。',
    member: '依次点两个节点连成杆件；点已有的杆件 = 把它改成当前选的截面与类型。',
    support: '点节点循环切换支座：无 → 铰支 → 滚动铰 → 固支。',
    load: '点节点切换是否为加载点（砝码只能放在加载点上）。',
    delete: '点节点删除节点及其相连杆件；点杆件中段删除该杆件。',
  };

  /** 利用率 → 颜色 */
  function utilizationColor(ur) {
    if (ur >= 1.0) return C.fail;
    if (ur >= 0.8) return C.high;
    if (ur >= 0.5) return C.warn;
    return C.safe;
  }

  /** 世界 ↔ 屏幕 双向映射（与桌面版 _Mapper 一致） */
  class Mapper {
    constructor(points, width, height, shake, minView) {
      shake = shake || [0, 0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      points.forEach(function (p) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      });
      // 最小视野：空画布 / 只有一个节点 / 全部重合时范围会退化成 0，
      // 那样点哪儿都换算出同一个坐标（放不下第二个节点），所以兜一个下限。
      // minView 一般传当前跨长，这样"默认工作区"就是用户打算建的桥那么大。
      const mvx = Math.max((minView && minView[0]) || 0, 0.02);
      const mvy = Math.max((minView && minView[1]) || 0, 0.005);
      if (x1 - x0 < mvx) {
        const cx = 0.5 * (x0 + x1);
        x0 = cx - mvx / 2;
        x1 = cx + mvx / 2;
      }
      const minH = Math.max(0.18 * (x1 - x0), mvy);
      if (y1 - y0 < minH) {
        const c = 0.5 * (y0 + y1);
        y0 = c - 0.5 * minH;
        y1 = c + 0.5 * minH;
      }
      y0 -= 0.06 * (y1 - y0);
      y1 += 0.22 * (y1 - y0);            // 上方留出放砝码的空间
      x0 -= 0.05 * (x1 - x0);
      x1 += 0.05 * (x1 - x0);
      const mx = 0.06 * width, my = 0.08 * height;
      const s = Math.min((width - 2 * mx) / (x1 - x0), (height - 2 * my) / (y1 - y0));
      this.width = width; this.height = height;
      this.x0 = x0; this.x1 = x1; this.y0 = y0; this.y1 = y1;
      this.scale = s;
      this.ox = mx + (width - 2 * mx - s * (x1 - x0)) / 2;
      this.oy = my + (height - 2 * my - s * (y1 - y0)) / 2;
      this.dx = shake[0]; this.dy = shake[1];
    }

    /**
     * 叠上用户自己的缩放与平移（画布是无限平面，视野不再被结构范围框住）。
     * 以画布中心为基准缩放，再整体平移；默认 zoom=1 / pan=0 时就是自动适应。
     */
    applyView(zoom, panX, panY) {
      if (!(zoom > 0)) zoom = 1;
      const cx = 0.5 * this.width, cy = 0.5 * this.height;
      this.scale *= zoom;
      this.ox = cx + (this.ox - cx) * zoom + panX;
      this.oy = cy + (this.oy - cy) * zoom + panY;
    }

    /** 画布可见范围对应的世界坐标 [x 最小, x 最大, y 最小, y 最大] */
    visibleWorld() {
      const a = this.fromScreen(0, 0);
      const b = this.fromScreen(this.width, this.height);
      return [Math.min(a[0], b[0]), Math.max(a[0], b[0]),
              Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    }

    toScreen(x, y) {
      return [this.ox + (x - this.x0) * this.scale + this.dx,
              this.oy + (this.y1 - y) * this.scale + this.dy];
    }

    fromScreen(px, py) {
      return [this.x0 + (px - this.dx - this.ox) / this.scale,
              this.y1 - (py - this.dy - this.oy) / this.scale];
    }

    /** 8 像素对应的世界长度，用于鼠标命中测试 */
    pixelTolerance() { return 8.0 / this.scale; }
  }

  class BridgeView {
    constructor(canvas) {
      this.canvas = canvas;
      this.analysis = null;          // {design, model, result, report}
      this.amplify = true;
      this.shake = [0, 0];
      this.collapsed = false;
      this.banner = '';
      // 编辑器状态
      this.editor = null;            // CustomStructure | null
      this.editMode = MODE_NODE;
      this.pendingNode = null;
      this.grid = 0.01;
      this.defaultSpan = 0.30;       // 空画布时的默认工作区宽度（由 app.js 从跨长同步）
      // 视野：自动适应之上再叠用户的缩放/平移（画布是无限平面）
      this.viewZoom = 1;
      this.viewPanX = 0;
      this.viewPanY = 0;
      this.touch = false;            // 触屏设备（提示文案不同，由 app.js 同步）
      this._pan = null;
      this._panning = false;
      this._pointers = new Map();    // 触屏双指缩放用
      this.hover = null;
      this.hoverNode = null;         // 鼠标指向的节点（命中测试结果）
      this.hoverMember = null;       // 鼠标指向的杆件
      this.dragNode = null;
      this.frozen = null;
      this.memberPointers = null;    // 待连杆件的橡皮筋落点（世界坐标）
      // 回调（由 app.js 注入）
      this.onEmptyClick = null;
      this.onNodeClick = null;
      this.onMemberClick = null;
      this.onMemberDoubleClick = null;
      this.onNodeMove = null;
      this.onNodeDrop = null;
      this.onModeHint = null;
      this.bindEvents();
    }

    // ---- 对外接口 ----
    showAnalysis(analysis, opts) {
      opts = opts || {};
      this.analysis = analysis;
      if (opts.amplify !== undefined) this.amplify = opts.amplify;
      if (opts.collapsed !== undefined) this.collapsed = opts.collapsed;
      if (opts.banner !== undefined) this.banner = opts.banner;
      this.draw();
    }

    setEditorState(editor, mode, pending, grid) {
      this.editor = editor;
      if (mode) this.editMode = mode;
      this.pendingNode = (pending === undefined) ? this.pendingNode : pending;
      if (grid !== undefined) this.grid = grid;
      this.draw();
    }

    snap(x, y) {
      if (!(this.grid > 0)) return [x, y];
      return [Math.round(x / this.grid) * this.grid, Math.round(y / this.grid) * this.grid];
    }

    /** 当前世界坐标点的来源：编辑器几何优先，否则用分析模型的节点 */
    worldPoints() {
      if (this.editor && this.editor.nodes.length) {
        return this.editor.nodes.map(function (n) { return [n[0], n[1]]; });
      }
      if (this.analysis) {
        return this.analysis.model.nodes.map(function (n) { return [n.x, n.y]; });
      }
      return [];
    }

    mapper() {
      if (this.frozen) return this.frozen;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (w < 60 || h < 60) return null;
      const mvx = Math.max(this.defaultSpan || 0.30, 0.05);   // 默认工作区 ≈ 一跨长
      let pts = this.worldPoints();
      // 空画布也要有一套坐标系：否则清空之后连第一个节点都放不上去
      if (!pts.length) {
        if (!this.editor) return null;
        pts = [[0, 0], [mvx, 0]];
      }
      const m = new Mapper(pts, w, h, this.shake, [mvx, 0.18 * mvx]);
      m.applyView(this.viewZoom, this.viewPanX, this.viewPanY);
      return m;
    }

    /** 回到默认视野（自动适应结构 / 空画布时回到默认平面） */
    resetView() {
      this.viewZoom = 1;
      this.viewPanX = 0;
      this.viewPanY = 0;
      this.draw();
    }

    /** 这次按下要不要平移画布（而不是编辑） */
    _shouldPan(ev) {
      if (ev.button === 1 || ev.button === 2) return true;   // 中键 / 右键
      if (ev.button === 0 && ev.shiftKey) return true;       // Shift + 左键
      if (ev.button === 0 && !this.editor) return true;      // 只看结果时左键拖动
      return false;
    }

    /** 执行一次编辑动作（鼠标按下即触发；触屏则在抬手确认后触发） */
    _applyAction(mode, node, member, wx, wy) {
      if (mode === MODE_NODE) {
        if (node === null && this.onEmptyClick) {
          const s = this.snap(wx, wy);
          this.onEmptyClick(s[0], s[1]);
        }
      } else if (mode === MODE_MEMBER || mode === MODE_DELETE) {
        if (node !== null && this.onNodeClick) this.onNodeClick(node);
        else if (member !== null && this.onMemberClick) this.onMemberClick(member);
      } else if (node !== null && this.onNodeClick) {
        this.onNodeClick(node);                              // 支座 / 加载点
      }
    }

    /** 双指落下：进入手势（放弃这一下可能已开始的编辑） */
    _beginGesture() {
      const pts = Array.from(this._pointers.values());
      this._tap = null;
      this._pan = null;
      this._panning = false;
      if (this.dragNode !== null) {
        const node = this.dragNode;
        this.dragNode = null;
        this.frozen = null;
        if (this.onNodeDrop) this.onNodeDrop(node);
      }
      this._gesture = {
        dist: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1,
        cx: 0.5 * (pts[0][0] + pts[1][0]),
        cy: 0.5 * (pts[0][1] + pts[1][1]),
      };
    }

    /** 双指移动：中心点位移 → 平移，两指间距变化 → 以中心为锚缩放 */
    _updateGesture() {
      const g = this._gesture;
      if (!g) return;
      const pts = Array.from(this._pointers.values());
      if (pts.length < 2) return;
      const dist = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
      const cx = 0.5 * (pts[0][0] + pts[1][0]);
      const cy = 0.5 * (pts[0][1] + pts[1][1]);
      this.viewPanX += cx - g.cx;
      this.viewPanY += cy - g.cy;
      g.cx = cx; g.cy = cy;
      const factor = dist / g.dist;
      g.dist = dist;
      this.zoomAt(cx, cy, factor);
    }

    /** 以画布上某点为锚缩放（该点下的世界坐标保持不动） */
    zoomAt(px, py, factor) {
      if (this.frozen) return;               // 正在拖节点：视图锁住了，别动
      const before = this.mapper();
      if (!before) return;
      const anchor = before.fromScreen(px, py);
      this.viewZoom = Math.min(Math.max(this.viewZoom * factor, 0.05), 60);
      const after = this.mapper();
      if (!after) return;
      // 把锚点处的世界坐标挪回光标下：ox 变 δ 会让 fromScreen 变 -δ/scale（y 相反）
      const now = after.fromScreen(px, py);
      this.viewPanX += (now[0] - anchor[0]) * after.scale;
      this.viewPanY -= (now[1] - anchor[1]) * after.scale;
      this.draw();
    }

    // ---- 鼠标 / 触屏交互（统一走 pointer 事件，手机上单指拖动也能用）----
    bindEvents() {
      const self = this;
      const pos = function (ev) {
        const r = self.canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      };
      const primary = function (ev) {
        // 多指触摸时只认主手指（第二根手指不参与绘编辑）
        return ev.pointerType !== 'touch' || ev.isPrimary;
      };

      // 滚轮 / 触控板双指：以光标为锚缩放（画布是无限平面）
      this.canvas.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        const p = pos(ev);
        self.zoomAt(p[0], p[1], ev.deltaY < 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });

      // 右键用来平移画布，别弹系统菜单
      this.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

      this.canvas.addEventListener('pointerdown', function (ev) {
        // 触屏：先登记手指，第二根落下就进入双指手势
        if (ev.pointerType === 'touch') {
          self._pointers.set(ev.pointerId, pos(ev));
          if (self._pointers.size === 2) { self._beginGesture(); return; }
          if (self._pointers.size > 2) return;
        }
        // 中键 / 右键 / Shift+左键 / 只看结果时的左键：拖动平移
        if (self._shouldPan(ev)) {
          try { self.canvas.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
          self._pan = pos(ev);
          self._panning = true;
          self.canvas.style.cursor = 'grabbing';
          ev.preventDefault();
          return;
        }
        if (ev.button !== 0 || !primary(ev)) return;
        try { self.canvas.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
        const mapper = self.mapper();
        if (!mapper) return;
        if (!self.editor) return;
        const p = pos(ev);
        const w = mapper.fromScreen(p[0], p[1]);
        const wx = w[0], wy = w[1];
        const tol = mapper.pixelTolerance() * 1.6;
        const node = self.editor.nodeAt(wx, wy, tol);
        const member = self.editor.memberAt(wx, wy, tol);
        const mode = self.editMode;
        if (ev.pointerType === 'touch') {
          // 触屏：按住节点直接拖，其余动作推迟到抬手判定 ——
          // 免得"想双指缩放"时第一根手指先在空白处点出一个节点
          if (mode === MODE_NODE && node !== null) {
            self.dragNode = node;
            self.frozen = mapper;          // 冻结视图，拖动时坐标不跟着变
          } else {
            self._tap = { node: node, member: member, wx: wx, wy: wy,
                          sx: p[0], sy: p[1], mode: mode };
          }
          return;
        }
        self._applyAction(mode, node, member, wx, wy);
      });

      this.canvas.addEventListener('pointermove', function (ev) {
        if (ev.pointerType === 'touch') {
          if (self._pointers.has(ev.pointerId)) self._pointers.set(ev.pointerId, pos(ev));
          if (self._gesture) { self._updateGesture(); return; }
          // 单指在空白处拖过阈值：改判成平移
          if (self._tap) {
            const q = pos(ev);
            if (Math.hypot(q[0] - self._tap.sx, q[1] - self._tap.sy) > 10) {
              self._tap = null;
              self._pan = q;
              self._panning = true;
              self.canvas.style.cursor = 'grabbing';
            }
          }
        }
        if (self._panning) {
          const q = pos(ev);
          self.viewPanX += q[0] - self._pan[0];
          self.viewPanY += q[1] - self._pan[1];
          self._pan = q;
          self.draw();
          return;
        }
        if (!primary(ev)) return;
        if (!self.editor) return;
        const mapper = self.mapper();
        if (!mapper) return;
        const p = pos(ev);
        const w = mapper.fromScreen(p[0], p[1]);
        const s = self.snap(w[0], w[1]);
        if (self.dragNode !== null) {
          if (self.onNodeMove) self.onNodeMove(self.dragNode, s[0], s[1]);
          return;
        }
        const tol = mapper.pixelTolerance() * 1.6;
        const node = self.editor.nodeAt(w[0], w[1], tol);
        const member = self.editor.memberAt(w[0], w[1], tol);
        const moved = !self.hover || self.hover[0] !== s[0] || self.hover[1] !== s[1];
        const switched = (node !== self.hoverNode) || (member !== self.hoverMember);
        self.hover = s;
        self.hoverNode = node;
        self.hoverMember = member;
        if (moved || switched) self.draw();
      });

      // 双击杆件：直接套用当前选的截面（节点/删除模式不参与，避免误加节点或误删）
      this.canvas.addEventListener('dblclick', function (ev) {
        if (!self.editor || !self.onMemberDoubleClick) return;
        if (self.editMode === MODE_NODE || self.editMode === MODE_DELETE) return;
        const mapper = self.mapper();
        if (!mapper) return;
        const p = pos(ev);
        const w = mapper.fromScreen(p[0], p[1]);
        const tol = mapper.pixelTolerance() * 1.6;
        const member = self.editor.memberAt(w[0], w[1], tol);
        if (member !== null) self.onMemberDoubleClick(member);
      });

      const finishPointer = function (ev) {
        if (ev.pointerType === 'touch') {
          self._pointers.delete(ev.pointerId);
          if (self._pointers.size < 2) self._gesture = null;
        }
        if (self._panning) {
          self._panning = false;
          self._pan = null;
          self.updateCursor();
          return;
        }
        // 触屏轻点：抬手时才真正执行编辑动作
        if (self._tap) {
          const t = self._tap;
          self._tap = null;
          self._applyAction(t.mode, t.node, t.member, t.wx, t.wy);
          return;
        }
        if (ev.button !== 0) return;
        if (self.dragNode !== null) {
          const node = self.dragNode;
          self.dragNode = null;
          self.frozen = null;
          if (self.onNodeDrop) self.onNodeDrop(node);
          self.draw();
        }
      };
      this.canvas.addEventListener('pointerup', finishPointer);
      this.canvas.addEventListener('pointercancel', function (ev) {
        if (ev.pointerType === 'touch') self._pointers.delete(ev.pointerId);
        if (self._pointers.size < 2) self._gesture = null;
        self._tap = null;
        self.dragNode = null;
        self.frozen = null;
        self._panning = false;
        self._pan = null;
        self.updateCursor();
        self.draw();
      });

      this.canvas.addEventListener('pointerleave', function () {
        self.clearHover();
        self.draw();
      });
    }

    /** 清空鼠标指向状态（删除节点后索引会失效，必须清掉） */
    clearHover() {
      this.hover = null;
      this.hoverNode = null;
      this.hoverMember = null;
    }

    /** 光标形状跟着编辑模式变，鼠标到画布上就知道该干什么 */
    updateCursor() {
      if (this._panning) { this.canvas.style.cursor = 'grabbing'; return; }
      if (!this.editor) { this.canvas.style.cursor = 'grab'; return; }
      const cursors = {};
      cursors[MODE_NODE] = 'crosshair';
      cursors[MODE_MEMBER] = 'crosshair';
      cursors[MODE_SUPPORT] = 'pointer';
      cursors[MODE_LOAD] = 'pointer';
      cursors[MODE_DELETE] = 'cell';
      this.canvas.style.cursor = cursors[this.editMode] || 'default';
    }

    // ---- 绘制 ----
    draw() {
      const canvas = this.canvas;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      this.updateCursor();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.canvas;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      if (w < 60 || h < 60) return;

      ctx.font = '12px ' + UI_FONT;
      const mapper = this.mapper();
      if (!mapper) {
        ctx.fillStyle = C.axis;
        ctx.textAlign = 'center';
        ctx.fillText('暂无结构', w / 2, h / 2);
        return;
      }

      if (this.editor) this.drawGrid(ctx, mapper);
      this.drawGround(ctx, mapper);
      if (this.analysis) this.drawAnalysis(ctx, mapper);
      else if (this.editor) this.drawEditorGeometry(ctx, mapper);
      if (this.editor) this.drawEditorOverlay(ctx, mapper);
      this.drawBanner(ctx);

      // 空画布：网格照常画，给一句提示告诉用户怎么开始
      if (this.editor && !this.editor.nodes.length) {
        ctx.fillStyle = C.axis;
        ctx.font = '13px ' + UI_FONT;
        ctx.textAlign = 'center';
        ctx.fillText('在画布上点击放置第一个节点', w / 2, h / 2);
      }

      // 右下角：视野操作提示
      ctx.fillStyle = C.axis;
      ctx.font = '10px ' + UI_FONT;
      ctx.textAlign = 'right';
      ctx.fillText(this.touch
        ? '双指缩放 / 平移 · 复位见右上「复位视野」'
        : '滚轮缩放 · Shift / 右键 / 中键拖动平移 · 按 0 复位', w - 8, h - 7);
      ctx.textAlign = 'left';
    }

    drawGrid(ctx, mapper) {
      if (!this.editor || !(this.grid > 0)) return;
      if (this.grid * mapper.scale < 7) return;       // 太密就不画
      // 网格铺满整个可见范围（画布是无限平面，不再只画结构那一块）
      const vis = mapper.visibleWorld();
      const xa = vis[0], xb = vis[1], ya = vis[2], yb = vis[3];
      if ((xb - xa) / this.grid > 400 || (yb - ya) / this.grid > 400) return;
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      const xStart = Math.ceil(xa / this.grid) * this.grid;
      for (let x = xStart; x <= xb; x += this.grid) {
        const a = mapper.toScreen(x, ya), b = mapper.toScreen(x, yb);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      const yStart = Math.ceil(ya / this.grid) * this.grid;
      for (let y = yStart; y <= yb; y += this.grid) {
        const a = mapper.toScreen(xa, y), b = mapper.toScreen(xb, y);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }

    /** 地面：支座所在高度画一条基准线 + 斜线阴影 */
    drawGround(ctx, mapper) {
      let gy = null;
      if (!this.worldPoints().length) return;
      const supports = this.analysis ? this.analysis.model.supports : [];
      if (this.editor) {
        const ys = Object.keys(this.editor.supports).map((k) => this.editor.nodes[k][1]);
        if (ys.length) gy = Math.max.apply(null, ys);
      } else if (supports.length) {
        const ys = supports.map((s) => this.analysis.model.nodes[s.node].y);
        gy = Math.max.apply(null, ys);
      }
      if (gy === null) return;
      // 地面横铺整个可见范围（无限平面：走到哪儿地面跟到哪儿）
      const c0 = mapper.toScreen(0, gy)[1];
      ctx.strokeStyle = C.steel;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-20, c0); ctx.lineTo(this.canvas.clientWidth + 20, c0); ctx.stroke();
      ctx.strokeStyle = '#b0bec5';
      ctx.lineWidth = 1;
      for (let x = -20; x <= this.canvas.clientWidth + 20; x += 9) {
        ctx.beginPath(); ctx.moveTo(x, c0); ctx.lineTo(x - 7, c0 + 9); ctx.stroke();
      }
    }

    /** 自动放大系数 */
    amplification() {
      if (!this.amplify || !this.analysis) return 1.0;
      const a = this.analysis;
      const defl = Math.abs(a.result.maxDeflection);
      if (!(defl > 1e-12)) return 1.0;
      let worldLen = 0;
      a.model.nodes.forEach(function (n) {
        worldLen = Math.max(worldLen, n.x);
      });
      let minX = Infinity;
      a.model.nodes.forEach(function (n) { minX = Math.min(minX, n.x); });
      worldLen -= minX;
      return Math.min(2000.0, Math.max(1.0, 0.10 * worldLen / defl));
    }

    drawAnalysis(ctx, mapper) {
      const a = this.analysis;
      const model = a.model, result = a.result, report = a.report;
      const amp = this.amplification();

      // 未变形轮廓
      ctx.strokeStyle = C.undeformed;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      for (let i = 0; i < model.elements.length; i++) {
        const g = model.elementGeometry(i);
        const p1 = mapper.toScreen(g.xi, g.yi);
        const p2 = mapper.toScreen(g.xi + g.L * g.c, g.yi + g.L * g.s);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
      }
      ctx.setLineDash([]);

      // 变形后杆件（按利用率着色）
      for (let i = 0; i < model.elements.length; i++) {
        const g = model.elementGeometry(i);
        const pts = model.deformedPoints(result, i);
        const n = pts.length - 1;
        const screen = [];
        for (let k = 0; k < pts.length; k++) {
          const t = n ? k / n : 0;
          const ux = g.xi + t * g.L * g.c, uy = g.yi + t * g.L * g.s;
          screen.push(mapper.toScreen(ux + amp * (pts[k][0] - ux),
            uy + amp * (pts[k][1] - uy)));
        }
        const roles = model.meta.roles || {};
        const role = roles[i] || '';
        // 主构件（桥面 / 上下弦 / 拱圈）画粗一点，腹杆与吊杆这类细杆画细。
        // 这里必须按 role 判断，不能拿 label 字符串去比 —— 自建结构的 label 是
        // chord / web，字符串比对认不出来，结果自建拱桥的拱圈会被画得跟吊杆一样细，
        // "主梁 + 细吊杆"的对比就没了。
        const main = (role === 'deck' || role === 'chord' || role === 'arch');
        const ur = report.utilizationOf(i);
        ctx.strokeStyle = utilizationColor(ur);
        ctx.lineWidth = main ? 3.0 : 2.0;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        screen.forEach(function (p, k) {
          if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        });
        ctx.stroke();
        if (this.collapsed && ur >= 1.0) {
          let mx = 0, my = 0;
          screen.forEach(function (p) { mx += p[0]; my += p[1]; });
          mx /= screen.length; my /= screen.length;
          ctx.strokeStyle = C.fail;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(mx - 5, my - 5); ctx.lineTo(mx + 5, my + 5);
          ctx.moveTo(mx - 5, my + 5); ctx.lineTo(mx + 5, my - 5);
          ctx.stroke();
        }
      }

      // 支座
      const self = this;
      model.supports.forEach(function (sup) {
        const node = model.nodes[sup.node];
        self.drawSupport(ctx, mapper.toScreen(node.x, node.y), sup.fixUx, sup.fixUy, sup.fixRz);
      });

      this.drawLoads(ctx, mapper);

      if (amp > 1.0001) {
        ctx.fillStyle = C.axis;
        ctx.font = '10px ' + UI_FONT;
        ctx.textAlign = 'right';
        ctx.fillText('变形已放大 ×' + amp.toFixed(0), this.canvas.clientWidth - 12,
          this.canvas.clientHeight - 10);
      }
      this.drawLegend(ctx);
    }

    drawSupport(ctx, p, fixUx, fixUy, fixRz) {
      if (fixRz && fixUx && fixUy) {          // 固支
        ctx.strokeStyle = C.steel; ctx.lineWidth = 2;
        ctx.fillStyle = '#cfd8dc';
        ctx.beginPath(); ctx.rect(p[0] - 7, p[1], 14, 12); ctx.fill(); ctx.stroke();
        return;
      }
      ctx.strokeStyle = C.steel; ctx.lineWidth = 2; ctx.fillStyle = '#cfd8dc';
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[0] - 8, p[1] + 13);
      ctx.lineTo(p[0] + 8, p[1] + 13);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (!fixUx) {                            // 滚动铰
        ctx.beginPath(); ctx.arc(p[0], p[1] + 17, 4, 0, Math.PI * 2); ctx.stroke();
      }
    }

    drawLoads(ctx, mapper) {
      const points = (this.analysis.model.meta.load_points) || [];
      const G = PB.Materials.G;
      ctx.font = '12px ' + UI_FONT;
      points.forEach(function (pt) {
        const force = pt[2];
        if (!(force > 0)) return;
        const p = mapper.toScreen(pt[0], pt[1]);
        const size = Math.min(28.0, 10.0 + 4.0 * Math.sqrt(force));
        const top = p[1] - size - 8;
        // 箭头
        ctx.strokeStyle = C.load; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p[0], top); ctx.lineTo(p[0], p[1] - 2); ctx.stroke();
        ctx.fillStyle = C.load;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - 2);
        ctx.lineTo(p[0] - 4, p[1] - 10);
        ctx.lineTo(p[0] + 4, p[1] - 10);
        ctx.closePath(); ctx.fill();
        // 砝码方块
        ctx.fillStyle = C.loadFill;
        ctx.strokeStyle = C.load; ctx.lineWidth = 1;
        const bw = size, bh = size * 0.82;
        ctx.beginPath(); ctx.rect(p[0] - bw / 2, top - bh, bw, bh); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.font = '10px ' + UI_FONT;
        ctx.fillText((force / G * 1e3).toFixed(0) + 'g', p[0], top - bh / 2 + 3);
        ctx.font = '12px ' + UI_FONT;
      });
    }

    drawLegend(ctx) {
      const items = [['安全 <50%', C.safe], ['注意 50~80%', C.warn],
        ['危险 80~100%', C.high], ['失效 ≥100%', C.fail]];
      ctx.font = '10px ' + UI_FONT;
      ctx.textAlign = 'left';
      let lx = 14, ly = 20;
      items.forEach(function (it) {
        ctx.fillStyle = it[1];
        ctx.fillRect(lx, ly - 6, 10, 10);
        ctx.fillStyle = C.text;
        ctx.fillText(it[0], lx + 14, ly + 3);
        lx += 14 + ctx.measureText(it[0]).width + 16;
      });
    }

    drawBanner(ctx) {
      if (!this.banner) return;
      ctx.font = 'bold 18px ' + UI_FONT;
      ctx.fillStyle = this.collapsed ? C.fail : C.text;
      ctx.textAlign = 'center';
      ctx.fillText(this.banner, this.canvas.clientWidth / 2, 28);
    }

    /** 未求解时的编辑几何：按截面类型着色（梁=实线，二力杆=虚线） */
    drawEditorGeometry(ctx, mapper) {
      const cs = this.editor;
      const used = [];
      cs.members.forEach(function (m) {
        const g1 = cs.nodes[m.i], g2 = cs.nodes[m.j];
        const a = mapper.toScreen(g1[0], g1[1]);
        const b = mapper.toScreen(g2[0], g2[1]);
        ctx.strokeStyle = Custom.SECTION_COLORS[m.section] || C.steel;
        ctx.lineWidth = m.kind === Custom.MEMBER_FRAME ? 3.0 : 2.0;
        ctx.setLineDash(m.kind === Custom.MEMBER_TRUSS ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
        if (used.indexOf(m.section) < 0) used.push(m.section);
      });
      // 左上角图例
      ctx.font = '10px ' + UI_FONT;
      ctx.textAlign = 'left';
      let ly = 20;
      used.forEach(function (kind) {
        ctx.strokeStyle = Custom.SECTION_COLORS[kind] || C.steel;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(14, ly); ctx.lineTo(34, ly); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(Custom.SECTION_SHORT_LABELS[kind] || kind, 38, ly + 4);
        ly += 15;
      });
      ctx.fillStyle = C.axis;
      ctx.fillText('实线 = 桥面 / 弦杆 / 拱圈（传弯矩），虚线 = 腹杆 / 吊杆（仅轴力）', 14, ly + 4);
    }

    /** 编辑器叠加层：节点、编号、加载点、支座、橡皮筋、鼠标落点 */
    drawEditorOverlay(ctx, mapper) {
      const cs = this.editor;

      // 待连杆件的橡皮筋
      if (this.pendingNode !== null && this.pendingNode < cs.nodes.length && this.hover) {
        const a = cs.nodes[this.pendingNode];
        const p1 = mapper.toScreen(a[0], a[1]);
        const p2 = mapper.toScreen(this.hover[0], this.hover[1]);
        ctx.strokeStyle = C.high;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 支座（未求解时补画；有解时由模型画过）
      if (!this.analysis) {
        const self = this;
        Object.keys(cs.supports).forEach(function (key) {
          const node = parseInt(key, 10);
          if (!(node >= 0 && node < cs.nodes.length)) return;
          const kind = cs.supports[key];
          const p = mapper.toScreen(cs.nodes[node][0], cs.nodes[node][1]);
          self.drawSupport(ctx, p,
            kind === Custom.SUPPORT_PIN || kind === Custom.SUPPORT_FIXED,
            kind !== Custom.SUPPORT_NONE, kind === Custom.SUPPORT_FIXED);
        });
      }

      // 加载点：节点下方小方块
      ctx.fillStyle = '#90caf9';
      ctx.strokeStyle = '#1565c0';
      ctx.lineWidth = 1;
      cs.loadNodes.forEach(function (n) {
        if (!(n >= 0 && n < cs.nodes.length)) return;
        const p = mapper.toScreen(cs.nodes[n][0], cs.nodes[n][1]);
        ctx.beginPath(); ctx.rect(p[0] - 4, p[1] + 6, 8, 8); ctx.fill(); ctx.stroke();
      });

      // 节点圆点 + 编号
      ctx.font = '10px ' + UI_FONT;
      ctx.textAlign = 'left';
      cs.nodes.forEach(function (n, k) {
        const p = mapper.toScreen(n[0], n[1]);
        const pending = k === this.pendingNode;
        const r = pending ? 7.0 : 4.5;
        ctx.strokeStyle = pending ? C.high : C.node;
        ctx.fillStyle = pending ? C.high : '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#78909c';
        ctx.fillText(String(k), p[0] + r + 2, p[1] - r);
      }, this);

      // 鼠标指向高亮：让"点这里会发生什么"一目了然
      const hl = this.editMode === MODE_DELETE ? C.fail : C.high;
      if (this.hoverMember !== null && this.hoverMember < cs.members.length) {
        const m = cs.members[this.hoverMember];
        const g1 = cs.nodes[m.i], g2 = cs.nodes[m.j];
        if (g1 && g2) {
          const a = mapper.toScreen(g1[0], g1[1]);
          const b = mapper.toScreen(g2[0], g2[1]);
          ctx.save();
          ctx.strokeStyle = hl;
          ctx.globalAlpha = 0.32;
          ctx.lineWidth = 8;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
          ctx.restore();
        }
      }
      if (this.hoverNode !== null && this.hoverNode < cs.nodes.length) {
        const n = cs.nodes[this.hoverNode];
        const p = mapper.toScreen(n[0], n[1]);
        ctx.save();
        ctx.strokeStyle = hl;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p[0], p[1], 8.5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = hl;
        ctx.beginPath(); ctx.arc(p[0], p[1], 8.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // 鼠标落点提示
      if (this.hover && this.editMode === MODE_NODE) {
        const p = mapper.toScreen(this.hover[0], this.hover[1]);
        ctx.strokeStyle = C.high;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(p[0] - 8, p[1]); ctx.lineTo(p[0] + 8, p[1]);
        ctx.moveTo(p[0], p[1] - 8); ctx.lineTo(p[0], p[1] + 8);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  PB.BridgeView = BridgeView;
  PB.BridgeViewConst = {
    MODE_NODE: MODE_NODE, MODE_MEMBER: MODE_MEMBER, MODE_SUPPORT: MODE_SUPPORT,
    MODE_LOAD: MODE_LOAD, MODE_DELETE: MODE_DELETE,
    EDIT_MODES: EDIT_MODES, MODE_LABELS: MODE_LABELS, MODE_HINTS: MODE_HINTS,
    utilizationColor: utilizationColor,
  };
})(globalThis.PB = globalThis.PB || {});

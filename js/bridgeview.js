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
    constructor(points, width, height, shake) {
      shake = shake || [0, 0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      points.forEach(function (p) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      });
      const minH = 0.18 * (x1 - x0) || 0.02;
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
      this.x0 = x0; this.x1 = x1; this.y0 = y0; this.y1 = y1;
      this.scale = s;
      this.ox = mx + (width - 2 * mx - s * (x1 - x0)) / 2;
      this.oy = my + (height - 2 * my - s * (y1 - y0)) / 2;
      this.dx = shake[0]; this.dy = shake[1];
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
      const pts = this.worldPoints();
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!pts.length || w < 60 || h < 60) return null;
      return new Mapper(pts, w, h, this.shake);
    }

    // ---- 鼠标交互 ----
    bindEvents() {
      const self = this;
      const pos = function (ev) {
        const r = self.canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      };

      this.canvas.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        const mapper = self.mapper();
        if (!mapper) return;
        const p = pos(ev);
        const w = mapper.fromScreen(p[0], p[1]);
        const wx = w[0], wy = w[1];
        if (self.editor) {
          const tol = mapper.pixelTolerance() * 1.6;
          const node = self.editor.nodeAt(wx, wy, tol);
          const member = self.editor.memberAt(wx, wy, tol);
          const mode = self.editMode;
          if (mode === MODE_NODE) {
            if (node !== null) {
              self.dragNode = node;
              self.frozen = mapper;          // 冻结视图，拖动时坐标不跟着变
            } else if (self.onEmptyClick) {
              const s = self.snap(wx, wy);
              self.onEmptyClick(s[0], s[1]);
            }
          } else if (mode === MODE_MEMBER) {
            if (node !== null && self.onNodeClick) self.onNodeClick(node);
            else if (member !== null && self.onMemberClick) self.onMemberClick(member);
          } else if (mode === MODE_DELETE) {
            if (node !== null && self.onNodeClick) self.onNodeClick(node);
            else if (member !== null && self.onMemberClick) self.onMemberClick(member);
          } else if (node !== null && self.onNodeClick) {
            self.onNodeClick(node);          // 支座 / 加载点
          }
          return;
        }
        // 非编辑态：点击也不做别的
      });

      this.canvas.addEventListener('mousemove', function (ev) {
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

      this.canvas.addEventListener('mouseup', function (ev) {
        if (ev.button !== 0) return;
        if (self.dragNode !== null) {
          const node = self.dragNode;
          self.dragNode = null;
          self.frozen = null;
          if (self.onNodeDrop) self.onNodeDrop(node);
          self.draw();
        }
      });

      this.canvas.addEventListener('mouseleave', function () {
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
      if (!this.editor) { this.canvas.style.cursor = 'default'; return; }
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
        ctx.fillText(this.editor ? '在画布上点击放置第一个节点' : '暂无结构', w / 2, h / 2);
        return;
      }

      if (this.editor) this.drawGrid(ctx, mapper);
      this.drawGround(ctx, mapper);
      if (this.analysis) this.drawAnalysis(ctx, mapper);
      else if (this.editor) this.drawEditorGeometry(ctx, mapper);
      if (this.editor) this.drawEditorOverlay(ctx, mapper);
      this.drawBanner(ctx);
    }

    drawGrid(ctx, mapper) {
      if (!this.editor || !(this.grid > 0)) return;
      if (this.grid * mapper.scale < 7) return;
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      const xStart = Math.ceil(mapper.x0 / this.grid) * this.grid;
      for (let x = xStart; x <= mapper.x1; x += this.grid) {
        const a = mapper.toScreen(x, mapper.y0), b = mapper.toScreen(x, mapper.y1);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      const yStart = Math.ceil(mapper.y0 / this.grid) * this.grid;
      for (let y = yStart; y <= mapper.y1; y += this.grid) {
        const a = mapper.toScreen(mapper.x0, y), b = mapper.toScreen(mapper.x1, y);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }

    /** 地面：支座所在高度画一条基准线 + 斜线阴影 */
    drawGround(ctx, mapper) {
      let gy = null, minX = Infinity, maxX = -Infinity;
      const pts = this.worldPoints();
      if (!pts.length) return;
      pts.forEach(function (p) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
      });
      const supports = this.analysis ? this.analysis.model.supports : [];
      if (this.editor) {
        const ys = Object.keys(this.editor.supports).map((k) => this.editor.nodes[k][1]);
        if (ys.length) gy = Math.max.apply(null, ys);
      } else if (supports.length) {
        const ys = supports.map((s) => this.analysis.model.nodes[s.node].y);
        gy = Math.max.apply(null, ys);
      }
      if (gy === null) return;
      const span = maxX - minX;
      const a = mapper.toScreen(minX - 0.03 * span, gy);
      const b = mapper.toScreen(maxX + 0.03 * span, gy);
      ctx.strokeStyle = C.steel;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = '#b0bec5';
      ctx.lineWidth = 1;
      for (let x = a[0]; x <= b[0]; x += 9) {
        ctx.beginPath(); ctx.moveTo(x, a[1]); ctx.lineTo(x - 7, a[1] + 9); ctx.stroke();
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
        const label = model.elements[i].label || '';
        const main = (label === 'deck' || label === 'top-chord' || label === 'bottom-chord'
          || label.indexOf('arch') === 0);
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
      ctx.fillText('（实线=传弯矩的梁，虚线=仅轴力的二力杆）', 14, ly + 4);
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

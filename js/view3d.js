/**
 * 3D 预览 / 编辑（three.js r149，本地 UMD 构建，无构建步骤、无网络请求）。
 *
 * 与 bridgeview.js 的接口完全对称，app.js 用同一套回调驱动两个视图：
 *   showAnalysis(a, opts)                       把分析结果画成 3D
 *   setEditorState(editor, mode, pending, grid) 自建结构的 3D 编辑状态
 * 世界坐标直接用模型坐标：x 沿跨向右、y 向上、z 为桥面宽度方向；编辑面固定为 z = 0。
 *
 * 相机是自研的简易轨道控制器（左键转 / 滚轮缩放 / Shift 或右键平移 / 双击复位），
 * 不用 examples/jsm 里的 OrbitControls —— 那是 ESM，file:// 下会被 CORS 拦。
 */
(function (PB) {
  'use strict';

  const THREE = typeof globalThis !== 'undefined' ? globalThis.THREE : null;
  const Custom = PB.Custom;
  const MODE = PB.BridgeViewConst;

  const UI_FONT = '"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

  const C = {
    bg: '#ffffff', ground: '#eef2f4', grid: '#dbe3e7', gridCenter: '#c3ccd3',
    undeformed: '#c3ccd3', steel: '#546e7a', node: '#37474f',
    safe: '#2e7d32', warn: '#f9a825', high: '#ef6c00', fail: '#c62828',
    load: '#8d6e63', loadFill: '#a1887f', loadEdge: '#5d4037',
    pick: '#90caf9', pickEdge: '#1565c0', text: '#263238',
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  class BridgeView3D {
    constructor(canvas) {
      this.canvas = canvas;
      this.ok = false;
      this.reason = '';
      this.visible = false;

      // ---- 与 BridgeView 对齐的状态 ----
      this.analysis = null;
      this.amplify = true;
      this.collapsed = false;
      this.banner = '';
      this.deckWidth = 0.15;          // 由 app.js 从「桥面宽度」滑块同步
      this.defaultSpan = 0.30;        // 空画布时的默认工作区宽度（由 app.js 同步）
      this.twin = true;              // 双侧示意：平面模型按桥宽镜像成两片
      this.twoSided = false;
      this.halfW = 0.075;
      this.editor = null;
      this.editMode = MODE.MODE_NODE;
      this.pendingNode = null;
      this.grid = 0.01;
      this.hoverNode = null;
      this.hoverMember = null;

      // ---- 回调（由 app.js 注入，签名与 2D 视图一致）----
      this.onEmptyClick = null;
      this.onNodeClick = null;
      this.onMemberClick = null;
      this.onMemberDoubleClick = null;
      this.onNodeMove = null;
      this.onNodeDrop = null;

      // 相机（球坐标绕 target）
      this.target = null;
      this.dist = 1.0;
      this.theta = 0.62;
      this.phi = 1.02;
      this.home = null;               // 双击复位用

      // 交互临时状态
      this.dragNode = null;
      this.dragging = false;
      this._down = null;
      this._pointers = new Map();     // 按下的指针（触屏双指缩放用）
      this._pinch = null;
      this._pendingRender = false;

      this.init();
    }

    // ------------------------------------------------------------------
    // 初始化
    // ------------------------------------------------------------------
    init() {
      if (!THREE) { this.reason = 'three.js 没加载（vendor/three.min.js 缺失）'; return; }
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      } catch (err) {
        this.reason = '无法创建 WebGL 上下文：' + (err && err.message ? err.message : err);
        return;
      }
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer = renderer;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(C.bg);
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.005, 100);

      this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6e9, 0.95));
      const key = new THREE.DirectionalLight(0xffffff, 0.7);
      key.position.set(1.0, 2.0, 1.4);
      this.scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.25);
      fill.position.set(-1.2, 0.8, -1.0);
      this.scene.add(fill);

      this.root = new THREE.Group();          // 桥体
      this.helpers = new THREE.Group();       // 地面 / 网格 / 支座墩
      this.picks = new THREE.Group();         // 拾取辅助（不可见）
      this.scene.add(this.root);
      this.scene.add(this.helpers);
      this.scene.add(this.picks);

      this.nodePicks = [];
      this.memberPicks = [];
      this.raycaster = new THREE.Raycaster();
      this.editPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);   // z = 0

      this.buildGround(0.30, -0.01);
      this.resetCamera(0.30, 0.05);
      this.bindEvents();
      this.ok = true;
      this.resize();
    }

    /** 地面 + 网格 + 支座墩（随结构尺寸重建） */
    buildGround(span, ymin) {
      const old = this.helpers;
      this.scene.remove(old);
      disposeGroup(old);
      const g = new THREE.Group();
      this.helpers = g;
      this.scene.add(g);

      const size = Math.max(span * 3.2, 0.4);
      // 地面要落在"放大后最大挠度"之下：自动放大把最大挠度映射到跨长的 10%，
      // 只留 2% 余量的话，变形后的桥会沉到地面以下被地板挡住。这里留 13%，
      // 保证桥永远在地面之上（也就永远不会被地面网格遮挡）。
      const groundY = ymin - Math.max(span * 0.13, 0.012);
      this.groundY = groundY;

      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({ color: C.ground, roughness: 1.0, metalness: 0.0 }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(span * 0.5, groundY, 0);
      // 地面只当参照背景：不写深度、最先绘制，任何情况下都不会挡住桥
      //（单层纸这种"真挠度就有好几米"的极端情况，桥会穿过地面，但仍然看得见）
      plane.material.depthWrite = false;
      plane.renderOrder = -10;
      g.add(plane);

      // 网格线不写深度、且最先绘制：即便低角度看过去，线也不会切在桥体前面
      const grid = new THREE.GridHelper(size, 24, C.gridCenter, C.grid);
      grid.position.set(span * 0.5, groundY + 1e-4, 0);
      if (grid.material) {
        grid.material.opacity = 0.85;
        grid.material.transparent = true;
        grid.material.depthWrite = false;
      }
      grid.renderOrder = -1;
      g.add(grid);
    }

    resetCamera(span, top) {
      const cx = span * 0.5;
      const cy = top * 0.5;
      this.target = new THREE.Vector3(cx, cy, 0);
      this.dist = Math.max(span * 2.1, 0.25);
      this.theta = 0.62;
      this.phi = 1.02;
      this.home = { target: this.target.clone(), dist: this.dist, theta: this.theta, phi: this.phi };
      this.updateCamera();
    }

    /** 按当前结构（模型或编辑器几何）自动取景 */
    fitCamera() {
      const box = this.worldExtent();
      if (!box) return false;
      const span = Math.max(box.maxX - box.minX, 1e-3);
      const top = Math.max(box.maxY, 1e-3);
      this.target = new THREE.Vector3((box.minX + box.maxX) / 2, Math.max(box.maxY, 0) * 0.5, 0);
      this.dist = Math.max(span * 2.1, 0.25);
      if (!this.home) this.home = {};
      this.home = { target: this.target.clone(), dist: this.dist, theta: 0.62, phi: 1.02 };
      this.updateCamera();
      return true;
    }

    worldExtent() {
      const pts = this.worldPoints();
      if (!pts.length) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      pts.forEach(function (p) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      });
      return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
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

    // ------------------------------------------------------------------
    // 对外接口（与 BridgeView 同名）
    // ------------------------------------------------------------------
    setVisible(flag) {
      this.visible = !!flag;
      if (this.visible) { this.resize(); this.renderNow(); }
    }

    setEditorState(editor, mode, pending, grid) {
      this.editor = editor;
      if (mode) this.editMode = mode;
      this.pendingNode = (pending === undefined) ? this.pendingNode : pending;
      if (grid !== undefined) this.grid = grid;
      this.updateCursor();
      this.build();
    }

    showAnalysis(analysis, opts) {
      opts = opts || {};
      this.analysis = analysis;
      if (opts.amplify !== undefined) this.amplify = opts.amplify;
      if (opts.collapsed !== undefined) this.collapsed = opts.collapsed;
      if (opts.banner !== undefined) this.banner = opts.banner;
      this.build();
    }

    clearHover() {
      this.hoverNode = null;
      this.hoverMember = null;
    }

    resize() {
      if (!this.ok) return;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (w < 8 || h < 8) return;
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderNow();
    }

    // ------------------------------------------------------------------
    // 场景构建
    // ------------------------------------------------------------------
    /** 按照当前 analysis / editor 重建 3D 场景（出错只降级，不影响 2D 主流程） */
    build() {
      if (!this.ok) return;
      try {
        this.buildScene();
      } catch (err) {
        this.ok = false;
        this.reason = '3D 场景构建失败：' + (err && err.message ? err.message : err);
        if (window.console && console.error) console.error('[view3d]', err);
      }
    }

    buildScene() {
      const a = this.analysis;
      const span = a ? Math.max(a.design.span, 1e-3) : this.editorSpan();
      let ymin = 0;
      const pts = this.worldPoints();
      if (pts.length) {
        ymin = Math.min.apply(null, pts.map(function (p) { return p[1]; }));
      }
      // 物理模型是平面模型（只有 x-y 一片，没有任何 z 信息），所以 3D 里把这片
      // 按桥面宽度镜像成两片、中间用桥面连起来 —— 这才是真实纸桥的搭法。
      // 梁式方案（平板/多层/折叠梁/圆管）本身就是一根整宽梁，不镜像。
      const structure = a ? a.design.structure : 'custom';
      const beamLike = ['flat', 'laminate', 'tube', 'folded'].indexOf(structure) >= 0;
      this.halfW = Math.max(this.deckWidth, 0.01) / 2;
      this.twoSided = !!(this.twin && !beamLike);
      this.buildGround(span, ymin);
      this.clearRoot();
      this.amp = this.amplification();

      if (a) this.buildAnalysis(a);
      else if (this.editor) this.buildEditorGeometry();

      this.buildEditorOverlay();
      // 首次或跨长变化明显时自动取景；之后保留用户转好的视角
      if (!this._fittedSpan || Math.abs(span - this._fittedSpan) / span > 0.2) {
        this._fittedSpan = span;
        this.fitCamera();
      }
      this.updateCursor();
      this.renderNow();
    }

    editorSpan() {
      if (this.editor && this.editor.nodes.length) {
        const s = this.editor.span();
        if (s > 0) return s;
      }
      return Math.max(this.defaultSpan || 0.30, 0.05);
    }

    clearRoot() {
      this.scene.remove(this.root);
      disposeGroup(this.root);
      this.root = new THREE.Group();
      this.scene.add(this.root);

      this.scene.remove(this.picks);
      disposeGroup(this.picks);
      this.picks = new THREE.Group();
      this.scene.add(this.picks);
      this.nodePicks = [];
      this.memberPicks = [];
      this.bannerSprite = null;
    }

    /** 自动放大系数（与 2D 视图同一公式） */
    amplification() {
      if (!this.amplify || !this.analysis) return 1.0;
      const a = this.analysis;
      const defl = Math.abs(a.result.maxDeflection);
      if (!(defl > 1e-12)) return 1.0;
      let worldLen = 0, minX = Infinity;
      a.model.nodes.forEach(function (n) {
        worldLen = Math.max(worldLen, n.x);
        minX = Math.min(minX, n.x);
      });
      worldLen -= minX;
      return clamp(0.10 * worldLen / defl, 1.0, 2000.0);
    }

    nodePosition(index, deformed) {
      const a = this.analysis;
      const n = a.model.nodes[index];
      if (!deformed || !a.result) return new THREE.Vector3(n.x, n.y, 0);
      const d = a.result.displacements[index] || [0, 0, 0];
      const amp = this.amp || 1.0;
      return new THREE.Vector3(n.x + amp * d[0], n.y + amp * d[1], 0);
    }

    /**
     * 一根构件在 3D 里画多大 —— 横向尺寸是最容易弄错的地方。
     *
     * 物理模型里"两端都是加载点"的杆件会被标成 deck（那是施加载荷的约定，桁架建模时
     * 也把下弦叫 deck）。但桥面宽度只对"整根梁就是桥面"的梁式方案成立：平板/多层/
     * 折叠梁/圆管这几种，桥面本身就是铺满桥宽的一根梁；而桁架、拱、自建结构里的每根
     * 杆件在真实结构里都是一条纸条，若也用桥宽，一根细杆就会被画成 15 cm 宽的板。
     * 所以分三类：
     *   1) 板式桥面（单层纸/多层纸）→ 桥面宽度：就是一张纸铺满桥宽；
     *   2) 梁式方案的桥面（折叠梁/圆管）→ 桥面宽度：整根梁的宽度就是桥宽；
     *   3) 其余杆件 → 取截面高量级的窄条，并按结构高度、跨长与自身长度夹紧。
     *
     * 第 3 类里的"结构高度"很关键：桁架桥/拱桥默认参数下，桁高和截面高是同一个
     * 滑块（都 40 mm），照截面高画就会出现"两块厚板夹一条缝"。所以杆件截面再限制到
     * 结构高度的 28% 以内 —— 只影响观感，模型算出来的 A / I 一点没变。
     */
    memberSize(sec, isDeck, len, span, structure, height, twoSided) {
      const key = sec && sec.key;
      const depth = (sec && sec.depth) || 0;
      const beamLike = ['flat', 'laminate', 'tube', 'folded'].indexOf(structure) >= 0;
      const thin = beamLike ? Infinity : 0.28 * Math.max(height || 0, span * 0.10);
      const lenCap = Math.max(len * 1.5, 0.002);
      let h, b;
      if (isDeck && (twoSided || beamLike || key === 'solid' || key === 'laminate')) {
        // 桥面那一条：按桥宽拉通。双侧示意时它正好把两片桁架连起来；梁式方案里
        // 它本身就是铺满桥宽的整根梁 / 整张纸。厚度仍受结构高度限制。
        h = clamp(depth, 0.0012, Math.min(span * 0.30, twoSided ? thin : Infinity));
        b = clamp(this.deckWidth, 0.004, span * 0.75);
      } else {
        const cap = Math.min(span * 0.30, thin, lenCap);
        h = clamp(depth, 0.0015, cap);
        b = clamp(depth, 0.003, cap);
      }
      return { h: h, b: b, r: clamp(depth / 2, 0.0012, Math.min(span * 0.30, thin) / 2) };
    }

    /** 双侧示意时的 z 偏移：平面模型按桥宽镜像成两片，否则只画中间那一片 */
    twinOffsets() {
      return this.twoSided ? [this.halfW, -this.halfW] : [0];
    }

    /** 是不是"最底下那一排"（自建结构里被误标 deck 的高处杆件不该被拉通成整宽板） */
    isDeckLevel(model, el, minY) {
      return Math.abs(model.nodes[el.i].y - minY) < 1e-6
        && Math.abs(model.nodes[el.j].y - minY) < 1e-6;
    }

    buildAnalysis(a) {
      const model = a.model, report = a.report;
      const self = this;
      const deck = {};
      (model.meta.deck_elements || []).forEach(function (i) { deck[i] = true; });

      const span = Math.max(a.design.span, 1e-3);
      const structure = a.design.structure;
      let minYN = Infinity, maxYN = -Infinity;
      model.nodes.forEach(function (n) {
        minYN = Math.min(minYN, n.y);
        maxYN = Math.max(maxYN, n.y);
      });
      const height = maxYN - minYN;                 // 结构自身的竖向尺度（未变形）
      const zs = this.twinOffsets();

      // 未变形轮廓（浅灰细线，作参照）
      const linePts = [];
      for (let i = 0; i < model.elements.length; i++) {
        const g = model.elementGeometry(i);
        zs.forEach(function (z) {
          linePts.push(new THREE.Vector3(g.xi, g.yi, z));
          linePts.push(new THREE.Vector3(g.xi + g.L * g.c, g.yi + g.L * g.s, z));
        });
      }
      if (linePts.length) {
        const geo = new THREE.BufferGeometry().setFromPoints(linePts);
        const mat = new THREE.LineBasicMaterial({ color: C.undeformed, transparent: true, opacity: 0.9 });
        this.root.add(new THREE.LineSegments(geo, mat));
      }

      // 变形后杆件（按利用率着色）
      for (let i = 0; i < model.elements.length; i++) {
        const el = model.elements[i];
        const ur = report.utilizationOf(i);
        const p1 = this.nodePosition(el.i, true);
        const p2 = this.nodePosition(el.j, true);
        const sec = el.section || {};
        const deckLevel = !!deck[i] && this.isDeckLevel(model, el, minYN);
        const size = this.memberSize(sec, deckLevel, p1.distanceTo(p2), span, structure, height,
          this.twoSided);
        const color = MODE.utilizationColor(ur);
        // 桥面那一条拉通成整宽（连接两片），其余杆件在两侧各画一片
        const zlist = (this.twoSided && !deckLevel) ? zs : [0];
        const round = el.kind === 'truss';        // 二力杆画圆杆，和梁式构件一眼分得开
        zlist.forEach(function (z) {
          const mesh = self.addBar(new THREE.Vector3(p1.x, p1.y, z),
            new THREE.Vector3(p2.x, p2.y, z), {
              sectionKey: sec.key, h: size.h, b: size.b, radius: size.r, color: color,
              round: round,
            });
          if (!mesh) return;
          mesh.userData.element = i;
          if (self.collapsed && ur >= 1.0) {
            mesh.material.emissive = new THREE.Color(C.fail);
            mesh.material.emissiveIntensity = 0.35;
          }
          self.memberPicks.push(mesh);
        });
      }

      // 支座：垫墩 + 符号（双侧示意时两端各两个）
      model.supports.forEach(function (sup) {
        const n = model.nodes[sup.node];
        zs.forEach(function (z) {
          self.addSupport(n.x, n.y, sup.fixUx, sup.fixUy, sup.fixRz, z);
        });
      });

      // 砝码
      (model.meta.load_points || []).forEach(function (pt) {
        self.addWeight(pt[0], pt[1], pt[2]);
      });

      this.addBanner();
    }

    /** 只有编辑器数据（还没算出结果）时：用截面颜色画杆件 */
    buildEditorGeometry() {
      const cs = this.editor;
      const self = this;
      // 最低一排横杆当桥面；双侧示意时桥面拉通成整宽，其余杆件镜像到两侧
      let ymin = Infinity, ymax = -Infinity;
      cs.nodes.forEach(function (n) { ymin = Math.min(ymin, n[1]); ymax = Math.max(ymax, n[1]); });
      const span = Math.max(this.editorSpan(), 1e-3);
      const height = Math.max(ymax - ymin, 0);
      const zs = this.twinOffsets();
      const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
      cs.members.forEach(function (m, mi) {
        const a = cs.nodes[m.i], b = cs.nodes[m.j];
        if (!a || !b) return;
        const decky = Math.abs(a[1] - ymin) < 1e-6 && Math.abs(b[1] - ymin) < 1e-6;
        p1.set(a[0], a[1], 0);
        p2.set(b[0], b[1], 0);
        const sec = { key: m.section, depth: self.sectionDepth(m.section) };
        const size = self.memberSize(sec, decky, p1.distanceTo(p2), span, 'custom', height,
          self.twoSided);
        const zlist = (self.twoSided && !decky) ? zs : [0];
        zlist.forEach(function (z) {
          const mesh = self.addBar(new THREE.Vector3(p1.x, p1.y, z),
            new THREE.Vector3(p2.x, p2.y, z), {
              h: size.h, b: size.b, radius: size.r,
              sectionKey: m.section,
              round: m.kind === Custom.MEMBER_TRUSS,   // 二力杆画圆杆
              color: Custom.SECTION_COLORS[m.section] || C.steel,
            });
          if (mesh) {
            mesh.userData.member = mi;
            self.memberPicks.push(mesh);
          }
        });
      });
      this.addBanner();
    }

    /** 编辑器叠加：节点球、编号、加载点、待连橡皮筋、悬停高亮 */
    buildEditorOverlay() {
      if (!this.editor) return;
      const cs = this.editor;
      const self = this;
      const r = Math.max(this.editorSpan() * 0.018, 0.0035);
      const pickR = Math.max(r * 2.2, 0.009);
      const zs = this.twinOffsets();          // 双侧示意时节点球、拾取球都在两片上

      cs.nodes.forEach(function (n, k) {
        const pending = k === self.pendingNode;
        const hovered = k === self.hoverNode;
        const hlColor = self.editMode === MODE.MODE_DELETE ? C.fail : C.high;
        const color = pending ? C.high : (hovered ? hlColor : C.node);

        zs.forEach(function (z) {
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(hovered ? r * 1.5 : r, 14, 10),
            new THREE.MeshStandardMaterial({
              color: color, roughness: 0.55, metalness: 0.05,
              emissive: new THREE.Color(hovered || pending ? color : '#000000'),
              emissiveIntensity: hovered || pending ? 0.45 : 0,
            }));
          dot.position.set(n[0], n[1], z);
          self.root.add(dot);

          // 透明放大球，专门给射线拾取用（和可见球同 z，点哪儿中哪儿）
          const pick = new THREE.Mesh(
            new THREE.SphereGeometry(pickR, 8, 6),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
          pick.position.copy(dot.position);
          pick.userData.node = k;
          self.picks.add(pick);
          self.nodePicks.push(pick);
        });

        const label = self.makeLabel(String(k), { size: r * 2.4, color: '#607d8b', bg: 'rgba(255,255,255,.82)' });
        label.position.set(n[0] + r * 2.6, n[1] + r * 2.2, zs[0]);
        self.root.add(label);
      });

      // 加载点：节点上方小方块（与 2D 一致）
      cs.loadNodes.forEach(function (n) {
        if (!(n >= 0 && n < cs.nodes.length)) return;
        const p = cs.nodes[n];
        const s = r * 1.7;
        zs.forEach(function (z) {
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(s, s, s),
            new THREE.MeshStandardMaterial({ color: C.pick, roughness: 0.7, metalness: 0.05 }));
          box.position.set(p[0], p[1] + r * 2.2, z);
          self.root.add(box);
        });
      });

      // 支座（无分析结果时补画；有结果时由 buildAnalysis 画过）
      if (!this.analysis) {
        Object.keys(cs.supports).forEach(function (key) {
          const node = parseInt(key, 10);
          if (!(node >= 0 && node < cs.nodes.length)) return;
          const kind = cs.supports[key];
          if (kind === Custom.SUPPORT_NONE) return;
          const p = cs.nodes[node];
          zs.forEach(function (z) {
            self.addSupport(p[0], p[1],
              kind === Custom.SUPPORT_PIN || kind === Custom.SUPPORT_FIXED,
              kind !== Custom.SUPPORT_FIXED && kind !== Custom.SUPPORT_PIN || kind === Custom.SUPPORT_ROLLER,
              kind === Custom.SUPPORT_FIXED, z);
          });
        });
      }

      // 待连杆件的橡皮筋
      if (this.pendingNode !== null && this.hoverNode !== null && this.hoverNode !== this.pendingNode) {
        const a = cs.nodes[this.pendingNode], b = cs.nodes[this.hoverNode];
        if (a && b) {
          zs.forEach(function (z) {
            const geo = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(a[0], a[1], z), new THREE.Vector3(b[0], b[1], z)]);
            self.root.add(new THREE.Line(geo,
              new THREE.LineBasicMaterial({ color: C.high, transparent: true, opacity: 0.9 })));
          });
        }
      }

      // 悬停的杆件：加一层发光感（双侧示意时两片一起亮）
      if (this.hoverMember !== null && this.memberPicks.length) {
        const hl = this.editMode === MODE.MODE_DELETE ? C.fail : C.high;
        this.memberPicks.forEach(function (m) {
          if (m.userData.member !== self.hoverMember && m.userData.element !== self.hoverMember) return;
          m.material.emissive = new THREE.Color(hl);
          m.material.emissiveIntensity = 0.55;
        });
      }
    }

    /** 编辑器模式下的截面尺寸猜测（还没有分析结果时用） */
    sectionDepth(kind) {
      const guess = { solid: 0.0015, laminate: 0.001, tube: 0.03, folded: 0.04 };
      return guess[kind] || 0.02;
    }

    /** 一根杆件：方管（或圆管）盒子，沿两端点连线摆放 */
    addBar(p1, p2, opts) {
      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = dir.length();
      if (!(len > 1e-9)) return null;
      // 圆管与"二力杆"都画成圆柱（二力杆细一点），方杆留给梁式构件
      const circle = opts.round || opts.sectionKey === 'tube';
      let geo;
      if (circle) {
        const r = opts.round
          ? Math.max(Math.min(opts.h, opts.b) * 0.42, 0.0015)
          : Math.max(opts.radius || 0.01, 0.0015);
        geo = new THREE.CylinderGeometry(r, r, len, 12, 1, true);
      } else {
        geo = new THREE.BoxGeometry(len, Math.max(opts.h, 0.0012), Math.max(opts.b, 0.002));
      }
      const mat = new THREE.MeshStandardMaterial({
        color: opts.color, roughness: 0.88, metalness: 0.04,
        side: circle ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(p1).addScaledVector(dir, 0.5);
      const axis = circle ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      mesh.quaternion.setFromUnitVectors(axis, dir.clone().normalize());
      this.root.add(mesh);
      return mesh;
    }

    addSupport(x, y, fixUx, fixUy, fixRz, z) {
      const self = this;
      const span = this.editorSpan();
      const pedW = Math.max(span * 0.02, 0.006);
      const top = y;
      const bottom = this.groundY;
      const h = Math.max(top - bottom, 0.002);
      const zz = z || 0;
      const mat = new THREE.MeshStandardMaterial({ color: '#b0bec5', roughness: 0.95, metalness: 0.02 });

      const ped = new THREE.Mesh(new THREE.BoxGeometry(pedW, h, pedW), mat);
      ped.position.set(x, bottom + h / 2, zz);
      this.root.add(ped);

      if (fixRz && fixUx && fixUy) {                    // 固支：方块
        const cube = new THREE.Mesh(new THREE.BoxGeometry(pedW * 1.6, pedW * 1.6, pedW * 1.6),
          new THREE.MeshStandardMaterial({ color: '#cfd8dc', roughness: 0.9 }));
        cube.position.set(x, top, zz);
        this.root.add(cube);
        return;
      }
      const cone = new THREE.Mesh(new THREE.ConeGeometry(pedW * 0.85, pedW * 1.5, 4),
        new THREE.MeshStandardMaterial({ color: '#cfd8dc', roughness: 0.9 }));
      cone.position.set(x, top, zz);
      cone.rotation.y = Math.PI / 4;
      this.root.add(cone);

      if (!fixUx) {                                     // 滚动铰：底下加两个小轮
        [-1, 1].forEach(function (s) {
          const wheel = new THREE.Mesh(new THREE.SphereGeometry(pedW * 0.28, 10, 8), mat);
          wheel.position.set(x + s * pedW * 0.45, top - pedW * 1.3, zz);
          self.root.add(wheel);
        });
      }
    }

    addWeight(x, y, force) {
      if (!(force > 0)) return;
      const G = PB.Materials.G;
      const span = this.editorSpan();
      const size = clamp(span * 0.06 * Math.sqrt(force) + span * 0.02, span * 0.03, span * 0.18);
      const y0 = y + size * 0.9;

      const box = new THREE.Mesh(
        new THREE.BoxGeometry(size, size * 0.85, size),
        new THREE.MeshStandardMaterial({ color: C.loadFill, roughness: 0.8, metalness: 0.05 }));
      box.position.set(x, y0 + size * 0.42, 0);
      this.root.add(box);

      // 向下的箭头
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(size * 0.06, 0.0008), Math.max(size * 0.06, 0.0008),
          Math.max(y0 - y - size * 0.1, 0.002), 8),
        new THREE.MeshStandardMaterial({ color: C.loadEdge, roughness: 0.8 }));
      shaft.position.set(x, (y0 + y) / 2, 0);
      this.root.add(shaft);
      const head = new THREE.Mesh(new THREE.ConeGeometry(size * 0.16, size * 0.3, 12),
        new THREE.MeshStandardMaterial({ color: C.loadEdge, roughness: 0.8 }));
      head.position.set(x, y + size * 0.14, 0);
      head.rotation.z = Math.PI;
      this.root.add(head);

      const label = this.makeLabel((force / G * 1e3).toFixed(0) + ' g',
        { size: size * 0.55, color: '#4e342e', bg: 'rgba(255,255,255,.9)' });
      label.position.set(x, y0 + size * 0.42, size * 0.65);
      this.root.add(label);
    }

    addBanner() {
      // 空画布时给一句提示（与 2D 一致）
      const emptyEditor = this.editor && !this.analysis && !this.editor.nodes.length;
      const text = this.banner || (emptyEditor ? '在画布上点击放置第一个节点' : '');
      if (!text) { this.bannerSprite = null; return; }
      const box = this.worldExtent();
      const span = box ? Math.max(box.maxX - box.minX, 1e-3) : 0.3;
      const top = box ? Math.max(box.maxY, 0) : 0;
      const sprite = this.makeLabel(text, {
        size: span * 0.075, color: this.collapsed ? C.fail : C.text, bg: 'rgba(255,255,255,.92)',
      });
      sprite.position.set(span * 0.5, top + span * 0.20, 0);
      this.root.add(sprite);
      this.bannerSprite = sprite;
    }

    /** 用 canvas 贴图做文字标签（免字体文件，file:// 也能用） */
    makeLabel(text, opts) {
      opts = opts || {};
      const px = 48;
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = 'bold ' + px + 'px ' + UI_FONT;
      const tw = measure.measureText(text).width;
      const pad = 12;
      const cv = document.createElement('canvas');
      cv.width = Math.max(2, Math.ceil(tw + pad * 2));
      cv.height = px + pad * 2;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = opts.bg || 'rgba(255,255,255,.85)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = 'bold ' + px + 'px ' + UI_FONT;
      ctx.fillStyle = opts.color || C.text;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, pad, cv.height / 2);

      const tex = new THREE.CanvasTexture(cv);
      if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
      }));
      const size = opts.size || 0.02;
      spr.scale.set(size * cv.width / cv.height, size, 1);
      spr.renderOrder = 10;
      return spr;
    }

    // ------------------------------------------------------------------
    // 相机与渲染
    // ------------------------------------------------------------------
    updateCamera() {
      if (!this.ok) return;
      const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
      this.camera.position.set(
        this.target.x + this.dist * sp * Math.sin(this.theta),
        this.target.y + this.dist * cp,
        this.target.z + this.dist * sp * Math.cos(this.theta));
      this.camera.lookAt(this.target);
      this.camera.near = Math.max(this.dist * 0.01, 0.002);
      this.camera.far = this.dist * 40;
      this.camera.updateProjectionMatrix();
    }

    requestRender() {
      if (this._pendingRender) return;
      const self = this;
      this._pendingRender = true;
      requestAnimationFrame(function () {
        self._pendingRender = false;
        self.renderNow();
      });
    }

    renderNow() {
      if (!this.ok || !this.visible) return;
      if (this.canvas.clientWidth < 8 || this.canvas.clientHeight < 8) return;
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
    }

    // ------------------------------------------------------------------
    // 鼠标交互
    // ------------------------------------------------------------------
    snap(x, y) {
      if (!(this.grid > 0)) return [x, y];
      return [Math.round(x / this.grid) * this.grid, Math.round(y / this.grid) * this.grid];
    }

    updateCursor() {
      if (!this.editor) { this.canvas.style.cursor = 'grab'; return; }
      const cursors = {};
      cursors[MODE.MODE_NODE] = 'crosshair';
      cursors[MODE.MODE_MEMBER] = 'crosshair';
      cursors[MODE.MODE_SUPPORT] = 'pointer';
      cursors[MODE.MODE_LOAD] = 'pointer';
      cursors[MODE.MODE_DELETE] = 'cell';
      this.canvas.style.cursor = cursors[this.editMode] || 'grab';
    }

    pick(ev) {
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
        -((ev.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const nodes = this.nodePicks.length ? this.raycaster.intersectObjects(this.nodePicks, false) : [];
      const bars = this.memberPicks.length ? this.raycaster.intersectObjects(this.memberPicks, false) : [];
      const hitPoint = new THREE.Vector3();
      const onPlane = this.raycaster.ray.intersectPlane(this.editPlane, hitPoint);
      const planeP = onPlane ? hitPoint.clone() : null;
      const nodeHit = nodes.length ? nodes[0] : null;
      const barHit = bars.length ? bars[0] : null;
      // 节点优先（半径小、意图明确）
      if (nodeHit) {
        return { node: nodeHit.object.userData.node, member: null, point: nodeHit.point, plane: planeP };
      }
      if (barHit) {
        const d = barHit.object.userData;
        return {
          node: null,
          member: d.element !== undefined ? d.element : d.member,
          point: barHit.point, plane: planeP,
        };
      }
      return { node: null, member: null, point: planeP, plane: planeP };
    }

    bindEvents() {
      const self = this;
      const canvas = this.canvas;

      /** 双指手势的当前状态：两指间距 + 中点（用于缩放与平移） */
      const pinchInfo = function () {
        const pts = Array.from(self._pointers.values());
        if (pts.length < 2) return null;
        const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
        return {
          dist: Math.max(Math.hypot(dx, dy), 1),
          mid: [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2],
        };
      };

      canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

      canvas.addEventListener('pointerdown', function (ev) {
        try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* 某些环境不允许捕获，忽略 */ }
        self._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (self._pointers.size >= 2) {           // 第二根手指 → 双指缩放 / 平移
          self._pinch = pinchInfo();
          self.dragNode = null;
          self._down = null;
          return;
        }
        if (ev.pointerType === 'touch' && !ev.isPrimary) return;
        self._down = {
          x: ev.clientX, y: ev.clientY, button: ev.button,
          pan: ev.button === 2 || ev.shiftKey, moved: 0,
          node: null, mode: self.editMode,
        };
        if (self.editor && self.editMode === MODE.MODE_NODE && ev.button === 0) {
          const hit = self.pick(ev);
          if (hit.node !== null) { self._down.node = hit.node; self.dragNode = hit.node; }
        }
      });

      canvas.addEventListener('pointermove', function (ev) {
        if (self._pointers.has(ev.pointerId)) {
          self._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        }
        if (self._pointers.size >= 2) {            // 双指：缩放 + 平移
          const info = pinchInfo();
          const prev = self._pinch;
          if (prev) {
            self.dist = clamp(self.dist * (prev.dist / info.dist), 0.05, 20);
            const k = self.dist * 0.0016;
            const right = new THREE.Vector3().setFromMatrixColumn(self.camera.matrix, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(self.camera.matrix, 1);
            self.target.addScaledVector(right, -(info.mid[0] - prev.mid[0]) * k);
            self.target.addScaledVector(up, (info.mid[1] - prev.mid[1]) * k);
          }
          self._pinch = info;
          updateCameraAndRender(self);
          return;
        }
        const down = self._down;
        if (!down) {                       // 只是移动鼠标：悬停高亮
          if (!self.editor) return;
          const hit = self.pick(ev);
          if (hit.node !== self.hoverNode || hit.member !== self.hoverMember) {
            self.hoverNode = hit.node;
            self.hoverMember = hit.member;
            self.build();
          }
          return;
        }
        const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
        down.moved = Math.max(down.moved, Math.abs(dx) + Math.abs(dy));

        if (self.dragNode !== null && !down.pan) {   // 拖动节点
          const hit = self.pick(ev);
          if (hit.plane) {
            const s = self.snap(hit.plane.x, hit.plane.y);
            if (!self.dragging) { self.dragging = true; }
            if (self.onNodeMove) self.onNodeMove(self.dragNode, s[0], s[1]);
            // 拖动过程按 ~14 fps 重建，松手时再完整重建一次
            const now = (window.performance && performance.now) ? performance.now() : Date.now();
            if (now - (self._dragBuildAt || 0) > 70) { self._dragBuildAt = now; self.build(); }
          }
          return;
        }
        // 轨道旋转 / 平移
        if (down.pan) {
          const k = self.dist * 0.0016;
          const right = new THREE.Vector3().setFromMatrixColumn(self.camera.matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(self.camera.matrix, 1);
          self.target.addScaledVector(right, -dx * k);
          self.target.addScaledVector(up, dy * k);
        } else {
          self.theta -= dx * 0.008;
          // 不允许转到地面以下，免得从地板背面看桥
          self.phi = clamp(self.phi - dy * 0.008, 0.12, Math.PI / 2);
        }
        updateCameraAndRender(self);
        self._down.x = ev.clientX;
        self._down.y = ev.clientY;
      });

      canvas.addEventListener('pointerup', function (ev) {
        self._pointers.delete(ev.pointerId);
        if (self._pointers.size < 2) self._pinch = null;
        const down = self._down;
        self._down = null;
        if (self.dragNode !== null) {
          const node = self.dragNode;
          self.dragNode = null;
          self.dragging = false;
          if (self.onNodeDrop) self.onNodeDrop(node);
          self.build();
          return;
        }
        if (!down || down.moved > 5 || down.pan || ev.button !== 0) return;
        if (down.mode !== self.editMode) return;
        self.handleClick(ev);
      });

      canvas.addEventListener('pointercancel', function (ev) {
        self._pointers.delete(ev.pointerId);
        if (self._pointers.size < 2) self._pinch = null;
        self._down = null;
        self.dragNode = null;
      });

      canvas.addEventListener('dblclick', function (ev) {
        if (!self.editor) { self.resetHome(); return; }
        if (self.editMode === MODE.MODE_NODE || self.editMode === MODE.MODE_DELETE
          || !self.onMemberDoubleClick) { self.resetHome(); return; }
        const hit = self.pick(ev);
        if (hit.member !== null) self.onMemberDoubleClick(hit.member);
        else self.resetHome();
      });

      canvas.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        self.dist = clamp(self.dist * Math.exp(ev.deltaY * 0.0012), 0.05, 20);
        updateCameraAndRender(self);
      }, { passive: false });

      canvas.addEventListener('pointerleave', function () {
        if (self.hoverNode === null && self.hoverMember === null) return;
        self.clearHover();
        self.build();
      });
    }

    resetHome() {
      if (!this.home) return;
      this.target.copy(this.home.target);
      this.dist = this.home.dist;
      this.theta = this.home.theta;
      this.phi = this.home.phi;
      updateCameraAndRender(this);
    }

    /** 单击（未拖动）时的编辑动作，与 2D 视图的分支保持一致 */
    handleClick(ev) {
      const hit = this.pick(ev);
      const mode = this.editMode;
      if (mode === MODE.MODE_NODE) {
        // 新节点放在 z = 0 工作面上（而不是箭头打到的杆件表面），位置更可预期
        if (hit.node === null && hit.plane && this.onEmptyClick) {
          const s = this.snap(hit.plane.x, hit.plane.y);
          this.onEmptyClick(s[0], s[1]);
        }
        return;
      }
      if (mode === MODE.MODE_MEMBER || mode === MODE.MODE_DELETE) {
        if (hit.node !== null && this.onNodeClick) this.onNodeClick(hit.node);
        else if (hit.member !== null && this.onMemberClick) this.onMemberClick(hit.member);
        return;
      }
      if (hit.node !== null && this.onNodeClick) this.onNodeClick(hit.node);
    }
  }

  function updateCameraAndRender(view) {
    view.updateCamera();
    view.requestRender();
  }

  function disposeGroup(group) {
    if (!group) return;
    group.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(function (m) {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }

  PB.BridgeView3D = THREE ? BridgeView3D : null;
  PB.BridgeView3DReason = THREE ? '' : 'three.js 未加载：请确认 vendor/three.min.js 存在';
})(globalThis.PB = globalThis.PB || {});

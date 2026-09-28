/**
 * 用户自定义结构的数据模型与编辑操作（Python 版 paperbridge/custom.py 的 JS 移植）。
 *
 * 只负责：描述几何（节点/杆件/支座/加载点）、编辑操作、命中测试、
 * 合法性校验、JSON 读写与示例模板。单位与全系统一致：坐标 m、力 N。
 */
(function (PB) {
  'use strict';

  const SUPPORT_NONE = 'none';
  const SUPPORT_PIN = 'pin';        // 固定铰：约束 ux, uy
  const SUPPORT_ROLLER = 'roller';  // 滚动铰：约束 uy
  const SUPPORT_FIXED = 'fixed';    // 固支：约束 ux, uy, θ

  const SUPPORT_LABELS = { none: '无', pin: '铰支', roller: '滚动铰', fixed: '固支' };
  const SUPPORT_ORDER = [SUPPORT_NONE, SUPPORT_PIN, SUPPORT_ROLLER, SUPPORT_FIXED];

  const MEMBER_FRAME = 'frame';
  const MEMBER_TRUSS = 'truss';
  const MEMBER_KIND_LABELS = { frame: '梁（传弯矩）', truss: '二力杆（仅轴力）' };
  const MEMBER_KINDS = [MEMBER_FRAME, MEMBER_TRUSS];

  const SECTION_KINDS = ['solid', 'laminate', 'tube', 'folded'];
  const SECTION_SHORT_LABELS = { solid: '单层纸', laminate: '多层纸', tube: '圆管', folded: '折叠梁' };
  // 编辑器在"未求解"状态下按截面类型给杆件上色
  const SECTION_COLORS = { solid: '#8d6e63', laminate: '#5d4037', tube: '#00695c', folded: '#4527a0' };

  const GEOM_TOL = 1e-6;

  /** 点到线段距离 */
  function pointSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-18) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /** 一根杆件：连接节点 i 与 j，指定截面类型与单元类型 */
  class CustomMember {
    constructor(i, j, section, kind) {
      this.i = i;
      this.j = j;
      this.section = section || 'folded';
      this.kind = kind || MEMBER_FRAME;
    }

    other(node) { return node === this.i ? this.j : this.i; }

    toDict() { return { i: this.i, j: this.j, section: this.section, kind: this.kind }; }

    static fromDict(d) {
      return new CustomMember(parseInt(d.i, 10), parseInt(d.j, 10),
        d.section !== undefined ? String(d.section) : 'folded',
        d.kind !== undefined ? String(d.kind) : MEMBER_FRAME);
    }
  }

  /** 用户自建的纸桥结构 */
  class CustomStructure {
    constructor() {
      this.nodes = [];        // [[x, y], ...]
      this.members = [];      // CustomMember[]
      this.supports = {};     // {节点编号: 支座类型}
      this.loadNodes = [];    // 加载点编号
    }

    // ---- 查询 ----
    nodeCount() { return this.nodes.length; }
    memberCount() { return this.members.length; }

    coordinates(node) { return [this.nodes[node][0], this.nodes[node][1]]; }

    /** [x0, y0, x1, y1]；没有节点时返回 null */
    bounds() {
      if (!this.nodes.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < this.nodes.length; k++) {
        const n = this.nodes[k];
        if (n[0] < x0) x0 = n[0];
        if (n[1] < y0) y0 = n[1];
        if (n[0] > x1) x1 = n[0];
        if (n[1] > y1) y1 = n[1];
      }
      return [x0, y0, x1, y1];
    }

    /** 跨度（x 方向尺寸）；退化为 0 时取 fallback */
    span(fallback) {
      fallback = fallback === undefined ? 0.30 : fallback;
      const b = this.bounds();
      if (!b) return fallback;
      const w = b[2] - b[0];
      return w > 1e-9 ? w : fallback;
    }

    /** 两端都是加载点的杆件 —— 视为"桥面" */
    deckElements() {
      const loads = {};
      this.loadNodes.forEach(function (n) { loads[n] = true; });
      const out = [];
      for (let k = 0; k < this.members.length; k++) {
        const m = this.members[k];
        if (loads[m.i] && loads[m.j]) out.push(k);
      }
      return out;
    }

    sectionKindCounts() {
      const counts = {};
      this.members.forEach(function (m) {
        counts[m.section] = (counts[m.section] || 0) + 1;
      });
      return counts;
    }

    supportCounts() {
      const counts = {};
      const self = this;
      Object.keys(this.supports).forEach(function (n) {
        const kind = self.supports[n];
        counts[kind] = (counts[kind] || 0) + 1;
      });
      return counts;
    }

    // ---- 编辑 ----
    addNode(x, y) {
      this.nodes.push([x, y]);
      return this.nodes.length - 1;
    }

    moveNode(node, x, y) { this.nodes[node] = [x, y]; }

    /** 删除节点：同时删除相关杆件、支座与加载点，并重编号 */
    removeNode(node) {
      if (!(node >= 0 && node < this.nodes.length)) {
        throw new Error('节点编号越界：' + node);
      }
      this.nodes.splice(node, 1);
      this.members = this.members.filter(function (m) { return m.i !== node && m.j !== node; });
      this.members.forEach(function (m) {
        if (m.i > node) m.i -= 1;
        if (m.j > node) m.j -= 1;
      });
      const supports = {};
      const self = this;
      Object.keys(this.supports).forEach(function (key) {
        const n = parseInt(key, 10);
        if (n === node) return;
        supports[String(n > node ? n - 1 : n)] = self.supports[key];
      });
      this.supports = supports;
      this.loadNodes = this.loadNodes
        .filter(function (n) { return n !== node; })
        .map(function (n) { return n > node ? n - 1 : n; })
        .sort(function (a, b) { return a - b; });
    }

    hasMember(i, j) {
      return this.members.some(function (m) {
        return (m.i === i && m.j === j) || (m.i === j && m.j === i);
      });
    }

    addMember(i, j, section, kind) {
      section = section || 'folded';
      kind = kind || MEMBER_FRAME;
      if (i === j) throw new Error('杆件两端不能是同一个节点');
      const bad = [i, j].filter(function (n) { return !(n >= 0 && n < this.nodes.length); }, this);
      if (bad.length) throw new Error('节点编号越界：' + bad[0]);
      if (this.hasMember(i, j)) throw new Error('节点 ' + i + ' 与 ' + j + ' 之间已经有杆件了');
      if (SECTION_KINDS.indexOf(section) < 0) throw new Error('未知截面类型：' + section);
      if (MEMBER_KINDS.indexOf(kind) < 0) throw new Error('未知杆件类型：' + kind);
      const a = this.coordinates(i), b = this.coordinates(j);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < GEOM_TOL) {
        throw new Error('两节点重合，杆件长度为零');
      }
      this.members.push(new CustomMember(i, j, section, kind));
      return this.members.length - 1;
    }

    removeMember(index) { this.members.splice(index, 1); }

    setMember(index, section, kind) {
      const m = this.members[index];
      if (section !== null && section !== undefined) {
        if (SECTION_KINDS.indexOf(section) < 0) throw new Error('未知截面类型：' + section);
        m.section = section;
      }
      if (kind !== null && kind !== undefined) {
        if (MEMBER_KINDS.indexOf(kind) < 0) throw new Error('未知杆件类型：' + kind);
        m.kind = kind;
      }
    }

    /** 支座循环：无 → 铰支 → 滚动铰 → 固支 → 无，返回新状态 */
    cycledSupport(node) {
      const current = this.supports[String(node)] || SUPPORT_NONE;
      const next = SUPPORT_ORDER[(SUPPORT_ORDER.indexOf(current) + 1) % SUPPORT_ORDER.length];
      this.setSupport(node, next);
      return next;
    }

    setSupport(node, kind) {
      if (kind === SUPPORT_NONE) {
        delete this.supports[String(node)];
      } else {
        if (SUPPORT_ORDER.indexOf(kind) < 0) throw new Error('未知支座类型：' + kind);
        this.supports[String(node)] = kind;
      }
    }

    supportOf(node) { return this.supports[String(node)] || SUPPORT_NONE; }

    /** 切换某节点是否为加载点，返回切换后的状态 */
    toggleLoadNode(node) {
      const idx = this.loadNodes.indexOf(node);
      if (idx >= 0) {
        this.loadNodes.splice(idx, 1);
        return false;
      }
      this.loadNodes.push(node);
      this.loadNodes.sort(function (a, b) { return a - b; });
      return true;
    }

    clear() {
      this.nodes = [];
      this.members = [];
      this.supports = {};
      this.loadNodes = [];
    }

    // ---- 命中测试 ----
    nodeAt(x, y, tol) {
      tol = tol === undefined ? 0.01 : tol;
      let best = null, bestD = tol;
      for (let k = 0; k < this.nodes.length; k++) {
        const d = Math.hypot(this.nodes[k][0] - x, this.nodes[k][1] - y);
        if (d <= bestD) { best = k; bestD = d; }
      }
      return best;
    }

    memberAt(x, y, tol) {
      tol = tol === undefined ? 0.01 : tol;
      let best = null, bestD = tol;
      for (let k = 0; k < this.members.length; k++) {
        const m = this.members[k];
        const a = this.coordinates(m.i), b = this.coordinates(m.j);
        const d = pointSegmentDistance(x, y, a[0], a[1], b[0], b[1]);
        if (d <= bestD) { best = k; bestD = d; }
      }
      return best;
    }

    // ---- 校验 ----
    /** 返回问题列表，空数组表示合法 */
    validate() {
      const self = this;
      const problems = [];
      if (!this.nodes.length) {
        problems.push('还没有任何节点：在画布上点击即可放置节点。');
        return problems;
      }
      if (!this.members.length) {
        problems.push('还没有任何杆件：用「杆件」模式连接两个节点。');
      }
      this.members.forEach(function (m, k) {
        [m.i, m.j].forEach(function (n) {
          if (!(n >= 0 && n < self.nodes.length)) {
            problems.push('第 ' + (k + 1) + ' 根杆件引用了不存在的节点 ' + n);
          }
        });
        if (m.i === m.j) problems.push('第 ' + (k + 1) + ' 根杆件两端是同一个节点');
        if (SECTION_KINDS.indexOf(m.section) < 0) {
          problems.push('第 ' + (k + 1) + ' 根杆件的截面类型非法：' + m.section);
        }
        if (MEMBER_KINDS.indexOf(m.kind) < 0) {
          problems.push('第 ' + (k + 1) + ' 根杆件的类型非法：' + m.kind);
        }
      });
      const seen = {};
      this.members.forEach(function (m, k) {
        const key = [Math.min(m.i, m.j), Math.max(m.i, m.j)].join('-');
        if (seen[key]) {
          problems.push('第 ' + (k + 1) + ' 根杆件与前面的杆件重复（节点 ' +
            Math.min(m.i, m.j) + '–' + Math.max(m.i, m.j) + '）');
        }
        seen[key] = true;
      });
      this.members.forEach(function (m, k) {
        if (m.i >= 0 && m.i < self.nodes.length && m.j >= 0 && m.j < self.nodes.length) {
          const a = self.coordinates(m.i), b = self.coordinates(m.j);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < GEOM_TOL) {
            problems.push('第 ' + (k + 1) + ' 根杆件长度为零（两端节点重合）');
          }
        }
      });
      const seenPos = {};
      this.nodes.forEach(function (n, k) {
        const key = n[0].toFixed(6) + ',' + n[1].toFixed(6);
        if (seenPos[key] !== undefined) {
          problems.push('节点 ' + seenPos[key] + ' 与节点 ' + k + ' 位置重合');
        }
        seenPos[key] = k;
      });
      Object.keys(this.supports).forEach(function (key) {
        const n = parseInt(key, 10);
        if (!(n >= 0 && n < self.nodes.length)) problems.push('支座引用了不存在的节点 ' + n);
      });
      this.loadNodes.forEach(function (n) {
        if (!(n >= 0 && n < self.nodes.length)) problems.push('加载点引用了不存在的节点 ' + n);
      });
      return problems;
    }

    /** 不算错误、但会导致算不出结果的提示 */
    warnings() {
      const notes = [];
      if (!Object.keys(this.supports).length) {
        notes.push('还没有设置支座，结构会因缺少约束而无法求解。');
      }
      if (!this.loadNodes.length) {
        notes.push('还没有指定加载点，砝码无处可放（目前只算自重）。');
      }
      return notes;
    }

    // ---- 序列化 / 快照 ----
    toDict() {
      const supports = {};
      Object.keys(this.supports).sort(function (a, b) {
        return parseInt(a, 10) - parseInt(b, 10);
      }).forEach((function (key) {
        supports[key] = this.supports[key];
      }).bind(this));
      return {
        nodes: this.nodes.map(function (n) { return [n[0], n[1]]; }),
        members: this.members.map(function (m) { return m.toDict(); }),
        supports: supports,
        load_nodes: this.loadNodes.slice(),
      };
    }

    static fromDict(d) {
      const cs = new CustomStructure();
      (d.nodes || []).forEach(function (p) { cs.nodes.push([parseFloat(p[0]), parseFloat(p[1])]); });
      (d.members || []).forEach(function (m) { cs.members.push(CustomMember.fromDict(m)); });
      Object.keys(d.supports || {}).forEach(function (key) {
        cs.supports[String(parseInt(key, 10))] = String(d.supports[key]);
      });
      (d.load_nodes || []).forEach(function (n) { cs.loadNodes.push(parseInt(n, 10)); });
      return cs;
    }

    toJSON(indent) {
      return JSON.stringify(this.toDict(), null, indent === undefined ? 2 : indent);
    }

    static fromJSON(text) { return CustomStructure.fromDict(JSON.parse(text)); }

    snapshot() { return this.toDict(); }

    restore(snap) {
      const other = CustomStructure.fromDict(snap);
      this.nodes = other.nodes;
      this.members = other.members;
      this.supports = other.supports;
      this.loadNodes = other.loadNodes;
    }

    copy() { return CustomStructure.fromDict(this.toDict()); }

    // ---- 统计 ----
    describe() {
      const kinds = this.sectionKindCounts();
      const self = this;
      const kindText = Object.keys(kinds).map(function (k) {
        return (SECTION_SHORT_LABELS[k] || k) + '×' + kinds[k];
      }).join('、') || '—';
      const sup = this.supportCounts();
      const supText = Object.keys(sup).map(function (k) {
        return (SUPPORT_LABELS[k] || k) + '×' + sup[k];
      }).join('、') || '无支座';
      return '自建结构：' + this.nodes.length + ' 节点 / ' + this.members.length +
        ' 杆件（' + kindText + '）；' + supText + '；加载点 ' + this.loadNodes.length + ' 个';
    }
  }

  // ------------------------------------------------------------------------
  // 示例模板
  // ------------------------------------------------------------------------
  /** 最朴素的简支平板桥 */
  function demoSimplySupported(span, panels) {
    span = span === undefined ? 0.30 : span;
    panels = panels === undefined ? 4 : panels;
    const cs = new CustomStructure();
    for (let k = 0; k <= panels; k++) {
      const node = cs.addNode(span * k / panels, 0.0);
      cs.loadNodes.push(node);
    }
    for (let k = 0; k < panels; k++) cs.addMember(k, k + 1, 'solid', MEMBER_FRAME);
    cs.setSupport(0, SUPPORT_PIN);
    cs.setSupport(panels, SUPPORT_ROLLER);
    return cs;
  }

  /** Pratt 桁架：斜杆受拉、竖杆受压 */
  function demoTruss(span, depth, panels) {
    span = span === undefined ? 0.30 : span;
    depth = depth === undefined ? 0.05 : depth;
    panels = panels === undefined ? 6 : panels;
    const cs = new CustomStructure();
    const bottom = [], top = [];
    for (let k = 0; k <= panels; k++) bottom.push(cs.addNode(span * k / panels, 0.0));
    for (let k = 0; k <= panels; k++) top.push(cs.addNode(span * k / panels, depth));
    cs.loadNodes = bottom.slice();
    for (let k = 0; k < panels; k++) {
      cs.addMember(bottom[k], bottom[k + 1], 'folded', MEMBER_FRAME);
      cs.addMember(top[k], top[k + 1], 'folded', MEMBER_FRAME);
    }
    for (let k = 0; k <= panels; k++) cs.addMember(bottom[k], top[k], 'solid', MEMBER_TRUSS);
    for (let k = 0; k < panels; k++) {
      if (k < Math.floor(panels / 2)) cs.addMember(top[k], bottom[k + 1], 'solid', MEMBER_TRUSS);
      else cs.addMember(bottom[k], top[k + 1], 'solid', MEMBER_TRUSS);
    }
    cs.setSupport(bottom[0], SUPPORT_PIN);
    cs.setSupport(bottom[bottom.length - 1], SUPPORT_ROLLER);
    return cs;
  }

  /** 系杆拱：抛物线拱圈 + 桥面 + 竖吊杆 */
  function demoArch(span, rise, panels) {
    span = span === undefined ? 0.30 : span;
    rise = rise === undefined ? 0.08 : rise;
    panels = panels === undefined ? 6 : panels;
    const cs = new CustomStructure();
    const archY = function (u) { return 4.0 * rise * u * (1.0 - u); };

    const deck = [];
    for (let k = 0; k <= panels; k++) deck.push(cs.addNode(span * k / panels, 0.0));
    cs.loadNodes = deck.slice();
    const ring = [deck[0]];
    for (let k = 1; k < panels; k++) {
      ring.push(cs.addNode(span * k / panels, archY(k / panels)));
    }
    ring.push(deck[deck.length - 1]);

    for (let k = 0; k < panels; k++) {
      cs.addMember(deck[k], deck[k + 1], 'solid', MEMBER_FRAME);
      cs.addMember(ring[k], ring[k + 1], 'folded', MEMBER_FRAME);
    }
    for (let k = 1; k < panels; k++) cs.addMember(ring[k], deck[k], 'solid', MEMBER_TRUSS);
    cs.setSupport(deck[0], SUPPORT_PIN);
    cs.setSupport(deck[deck.length - 1], SUPPORT_PIN);
    return cs;
  }

  const DEMOS = {
    beam: { label: '简支平板桥', build: demoSimplySupported },
    truss: { label: '三角桁架桥', build: demoTruss },
    arch: { label: '系杆拱桥', build: demoArch },
  };

  PB.Custom = {
    SUPPORT_NONE: SUPPORT_NONE,
    SUPPORT_PIN: SUPPORT_PIN,
    SUPPORT_ROLLER: SUPPORT_ROLLER,
    SUPPORT_FIXED: SUPPORT_FIXED,
    SUPPORT_LABELS: SUPPORT_LABELS,
    SUPPORT_ORDER: SUPPORT_ORDER,
    MEMBER_FRAME: MEMBER_FRAME,
    MEMBER_TRUSS: MEMBER_TRUSS,
    MEMBER_KIND_LABELS: MEMBER_KIND_LABELS,
    MEMBER_KINDS: MEMBER_KINDS,
    SECTION_KINDS: SECTION_KINDS,
    SECTION_SHORT_LABELS: SECTION_SHORT_LABELS,
    SECTION_COLORS: SECTION_COLORS,
    CustomMember: CustomMember,
    CustomStructure: CustomStructure,
    demoSimplySupported: demoSimplySupported,
    demoTruss: demoTruss,
    demoArch: demoArch,
    DEMOS: DEMOS,
  };
})(globalThis.PB = globalThis.PB || {});

/**
 * 桥梁结构方案建模（Python 版 paperbridge/structures.py 的 JS 移植）。
 *
 * 6 种内置方案 + 自定义结构；统一产出 PB.Fem.Model（含自重与活载），
 * 并在 model.meta 里记录 roles / deck_elements / load_points 供界面与失效归因使用。
 */
(function (PB) {
  'use strict';

  const Mat = PB.Materials;
  const Sec = PB.Sections;
  const Fem = PB.Fem;
  const Custom = PB.Custom;
  const G = Mat.G;

  const FRAME = Fem.FRAME, TRUSS = Fem.TRUSS;

  const STRUCTURE_LABELS = {
    flat: '平板桥（单层纸）',
    laminate: '多层复合梁桥',
    tube: '圆管梁桥',
    folded: '折叠梁桥',
    truss: '桁架桥',
    arch: '拱桥',
    custom: '自定义结构（自己搭建）',
  };

  /** 各方案默认用哪种截面 */
  const DEFAULT_SECTION_KIND = {
    flat: 'solid', laminate: 'laminate', tube: 'tube',
    folded: 'folded', truss: 'folded', arch: 'folded', custom: 'folded',
  };

  const STRUCTURE_KEYS = ['flat', 'laminate', 'tube', 'folded', 'truss', 'arch', 'custom'];

  const SUPPORT_LABELS = {
    simply: '简支（一端固定铰、一端滚动铰）',
    fixed: '两端固支（胶粘在桥墩上）',
    cantilever: '悬臂（仅一端固定）',
  };

  // 单元用途
  const ROLE_DECK = 'deck', ROLE_CHORD = 'chord', ROLE_WEB = 'web',
    ROLE_ARCH = 'arch', ROLE_HANGER = 'hanger';
  const ROLE_LABELS = {
    deck: '桥面', chord: '弦杆', web: '腹杆', arch: '拱圈', hanger: '吊杆',
  };

  const LOAD_LABELS = PB.Beam.LOAD_LABELS;

  /** 一套纸桥设计方案 */
  class BridgeDesign {
    constructor(o) {
      o = o || {};
      const pick = function (key, dflt) {
        return o[key] !== undefined ? o[key] : dflt;
      };
      this.structure = pick('structure', 'folded');
      this.span = pick('span', 0.30);
      this.width = pick('width', 0.15);
      this.material_key = pick('material_key', 'office80');
      this.support = pick('support', 'simply');
      this.layers = pick('layers', 3);
      this.glued = pick('glued', true);
      this.depth = pick('depth', 0.04);
      this.web_count = pick('web_count', 2);
      this.fold_panels = pick('fold_panels', 6);
      this.diameter = pick('diameter', 0.03);
      this.thickness = pick('thickness', 0.0);
      this.panels = pick('panels', 6);
      this.arch_rise = pick('arch_rise', 0.08);
      this.load_type = pick('load_type', 'point_center');
      this.live_load = pick('live_load', 0.0);
      this.load_position = pick('load_position', null);
      this.include_self_weight = pick('include_self_weight', true);
      this.n_elements = pick('n_elements', 12);
      this.custom = pick('custom', null);
    }

    toOptions() {
      return {
        structure: this.structure, span: this.span, width: this.width,
        material_key: this.material_key, support: this.support,
        layers: this.layers, glued: this.glued, depth: this.depth,
        web_count: this.web_count, fold_panels: this.fold_panels,
        diameter: this.diameter, thickness: this.thickness,
        panels: this.panels, arch_rise: this.arch_rise,
        load_type: this.load_type, live_load: this.live_load,
        load_position: this.load_position,
        include_self_weight: this.include_self_weight,
        n_elements: this.n_elements, custom: this.custom,
      };
    }

    /** 返回修改若干参数后的副本（会做一次校验） */
    copyWith(kwargs) {
      const d = new BridgeDesign(Object.assign(this.toOptions(), kwargs || {}));
      d.validate();
      return d;
    }

    get material() { return Mat.get(this.material_key); }

    validate() {
      if (STRUCTURE_KEYS.indexOf(this.structure) < 0) {
        throw new Error('未知结构方案 ' + JSON.stringify(this.structure) +
          '，可选：' + STRUCTURE_KEYS.join(', '));
      }
      if (!(this.span > 0) || !(this.width > 0)) throw new Error('跨长与桥宽必须为正');
      if (!SUPPORT_LABELS[this.support]) {
        throw new Error('未知支撑方式 ' + JSON.stringify(this.support));
      }
      if (!LOAD_LABELS[this.load_type]) {
        throw new Error('未知加载方式 ' + JSON.stringify(this.load_type));
      }
      if (this.live_load < 0) throw new Error('活载不能为负');

      if (this.structure === 'custom') {
        if (!this.custom) throw new Error('自定义结构为空：请先在画布上搭建或载入一个示例。');
        const problems = this.custom.validate();
        if (problems.length) throw new Error(problems.slice(0, 3).join('；'));
        return;
      }
      if (this.panels < 2) throw new Error('节间数至少为 2');
      if (this.panels % 2 !== 0) throw new Error('节间数需为偶数，以保证跨中有节点');
      if ((this.structure === 'truss' || this.structure === 'arch') && !(this.depth > 0)) {
        throw new Error('桁架/拱的结构高度必须为正');
      }
      if (this.structure === 'arch' && !(this.arch_rise > 0 && this.arch_rise < this.span)) {
        throw new Error('拱矢高应在 (0, 跨长) 之间');
      }
    }

    /** 按给定截面类型，用当前几何与材料参数造一个截面 */
    sectionFor(kind) {
      const m = this.material;
      if (kind === 'solid') {
        return new Sec.SolidStrip(m, { width: this.width, thickness: this.thickness });
      }
      if (kind === 'laminate') {
        return new Sec.Laminate(m, {
          width: this.width, layers: this.layers, glued: this.glued, thickness: this.thickness,
        });
      }
      if (kind === 'tube') {
        return new Sec.Tube(m, { diameter: this.diameter, thickness: this.thickness });
      }
      if (kind === 'folded') {
        return new Sec.FoldedBeam(m, {
          width: this.width, depth: this.depth, thickness: this.thickness,
          web_count: this.web_count, fold_panels: this.fold_panels,
        });
      }
      throw new Error('未知截面类型 ' + JSON.stringify(kind));
    }

    /** 方案的主截面（自定义结构取第一根杆件的截面类型） */
    buildSection() {
      let kind = DEFAULT_SECTION_KIND[this.structure] || 'folded';
      if (this.structure === 'custom') {
        kind = (this.custom && this.custom.members.length)
          ? this.custom.members[0].section : 'folded';
      }
      return this.sectionFor(kind);
    }

    /** 腹杆/吊杆等次要构件的截面（单层纸即可） */
    buildWebSection() {
      return new Sec.SolidStrip(this.material, {
        width: this.width, thickness: this.thickness, label: '腹杆（单层纸）',
      });
    }

    /** 方案里实际用到的截面类型 */
    usedSectionKinds() {
      if (this.structure !== 'custom' || !this.custom) {
        return [DEFAULT_SECTION_KIND[this.structure] || 'folded'];
      }
      const seen = [];
      this.custom.members.forEach(function (m) {
        if (seen.indexOf(m.section) < 0) seen.push(m.section);
      });
      return seen.length ? seen : ['folded'];
    }

    describe() {
      const mat = this.material;
      const tail = '加载：' + LOAD_LABELS[this.load_type] + ' ' + this.live_load.toFixed(2) + ' N';
      if (this.structure === 'custom') {
        const cs = this.custom;
        const geo = cs ? cs.describe() : '空结构';
        const kinds = this.usedSectionKinds().map(function (k) {
          return Custom.SECTION_SHORT_LABELS[k] || k;
        }).join('、');
        return '自定义结构｜跨长 ' + (this.span * 1e2).toFixed(0) + ' cm，桥宽 ' +
          (this.width * 1e2).toFixed(1) + ' cm，' + mat.name + '；' + geo +
          '；截面类型：' + kinds + '；' + tail;
      }
      const supText = (this.structure === 'truss' || this.structure === 'arch')
        ? '两端支承' : SUPPORT_LABELS[this.support];
      const s = this.buildSection();
      return STRUCTURE_LABELS[this.structure] + '｜跨长 ' + (this.span * 1e2).toFixed(0) +
        ' cm，桥宽 ' + (this.width * 1e2).toFixed(1) + ' cm，' + mat.name + '，' + supText +
        '；截面：' + s.label + '（d=' + (s.depth * 1e3).toFixed(1) + ' mm，I=' +
        (s.inertia * 1e12).toFixed(2) + ' mm⁴）；' + tail;
    }
  }

  // ------------------------------------------------------------------------
  // 建模
  // ------------------------------------------------------------------------
  function buildModel(design) {
    design.validate();
    if (design.structure === 'custom') return buildCustom(design);
    if (['flat', 'laminate', 'tube', 'folded'].indexOf(design.structure) >= 0) {
      return buildBeamlike(design);
    }
    if (design.structure === 'truss') return buildTruss(design);
    return buildArch(design);
  }

  function attachCommonMeta(model, design, roles, deckElements, deckNodes) {
    model.meta.structure = design.structure;
    model.meta.roles = roles;
    model.meta.deck_elements = deckElements;
    model.meta.deck_nodes = deckNodes;
    model.meta.design = design;
    model.meta.support = design.support;
  }

  function buildBeamlike(design) {
    const span = design.span, n = Math.max(2, design.n_elements);
    const model = new Fem.Model(design.structure + '-bridge');
    const section = design.buildSection();
    const nodes = [];
    for (let i = 0; i <= n; i++) nodes.push(model.addNode(span * i / n, 0.0, 'n' + i));

    const roles = {}, deckElements = [];
    for (let i = 0; i < n; i++) {
      const e = model.addElement(nodes[i], nodes[i + 1], section, FRAME, 'deck');
      deckElements.push(e);
      roles[e] = ROLE_DECK;
    }
    if (design.support === 'simply') {
      model.addSupport(nodes[0], true, true, false);
      model.addSupport(nodes[n], false, true, false);
    } else if (design.support === 'fixed') {
      model.addSupport(nodes[0], true, true, true);
      model.addSupport(nodes[n], true, true, true);
    } else {
      model.addSupport(nodes[0], true, true, true);   // 悬臂
    }
    applySelfWeight(model, design);
    attachCommonMeta(model, design, roles, deckElements, nodes);
    applyLiveLoad(model, design, nodes, deckElements);
    return model;
  }

  function buildTruss(design) {
    const span = design.span, h = design.depth, panels = design.panels;
    const model = new Fem.Model('truss-bridge');
    const chord = design.buildSection();
    const web = design.buildWebSection();

    const bottom = [], top = [];
    for (let i = 0; i <= panels; i++) bottom.push(model.addNode(span * i / panels, 0.0, 'b' + i));
    for (let i = 0; i <= panels; i++) top.push(model.addNode(span * i / panels, h, 't' + i));

    const roles = {}, deckElements = [];
    for (let i = 0; i < panels; i++) {
      const e = model.addElement(bottom[i], bottom[i + 1], chord, FRAME, 'bottom-chord');
      roles[e] = ROLE_DECK;
      deckElements.push(e);
    }
    for (let i = 0; i < panels; i++) {
      roles[model.addElement(top[i], top[i + 1], chord, FRAME, 'top-chord')] = ROLE_CHORD;
    }
    for (let i = 0; i <= panels; i++) {
      roles[model.addElement(bottom[i], top[i], web, TRUSS, 'vertical')] = ROLE_WEB;
    }
    for (let i = 0; i < panels; i++) {
      const e = (i < Math.floor(panels / 2))
        ? model.addElement(top[i], bottom[i + 1], web, TRUSS, 'diag' + i)
        : model.addElement(bottom[i], top[i + 1], web, TRUSS, 'diag' + i);
      roles[e] = ROLE_WEB;
    }
    model.addSupport(bottom[0], true, true, false);
    model.addSupport(bottom[bottom.length - 1], false, true, false);

    applySelfWeight(model, design);
    attachCommonMeta(model, design, roles, deckElements, bottom);
    applyLiveLoad(model, design, bottom, deckElements);
    return model;
  }

  function buildArch(design) {
    const span = design.span, f = design.arch_rise, panels = design.panels;
    const model = new Fem.Model('arch-bridge');
    const ring = design.buildSection();
    const deckSec = design.buildWebSection();
    const hanger = design.buildWebSection();

    const archY = function (x) {
      const u = x / span;
      return 4.0 * f * u * (1.0 - u);
    };

    const deckNodes = [];
    for (let i = 0; i <= panels; i++) deckNodes.push(model.addNode(span * i / panels, 0.0, 'd' + i));
    const archNodes = [deckNodes[0]];      // 拱脚与桥面端节点共用
    for (let i = 1; i < panels; i++) {
      const x = span * i / panels;
      archNodes.push(model.addNode(x, archY(x), 'a' + i));
    }
    archNodes.push(deckNodes[deckNodes.length - 1]);

    const roles = {}, deckElements = [];
    for (let i = 0; i < panels; i++) {
      const e = model.addElement(deckNodes[i], deckNodes[i + 1], deckSec, FRAME, 'deck');
      roles[e] = ROLE_DECK;
      deckElements.push(e);
    }
    for (let i = 0; i < panels; i++) {
      roles[model.addElement(archNodes[i], archNodes[i + 1], ring, FRAME, 'arch' + i)] = ROLE_ARCH;
    }
    for (let i = 1; i < panels; i++) {
      roles[model.addElement(archNodes[i], deckNodes[i], hanger, TRUSS, 'hanger' + i)] = ROLE_HANGER;
    }
    model.addSupport(deckNodes[0], true, true, false);
    model.addSupport(deckNodes[deckNodes.length - 1], true, true, false);

    applySelfWeight(model, design);
    attachCommonMeta(model, design, roles, deckElements, deckNodes);
    applyLiveLoad(model, design, deckNodes, deckElements);
    return model;
  }

  function buildCustom(design) {
    const cs = design.custom;
    if (!cs) throw new Error('自定义结构为空');
    const model = new Fem.Model('custom-bridge');
    cs.nodes.forEach(function (p) { model.addNode(p[0], p[1]); });

    const sections = {};
    const loadSet = {};
    cs.loadNodes.forEach(function (n) { loadSet[n] = true; });
    const roles = {}, deckElements = [];

    cs.members.forEach(function (m, k) {
      let sec = sections[m.section];
      if (!sec) {
        sec = design.sectionFor(m.section);
        sections[m.section] = sec;
      }
      const isDeck = !!(loadSet[m.i] && loadSet[m.j]);
      const kind = (m.kind === Custom.MEMBER_TRUSS) ? TRUSS : FRAME;
      const label = isDeck ? ROLE_DECK : (kind === TRUSS ? ROLE_WEB : ROLE_CHORD);
      const e = model.addElement(m.i, m.j, sec, kind, label);
      roles[e] = label;
      if (isDeck) deckElements.push(e);
    });

    Object.keys(cs.supports).forEach(function (key) {
      const node = parseInt(key, 10), kind = cs.supports[key];
      if (kind === Custom.SUPPORT_PIN) model.addSupport(node, true, true, false);
      else if (kind === Custom.SUPPORT_ROLLER) model.addSupport(node, false, true, false);
      else if (kind === Custom.SUPPORT_FIXED) model.addSupport(node, true, true, true);
    });

    applySelfWeight(model, design);
    attachCommonMeta(model, design, roles, deckElements, cs.loadNodes.slice());
    applyLiveLoad(model, design, cs.loadNodes.slice(), deckElements);
    return model;
  }

  // ------------------------------------------------------------------------
  // 载荷
  // ------------------------------------------------------------------------
  function applySelfWeight(model, design) {
    if (!design.include_self_weight) return;
    model.elements.forEach(function (e, k) {
      model.addDistributed(k, -e.section.mass_per_line * G);
    });
  }

  function nearestNode(model, candidates, x) {
    let best = candidates[0], bestD = Infinity;
    candidates.forEach(function (n) {
      const d = Math.abs(model.nodes[n].x - x);
      if (d < bestD) { best = n; bestD = d; }
    });
    return best;
  }

  /** 把砝码（活载）施加到桥面上，并记录加载点供绘制 */
  function applyLiveLoad(model, design, deckNodes, deckElements) {
    const total = design.live_load, span = design.span;
    const points = [];                      // [x, y, 力]
    if (!(total > 0) || (!deckNodes.length && !deckElements.length)) {
      model.meta.load_points = points;      // 自建结构还没标加载点时只算自重
      return;
    }

    if (design.load_type === 'udl') {
      const q = total / span;
      if (deckElements.length) {
        deckElements.forEach(function (e) { model.addDistributed(e, -q); });
        const share = q * span / Math.max(1, deckNodes.length - 1);
        deckNodes.forEach(function (node) {
          points.push([model.nodes[node].x, model.nodes[node].y, share]);
        });
      } else {
        const share = total / deckNodes.length;
        deckNodes.forEach(function (node) {
          model.addNodalLoad(node, 0, -share);
          points.push([model.nodes[node].x, model.nodes[node].y, share]);
        });
      }
    } else if (design.load_type === 'point_two') {
      [span / 3.0, 2.0 * span / 3.0].forEach(function (target) {
        const node = nearestNode(model, deckNodes, target);
        model.addNodalLoad(node, 0, -total / 2.0);
        points.push([model.nodes[node].x, model.nodes[node].y, total / 2.0]);
      });
    } else {
      let target;
      if (design.load_position !== null && design.load_position !== undefined) {
        target = design.load_position;
      } else if (design.support === 'cantilever') {
        target = span;                       // 悬臂梁默认在自由端挂砝码
      } else {
        target = span / 2.0;
      }
      const node = nearestNode(model, deckNodes, target);
      model.addNodalLoad(node, 0, -total);
      points.push([model.nodes[node].x, model.nodes[node].y, total]);
    }
    model.meta.load_points = points;
  }

  function loadTypeLabels() { return Object.assign({}, LOAD_LABELS); }

  function supportLabels(forStructure) {
    if (forStructure === 'truss' || forStructure === 'arch') {
      return { simply: '两端支承（体系自带）' };
    }
    if (forStructure === 'custom') return { simply: '由画布逐节点设置' };
    return Object.assign({}, SUPPORT_LABELS);
  }

  // ------------------------------------------------------------------------
  // 解析解对照（只适用于梁式方案）
  // ------------------------------------------------------------------------
  /** 用 beam.js 的闭式解独立算一遍梁式方案（线性叠加），用于校验有限元 */
  function analyticBeamCheck(design, liveLoad) {
    if (['flat', 'laminate', 'tube', 'folded'].indexOf(design.structure) < 0) return null;
    const section = design.buildSection();
    const EI = section.flexural_rigidity;
    const L = design.span;
    const total = (liveLoad === null || liveLoad === undefined) ? design.live_load : liveLoad;

    // 均布部分：自重（+ 均布活载）
    const qUdl = section.mass_per_line * G + (design.load_type === 'udl' ? total / L : 0.0);
    const rUdl = PB.Beam.solveBeam(L, EI, design.support, 'udl', { total_load: qUdl * L });
    let wMax = rUdl.wMax(), mMax = rUdl.momentMax();
    let name = rUdl.case;

    // 集中力部分
    if (total > 0 && design.load_type === 'point_center') {
      const r = PB.Beam.solveBeam(L, EI, design.support, 'point_center',
        { total_load: total, load_position: design.load_position });
      wMax += r.wMax(); mMax += r.momentMax(); name += ' + ' + r.case;
    } else if (total > 0 && design.load_type === 'point_two') {
      const r = PB.Beam.solveBeam(L, EI, design.support, 'point_two', { total_load: total });
      wMax += r.wMax(); mMax += r.momentMax(); name += ' + ' + r.case;
    }
    return { w_max: wMax, moment_max: mMax, note: name };
  }

  PB.Structures = {
    STRUCTURE_LABELS: STRUCTURE_LABELS,
    STRUCTURE_KEYS: STRUCTURE_KEYS,
    DEFAULT_SECTION_KIND: DEFAULT_SECTION_KIND,
    SUPPORT_LABELS: SUPPORT_LABELS,
    ROLE_DECK: ROLE_DECK, ROLE_CHORD: ROLE_CHORD, ROLE_WEB: ROLE_WEB,
    ROLE_ARCH: ROLE_ARCH, ROLE_HANGER: ROLE_HANGER,
    ROLE_LABELS: ROLE_LABELS,
    BridgeDesign: BridgeDesign,
    buildModel: buildModel,
    applySelfWeight: applySelfWeight,
    applyLiveLoad: applyLiveLoad,
    loadTypeLabels: loadTypeLabels,
    supportLabels: supportLabels,
    analyticBeamCheck: analyticBeamCheck,
  };
})(globalThis.PB = globalThis.PB || {});

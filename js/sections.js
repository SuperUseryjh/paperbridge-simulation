/**
 * 纸桥截面库（Python 版 paperbridge/sections.py 的 JS 移植）。
 *
 * 纸的致命弱点是厚度极小：单层纸 I = b·t³/12。真实纸桥必须靠
 * **折出截面高度**、**卷成管**、**多层复合** 把材料推到远离中性轴的位置。
 *
 * 所有截面统一暴露：area / inertia / inertia_weak / torsion / depth /
 * c_top / c_bottom / mass_per_line / developed_width / local_buckling 参数。
 *
 * 注意构造顺序：基类构造函数只存 key/label/material，子类**先设置几何参数**，
 * 最后调用 ``finish()`` 才计算派生量（对应 Python dataclass 的 __post_init__）。
 */
(function (PB) {
  'use strict';

  const Mat = PB.Materials;

  /**
   * 组合截面性质：parts 为 [[面积 A, 形心高度 y, 自身惯性矩 I0], ...]，
   * y 自参考轴向下为正。返回 {area, yBar, inertia}。
   */
  function compositeProperties(parts) {
    if (!parts.length) throw new Error('组合截面至少需要一个子块');
    let area = 0, moment = 0, own = 0;
    for (let k = 0; k < parts.length; k++) {
      area += parts[k][0];
      moment += parts[k][0] * parts[k][1];
      own += parts[k][2];
    }
    if (area <= 0) throw new Error('截面积必须为正');
    const yBar = moment / area;
    let inertia = own;
    for (let k = 0; k < parts.length; k++) {
      inertia += parts[k][0] * Math.pow(parts[k][1] - yBar, 2);
    }
    return { area: area, yBar: yBar, inertia: inertia };
  }

  /** 截面基类 */
  class Section {
    constructor(key, label, material) {
      this.key = key;
      this.label = label;
      this.material = material;
      this.area = 0;
      this.inertia = 0;
      this.inertia_weak = 0;
      this.torsion = 0;
      this.depth = 0;
      this.c_top = 0;
      this.c_bottom = 0;
      this.developed_width = 0;
      this.mass_per_line = 0;
      this.buckling_k = 4.0;
      this.buckling_b = 0.0;
      this.buckling_t = 0.0;
      this.shear_area = 0.0;
    }

    /** 子类设置完几何参数后调用：算派生量 + 线密度 + 合法性校验 */
    finish() {
      this.compute();
      this.mass_per_line = this.material.area_density * this.developed_width;
      if (!(this.area > 0) || !(this.inertia > 0)) {
        throw new Error('截面 ' + this.key + ' 计算结果非法');
      }
      return this;
    }

    compute() { throw new Error('子类需实现 compute()'); }

    /** 单层厚度（0 表示用材料厚度） */
    ply(t) { return t || this.material.ply_thickness; }

    get flexural_rigidity() { return this.material.E * this.inertia; }
    get axial_rigidity() { return this.material.E * this.area; }
    get modulus_bottom() { return this.inertia / this.c_bottom; }
    get modulus_top() { return this.inertia / this.c_top; }
    get height_to_thickness() { return this.buckling_t > 0 ? this.depth / this.buckling_t : 0.0; }

    /** 受压翼缘宽厚比 b/t */
    flangeSlenderness() {
      return this.buckling_t > 0 ? this.buckling_b / this.buckling_t : 0.0;
    }

    describe() {
      return this.label + '：A=' + (this.area * 1e6).toFixed(2) + ' mm²，I=' +
        (this.inertia * 1e12).toFixed(3) + ' mm⁴，截面高 d=' + (this.depth * 1e3).toFixed(1) +
        ' mm，线密度=' + (this.mass_per_line * 1e3).toFixed(2) + ' g/m，展开用纸=' +
        (this.developed_width * 1e2).toFixed(1) + ' cm';
    }
  }

  /** 1. 单层平板条：刚度最低，对照组 */
  class SolidStrip extends Section {
    constructor(material, opts) {
      const o = opts || {};
      super('solid', o.label || '平板桥面（单层纸）', material);
      this.width = o.width !== undefined ? o.width : 0.15;
      this.thickness = o.thickness !== undefined ? o.thickness : 0.0;
      this.finish();
    }

    compute() {
      const t = this.ply(this.thickness), b = this.width;
      this.area = b * t;
      this.inertia = b * Math.pow(t, 3) / 12.0;
      this.inertia_weak = t * Math.pow(b, 3) / 12.0;
      this.torsion = b * Math.pow(t, 3) / 3.0 * (1.0 - 0.63 * t / b);
      this.depth = t;
      this.c_top = this.c_bottom = t / 2.0;
      this.developed_width = b;
      // 实心截面没有"两侧有支承的薄壁板件"，不做局部屈曲判定（buckling_b=0 表示不适用）
      this.buckling_k = 4.0;
      this.buckling_b = 0.0;
      this.buckling_t = t;
      // 矩形截面最大剪应力为平均值的 1.5 倍 → 等效剪切面积 = 2/3·A
      this.shear_area = 2.0 * b * t / 3.0;
    }
  }

  /** 2. 多层复合：glued 决定层间是否共同工作（刚度差 n² 倍） */
  class Laminate extends Section {
    constructor(material, opts) {
      const o = opts || {};
      super('laminate', o.label || '多层复合梁', material);
      this.width = o.width !== undefined ? o.width : 0.15;
      this.layers = o.layers !== undefined ? o.layers : 3;
      this.glued = o.glued !== undefined ? o.glued : true;
      this.thickness = o.thickness !== undefined ? o.thickness : 0.0;
      this.finish();
    }

    compute() {
      const t = this.ply(this.thickness), b = this.width, n = Math.max(1, Math.floor(this.layers));
      this.area = b * t * n;
      this.inertia = this.glued
        ? b * Math.pow(n * t, 3) / 12.0
        : n * b * Math.pow(t, 3) / 12.0;
      this.buckling_k = 4.0;
      this.buckling_b = 0.0;
      this.inertia_weak = this.glued
        ? (n * t) * Math.pow(b, 3) / 12.0
        : n * t * Math.pow(b, 3) / 12.0;
      this.torsion = this.glued
        ? b * Math.pow(n * t, 3) / 3.0 * (1.0 - 0.63 * (n * t) / b)
        : n * b * Math.pow(t, 3) / 3.0;
      this.depth = n * t;
      this.c_top = this.c_bottom = this.depth / 2.0;
      this.developed_width = b * n;
      this.buckling_t = this.glued ? n * t : t;
      this.shear_area = 2.0 * this.area / 3.0;
    }
  }

  /** 3. 卷成的圆管梁：抗扭好，但壁薄易局部起皱 */
  class Tube extends Section {
    constructor(material, opts) {
      const o = opts || {};
      super('tube', o.label || '圆管梁', material);
      this.diameter = o.diameter !== undefined ? o.diameter : 0.03;
      this.thickness = o.thickness !== undefined ? o.thickness : 0.0;
      this.finish();
    }

    compute() {
      const t = this.ply(this.thickness), D = this.diameter, d = D - 2.0 * t;
      if (d <= 0) throw new Error('管壁厚度不能大于半径');
      this.area = Math.PI / 4.0 * (D * D - d * d);
      this.inertia = Math.PI / 64.0 * (Math.pow(D, 4) - Math.pow(d, 4));
      this.inertia_weak = this.inertia;
      this.torsion = 2.0 * this.inertia;      // 圆截面 J = Ix + Iy = 2I
      this.depth = D;
      this.c_top = this.c_bottom = D / 2.0;
      this.developed_width = Math.PI * (D - t);
      // 薄壁圆柱受弯起皱：等效平板宽度 b = 1.73·√(R·t)
      const R = (D - t) / 2.0;
      this.buckling_k = 4.0;
      this.buckling_b = 1.73 * Math.sqrt(R * t);
      this.buckling_t = t;
      this.shear_area = this.area / 2.0;      // 薄壁圆管最大剪应力为平均值的 2 倍
    }
  }

  /** 4. 折叠梁（U形/工形/箱形）：纸桥能站住的关键 */
  class FoldedBeam extends Section {
    constructor(material, opts) {
      const o = opts || {};
      super('folded', o.label || '折叠梁（U形/箱形）', material);
      this.width = o.width !== undefined ? o.width : 0.15;
      this.depth = o.depth !== undefined ? o.depth : 0.04;
      this.thickness = o.thickness !== undefined ? o.thickness : 0.0;
      this.web_count = o.web_count !== undefined ? o.web_count : 2;
      this.fold_panels = o.fold_panels !== undefined ? o.fold_panels : 6;
      this.finish();
    }

    compute() {
      const t = this.ply(this.thickness), b = this.width, d = this.depth;
      if (d <= 2 * t) throw new Error('折出的截面高度必须大于两倍纸厚');
      const web_h = d - 2.0 * t;
      const y_f = (d - t) / 2.0;

      const parts = [];
      const flangeArea = b * t;
      [1.0, -1.0].forEach(function (sign) {
        parts.push([flangeArea, sign * y_f, b * Math.pow(t, 3) / 12.0]);
      });
      const webs = Math.max(1, Math.floor(this.web_count));
      for (let k = 0; k < webs; k++) {
        // 腹板在宽度方向的位置不影响竖向抗弯
        parts.push([web_h * t, 0.0, t * Math.pow(web_h, 3) / 12.0]);
      }
      const comp = compositeProperties(parts);
      this.area = comp.area;
      this.inertia = comp.inertia;

      // 弱轴
      const iyFlange = 2.0 * (t * Math.pow(b, 3) / 12.0);
      const iyWeb = this.web_count === 1
        ? web_h * Math.pow(t, 3) / 12.0
        : 2.0 * (web_h * Math.pow(t, 3) / 12.0 + web_h * t * Math.pow(b / 2.0, 2));
      this.inertia_weak = iyFlange + iyWeb;

      // 扭转常数：闭口箱形约为开口槽形的几十倍
      if (this.web_count === 2) {
        const a_m = Math.max(b - t, 1e-6);
        this.torsion = 4.0 * a_m * a_m * web_h * web_h * t / (2.0 * (a_m + web_h));
      } else {
        this.torsion = (2.0 * b * Math.pow(t, 3) + web_h * Math.pow(t, 3)) / 3.0;
      }

      this.depth = d;
      this.c_top = this.c_bottom = d / 2.0;
      this.developed_width = 2.0 * b + this.web_count * web_h;

      // 受压翼缘板件：分格后被折痕/腹板支承在两侧 → k≈4
      const panels = Math.max(1, Math.floor(this.fold_panels));
      const panel_w = b / panels;
      if (panels >= 2 || this.web_count === 2) {
        this.buckling_k = 4.0;
        this.buckling_b = Math.max(panel_w - t, t);
      } else {
        // 单块腹板 + 不折分格：板件一边自由
        this.buckling_k = 0.43;
        this.buckling_b = Math.max(panel_w / 2.0, t);
      }
      this.buckling_t = t;
      this.shear_area = Math.max(1, Math.floor(this.web_count)) * web_h * t;
    }
  }

  const SECTION_KINDS = ['solid', 'laminate', 'tube', 'folded'];

  const SECTION_LABELS = {
    solid: '平板桥面（单层纸）',
    laminate: '多层复合梁',
    tube: '圆管梁',
    folded: '折叠梁（U形/箱形）',
  };

  /** 按类型创建截面。material 可以是材料对象或 key。 */
  function makeSection(kind, material, opts) {
    const mat = typeof material === 'string' ? Mat.get(material) : material;
    if (kind === 'solid') return new SolidStrip(mat, opts);
    if (kind === 'laminate') return new Laminate(mat, opts);
    if (kind === 'tube') return new Tube(mat, opts);
    if (kind === 'folded') return new FoldedBeam(mat, opts);
    throw new Error('未知截面类型 ' + JSON.stringify(kind) + '，可选：' + SECTION_KINDS.join(', '));
  }

  PB.Sections = {
    compositeProperties: compositeProperties,
    Section: Section,
    SolidStrip: SolidStrip,
    Laminate: Laminate,
    Tube: Tube,
    FoldedBeam: FoldedBeam,
    SECTION_KINDS: SECTION_KINDS,
    SECTION_LABELS: SECTION_LABELS,
    make: makeSection,
  };
})(globalThis.PB = globalThis.PB || {});

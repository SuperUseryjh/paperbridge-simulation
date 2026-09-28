/**
 * 加载实验与方案对比（Python 版 paperbridge/experiment.py 的 JS 移植）。
 *
 * runLoadTest    —— 逐级加载，给出载荷–挠度曲线数据点，直到极限承载力；
 * compareStructures —— 同一条件下跑多套方案并排序。
 *
 * 本模型为小变形线弹性，位移与载荷成正比，所以"加载动画"只需按载荷比例
 * 连续求解，无需时间积分。
 */
(function (PB) {
  'use strict';

  const Fail = PB.Failure;
  const Str = PB.Structures;
  const G = PB.Materials.G;

  /** 一级载荷下的结果快照 */
  class LoadStep {
    constructor(liveLoad, maxDeflection, deflectionRatio, maxUtilization, mode) {
      this.live_load = liveLoad;
      this.max_deflection = maxDeflection;
      this.deflection_ratio = deflectionRatio;
      this.max_utilization = maxUtilization;
      this.mode = mode;
    }

    failed() { return this.max_utilization >= 1.0; }

    /** 该级载荷对应的砝码质量 kg */
    equivalentMass() { return this.live_load / G; }
  }

  /** 一次完整加载实验的结果 */
  class LoadTestResult {
    constructor(design, limitLoad, limitReport, selfWeightSafe, solves) {
      this.design = design;
      this.steps = [];
      this.limit_load = limitLoad;
      this.limit_report = limitReport;
      this.self_weight_safe = selfWeightSafe;
      this.solves = solves || 0;
    }

    failureMode() {
      return (this.limit_report && this.limit_report.governing)
        ? this.limit_report.governing.mode : '—';
    }

    /** 载荷–挠度曲线的数据点（N 与 mm） */
    curve() {
      return {
        loads: this.steps.map(function (s) { return s.live_load; }),
        deflections: this.steps.map(function (s) { return s.max_deflection * 1e3; }),
      };
    }

    /** 初始刚度 N/mm（曲线前两点的割线斜率） */
    stiffness() {
      for (let i = 0; i + 1 < this.steps.length; i++) {
        const a = this.steps[i], b = this.steps[i + 1];
        if (b.max_deflection > a.max_deflection) {
          return (b.live_load - a.live_load) / ((b.max_deflection - a.max_deflection) * 1e3);
        }
      }
      return 0.0;
    }

    summaryLines() {
      if (!this.self_weight_safe) {
        return ['仅自重就已使结构超过挠度/强度限值：这张桥撑不住自己。'];
      }
      const lines = [
        '极限活载 ≈ ' + this.limit_load.toFixed(3) + ' N（砝码 ~' +
        (this.limit_load / G * 1e3).toFixed(1) + ' g）',
        '控制失效模式：' + this.failureMode(),
        '初始刚度 ≈ ' + this.stiffness().toFixed(2) + ' N/mm',
      ];
      if (this.limit_report) lines.push.apply(lines, this.limit_report.summaryLines().slice(1));
      return lines;
    }
  }

  /** 方案对比表中的一行 */
  class ComparisonRow {
    constructor(label, design, limitLoad, failureMode, limitDeflection,
      structureMass, paperArea, selfWeightSafe) {
      this.label = label;
      this.design = design;
      this.limit_load = limitLoad;
      this.failure_mode = failureMode;
      this.limit_deflection = limitDeflection;
      this.structure_mass = structureMass;
      this.paper_area = paperArea;
      this.self_weight_safe = selfWeightSafe === undefined ? true : selfWeightSafe;
    }

    limitMass() { return this.limit_load / G; }

    /** 承重比 = 极限活载 / 自重 */
    loadRatio() {
      const weight = this.structure_mass * G;
      return weight > 0 ? this.limit_load / weight : 0.0;
    }

    /** 材料效率 = 极限活载 / 用纸面积 (N/m²) */
    efficiency() {
      return this.paper_area > 0 ? this.limit_load / this.paper_area : 0.0;
    }
  }

  /** 逐级加载实验：先二分求极限，再在 0~极限 间等分 steps 级逐一分析 */
  function runLoadTest(design, steps, limit) {
    steps = steps === undefined ? 20 : steps;
    if (steps < 2) throw new Error('加载级数至少为 2');

    const lim = limit || Fail.findLimitLoad(design);
    const result = new LoadTestResult(design, lim.limit_load, lim.report,
      lim.self_weight_safe, lim.solves);
    if (!lim.self_weight_safe) return result;

    for (let i = 0; i <= steps; i++) {
      const load = lim.limit_load * i / steps;
      const a = Fail.analyze(design.copyWith({ live_load: load }));
      result.solves += 1;
      const gov = a.report.governing;
      result.steps.push(new LoadStep(load, Math.abs(a.result.maxDeflection),
        a.report.deflection_ratio, a.report.max_utilization, gov ? gov.mode : '—'));
    }
    return result;
  }

  /** 同一材料/跨长/布载下对比各方案，按极限承载力降序（自建结构会自动加入） */
  function compareStructures(base, structures, limitCache) {
    structures = structures || ['flat', 'laminate', 'tube', 'folded', 'truss', 'arch'];
    const keys = structures.slice();
    if (base.structure === 'custom' && base.custom && keys.indexOf('custom') < 0) {
      keys.push('custom');
    }
    const rows = [];
    keys.forEach(function (key) {
      const d = base.copyWith({ structure: key, live_load: 0.0 });
      let lim = limitCache ? limitCache[key] : null;
      if (!lim) {
        lim = Fail.findLimitLoad(d);
        if (limitCache) limitCache[key] = lim;
      }
      const model = Str.buildModel(d);
      const label = key === 'custom'
        ? '★ 你的自建结构'
        : (Str.STRUCTURE_LABELS[key] || key);
      rows.push(new ComparisonRow(label, d, lim.limit_load,
        lim.report.governing ? lim.report.governing.mode : '—',
        lim.report.max_deflection, model.totalMass(), model.totalPaperArea(),
        lim.self_weight_safe));
    });
    rows.sort(function (a, b) { return b.limit_load - a.limit_load; });
    return rows;
  }

  PB.Experiment = {
    LoadStep: LoadStep,
    LoadTestResult: LoadTestResult,
    ComparisonRow: ComparisonRow,
    runLoadTest: runLoadTest,
    compareStructures: compareStructures,
  };
})(globalThis.PB = globalThis.PB || {});

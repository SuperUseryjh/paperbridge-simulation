/**
 * 失效判定与极限承载力（Python 版 paperbridge/failure.py 的 JS 移植）。
 *
 * 对每个单元计算利用率 UR = 实际需求 / 许用极限，UR ≥ 1 即失效。7 类失效模式：
 * 受拉断裂 / 受压压溃 / 薄壁局部屈曲 / 杆件欧拉失稳 / 整体侧向扭转屈曲 /
 * 层间剪切破坏 / 挠度过大。
 *
 * 极限承载力：模型线性、自重固定、活载按比例放大 ⇒ UR(活载) 单调递增；
 * 先用倍增法找上界，再二分求 UR = 1 的活载。
 */
(function (PB) {
  'use strict';

  const Mat = PB.Materials;
  const Str = PB.Structures;
  const G = Mat.G;

  // 使用性极限：跨中挠度不得超过跨长的 1/50
  const DEFLECTION_LIMIT_RATIO = 1.0 / 50.0;
  const EULER_K = 1.0;

  const MODE_TENSION = '受拉断裂';
  const MODE_CRUSH = '受压压溃';
  const MODE_LOCAL_BUCKLE = '薄壁局部屈曲';
  const MODE_EULER = '杆件欧拉失稳';
  const MODE_LTB = '整体侧向扭转屈曲';
  const MODE_SHEAR = '层间剪切破坏';
  const MODE_DEFLECTION = '挠度过大';
  const MODE_ORDER = [MODE_TENSION, MODE_CRUSH, MODE_LOCAL_BUCKLE, MODE_EULER,
    MODE_LTB, MODE_SHEAR, MODE_DEFLECTION];

  /** 一次利用率检查 */
  class FailureCheck {
    constructor(element, role, mode, utilization, demand, limit, unit, note) {
      this.element = element;
      this.role = role;
      this.mode = mode;
      this.utilization = utilization;
      this.demand = demand;
      this.limit = limit;
      this.unit = unit;
      this.note = note || '';
    }

    failed() { return this.utilization >= 1.0; }

    line() {
      return '[' + this.mode + '] ' + this.role + ' 单元' + this.element + '：' +
        this.demand.toPrecision(3) + ' / ' + this.limit.toPrecision(3) + ' ' + this.unit +
        ' = 利用率 ' + (this.utilization * 100).toFixed(1) + '%' +
        (this.note ? '（' + this.note + '）' : '');
    }
  }

  /** 一次完整分析的安全评定结果 */
  class FailureReport {
    constructor() {
      this.checks = [];            // 每个单元的最不利检查
      this.all_checks = [];        // 全部检查条目
      this.max_utilization = 0.0;
      this.governing = null;
      this.by_element = {};
      this.deflection_ratio = 0.0;
      this.deflection_limit_ratio = DEFLECTION_LIMIT_RATIO;
      this.max_deflection = 0.0;
      this.span = 0.0;
      this.live_load = 0.0;
      this.self_weight = 0.0;
    }

    safe() { return this.max_utilization < 1.0; }

    safetyFactor() {
      if (this.max_utilization <= 0) return Infinity;
      return 1.0 / this.max_utilization;
    }

    utilizationOf(element) {
      const v = this.by_element[element];
      return v === undefined ? 0.0 : v;
    }

    topChecks(n) {
      n = n === undefined ? 6 : n;
      return this.all_checks.slice().sort(function (a, b) {
        return b.utilization - a.utilization;
      }).slice(0, n);
    }

    failureModes() {
      const out = {};
      this.checks.forEach(function (c) { out[c.mode] = (out[c.mode] || 0) + 1; });
      return out;
    }

    summaryLines() {
      const lines = [
        '活载 ' + this.live_load.toFixed(3) + ' N（自重 ' + (this.self_weight * 1000).toFixed(2) + ' g）',
        '最大挠度 ' + (this.max_deflection * 1e3).toFixed(3) + ' mm（跨长 ' +
        (this.span * 1e3).toFixed(0) + ' mm 的 ' + (this.deflection_ratio * 100).toFixed(2) +
        '%，限值 ' + (this.deflection_limit_ratio * 100).toFixed(1) + '%）',
        '最大利用率 ' + (this.max_utilization * 100).toFixed(1) + '%，安全系数 ' +
        this.safetyFactor().toFixed(2),
      ];
      if (this.governing) lines.push('控制失效：' + this.governing.line());
      return lines;
    }
  }

  /** 极限承载力搜索结果 */
  class LimitLoadResult {
    constructor(design, limitLoad, report, selfWeightSafe, solves) {
      this.design = design;
      this.limit_load = limitLoad;
      this.report = report;
      this.self_weight_safe = selfWeightSafe;
      this.solves = solves || 0;
    }

    limitMass() { return this.limit_load / G; }

    summary() {
      if (!this.self_weight_safe) {
        return '仅自重就已超限：这张纸桥撑不住自己的重量。';
      }
      const mode = (this.report && this.report.governing) ? this.report.governing.mode : '—';
      return '极限活载 ≈ ' + this.limit_load.toFixed(3) + ' N（约 ' +
        (this.limitMass() * 1e3).toFixed(1) + ' g），控制失效模式：' + mode;
    }
  }

  // ---- 屈曲临界值 ----
  /** 受压翼缘的弹性局部屈曲应力 σ_cr = kπ²E/(12(1-ν²))·(t/b)² */
  function localBucklingStress(section) {
    const mat = section.material;
    const t = section.buckling_t, b = section.buckling_b;
    if (!(t > 0) || !(b > 0)) return Infinity;
    return section.buckling_k * Math.PI * Math.PI * mat.E /
      (12.0 * (1.0 - mat.nu * mat.nu)) * Math.pow(t / b, 2);
  }

  /** 整体侧向扭转屈曲临界弯矩 M_cr = π/L_b·√(EI_y·GJ) */
  function lateralTorsionalMoment(section, unbracedLength) {
    const mat = section.material;
    if (!(unbracedLength > 0)) return Infinity;
    const GJ = mat.G_shear * section.torsion;
    const EIy = mat.E * section.inertia_weak;
    if (!(GJ > 0) || !(EIy > 0)) return Infinity;
    return Math.PI / unbracedLength * Math.sqrt(EIy * GJ);
  }

  /** 两端铰接压杆的欧拉临界力 P_cr = π²EI/(KL)² */
  function eulerBucklingLoad(section, length, kFactor) {
    kFactor = kFactor === undefined ? EULER_K : kFactor;
    if (!(length > 0)) return Infinity;
    return Math.PI * Math.PI * section.flexural_rigidity / Math.pow(kFactor * length, 2);
  }

  /** 对已求解的模型做全面失效判定 */
  function evaluate(model, result, design) {
    const roles = model.meta.roles || {};
    const span = design.span;
    const report = new FailureReport();
    report.deflection_limit_ratio = DEFLECTION_LIMIT_RATIO;
    report.span = span;
    report.live_load = design.live_load;
    report.self_weight = model.totalMass();

    result.elementForces.forEach(function (ef, idx) {
      const e = model.elements[idx];
      const sec = e.section;
      const mat = sec.material;
      const roleKey = roles[idx] !== undefined ? roles[idx] : Str.ROLE_DECK;
      const role = Str.ROLE_LABELS[roleKey] || roleKey;
      const L = model.elementGeometry(idx).L;
      const area = sec.area, inertia = sec.inertia;

      const localCr = localBucklingStress(sec);
      const checks = [];

      // --- 1/2/3. 上下缘正应力：受拉断裂、受压压溃、薄壁局部屈曲 ---
      [ef.moment_min, ef.moment_max].forEach(function (M) {
        [['下缘', sec.c_bottom], ['上缘', sec.c_top]].forEach(function (fb) {
          const fiber = fb[0], c = fb[1];
          const sigma = ef.axial / area + (fiber === '下缘' ? M : -M) * c / inertia;
          let limit, mode, note;
          if (sigma >= 0.0) {
            limit = mat.sigma_t; mode = MODE_TENSION; note = fiber + '受拉';
          } else if (mat.sigma_c <= localCr) {
            limit = mat.sigma_c; mode = MODE_CRUSH; note = fiber + '受压';
          } else {
            limit = localCr; mode = MODE_LOCAL_BUCKLE;
            note = fiber + '受压起皱（b/t=' + sec.flangeSlenderness().toFixed(0) + '）';
          }
          checks.push(new FailureCheck(idx, role, mode, Math.abs(sigma) / limit,
            Math.abs(sigma), limit, 'Pa', note));
        });
      });

      // --- 4. 压杆欧拉失稳 ---
      if (ef.axial < 0.0) {
        const pCr = eulerBucklingLoad(sec, L);
        checks.push(new FailureCheck(idx, role, MODE_EULER, -ef.axial / pCr, -ef.axial, pCr,
          'N', '计算长度 ' + (L * 1e3).toFixed(1) + ' mm'));
      }

      // --- 5. 整体侧向扭转屈曲 ---
      const Lb = ([Str.ROLE_DECK, Str.ROLE_CHORD, Str.ROLE_ARCH].indexOf(roleKey) >= 0) ? span : L;
      const mCr = lateralTorsionalMoment(sec, Lb);
      const mAbs = Math.max(Math.abs(ef.moment_min), Math.abs(ef.moment_max));
      if (mAbs > 0 && mCr < Infinity) {
        checks.push(new FailureCheck(idx, role, MODE_LTB, mAbs / mCr, mAbs, mCr,
          'N·m', '侧向无支撑长度 ' + (Lb * 1e3).toFixed(0) + ' mm'));
      }

      // --- 6. 层间剪切 ---
      const vJ = ef.shear_i + ef.distributed * L;
      const vMax = Math.max(Math.abs(ef.shear_i), Math.abs(vJ));
      const tau = sec.shear_area > 0 ? vMax / sec.shear_area : Infinity;
      checks.push(new FailureCheck(idx, role, MODE_SHEAR, tau / mat.tau_allow, tau,
        mat.tau_allow, 'Pa', '剪力 ' + vMax.toPrecision(3) + ' N'));

      let worst = checks[0];
      checks.forEach(function (c) { if (c.utilization > worst.utilization) worst = c; });
      report.checks.push(worst);
      checks.forEach(function (c) { report.all_checks.push(c); });
      report.by_element[idx] = worst.utilization;
    });

    // --- 7. 挠度（使用性） ---
    const wMax = Math.abs(result.maxDeflection);
    const ratio = span > 0 ? wMax / span : 0.0;
    report.max_deflection = wMax;
    report.deflection_ratio = ratio;
    report.all_checks.push(new FailureCheck(-1, '整体', MODE_DEFLECTION,
      ratio / DEFLECTION_LIMIT_RATIO, ratio, DEFLECTION_LIMIT_RATIO, '挠跨比',
      '最大挠度 ' + (wMax * 1e3).toFixed(3) + ' mm'));

    let gov = report.all_checks[0];
    report.all_checks.forEach(function (c) { if (c.utilization > gov.utilization) gov = c; });
    report.governing = gov;
    report.max_utilization = gov.utilization;
    return report;
  }

  /** 一次完整分析：建模 → 求解 → 失效判定 */
  function analyze(design) {
    const model = Str.buildModel(design);
    const result = model.solve();
    const report = evaluate(model, result, design);
    return { design: design, model: model, result: result, report: report };
  }

  /** 把活载设为 liveLoad 重新分析，返回 {utilization, report, analysis} */
  function utilizationAtLive(design, liveLoad) {
    const d = design.copyWith({ live_load: liveLoad });
    const a = analyze(d);
    return { utilization: a.report.max_utilization, report: a.report, analysis: a };
  }

  /** 求极限活载：UR(λ) = 1 对应的活载 */
  function findLimitLoad(design, upper, tol, maxIter) {
    upper = upper === undefined ? 200.0 : upper;
    tol = tol === undefined ? 1e-3 : tol;
    let solves = 0;

    // 1) 仅自重
    const first = utilizationAtLive(design, 0.0);
    solves += 1;
    if (first.utilization >= 1.0) {
      return new LimitLoadResult(design, 0.0, first.report, false, solves);
    }

    // 2) 倍增找上界
    let hi = Math.max(1e-3, Math.min(upper, design.span));
    let state = utilizationAtLive(design, hi);
    solves += 1;
    while (state.utilization < 1.0) {
      if (hi >= upper) {
        return new LimitLoadResult(design, upper, state.report, true, solves);
      }
      hi = Math.min(upper, hi * 2.0);
      state = utilizationAtLive(design, hi);
      solves += 1;
    }
    let repHi = state.report;

    // 3) 二分
    let lo = 0.0;
    while (hi - lo > tol * Math.max(1.0, hi)) {
      const mid = 0.5 * (lo + hi);
      const s = utilizationAtLive(design, mid);
      solves += 1;
      if (s.utilization >= 1.0) { hi = mid; repHi = s.report; } else { lo = mid; }
    }
    return new LimitLoadResult(design, hi, repHi, true, solves);
  }

  PB.Failure = {
    DEFLECTION_LIMIT_RATIO: DEFLECTION_LIMIT_RATIO,
    EULER_K: EULER_K,
    MODE_TENSION: MODE_TENSION, MODE_CRUSH: MODE_CRUSH,
    MODE_LOCAL_BUCKLE: MODE_LOCAL_BUCKLE, MODE_EULER: MODE_EULER,
    MODE_LTB: MODE_LTB, MODE_SHEAR: MODE_SHEAR, MODE_DEFLECTION: MODE_DEFLECTION,
    MODE_ORDER: MODE_ORDER,
    FailureCheck: FailureCheck,
    FailureReport: FailureReport,
    LimitLoadResult: LimitLoadResult,
    localBucklingStress: localBucklingStress,
    lateralTorsionalMoment: lateralTorsionalMoment,
    eulerBucklingLoad: eulerBucklingLoad,
    evaluate: evaluate,
    analyze: analyze,
    utilizationAtLive: utilizationAtLive,
    findLimitLoad: findLimitLoad,
  };
})(globalThis.PB = globalThis.PB || {});

/**
 * 梁弯曲解析解（Python 版 paperbridge/beam.py 的 JS 移植）。
 *
 * 用途：1) 直接给出经典工况的挠度曲线/弯矩图/剪力图与支座反力；
 *       2) 校验有限元结果。
 *
 * 符号约定（全系统统一，与 Python 版一致）
 *  - w 向下挠度为正；
 *  - 弯矩 M 以下缘受拉为正；
 *  - 剪力 V = dM/dx；
 *  - 载荷 q（N/m）、集中力 P（N）均向下为正。
 */
(function (PB) {
  'use strict';

  /** 采样横坐标 */
  function grid(L, n) {
    if (n < 2) throw new Error('采样点数至少为 2');
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = L * i / (n - 1);
    return out;
  }

  /** 近似 Python 的 "%.3g" 格式化（用于 case 说明文字保持一致） */
  function g3(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a < 1e-4 || a >= 1e3) {
      return v.toExponential(2).replace(/e([+-])(\d)$/, 'e$10$2');
    }
    return String(Number(v.toPrecision(3)));
  }

  /** 结果对象：x / w / moment / shear / reactions / case */
  function makeResult(x, w, moment, shear, reactions, name) {
    return {
      x: x, w: w, moment: moment, shear: shear,
      reactions: reactions, case: name,
      /** 最大挠度（取绝对值最大处的带符号值） */
      wMax: function () {
        let best = 0;
        for (let i = 0; i < this.w.length; i++) {
          if (Math.abs(this.w[i]) > Math.abs(best)) best = this.w[i];
        }
        return best;
      },
      momentMax: function () {
        let best = 0;
        for (let i = 0; i < this.moment.length; i++) {
          if (Math.abs(this.moment[i]) > Math.abs(best)) best = this.moment[i];
        }
        return best;
      },
      shearMax: function () {
        let best = 0;
        for (let i = 0; i < this.shear.length; i++) {
          if (Math.abs(this.shear[i]) > Math.abs(best)) best = this.shear[i];
        }
        return best;
      },
      /** 线性插值取某截面的结果 */
      at: function (x) {
        if (!this.x.length) throw new Error('结果为空');
        let i, t;
        if (x <= this.x[0]) {
          i = 0; t = 0.0;
        } else if (x >= this.x[this.x.length - 1]) {
          i = this.x.length - 2; t = 1.0;
        } else {
          i = Math.max(0, Math.min(this.x.length - 2,
            Math.trunc(x / (this.x[this.x.length - 1] - this.x[0]) * (this.x.length - 1))));
          while (i + 1 < this.x.length - 1 && this.x[i + 1] < x) i += 1;
          const span = this.x[i + 1] - this.x[i];
          t = span === 0 ? 0.0 : (x - this.x[i]) / span;
        }
        return {
          w: this.w[i] * (1 - t) + this.w[i + 1] * t,
          moment: this.moment[i] * (1 - t) + this.moment[i + 1] * t,
          shear: this.shear[i] * (1 - t) + this.shear[i + 1] * t,
        };
      },
    };
  }

  function addResults(a, b, reactions, name) {
    const w = [], M = [], V = [];
    for (let i = 0; i < a.x.length; i++) {
      w.push(a.w[i] + b.w[i]);
      M.push(a.moment[i] + b.moment[i]);
      V.push(a.shear[i] + b.shear[i]);
    }
    return makeResult(a.x, w, M, V, reactions, name);
  }

  // ---- 简支梁 ----
  function simplySupportedPoint(L, P, EI, a, n) {
    if (!(L > 0) || !(EI > 0)) throw new Error('L 与 EI 必须为正');
    n = n || 201;
    a = (a === null || a === undefined) ? L / 2.0 : Math.min(Math.max(a, 0.0), L);
    const b = L - a;
    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      let m, d, v;
      if (x <= a) {
        m = P * b * x / L;
        d = P * b * x * (L * L - b * b - x * x) / (6.0 * L * EI);
        v = P * b / L;
      } else {
        m = P * a * (L - x) / L;
        d = P * a * (L - x) * (2.0 * L * x - x * x - a * a) / (6.0 * L * EI);
        v = -P * a / L;
      }
      w.push(d); M.push(m); V.push(v);
    }
    return makeResult(xs, w, M, V, { RA: P * b / L, RB: P * a / L },
      '简支梁 + 集中力 ' + g3(P) + ' N @ x=' + g3(a) + ' m');
  }

  function simplySupportedUdl(L, q, EI, n) {
    if (!(L > 0) || !(EI > 0)) throw new Error('L 与 EI 必须为正');
    n = n || 201;
    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      w.push(q * x * (Math.pow(L, 3) - 2.0 * L * x * x + Math.pow(x, 3)) / (24.0 * EI));
      M.push(q * x * (L - x) / 2.0);
      V.push(q * (L / 2.0 - x));
    }
    return makeResult(xs, w, M, V, { RA: q * L / 2.0, RB: q * L / 2.0 },
      '简支梁 + 均布载荷 ' + g3(q) + ' N/m');
  }

  function simplySupportedTwoPoint(L, P, EI, spanRatio, n) {
    spanRatio = spanRatio === undefined ? 1.0 / 3.0 : spanRatio;
    if (!(spanRatio > 0.0 && spanRatio < 1.0)) throw new Error('span_ratio 必须在 (0,1) 内');
    const a = (L - spanRatio * L) / 2.0;
    const left = simplySupportedPoint(L, P, EI, a, n);
    const right = simplySupportedPoint(L, P, EI, L - a, n);
    return addResults(left, right, { RA: P, RB: P },
      '简支梁 + 两点加载 ' + g3(P) + ' N（间距 ' + spanRatio.toFixed(2) + 'L）');
  }

  // ---- 悬臂梁 ----
  function cantileverEndPoint(L, P, EI, n) {
    n = n || 201;
    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      w.push(P * x * x * (3.0 * L - x) / (6.0 * EI));
      M.push(-P * (L - x));
      V.push(P);
    }
    return makeResult(xs, w, M, V, { M_fix: -P * L, R_fix: P },
      '悬臂梁 + 端部集中力 ' + g3(P) + ' N');
  }

  function cantileverUdl(L, q, EI, n) {
    n = n || 201;
    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      w.push(q * x * x * (6.0 * L * L - 4.0 * L * x + x * x) / (24.0 * EI));
      M.push(-q * Math.pow(L - x, 2) / 2.0);
      V.push(q * (L - x));
    }
    return makeResult(xs, w, M, V, { M_fix: -q * L * L / 2.0, R_fix: q * L },
      '悬臂梁 + 均布载荷 ' + g3(q) + ' N/m');
  }

  function cantileverPoint(L, P, EI, a, n) {
    n = n || 201;
    a = Math.min(Math.max(a, 1e-9), L);
    const xs = grid(Math.max(L, a), n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (x <= a) {
        w.push(P * x * x * (3.0 * a - x) / (6.0 * EI));
        M.push(-P * (a - x));
        V.push(P);
      } else {
        w.push(P * a * a * (3.0 * x - a) / (6.0 * EI));
        M.push(0.0);
        V.push(0.0);
      }
    }
    return makeResult(xs, w, M, V, { M_fix: -P * a, R_fix: P },
      '悬臂梁 + 距固端 ' + g3(a) + ' m 处集中力 ' + g3(P) + ' N');
  }

  function cantileverTwoPoint(L, P, spanRatio, EI, n) {
    const a1 = L * (1.0 - spanRatio) / 2.0;
    const a2 = L * (1.0 + spanRatio) / 2.0;
    const r1 = cantileverPoint(L, P, EI, a1, n);
    const r2 = cantileverPoint(L, P, EI, a2, n);
    return addResults(r1, r2, { M_fix: -(P * a1 + P * a2), R_fix: 2.0 * P },
      '悬臂梁 + 两点加载 ' + g3(P) + ' N×2');
  }

  // ---- 两端固支 ----
  function fixedFixedUdl(L, q, EI, n) {
    n = n || 201;
    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      w.push(q * x * x * Math.pow(L - x, 2) / (24.0 * EI));
      M.push(q * (L * L / 12.0 - L * x / 2.0 + x * x / 2.0));
      V.push(q * (L / 2.0 - x));
    }
    return makeResult(xs, w, M, V,
      { M_A: -q * L * L / 12.0, M_B: -q * L * L / 12.0, RA: q * L / 2.0, RB: q * L / 2.0 },
      '两端固支 + 均布载荷 ' + g3(q) + ' N/m');
  }

  function fixedFixedPointAt(L, P, EI, a, n) {
    if (!(L > 0) || !(EI > 0)) throw new Error('L 与 EI 必须为正');
    n = n || 201;
    a = Math.min(Math.max(a, 1e-9), L - 1e-9);
    const b = L - a;
    const M_A = -P * a * b * b / (L * L);
    const M_B = -P * a * a * b / (L * L);
    const R_A = P * b * b * (3.0 * a + b) / Math.pow(L, 3);
    const R_B = P * a * a * (a + 3.0 * b) / Math.pow(L, 3);

    const xs = grid(L, n), w = [], M = [], V = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      let m, d, v;
      if (x <= a) {
        m = M_A + R_A * x;
        d = (-M_A * x * x / 2.0 - R_A * Math.pow(x, 3) / 6.0) / EI;
        v = R_A;
      } else {
        const xr = L - x;
        m = M_B + R_B * xr;
        d = (-M_B * xr * xr / 2.0 - R_B * Math.pow(xr, 3) / 6.0) / EI;
        v = -R_B;
      }
      w.push(d); M.push(m); V.push(v);
    }
    return makeResult(xs, w, M, V,
      { M_A: M_A, M_B: M_B, RA: R_A, RB: R_B },
      '两端固支 + 距左端 ' + g3(a) + ' m 处集中力 ' + g3(P) + ' N');
  }

  function fixedFixedPoint(L, P, EI, n) {
    return fixedFixedPointAt(L, P, EI, L / 2.0, n);
  }

  function fixedFixedTwoPoint(L, P, spanRatio, EI, n) {
    const a = (L - spanRatio * L) / 2.0;
    const left = fixedFixedPointAt(L, P, EI, a, n);
    const right = fixedFixedPointAt(L, P, EI, L - a, n);
    const reactions = {};
    Object.keys(left.reactions).forEach(function (k) {
      reactions[k] = left.reactions[k] + right.reactions[k];
    });
    return addResults(left, right, reactions,
      '两端固支 + 两点加载 ' + g3(P) + ' N×2（间距 ' + spanRatio.toFixed(2) + 'L）');
  }

  const SUPPORT_LABELS = {
    simply: '简支（两端支座）',
    cantilever: '悬臂（一端固支）',
    fixed: '两端固支',
  };

  const LOAD_LABELS = {
    point_center: '跨中集中力（砝码）',
    point_two: '对称两点加载（四点弯曲）',
    udl: '满跨均布载荷',
  };

  /** 统一求解入口（totalLoad：集中力工况为砝码总重 N；均布工况为总载荷 N） */
  function solveBeam(L, EI, support, loadType, opts) {
    const o = opts || {};
    const totalLoad = o.total_load !== undefined ? o.total_load : 0.0;
    const loadPosition = o.load_position !== undefined ? o.load_position : null;
    const spanRatio = o.span_ratio !== undefined ? o.span_ratio : 1.0 / 3.0;
    const n = o.n !== undefined ? o.n : 201;
    support = support || 'simply';
    loadType = loadType || 'point_center';

    if (!SUPPORT_LABELS[support]) throw new Error('未知支撑方式 ' + JSON.stringify(support));
    if (!LOAD_LABELS[loadType]) throw new Error('未知载荷类型 ' + JSON.stringify(loadType));

    if (support === 'simply') {
      if (loadType === 'point_center') return simplySupportedPoint(L, totalLoad, EI, loadPosition, n);
      if (loadType === 'point_two') return simplySupportedTwoPoint(L, totalLoad / 2.0, EI, spanRatio, n);
      return simplySupportedUdl(L, totalLoad / L, EI, n);
    }
    if (support === 'cantilever') {
      if (loadType === 'point_center') {
        const a = loadPosition === null ? L : loadPosition;
        return cantileverPoint(L, totalLoad, EI, a, n);
      }
      if (loadType === 'point_two') return cantileverTwoPoint(L, totalLoad / 2.0, spanRatio, EI, n);
      return cantileverUdl(L, totalLoad / L, EI, n);
    }
    // 两端固支
    if (loadType === 'point_center') {
      const a = loadPosition === null ? L / 2.0 : loadPosition;
      return fixedFixedPointAt(L, totalLoad, EI, a, n);
    }
    if (loadType === 'point_two') return fixedFixedTwoPoint(L, totalLoad / 2.0, spanRatio, EI, n);
    return fixedFixedUdl(L, totalLoad / L, EI, n);
  }

  PB.Beam = {
    simplySupportedPoint: simplySupportedPoint,
    simplySupportedUdl: simplySupportedUdl,
    simplySupportedTwoPoint: simplySupportedTwoPoint,
    cantileverEndPoint: cantileverEndPoint,
    cantileverUdl: cantileverUdl,
    cantileverPoint: cantileverPoint,
    fixedFixedUdl: fixedFixedUdl,
    fixedFixedPoint: fixedFixedPoint,
    fixedFixedPointAt: fixedFixedPointAt,
    SUPPORT_LABELS: SUPPORT_LABELS,
    LOAD_LABELS: LOAD_LABELS,
    solveBeam: solveBeam,
  };
})(globalThis.PB = globalThis.PB || {});

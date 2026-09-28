/**
 * 稠密线性代数（Python 版 paperbridge/linalg.py 的 JS 移植）。
 *
 * 有限元刚度矩阵规模不大（几十到几百阶），用带部分主元的高斯消元（LU）即可。
 * 与 Python 版保持一致：结构缺少约束 / 几何可变时抛 SingularMatrixError，
 * 上层据此提示"结构可能缺支座"。
 *
 * 实现细节：消元前按矩阵最大绝对值归一化，于是主元判据是**相对**的
 * （|pivot| < 1e-13·max|A|）。这样既不会像绝对阈值那样随量纲失效，
 * 也不会对纸桥这种病态但合法的模型（条件数 ~1e9）误报。
 */
(function (PB) {
  'use strict';

  class SingularMatrixError extends Error {
    constructor(message) {
      super(message || '刚度矩阵奇异，结构可能缺少约束（几何可变）');
      this.name = 'SingularMatrixError';
    }
  }

  /**
   * 解 A·x = b。
   * @param {Float64Array|number[]} A 行主序 n×n（长度为 n*n，不会被修改）
   * @param {Float64Array|number[]} b 长度 n
   * @returns {Float64Array} 长度 n
   */
  function solveDense(A, b) {
    const n = b.length;
    if (A.length !== n * n) {
      throw new Error('系数矩阵必须为 n×n（行主序），实际长度 ' + A.length + '，期望 ' + (n * n));
    }
    const M = Float64Array.from(A);
    const rhs = Float64Array.from(b);

    let scale = 0;
    for (let i = 0; i < M.length; i++) {
      const v = Math.abs(M[i]);
      if (v > scale) scale = v;
    }
    const tol = 1e-13 * (scale > 0 ? scale : 1.0);

    // 列主元高斯消元
    for (let col = 0; col < n; col++) {
      let pivot = col, best = Math.abs(M[col * n + col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(M[r * n + col]);
        if (v > best) { best = v; pivot = r; }
      }
      if (!(best > tol)) {
        throw new SingularMatrixError(
          '第 ' + col + ' 列主元为 0（相对量级 ' + (best / (scale || 1)).toExponential(2) +
          '），结构可能缺少约束（几何可变）');
      }
      if (pivot !== col) {
        for (let c = col; c < n; c++) {
          const tmp = M[col * n + c];
          M[col * n + c] = M[pivot * n + c];
          M[pivot * n + c] = tmp;
        }
        const tb = rhs[col];
        rhs[col] = rhs[pivot];
        rhs[pivot] = tb;
      }
      const piv = M[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const factor = M[r * n + col] / piv;
        if (factor === 0) continue;
        M[r * n + col] = 0;
        for (let c = col + 1; c < n; c++) {
          M[r * n + c] -= factor * M[col * n + c];
        }
        rhs[r] -= factor * rhs[col];
      }
    }

    // 回代
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = rhs[r];
      const base = r * n;
      for (let c = r + 1; c < n; c++) s -= M[base + c] * x[c];
      x[r] = s / M[base + r];
    }
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(x[i])) {
        throw new SingularMatrixError('求解结果非有限，结构可能缺少约束（几何可变）');
      }
    }
    return x;
  }

  PB.Linalg = {
    SingularMatrixError: SingularMatrixError,
    solveDense: solveDense,
  };
})(globalThis.PB = globalThis.PB || {});

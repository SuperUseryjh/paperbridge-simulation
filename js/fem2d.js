/**
 * 二维平面桁架 / 刚架有限元（Python 版 paperbridge/fem2d.py 的 JS 移植）。
 *
 * 每个节点 3 个自由度 [u, v, θ]（水平位移、竖向位移、转角，转角逆时针为正）。
 * 单元分两类：
 *   frame —— 平面梁单元，同时传轴力与弯矩（桥面、拱、折叠梁）；
 *   truss —— 只传轴力的二力杆（桁架腹杆与弦杆）。
 *
 * 求解链（与 Python 版步骤一一对应）：等效节点载荷 → 单元刚度 → 坐标变换
 * → 整体装配 → 边界条件（支座 + 自动识别无刚度自由度）→ 稠密求解 →
 * 支座反力 → 单元内力回代 → 最大挠度。
 *
 * 内力符号约定（与 beam.js 一致）：轴力受拉为正；弯矩以下缘受拉为正；
 * 分布载荷 wy 沿整体 y 方向、向下为负。
 */
(function (PB) {
  'use strict';

  const FRAME = 'frame';
  const TRUSS = 'truss';

  const Mat = PB.Materials;

  /** 单元几何：长度 L、cosθ、sinθ 与 i 端坐标 */
  function geometryOf(model, index) {
    const e = model.elements[index];
    const ni = model.nodes[e.i], nj = model.nodes[e.j];
    const dx = nj.x - ni.x, dy = nj.y - ni.y;
    const L = Math.sqrt(dx * dx + dy * dy);
    if (!(L > 0)) throw new Error('单元 ' + index + ' 长度为零');
    return { L: L, c: dx / L, s: dy / L, xi: ni.x, yi: ni.y };
  }

  /** 局部坐标系下的单元刚度矩阵（6×6，行主序 Float64Array） */
  function localStiffness(L, section, kind) {
    const k = new Float64Array(36);
    const set = function (r, c, v) { k[r * 6 + c] = v; };

    const EA = section.axial_rigidity;
    const a = EA / L;
    set(0, 0, a); set(3, 3, a);
    set(0, 3, -a); set(3, 0, -a);
    if (kind === TRUSS) return k;

    const EI = section.flexural_rigidity;
    const b = 12.0 * EI / Math.pow(L, 3);
    const cc = 6.0 * EI / (L * L);
    const d = 4.0 * EI / L;
    const e2 = 2.0 * EI / L;

    set(1, 1, b); set(4, 4, b);
    set(1, 4, -b); set(4, 1, -b);
    set(1, 2, cc); set(2, 1, cc);
    set(1, 5, cc); set(5, 1, cc);
    set(2, 4, -cc); set(4, 2, -cc);
    set(4, 5, -cc); set(5, 4, -cc);
    set(2, 2, d); set(5, 5, d);
    set(2, 5, e2); set(5, 2, e2);
    return k;
  }

  /** 整体 → 局部（T·v）：逐 3 个自由度做 R·v */
  function toLocal(c, s, v, out) {
    for (let blk = 0; blk < 2; blk++) {
      const b = blk * 3;
      const x = v[b], y = v[b + 1], z = v[b + 2];
      out[b] = c * x + s * y;
      out[b + 1] = -s * x + c * y;
      out[b + 2] = z;
    }
    return out;
  }

  /** 局部 → 整体（Tᵀ·v） */
  function toGlobal(c, s, v, out) {
    for (let blk = 0; blk < 2; blk++) {
      const b = blk * 3;
      const x = v[b], y = v[b + 1], z = v[b + 2];
      out[b] = c * x - s * y;
      out[b + 1] = s * x + c * y;
      out[b + 2] = z;
    }
    return out;
  }

  /** 局部刚度 → 整体刚度：K_e = Tᵀ·k·T（T 为两个 3×3 转角块的分块对角矩阵） */
  function transformStiffness(c, s, kl) {
    const R = [c, s, 0, -s, c, 0, 0, 0, 1];
    const out = new Float64Array(36);
    for (let rb = 0; rb < 2; rb++) {
      for (let cb = 0; cb < 2; cb++) {
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            let v = 0;
            for (let m = 0; m < 3; m++) {
              const rma = R[m * 3 + a];
              if (rma === 0) continue;
              for (let n = 0; n < 3; n++) {
                v += rma * kl[(3 * rb + m) * 6 + (3 * cb + n)] * R[n * 3 + b];
              }
            }
            out[(3 * rb + a) * 6 + (3 * cb + b)] = v;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // 模型
  // ------------------------------------------------------------------------
  class Model {
    constructor(name) {
      this.name = name || 'paper-bridge';
      this.nodes = [];
      this.elements = [];
      this.supports = [];
      this.nodalLoads = {};     // node -> [fx, fy, mz]
      this.distributed = {};    // element -> wy
      this.meta = {};
    }

    addNode(x, y, label) {
      this.nodes.push({ x: x, y: y, label: label || '' });
      return this.nodes.length - 1;
    }

    addElement(i, j, section, kind, label) {
      if (i === j) throw new Error('单元两端不能是同一节点');
      kind = kind || FRAME;
      if (kind !== FRAME && kind !== TRUSS) throw new Error('未知单元类型 ' + JSON.stringify(kind));
      this.elements.push({ i: i, j: j, section: section, kind: kind, label: label || '' });
      return this.elements.length - 1;
    }

    addSupport(node, fixUx, fixUy, fixRz) {
      this.supports.push({
        node: node,
        fixUx: fixUx === undefined ? true : !!fixUx,
        fixUy: fixUy === undefined ? true : !!fixUy,
        fixRz: !!fixRz,
      });
    }

    addNodalLoad(node, fx, fy, mz) {
      const cur = this.nodalLoads[node] || [0, 0, 0];
      cur[0] += fx || 0; cur[1] += fy || 0; cur[2] += mz || 0;
      this.nodalLoads[node] = cur;
    }

    addDistributed(element, wy) {
      this.distributed[element] = (this.distributed[element] || 0) + wy;
    }

    elementGeometry(index) { return geometryOf(this, index); }

    /** 结构总质量 kg */
    totalMass() {
      let mass = 0;
      for (let k = 0; k < this.elements.length; k++) {
        mass += this.elements[k].section.mass_per_line * geometryOf(this, k).L;
      }
      return mass;
    }

    /** 总用纸面积 m² */
    totalPaperArea() {
      let area = 0;
      for (let k = 0; k < this.elements.length; k++) {
        area += this.elements[k].section.developed_width * geometryOf(this, k).L;
      }
      return area;
    }

    /** 求解，返回 ModelResult */
    solve() {
      const nNode = this.nodes.length;
      const nEl = this.elements.length;
      const ndof = 3 * nNode;
      if (ndof === 0) throw new Error('模型中没有任何节点');

      // 单元几何与类型
      const geo = [], kindTruss = [];
      for (let k = 0; k < nEl; k++) {
        geo.push(geometryOf(this, k));
        kindTruss.push(this.elements[k].kind === TRUSS);
      }

      // 单元自由度编号（局部 0..5 → 整体）
      const dofs = [];
      for (let k = 0; k < nEl; k++) {
        const e = this.elements[k];
        dofs.push([3 * e.i, 3 * e.i + 1, 3 * e.i + 2, 3 * e.j, 3 * e.j + 1, 3 * e.j + 2]);
      }

      // 1) 等效节点载荷 + 单元局部载荷向量
      const F = new Float64Array(ndof);
      const peq = new Array(nEl).fill(null);
      const tmp6 = new Float64Array(6);
      const glob6 = new Float64Array(6);
      Object.keys(this.distributed).forEach((key) => {
        const idx = parseInt(key, 10);
        const wy = this.distributed[key];
        const g = geo[idx];
        const pX = g.s * wy;              // 局部 x' 分量
        const pY = g.c * wy;              // 局部 y' 分量
        const local = new Float64Array(6);
        local[0] = local[3] = pX * g.L / 2.0;
        local[1] = local[4] = pY * g.L / 2.0;
        local[2] = pY * g.L * g.L / 12.0;
        local[5] = -pY * g.L * g.L / 12.0;
        if (kindTruss[idx]) { local[2] = 0; local[5] = 0; }   // 二力杆无转动自由度
        peq[idx] = local;
        toGlobal(g.c, g.s, local, glob6);
        const d = dofs[idx];
        for (let n = 0; n < 6; n++) F[d[n]] += glob6[n];
      });

      // 2) 节点集中载荷
      Object.keys(this.nodalLoads).forEach((key) => {
        const node = parseInt(key, 10);
        const v = this.nodalLoads[key];
        F[3 * node] += v[0];
        F[3 * node + 1] += v[1];
        F[3 * node + 2] += v[2];
      });

      // 3) 刚度装配
      const K = new Float64Array(ndof * ndof);
      for (let k = 0; k < nEl; k++) {
        const g = geo[k];
        const kl = localStiffness(g.L, this.elements[k].section, this.elements[k].kind);
        const ke = transformStiffness(g.c, g.s, kl);
        const d = dofs[k];
        for (let a = 0; a < 6; a++) {
          const rowBase = d[a] * ndof;
          for (let b = 0; b < 6; b++) K[rowBase + d[b]] += ke[a * 6 + b];
        }
      }

      // 4) 边界条件（支座 + 对角元为 0 的自由度，例如纯桁架节点的转角）
      const constrained = new Uint8Array(ndof);
      this.supports.forEach(function (sup) {
        if (sup.fixUx) constrained[3 * sup.node] = 1;
        if (sup.fixUy) constrained[3 * sup.node + 1] = 1;
        if (sup.fixRz) constrained[3 * sup.node + 2] = 1;
      });
      for (let d = 0; d < ndof; d++) {
        if (Math.abs(K[d * ndof + d]) < 1e-12) constrained[d] = 1;
      }

      const free = [];
      for (let d = 0; d < ndof; d++) if (!constrained[d]) free.push(d);
      if (free.length === 0) throw new Error('所有自由度都被约束，模型无意义');

      // 5) 求解自由度
      const nf = free.length;
      const Kff = new Float64Array(nf * nf);
      const Ff = new Float64Array(nf);
      for (let a = 0; a < nf; a++) {
        Ff[a] = F[free[a]];
        const rowBase = free[a] * ndof;
        for (let b = 0; b < nf; b++) Kff[a * nf + b] = K[rowBase + free[b]];
      }
      const uf = PB.Linalg.solveDense(Kff, Ff);

      const U = new Float64Array(ndof);
      for (let a = 0; a < nf; a++) U[free[a]] = uf[a];

      // 6) 支座反力 R = K·U - F
      const KU = new Float64Array(ndof);
      for (let r = 0; r < ndof; r++) {
        let sum = 0;
        const base = r * ndof;
        for (let c = 0; c < ndof; c++) sum += K[base + c] * U[c];
        KU[r] = sum;
      }
      const reactions = {};
      this.supports.forEach(function (sup) {
        const vals = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const d = 3 * sup.node + k;
          vals[k] = constrained[d] ? (KU[d] - F[d]) : 0.0;
        }
        reactions[sup.node] = vals;
      });

      // 7) 单元内力回代
      const forces = [];
      const ug = new Float64Array(6), ul = new Float64Array(6), S = new Float64Array(6);
      for (let k = 0; k < nEl; k++) {
        const e = this.elements[k], g = geo[k], d = dofs[k];
        for (let n = 0; n < 6; n++) ug[n] = U[d[n]];
        toLocal(g.c, g.s, ug, ul);
        const kl = localStiffness(g.L, e.section, e.kind);
        for (let r = 0; r < 6; r++) {
          let sum = 0;
          for (let c = 0; c < 6; c++) sum += kl[r * 6 + c] * ul[c];
          S[r] = sum;
        }
        if (peq[k]) { for (let r = 0; r < 6; r++) S[r] -= peq[k][r]; }

        let axial = -S[0];
        let shearI = S[1];
        let mI = -S[2];
        let mJ = S[5];
        let pLoc = (this.distributed[k] || 0.0) * g.c;   // 局部横向分布载荷

        let momentMin, momentMax;
        if (kindTruss[k]) {
          // 二力杆只传轴力：横向分布载荷已按节点集中处理，杆内不产生弯矩与剪力
          shearI = 0; mI = 0; mJ = 0; momentMin = 0; momentMax = 0; pLoc = 0;
        } else {
          // 弯矩沿单元极值：M(x) = m_i + V_i·x + p·x²/2
          const cands = [mI, mJ];
          if (Math.abs(pLoc) > 1e-12) {
            const xExt = -shearI / pLoc;
            if (xExt >= 0 && xExt <= g.L) {
              cands.push(mI + shearI * xExt + pLoc * xExt * xExt / 2.0);
            }
          }
          momentMin = Math.min.apply(null, cands);
          momentMax = Math.max.apply(null, cands);
        }
        forces.push({
          index: k, axial: axial, shear_i: shearI,
          moment_i: mI, moment_j: mJ,
          moment_max: momentMax, moment_min: momentMin,
          distributed: pLoc,
        });
      }

      // 8) 最大挠度（向下为正）
      let maxDef = 0.0, nodeAt = -1;
      for (let n = 0; n < nNode; n++) {
        const val = -U[3 * n + 1];
        if (Math.abs(val) > Math.abs(maxDef)) { maxDef = val; nodeAt = n; }
      }

      const displacements = [];
      for (let n = 0; n < nNode; n++) {
        displacements.push([U[3 * n], U[3 * n + 1], U[3 * n + 2]]);
      }
      return {
        model: this,
        displacements: displacements,
        elementForces: forces,
        reactions: reactions,
        maxDeflection: maxDef,
        deflectionNode: nodeAt,
      };
    }

    /** 单元变形后的折线（三次 Hermite 插值节点位移） */
    deformedPoints(res, index, n) {
      n = n || 16;
      const g = geometryOf(this, index);
      const e = this.elements[index];
      const d1 = res.displacements[e.i], d2 = res.displacements[e.j];
      const ul1 = g.c * d1[0] + g.s * d1[1];
      const vl1 = -g.s * d1[0] + g.c * d1[1];
      const ul2 = g.c * d2[0] + g.s * d2[1];
      const vl2 = -g.s * d2[0] + g.c * d2[1];
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const h1 = 1 - 3 * t * t + 2 * t * t * t;
        const h2 = g.L * (t - 2 * t * t + t * t * t);
        const h3 = 3 * t * t - 2 * t * t * t;
        const h4 = g.L * (-t * t + t * t * t);
        const vl = h1 * vl1 + h2 * d1[2] + h3 * vl2 + h4 * d2[2];
        const ul = (1 - t) * ul1 + t * ul2;
        pts.push([g.xi + t * g.L * g.c - vl * g.s + ul * g.c,
                  g.yi + t * g.L * g.s + vl * g.c + ul * g.s]);
      }
      return pts;
    }

    /** 单元弯矩图采样 [[x', M], ...]（x' 自 i 端起算） */
    momentDiagram(res, index, n) {
      n = n || 16;
      const g = geometryOf(this, index);
      const ef = res.elementForces[index];
      const out = [];
      for (let k = 0; k <= n; k++) {
        const x = g.L * k / n;
        out.push([x, ef.moment_i + ef.shear_i * x + ef.distributed * x * x / 2.0]);
      }
      return out;
    }
  }

  PB.Fem = {
    FRAME: FRAME,
    TRUSS: TRUSS,
    Model: Model,
    localStiffness: localStiffness,
    transformStiffness: transformStiffness,
    toLocal: toLocal,
    toGlobal: toGlobal,
  };
})(globalThis.PB = globalThis.PB || {});

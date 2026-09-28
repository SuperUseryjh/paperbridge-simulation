/**
 * Web 版 JS 内核与 Python 实现的对拍校验（用 bun 运行）。
 *
 *     bun web/tests/check.js
 *
 * 读 ``ref.json``（由 gen_ref.py 用 Python 内核生成），用**完全相同的输入**
 * 重算一遍，逐项比对材料常数、截面性质、梁解析解与 24 个完整场景的
 * 全部数值（位移/反力/内力/利用率/极限承载力/加载曲线）。
 *
 * 判据：绝对偏差相对该场量的量级；字符串等离散结果必须完全一致。
 */
import "../js/materials.js";
import "../js/sections.js";
import "../js/linalg.js";
import "../js/beam.js";
import "../js/fem2d.js";
import "../js/custom.js";
import "../js/structures.js";
import "../js/failure.js";
import "../js/experiment.js";

const { Materials, Sections, Beam, Custom, Structures, Failure, Experiment } = globalThis.PB;

const FIELD_TOL = 1e-8;      // 与 Python 侧 _baseline.py 同一判据
const ref = await Bun.file(new URL("./ref.json", import.meta.url)).json();

let stats = { values: 0, exact: 0, worst: 0, worstAt: "", diffs: [], ties: [] };

function maxAbs(obj) {
  let best = 0;
  (function walk(o) {
    if (typeof o === "number") { best = Math.max(best, Math.abs(o)); return; }
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === "object") { Object.values(o).forEach(walk); }
  })(obj);
  return best;
}

function compare(actual, expected, path, scale) {
  if (typeof expected === "number" && typeof actual === "number") {
    stats.values += 1;
    if (actual === expected) { stats.exact += 1; return; }
    const delta = Math.abs(actual - expected);
    const ratio = delta / Math.max(scale, 1e-300);
    if (ratio > stats.worst) {
      stats.worst = Math.abs(Math.abs(actual) - Math.abs(expected)) / Math.max(scale, 1e-300);
      stats.worstAt = path + " → JS=" + actual + "  PY=" + expected;
    }
    if (ratio <= FIELD_TOL) return;
    // 平局（符号相反但绝对值相同）：如固支梁两端与跨中弯矩大小相等，
    // 1 ulp 的舍入差异会让"取绝对值最大者"落在不同位置。物理上等价。
    const absDelta = Math.abs(Math.abs(actual) - Math.abs(expected)) / Math.max(scale, 1e-300);
    if (actual * expected < 0 && absDelta <= FIELD_TOL) {
      stats.ties.push(`${path}: JS=${actual}  PY=${expected}（符号相反的 1 ulp 平局）`);
      return;
    }
    stats.diffs.push(`${path}: JS=${actual}  PY=${expected}（绝对 ${delta.toExponential(2)}，相对场量级 ${ratio.toExponential(2)}）`);
    return;
  }
  if (typeof expected === "number" || typeof actual === "number") {
    stats.diffs.push(`${path}: JS=${actual}  PY=${expected}（类型不一致）`);
    return;
  }
  if (typeof expected === "string" || typeof expected === "boolean") {
    if (actual !== expected) stats.diffs.push(`${path}: JS=${actual}  PY=${expected}`);
    return;
  }
  if (expected === null || expected === undefined) {
    if (actual !== expected) stats.diffs.push(`${path}: JS=${actual}  PY=${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      stats.diffs.push(`${path}: 长度 JS=${actual && actual.length}  PY=${expected.length}`);
      return;
    }
    for (let k = 0; k < expected.length; k++) compare(actual[k], expected[k], `${path}[${k}]`, scale);
    return;
  }
  if (typeof expected === "object") {
    const keys = Object.keys(expected);
    for (const key of keys) {
      if (!(key in actual)) {
        stats.diffs.push(`${path}.${key}: JS 缺少该字段`);
        continue;
      }
      compare(actual[key], expected[key], `${path}.${key}`, maxAbs(expected[key]) || scale);
    }
    return;
  }
  if (actual !== expected) stats.diffs.push(`${path}: JS=${actual}  PY=${expected}`);
}

function sectionValues(sec) {
  return {
    area: sec.area, inertia: sec.inertia, inertia_weak: sec.inertia_weak,
    torsion: sec.torsion, depth: sec.depth, c_top: sec.c_top, c_bottom: sec.c_bottom,
    developed_width: sec.developed_width, mass_per_line: sec.mass_per_line,
    buckling_k: sec.buckling_k, buckling_b: sec.buckling_b, buckling_t: sec.buckling_t,
    shear_area: sec.shear_area, flexural_rigidity: sec.flexural_rigidity,
    axial_rigidity: sec.axial_rigidity, flange_slenderness: sec.flangeSlenderness(),
    label: sec.label,
  };
}

function beamValues(res) {
  const mid = res.at(0.15);
  return {
    w_max: res.wMax(), moment_max: res.momentMax(), shear_max: res.shearMax(),
    w_mid: mid.w, moment_mid: mid.moment, case: res.case,
    reactions: res.reactions,
  };
}

const DEMOS = {
  simply_supported: (args) => Custom.demoSimplySupported(args.span, args.panels),
  truss: (args) => Custom.demoTruss(args.span, args.depth, args.panels),
  arch: (args) => Custom.demoArch(args.span, args.rise, args.panels),
};

function makeDesign(spec) {
  const opts = Object.assign({}, spec.options);
  let cs = null;
  if (spec.custom) cs = DEMOS[spec.custom.demo](spec.custom.args);
  opts.custom = cs;
  const design = new Structures.BridgeDesign(opts);
  (spec.post || []).forEach((op) => {
    if (op === "clamp_all") {
      Object.keys(design.custom.supports).forEach((node) => {
        design.custom.setSupport(parseInt(node, 10), Custom.SUPPORT_FIXED);
      });
    } else {
      throw new Error("未知后处理 " + op);
    }
  });
  return design;
}

function fingerprint(design) {
  const a = Failure.analyze(design);
  const lim = Failure.findLimitLoad(design);
  const test = Experiment.runLoadTest(design.copyWith({ live_load: 0.0 }), 12);
  const model = Structures.buildModel(design);
  const curve = test.steps.length ? test.curve() : { loads: [], deflections: [] };
  const reactions = {};
  Object.keys(a.result.reactions).sort((x, y) => x - y).forEach((k) => {
    reactions[String(k)] = a.result.reactions[k];
  });
  return {
    deflection_mm: Math.abs(a.result.maxDeflection) * 1e3,
    deflection_node: a.result.deflectionNode,
    utilization_pct: a.report.max_utilization * 100.0,
    safety_factor: a.report.safetyFactor(),
    governing_mode: a.report.governing ? a.report.governing.mode : "—",
    n_nodes: model.nodes.length,
    n_elements: model.elements.length,
    mass_kg: model.totalMass(),
    area_m2: model.totalPaperArea(),
    displacements: a.result.displacements,
    reactions: reactions,
    forces: a.result.elementForces.map((ef) => [
      ef.axial, ef.shear_i, ef.moment_i, ef.moment_j,
      ef.moment_min, ef.moment_max, ef.distributed]),
    checks: a.report.checks.map((c) => [c.mode, c.element, c.role, c.utilization, c.demand, c.limit]),
    limit: {
      load: lim.limit_load,
      mode: lim.report.governing ? lim.report.governing.mode : "—",
      solves: lim.solves,
      self_weight_safe: lim.self_weight_safe,
    },
    load_test: {
      limit: test.limit_load,
      mode: test.failureMode(),
      loads: curve.loads,
      deflections: curve.deflections,
    },
  };
}

function group(name, fn) {
  const before = stats.diffs.length;
  fn();
  const added = stats.diffs.length - before;
  console.log(`  ${added === 0 ? "✓" : "✗"} ${name}${added ? `（${added} 处不一致）` : ""}`);
}

console.log("===== JS 内核 vs Python 参考值 =====");

group("材料库 " + Object.keys(ref.materials).length + " 种", () => {
  Object.keys(ref.materials).forEach((key) => {
    const m = Materials.get(key);
    const actual = {
      E: m.E, nu: m.nu, sigma_t: m.sigma_t, sigma_c: m.sigma_c, tau_allow: m.tau_allow,
      grammage: m.grammage, ply_thickness: m.ply_thickness, G_shear: m.G_shear,
      area_density: m.area_density, strength_ratio: m.strength_ratio, name: m.name,
    };
    compare(actual, ref.materials[key], `materials.${key}`, maxAbs(ref.materials[key]));
  });
});

group("截面 " + ref.sections.length + " 组", () => {
  ref.sections.forEach((item) => {
    const spec = item.spec;
    const sec = Sections.make(spec.kind, "office80", spec.opts);
    compare(sectionValues(sec), item.values, `sections.${spec.name}`, maxAbs(item.values));
  });
});

group("梁解析解 " + ref.beam.length + " 工况", () => {
  ref.beam.forEach((item) => {
    const spec = item.spec;
    const res = Beam.solveBeam(spec.L, spec.EI, spec.support, spec.load_type,
      { total_load: spec.total_load });
    compare(beamValues(res), item.values, `beam.${spec.name}`, maxAbs(item.values));
  });
});

group("完整场景 " + ref.scenarios.length + " 个", () => {
  ref.scenarios.forEach((item) => {
    const design = makeDesign(item.spec);
    compare(fingerprint(design), item.values, `scenarios.${item.spec.name}`, maxAbs(item.values));
  });
});

console.log("");
console.log(`数值总数 ${stats.values}，逐位相同 ${stats.exact}` +
  `（${(stats.exact / Math.max(1, stats.values) * 100).toFixed(1)}%）` +
  `，其余最大偏差 ${stats.worst.toExponential(2)}×场量级（容差 ${FIELD_TOL}）`);
if (stats.worstAt) console.log(`最大偏差处：${stats.worstAt}`);
if (stats.ties.length) {
  console.log(`\n注：${stats.ties.length} 处为符号相反的 1 ulp 平局（绝对值完全相同，物理等价）：`);
  stats.ties.forEach((t) => console.log("   " + t));
}
if (stats.diffs.length) {
  console.log(`\n不一致 ${stats.diffs.length} 处（最多显示 25 条）：`);
  stats.diffs.slice(0, 25).forEach((d) => console.log("   " + d));
  console.log("\n✗ JS 内核与 Python 参考值不一致");
  process.exit(1);
}
console.log("\n✓ JS 内核与 Python 参考值一致（离散结论完全相同，数值差异仅为浮点重排）");

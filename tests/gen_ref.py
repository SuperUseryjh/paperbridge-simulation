"""生成 Web 版 JS 内核的对拍参考值（Python 侧）。

用法::

    py web/tests/gen_ref.py

输出 ``web/tests/ref.json``：材料、截面、梁解析解、以及 24 个完整场景的全量数值指纹。
JS 侧 ``check.js`` 读同一个文件，用相同的输入重算并逐项比对 —— 这是"JS 移植是否
忠实于 Python 实现"的硬证据。
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from paperbridge import beam  # noqa: E402
from paperbridge.custom import (  # noqa: E402
    SUPPORT_FIXED,
    demo_arch,
    demo_simply_supported,
    demo_truss,
)
from paperbridge.experiment import run_load_test  # noqa: E402
from paperbridge.failure import analyze, find_limit_load  # noqa: E402
from paperbridge.materials import LIBRARY, get_material  # noqa: E402
from paperbridge.sections import (  # noqa: E402
    SECTION_LABELS,
    FoldedBeam,
    Laminate,
    SolidStrip,
    Tube,
)
from paperbridge.structures import BridgeDesign, build_model  # noqa: E402

DEMOS = {
    "simply_supported": demo_simply_supported,
    "truss": demo_truss,
    "arch": demo_arch,
}


# --------------------------------------------------------------------------
# 输入规格（JS 侧读同一份，保证两边输入完全一致）
# --------------------------------------------------------------------------
def section_specs():
    """截面配置：覆盖 4 种类型与主要参数分叉。"""
    return [
        {"name": "solid/default", "kind": "solid",
         "opts": {"width": 0.15}},
        {"name": "solid/thick", "kind": "solid",
         "opts": {"width": 0.20, "thickness": 0.0003}},
        {"name": "laminate/glued3", "kind": "laminate",
         "opts": {"width": 0.15, "layers": 3, "glued": True}},
        {"name": "laminate/unglued3", "kind": "laminate",
         "opts": {"width": 0.15, "layers": 3, "glued": False}},
        {"name": "laminate/glued5", "kind": "laminate",
         "opts": {"width": 0.12, "layers": 5, "glued": True}},
        {"name": "tube/default", "kind": "tube",
         "opts": {"diameter": 0.03}},
        {"name": "tube/big", "kind": "tube",
         "opts": {"diameter": 0.05, "thickness": 0.0002}},
        {"name": "folded/box-d40-p6", "kind": "folded",
         "opts": {"width": 0.15, "depth": 0.04, "web_count": 2, "fold_panels": 6}},
        {"name": "folded/u-d20-p1", "kind": "folded",
         "opts": {"width": 0.15, "depth": 0.02, "web_count": 1, "fold_panels": 1}},
        {"name": "folded/box-d60-p12", "kind": "folded",
         "opts": {"width": 0.18, "depth": 0.06, "web_count": 2, "fold_panels": 12}},
        {"name": "web/solid", "kind": "solid",
         "opts": {"width": 0.15, "label": "腹杆（单层纸）"}},
    ]


def beam_specs():
    """梁解析解工况：三种支承 × 三种加载。"""
    specs = []
    EI, L = 0.05, 0.30
    for support in ("simply", "cantilever", "fixed"):
        for load_type in ("point_center", "point_two", "udl"):
            specs.append({"name": f"beam/{support}/{load_type}", "EI": EI, "L": L,
                          "support": support, "load_type": load_type, "total_load": 2.0})
    return specs


def scenario_specs():
    """24 个完整场景：内置方案 × 荷载 × 支承 × 加载方式 × 规模 × 材料 × 自建结构。"""
    specs = []

    def add(name, options, custom=None, post=None):
        specs.append({"name": name, "options": options, "custom": custom, "post": post or []})

    for key in ("flat", "laminate", "tube", "folded", "truss", "arch"):
        add(f"builtin/{key}", {"structure": key, "live_load": 0.0})
        add(f"builtin/{key}/loaded", {"structure": key, "live_load": 2.0})

    beam_custom = {"demo": "simply_supported", "args": {"span": 0.30, "panels": 12}}
    add("custom/beam", {"structure": "custom", "live_load": 1.5}, beam_custom)
    add("custom/beam/clamped", {"structure": "custom", "live_load": 1.5}, beam_custom,
        ["clamp_all"])
    add("custom/truss", {"structure": "custom", "live_load": 1.0, "depth": 0.05, "panels": 6},
        {"demo": "truss", "args": {"span": 0.30, "depth": 0.05, "panels": 6}})
    add("custom/arch", {"structure": "custom", "live_load": 1.0, "arch_rise": 0.08, "panels": 6},
        {"demo": "arch", "args": {"span": 0.30, "rise": 0.08, "panels": 6}})

    for support in ("fixed", "cantilever"):
        add(f"support/{support}", {"structure": "folded", "support": support, "live_load": 1.0})
    for load_type in ("point_two", "udl"):
        add(f"load/{load_type}", {"structure": "folded", "load_type": load_type,
                                  "live_load": 3.0})
    add("scale/fine_mesh", {"structure": "folded", "n_elements": 32, "live_load": 1.0})
    add("scale/coarse", {"structure": "folded", "n_elements": 4, "live_load": 1.0})
    add("material/newspaper", {"structure": "folded", "material_key": "newspaper",
                               "live_load": 1.0})
    add("laminate/unglued", {"structure": "laminate", "glued": False, "live_load": 1.0})
    add("folded/u20", {"structure": "folded", "web_count": 1, "depth": 0.02, "live_load": 1.0})
    return specs


# --------------------------------------------------------------------------
# 构造与测量
# --------------------------------------------------------------------------
def build_section(spec):
    """按规格造截面（支持自定义 label，用于验证腹杆截面）。"""
    opts = dict(spec["opts"])
    label = opts.pop("label", None) or SECTION_LABELS[spec["kind"]]
    cls = {"solid": SolidStrip, "laminate": Laminate, "tube": Tube, "folded": FoldedBeam}
    return cls[spec["kind"]](key=spec["kind"], label=label,
                             material=get_material("office80"), **opts)


def make_custom(spec):
    if spec is None:
        return None
    cs = DEMOS[spec["demo"]](**spec["args"])
    return cs


def make_design(spec):
    options = dict(spec["options"])
    cs = make_custom(spec["custom"])
    design = BridgeDesign(custom=cs, **options)
    for op in spec["post"]:
        if op == "clamp_all":
            for node in list(design.custom.supports):
                design.custom.set_support(node, SUPPORT_FIXED)
        else:
            raise ValueError(f"未知后处理 {op}")
    return design


def fingerprint(design):
    a = analyze(design)
    lim = find_limit_load(design)
    test = run_load_test(design.copy_with(live_load=0.0), steps=12)
    loads, defl = test.curve() if test.steps else ([], [])
    model = build_model(design)
    return {
        "deflection_mm": abs(a.result.max_deflection) * 1e3,
        "deflection_node": a.result.deflection_node,
        "utilization_pct": a.report.max_utilization * 100.0,
        "safety_factor": a.report.safety_factor,
        "governing_mode": a.report.governing.mode if a.report.governing else "—",
        "n_nodes": len(model.nodes),
        "n_elements": len(model.elements),
        "mass_kg": model.total_mass(),
        "area_m2": model.total_paper_area(),
        "displacements": [list(d) for d in a.result.displacements],
        "reactions": {str(k): list(v) for k, v in sorted(a.result.reactions.items())},
        "forces": [[ef.axial, ef.shear_i, ef.moment_i, ef.moment_j,
                    ef.moment_min, ef.moment_max, ef.distributed]
                   for ef in a.result.element_forces],
        "checks": [[c.mode, c.element, c.role, c.utilization, c.demand, c.limit]
                   for c in a.report.checks],
        "limit": {
            "load": lim.limit_load,
            "mode": lim.report.governing.mode if lim.report.governing else "—",
            "solves": lim.solves,
            "self_weight_safe": lim.self_weight_safe,
        },
        "load_test": {
            "limit": test.limit_load,
            "mode": test.failure_mode,
            "loads": list(loads),
            "deflections": list(defl),
        },
    }


def section_values(sec):
    return {
        "area": sec.area, "inertia": sec.inertia, "inertia_weak": sec.inertia_weak,
        "torsion": sec.torsion, "depth": sec.depth, "c_top": sec.c_top,
        "c_bottom": sec.c_bottom, "developed_width": sec.developed_width,
        "mass_per_line": sec.mass_per_line, "buckling_k": sec.buckling_k,
        "buckling_b": sec.buckling_b, "buckling_t": sec.buckling_t,
        "shear_area": sec.shear_area,
        "flexural_rigidity": sec.flexural_rigidity, "axial_rigidity": sec.axial_rigidity,
        "flange_slenderness": sec.flange_slenderness(), "label": sec.label,
    }


def beam_values(res):
    return {
        "w_max": res.w_max, "moment_max": res.moment_max, "shear_max": res.shear_max,
        "w_mid": res.at(0.15)["w"], "moment_mid": res.at(0.15)["moment"],
        "reactions": res.reactions, "case": res.case,
    }


def main() -> int:
    out = {"materials": {}, "sections": [], "beam": [], "scenarios": []}

    for key, mat in LIBRARY.items():
        out["materials"][key] = {
            "E": mat.E, "nu": mat.nu, "sigma_t": mat.sigma_t, "sigma_c": mat.sigma_c,
            "tau_allow": mat.tau_allow, "grammage": mat.grammage,
            "ply_thickness": mat.ply_thickness, "G_shear": mat.G_shear,
            "area_density": mat.area_density, "strength_ratio": mat.strength_ratio,
            "name": mat.name,
        }

    for spec in section_specs():
        sec = build_section(spec)
        out["sections"].append({"spec": spec, "values": section_values(sec)})

    for spec in beam_specs():
        res = beam.solve_beam(spec["L"], spec["EI"], spec["support"], spec["load_type"],
                              total_load=spec["total_load"])
        # 采样点较多，只记录关键值以控制文件体积
        out["beam"].append({"spec": spec, "values": beam_values(res)})

    for spec in scenario_specs():
        design = make_design(spec)
        out["scenarios"].append({"spec": spec, "values": fingerprint(design)})

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ref.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    size = os.path.getsize(path) / 1024.0
    print(f"已生成 {path}")
    print(f"  材料 {len(out['materials'])} 种，截面 {len(out['sections'])} 组，"
          f"梁工况 {len(out['beam'])} 个，完整场景 {len(out['scenarios'])} 个（{size:.0f} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

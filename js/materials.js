/**
 * 纸张材料库（Python 版 paperbridge/materials.py 的 JS 移植）。
 *
 * 单位制统一为 SI：长度 m，力 N，应力 Pa，质量 kg。
 * 纸张"克重"（g/m²）决定自重：kg/m² = 克重 / 1000。
 *
 * 每个文件都是经典脚本（IIFE + 全局 PB 命名空间），这样双击 index.html
 * 即可用 file:// 打开（ES module 在 file:// 下会被 CORS 拦住）。
 */
(function (PB) {
  'use strict';

  /** 重力加速度 m/s² */
  const G = 9.80665;

  /** 原始材料参数表（与 Python 版逐字对应） */
  const RAW = [
    { key: 'newspaper', name: '报纸 (45 g/m²)', E: 2.5e9, nu: 0.30, sigma_t: 20e6, sigma_c: 10e6, tau_allow: 3.5e6, grammage: 45.0, ply_thickness: 0.07e-3 },
    { key: 'office80', name: '普通打印纸 (80 g/m²)', E: 3.8e9, nu: 0.30, sigma_t: 35e6, sigma_c: 18e6, tau_allow: 6.0e6, grammage: 80.0, ply_thickness: 0.10e-3 },
    { key: 'kraft120', name: '牛皮纸 (120 g/m²)', E: 4.2e9, nu: 0.30, sigma_t: 50e6, sigma_c: 24e6, tau_allow: 9.0e6, grammage: 120.0, ply_thickness: 0.15e-3 },
    { key: 'coated157', name: '铜版纸 (157 g/m²)', E: 4.0e9, nu: 0.29, sigma_t: 38e6, sigma_c: 20e6, tau_allow: 7.0e6, grammage: 157.0, ply_thickness: 0.14e-3 },
    { key: 'cardboard200', name: '白卡纸 (200 g/m²)', E: 4.5e9, nu: 0.29, sigma_t: 45e6, sigma_c: 22e6, tau_allow: 8.0e6, grammage: 200.0, ply_thickness: 0.25e-3 },
    { key: 'cardboard300', name: '厚卡纸 (300 g/m²)', E: 4.8e9, nu: 0.29, sigma_t: 48e6, sigma_c: 24e6, tau_allow: 9.0e6, grammage: 300.0, ply_thickness: 0.35e-3 },
    { key: 'corrugated', name: '单层瓦楞纸板', E: 0.35e9, nu: 0.25, sigma_t: 8e6, sigma_c: 5e6, tau_allow: 1.2e6, grammage: 600.0, ply_thickness: 4.0e-3 },
  ];

  /** 派生量在装载时一次算好 */
  function build(raw) {
    const m = Object.assign({}, raw);
    m.G_shear = raw.E / (2.0 * (1.0 + raw.nu));
    m.area_density = raw.grammage / 1000.0;   // kg/m²
    m.thickness = raw.ply_thickness;
    m.strength_ratio = raw.sigma_t / raw.sigma_c;
    m.describe = function () {
      return raw.name + '：E=' + (raw.E / 1e9).toFixed(2) + ' GPa，厚度=' +
        (raw.ply_thickness * 1e3).toFixed(3) + ' mm，克重=' + raw.grammage.toFixed(0) +
        ' g/m²，抗拉=' + (raw.sigma_t / 1e6).toFixed(0) + ' MPa，抗压=' +
        (raw.sigma_c / 1e6).toFixed(0) + ' MPa';
    };
    return m;
  }

  const LIBRARY = {};
  RAW.forEach(function (raw) {
    LIBRARY[raw.key] = build(raw);
  });

  const DEFAULT_MATERIAL_KEY = 'office80';

  function getMaterial(key) {
    const m = LIBRARY[key];
    if (!m) {
      throw new Error('未知材料 ' + JSON.stringify(key) + '，可选：' +
        Object.keys(LIBRARY).sort().join(', '));
    }
    return m;
  }

  function listMaterials() {
    return Object.keys(LIBRARY).map(function (k) { return LIBRARY[k]; });
  }

  function materialNames() {
    return listMaterials().map(function (m) { return m.name; });
  }

  function keyByName(name) {
    const hit = listMaterials().filter(function (m) { return m.name === name; })[0];
    if (!hit) throw new Error('未知材料名称 ' + JSON.stringify(name));
    return hit.key;
  }

  PB.G = G;
  PB.Materials = {
    G: G,
    LIBRARY: LIBRARY,
    DEFAULT_KEY: DEFAULT_MATERIAL_KEY,
    get: getMaterial,
    list: listMaterials,
    names: materialNames,
    keyByName: keyByName,
  };
})(globalThis.PB = globalThis.PB || {});

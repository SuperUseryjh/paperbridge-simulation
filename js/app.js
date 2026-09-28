/**
 * Web 版界面控制器（对应桌面版 ui.py 的 MainWindow）。
 *
 * 职责：把控制面板的输入读成 BridgeDesign → 调分析 → 刷新桥体视图/两张图表/读数；
 * 另外负责加载动画、逐级加载实验、极限承载力、自建结构编辑与 JSON 导入导出。
 */
(function (PB) {
  'use strict';

  const Mat = PB.Materials;
  const Custom = PB.Custom;
  const Str = PB.Structures;
  const Fail = PB.Failure;
  const Exp = PB.Experiment;
  const C = PB.BridgeViewConst;
  const G = Mat.G;

  const $ = function (id) { return document.getElementById(id); };

  // 滑块的显示规则（单位与小数位）
  const SLIDERS = [
    { id: 'span', unit: 'cm', digits: 0 },
    { id: 'width', unit: 'cm', digits: 1 },
    { id: 'depth', unit: 'mm', digits: 0 },
    { id: 'foldPanels', unit: '格', digits: 0 },
    { id: 'layers', unit: '层', digits: 0 },
    { id: 'diameter', unit: 'mm', digits: 0 },
    { id: 'rise', unit: 'cm', digits: 1 },
    { id: 'speed', unit: 'ms', digits: 0, noRecompute: true },
    { id: 'mass', unit: 'g', digits: 0, live: true },
  ];

  // ---- 状态 ----
  let view, curveChart, momentChart;
  let editor = null;
  const undoStack = [];
  let limitResult = null;
  let testResult = null;
  let animTimer = null;
  let animating = false;
  let animFrame = 0;
  const ANIM_FRAMES = 26;
  let animTarget = 0;
  let dragging = false;
  let massTimer = null;
  let currentTab = 'plan';

  // 结果条：利用率着色（与桥体视图同一套阈值）
  const KPI_CLASSES = ['safe', 'warn', 'high', 'fail', 'idle'];
  const KPI_ROWS = [
    { card: 'kpi-ur', value: 'kpi-ur-v', sub: 'kpi-ur-s' },
    { card: 'kpi-sf', value: 'kpi-sf-v', sub: 'kpi-sf-s' },
    { card: 'kpi-limit', value: 'kpi-limit-v', sub: 'kpi-limit-s' },
    { card: 'kpi-paper', value: 'kpi-paper-v', sub: 'kpi-paper-s' },
  ];

  // ------------------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------------------
  function init() {
    fillSelects();
    view = new PB.BridgeView($('bridge'));
    curveChart = new PB.ChartView($('curve'), '载荷–挠度曲线', '载荷 (N)', '跨中挠度 (mm)');
    momentChart = new PB.ChartView($('moment'), '桥面弯矩图', '沿跨位置 (cm)', '弯矩 (N·m)');
    buildModeButtons();
    bindTabs();
    bindReadoutToggle();
    bindKeyboard();
    bindControls();
    bindEditorCallbacks();
    bindCanvasResize();
    updateSliderLabels();
    applyControlStates();
    syncView();
    recompute();
  }

  function fillSelects() {
    const option = function (value, label) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };
    const structure = $('structure');
    Str.STRUCTURE_KEYS.forEach(function (key) {
      structure.appendChild(option(key, Str.STRUCTURE_LABELS[key]));
    });
    structure.value = 'folded';

    const support = $('support');
    Object.keys(Str.SUPPORT_LABELS).forEach(function (key) {
      support.appendChild(option(key, Str.SUPPORT_LABELS[key]));
    });

    const material = $('material');
    Mat.list().forEach(function (m) { material.appendChild(option(m.key, m.name)); });
    material.value = Mat.DEFAULT_KEY;

    const loadType = $('loadType');
    Object.keys(PB.Beam.LOAD_LABELS).forEach(function (key) {
      loadType.appendChild(option(key, PB.Beam.LOAD_LABELS[key]));
    });

    const memberSection = $('memberSection');
    Custom.SECTION_KINDS.forEach(function (kind) {
      memberSection.appendChild(option(kind, Custom.SECTION_SHORT_LABELS[kind]));
    });
    memberSection.value = 'folded';

    const memberKind = $('memberKind');
    Custom.MEMBER_KINDS.forEach(function (kind) {
      memberKind.appendChild(option(kind, Custom.MEMBER_KIND_LABELS[kind]));
    });
  }

  function buildModeButtons() {
    const box = $('modes');
    C.EDIT_MODES.forEach(function (mode) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = mode;
      b.textContent = C.MODE_LABELS[mode];
      b.addEventListener('click', function () { setEditMode(mode); });
      box.appendChild(b);
    });
    highlightMode();
  }

  function highlightMode() {
    const mode = view ? view.editMode : C.MODE_NODE;
    Array.prototype.forEach.call($('modes').children, function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    showModePanel(mode);
    updateEditorStats(mode);
  }

  /** 每个模式一个面板：只显示当前模式的说明、步骤与它专属的设置 */
  function showModePanel(mode) {
    const panes = $('modePanels').querySelectorAll('.mpane');
    Array.prototype.forEach.call(panes, function (p) {
      const on = p.dataset.mpane === mode;
      p.classList.toggle('active', on);
      if (on) {
        const sub = p.querySelector('.mp-sub');
        if (sub) sub.textContent = C.MODE_HINTS[mode] || '';
      }
    });
  }

  function updateEditorStats(mode) {
    const box = $('editorStats');
    if (!editor || !editor.nodes.length) {
      box.textContent = '画布还是空的 —— 用「载入示例」或「节点」模式开始搭建。';
      return;
    }
    box.innerHTML = '节点 <b>' + editor.nodeCount() + '</b> · 杆件 <b>' +
      editor.memberCount() + '</b> · 跨长 <b>' + (editor.span() * 1e2).toFixed(1) +
      '</b> cm · 当前模式 <b>' + (C.MODE_LABELS[mode] || mode) + '</b>';
  }

  function bindControls() {
    // 滑块
    SLIDERS.forEach(function (spec) {
      const input = $(spec.id);
      input.addEventListener('input', function () {
        updateSliderLabel(spec);
        if (spec.noRecompute) return;
        if (spec.live) {
          clearTimeout(massTimer);
          massTimer = setTimeout(recompute, 45);   // 拖动砝码时节流重算
        } else {
          recompute();
        }
      });
    });
    // 下拉框
    ['support', 'material', 'loadType', 'webCount', 'panels', 'gridSnap'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (id === 'gridSnap') { syncView(); return; }
        recompute();
      });
    });
    $('structure').addEventListener('change', function () {
      applyControlStates();
      if (isCustom()) setTab('editor');     // 切到自建结构就顺手打开编辑器
      recompute();
    });
    $('amplify').addEventListener('change', function () {
      if (view.analysis) {
        view.amplify = $('amplify').checked;
        view.draw();
      }
    });
    $('memberSection').addEventListener('change', editorOptionChanged);
    $('memberKind').addEventListener('change', editorOptionChanged);
    $('demo').addEventListener('change', function () {
      loadDemo($('demo').value);
    });
    // 按钮
    $('btnRecompute').addEventListener('click', recompute);
    $('btnAnimate').addEventListener('click', toggleAnimation);
    $('btnExperiment').addEventListener('click', runExperiment);
    $('btnLimit').addEventListener('click', showLimit);
    $('btnReset').addEventListener('click', resetDefaults);
    $('btnUndo').addEventListener('click', undoEdit);
    $('btnClear').addEventListener('click', clearStructure);
    $('btnExport').addEventListener('click', exportJson);
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (ev) {
      if (ev.target.files && ev.target.files[0]) importJson(ev.target.files[0]);
      ev.target.value = '';
    });
  }

  function bindEditorCallbacks() {
    view.onEmptyClick = function (x, y) {
      if (!isCustom() || view.editMode !== C.MODE_NODE) return;
      ensureEditor();
      snapshot();
      const node = editor.addNode(x, y);
      afterEdit('新增节点 ' + node + '（x=' + (x * 1e2).toFixed(1) + ' cm，y=' +
        (y * 1e2).toFixed(1) + ' cm）');
    };
    view.onNodeClick = function (node) {
      if (!isCustom() || !editor) return;
      const mode = view.editMode;
      if (mode === C.MODE_MEMBER) {
        if (view.pendingNode === null) {
          view.pendingNode = node;
          syncView();
          setStatus('已选中起点 ' + node + '：再点一个节点连成杆件');
          return;
        }
        const start = view.pendingNode;
        view.pendingNode = null;
        if (start === node) { syncView(); setStatus('起点与终点相同，已取消'); return; }
        snapshot();
        try {
          const idx = editor.addMember(start, node, $('memberSection').value,
            $('memberKind').value);
          afterEdit('新增杆件 ' + idx + '：' + start + '–' + node + '，' +
            Custom.SECTION_SHORT_LABELS[$('memberSection').value] + ' / ' +
            Custom.MEMBER_KIND_LABELS[$('memberKind').value]);
        } catch (err) {
          setStatus('无法连接：' + err.message, 'error');
          syncView();
        }
      } else if (mode === C.MODE_SUPPORT) {
        snapshot();
        const kind = editor.cycledSupport(node);
        afterEdit('节点 ' + node + ' 支座 → ' + Custom.SUPPORT_LABELS[kind]);
      } else if (mode === C.MODE_LOAD) {
        snapshot();
        const on = editor.toggleLoadNode(node);
        afterEdit('节点 ' + node + (on ? '设为' : '取消') + '加载点');
      } else if (mode === C.MODE_DELETE) {
        snapshot();
        editor.removeNode(node);
        afterEdit('已删除节点 ' + node + ' 及其相连杆件');
      }
    };
    view.onMemberClick = function (member) {
      if (!isCustom() || !editor) return;
      const mode = view.editMode;
      if (mode === C.MODE_DELETE) {
        snapshot();
        editor.removeMember(member);
        afterEdit('已删除杆件 ' + member);
      } else if (mode === C.MODE_MEMBER) {
        snapshot();
        editor.setMember(member, $('memberSection').value, $('memberKind').value);
        afterEdit('杆件 ' + member + ' 改为 ' + Custom.SECTION_SHORT_LABELS[$('memberSection').value] +
          ' / ' + Custom.MEMBER_KIND_LABELS[$('memberKind').value]);
      }
    };
    // 双击杆件 = 直接套用当前选的截面与类型（少切一次模式）
    view.onMemberDoubleClick = function (member) {
      if (!isCustom() || !editor || view.editMode === C.MODE_DELETE) return;
      snapshot();
      editor.setMember(member, $('memberSection').value, $('memberKind').value);
      afterEdit('杆件 ' + member + ' 改为 ' +
        Custom.SECTION_SHORT_LABELS[$('memberSection').value] + ' / ' +
        Custom.MEMBER_KIND_LABELS[$('memberKind').value]);
    };
    view.onNodeMove = function (node, x, y) {
      if (!isCustom() || !editor) return;
      if (!dragging) { snapshot(); dragging = true; }
      editor.moveNode(node, x, y);
      view.draw();          // 拖动过程只重绘，松手才重新求解
    };
    view.onNodeDrop = function (node) {
      if (!dragging) return;
      dragging = false;
      if (!editor) return;
      const p = editor.coordinates(node);
      afterEdit('节点 ' + node + ' 移到（x=' + (p[0] * 1e2).toFixed(1) + ' cm，y=' +
        (p[1] * 1e2).toFixed(1) + ' cm）');
    };
  }

  function bindCanvasResize() {
    const fit = function () {
      [$('bridge'), $('curve'), $('moment')].forEach(function (cv) {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(cv.clientWidth * dpr));
        const h = Math.max(1, Math.round(cv.clientHeight * dpr));
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      });
      redraw();
    };
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(fit);
      ro.observe($('bridge'));
      ro.observe($('curve'));
      ro.observe($('moment'));
    }
    window.addEventListener('resize', fit);
    fit();
  }

  function redraw() {
    if (view) view.draw();
    if (curveChart) curveChart.draw();
    if (momentChart) momentChart.draw();
  }

  // ------------------------------------------------------------------------
  // 参数读取与联动
  // ------------------------------------------------------------------------
  function updateSliderLabel(spec) {
    const input = $(spec.id);
    const v = parseFloat(input.value);
    $(spec.id + '-val').textContent = v.toFixed(spec.digits) + ' ' + spec.unit;
  }

  function updateSliderLabels() {
    SLIDERS.forEach(updateSliderLabel);
  }

  function isCustom() { return $('structure').value === 'custom'; }

  function structureKey() { return $('structure').value; }

  function readDesign(liveLoad) {
    const key = structureKey();
    const support = (key === 'truss' || key === 'arch' || key === 'custom')
      ? 'simply' : $('support').value;
    const massG = (liveLoad === undefined)
      ? parseFloat($('mass').value)
      : liveLoad / G * 1e3;
    let span = parseFloat($('span').value) / 100.0;
    if (key === 'custom') {
      if (!editor || !editor.nodes.length) {
        throw new Error('画布还是空的：用「载入示例」或「节点」模式开始搭建。');
      }
      span = editor.span();
    }
    const design = new Str.BridgeDesign({
      structure: key,
      span: span,
      width: parseFloat($('width').value) / 100.0,
      material_key: $('material').value,
      support: support,
      layers: parseInt($('layers').value, 10),
      glued: $('glued').checked,
      depth: parseFloat($('depth').value) / 1000.0,
      web_count: parseInt($('webCount').value, 10),
      fold_panels: parseInt($('foldPanels').value, 10),
      diameter: parseFloat($('diameter').value) / 1000.0,
      panels: parseInt($('panels').value, 10),
      arch_rise: parseFloat($('rise').value) / 100.0,
      load_type: $('loadType').value,
      live_load: Math.max(0, massG) / 1000.0 * G,
      custom: key === 'custom' ? editor : null,
    });
    design.validate();
    return design;
  }

  /** 切换结构方案后禁用无关参数 */
  function applyControlStates() {
    const key = structureKey();
    const isCustomNow = key === 'custom';
    const isFolded = key === 'folded';
    const isLam = key === 'laminate';
    const isTube = key === 'tube';
    const isFrame = (key === 'truss' || key === 'arch');

    // 自建结构里每根杆件都可能用任意截面，所以全部截面参数都放开
    $('depth').disabled = !(isCustomNow || isFolded || isFrame);
    $('foldPanels').disabled = !(isCustomNow || isFolded);
    $('webCount').disabled = !(isCustomNow || isFolded);
    $('layers').disabled = !(isCustomNow || isLam);
    $('glued').disabled = !(isCustomNow || isLam);
    $('diameter').disabled = !(isCustomNow || isTube);
    $('panels').disabled = !isFrame;
    $('rise').disabled = (key !== 'arch');
    $('support').disabled = (isFrame || isCustomNow);
    $('span').disabled = isCustomNow;            // 自建结构的跨长由几何决定

    ['depth', 'foldPanels', 'webCount', 'layers', 'glued', 'diameter', 'panels', 'rise',
      'support', 'span'].forEach(function (id) {
      const row = $(id).closest('.row');
      if (row) row.classList.toggle('off', $(id).disabled);
    });

    // 编辑器：非自建结构时整块停用，并给出提示
    $('editorNotice').classList.toggle('hidden', isCustomNow);
    ['memberSection', 'memberKind', 'gridSnap', 'demo',
      'btnUndo', 'btnClear', 'btnImport', 'btnExport'].forEach(function (id) {
      $(id).disabled = !isCustomNow;
    });
    Array.prototype.forEach.call($('modes').children, function (b) {
      b.disabled = !isCustomNow;
    });
    if (isCustomNow) {
      ensureEditor();
      syncView();
    }
  }

  function syncView() {
    view.setEditorState(isCustom() ? editor : null, view.editMode, view.pendingNode,
      parseFloat($('gridSnap').value));
    highlightMode();
  }

  function editorOptionChanged() {
    syncView();
    if (isCustom()) {
      setStatus('接下来画的杆件：' + Custom.SECTION_SHORT_LABELS[$('memberSection').value] +
        ' / ' + Custom.MEMBER_KIND_LABELS[$('memberKind').value] +
        '；网格吸附：' + $('gridSnap').selectedOptions[0].textContent);
    }
  }

  function setEditMode(mode) {
    view.editMode = mode;
    view.pendingNode = null;
    syncView();
    setStatus('编辑模式：' + C.MODE_LABELS[mode]);
  }

  function setStatus(text, kind) {
    const box = $('status');
    box.textContent = text;
    box.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------------
  // 界面外壳：标签页 / 读数折叠 / 快捷键 / 结果条
  // ------------------------------------------------------------------------
  function bindTabs() {
    const buttons = $('tabs').querySelectorAll('.tab');
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });
    setTab(currentTab);
  }

  function setTab(name) {
    const panes = document.querySelectorAll('.pane');
    const buttons = $('tabs').querySelectorAll('.tab');
    let found = false;
    Array.prototype.forEach.call(buttons, function (b) {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) found = true;
    });
    if (!found) return;                    // 未知标签名：保持原状
    currentTab = name;
    Array.prototype.forEach.call(panes, function (p) {
      p.classList.toggle('active', p.dataset.pane === name);
    });
    redraw();                              // 画布尺寸在隐藏期间可能没量到
  }

  function bindReadoutToggle() {
    const wrap = $('readout').parentNode;
    wrap.querySelector('.readout-title').addEventListener('click', function () {
      wrap.classList.toggle('folded');
    });
    if (window.innerHeight < 640) wrap.classList.add('folded');   // 矮屏先收起来
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (ev) {
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (!isCustom() || !editor) return;
      const modes = C.EDIT_MODES;
      if (ev.key >= '1' && ev.key <= '9') {
        const idx = parseInt(ev.key, 10) - 1;
        if (idx >= 0 && idx < modes.length) { setEditMode(modes[idx]); ev.preventDefault(); }
        return;
      }
      if (ev.key === 'Escape') {
        if (view.pendingNode !== null) {
          view.pendingNode = null;
          syncView();
          setStatus('已取消待连的杆件');
        }
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        deleteHovered();
        ev.preventDefault();
      }
    });
  }

  /** 删除鼠标当前指向的节点或杆件（快捷键 Delete） */
  function deleteHovered() {
    const node = view.hoverNode, member = view.hoverMember;
    if (node === null && member === null) {
      setStatus('把鼠标移到要删的节点或杆件上，再按 Delete / Backspace');
      return;
    }
    snapshot();
    view.clearHover();
    if (node !== null) {
      editor.removeNode(node);
      afterEdit('已删除节点 ' + node + ' 及其相连杆件');
    } else {
      editor.removeMember(member);
      afterEdit('已删除杆件 ' + member);
    }
  }

  function urClass(ur) {
    if (!(ur > 0)) return 'idle';
    if (ur >= 1.0) return 'fail';
    if (ur >= 0.8) return 'high';
    if (ur >= 0.5) return 'warn';
    return 'safe';
  }

  function setKpi(row, cls, value, sub) {
    const card = $(row.card);
    if (!card) return;
    KPI_CLASSES.forEach(function (c) { card.classList.remove(c); });
    card.classList.add(cls);
    $(row.value).textContent = value;
    $(row.sub).textContent = sub;
  }

  /** a 为分析结果；传 null 表示当前没有有效结果 */
  function renderKpi(a) {
    if (!a) {
      KPI_ROWS.forEach(function (row) { setKpi(row, 'idle', '—', '—'); });
      setKpi(KPI_ROWS[0], 'idle', '—', '控制模式 —');
      setKpi(KPI_ROWS[2], 'idle', '—', '点「求极限承载力」');
      return;
    }
    const ur = a.report.max_utilization;
    const gov = a.report.governing;
    setKpi(KPI_ROWS[0], urClass(ur), (ur * 100).toFixed(1) + '%',
      '控制模式 ' + (gov ? gov.mode : '—'));

    const sf = a.report.safetyFactor();
    setKpi(KPI_ROWS[1], urClass(ur),
      isFinite(sf) ? sf.toFixed(2) : '∞',
      sf >= 1.0 ? '还有余量' : '已经超限');

    const lim = limitResult || testResult;
    if (lim && lim.limit_load > 0) {
      setKpi(KPI_ROWS[2], 'idle', lim.limit_load.toFixed(3) + ' N',
        '砝码 ' + (lim.limit_load / G * 1e3).toFixed(0) + ' g（' +
        (limitResult ? '二分求解' : '实验外推') + '）');
    } else {
      setKpi(KPI_ROWS[2], 'idle', '—', '点「求极限承载力」');
    }

    setKpi(KPI_ROWS[3], 'idle',
      (a.model.totalPaperArea() * 1e4).toFixed(1) + ' cm²',
      '自重 ' + (a.model.totalMass() * 1e3).toFixed(2) + ' g');
  }

  // ------------------------------------------------------------------------
  // 主编排
  // ------------------------------------------------------------------------
  function recompute() {
    stopAnimation();
    syncView();
    let design;
    try {
      design = readDesign();
    } catch (err) {
      setStatus('参数不合法：' + err.message, 'error');
      renderKpi(null);
      if (isCustom()) { view.showAnalysis(null, { banner: '' }); }
      return;
    }
    limitResult = null;
    let a;
    try {
      a = Fail.analyze(design);
    } catch (err) {
      setStatus('求解失败：' + err.message, 'error');
      renderKpi(null);
      if (isCustom()) view.showAnalysis(null, { banner: '' });
      return;
    }
    const collapsed = a.report.max_utilization >= 1.0;
    view.showAnalysis(a, {
      amplify: $('amplify').checked,
      collapsed: collapsed,
      banner: collapsed ? '× 桥塌了！' : '',
    });
    renderReadout(a);
    renderCharts(a);
    setStatus(Str.STRUCTURE_LABELS[design.structure] + '｜跨长 ' +
      (design.span * 1e2).toFixed(0) + ' cm｜砝码 ' + $('mass').value + ' g｜最大利用率 ' +
      (a.report.max_utilization * 100).toFixed(1) + '%｜安全系数 ' +
      a.report.safetyFactor().toFixed(2));
  }

  function renderReadout(a) {
    const design = a.design;
    const lines = [];
    lines.push('【结构】' + design.describe());
    if (design.structure === 'custom' && design.custom) {
      design.usedSectionKinds().forEach(function (kind) {
        lines.push('【截面·' + (Custom.SECTION_SHORT_LABELS[kind] || kind) + '】' +
          design.sectionFor(kind).describe());
      });
      design.custom.warnings().forEach(function (n) { lines.push('【提示】' + n); });
    } else {
      lines.push('【截面】' + design.buildSection().describe());
    }
    lines.push('【用纸】' + (a.model.totalPaperArea() * 1e4).toFixed(1) + ' cm²（展开面积）' +
      '　【自重】' + (a.model.totalMass() * 1e3).toFixed(2) + ' g');
    lines.push('');
    a.report.summaryLines().forEach(function (s) { lines.push('【评定】' + s); });
    const ref = Str.analyticBeamCheck(design);
    if (ref) {
      const femW = Math.abs(a.result.maxDeflection);
      const pct = ref.w_max ? (femW - ref.w_max) / ref.w_max * 100.0 : 0.0;
      lines.push('【解析解校验】梁理论 w_max = ' + (ref.w_max * 1e3).toFixed(4) +
        ' mm，有限元 = ' + (femW * 1e3).toFixed(4) + ' mm（偏差 ' + pct.toFixed(3) + '%）');
      lines.push('　　' + ref.note);
    }
    lines.push('');
    lines.push('【最不利检查】');
    a.report.topChecks(5).forEach(function (c) { lines.push('　' + c.line()); });
    if (testResult && testResult.steps.length) {
      lines.push('');
      lines.push('【逐级加载实验】');
      testResult.summaryLines().forEach(function (s) { lines.push('　' + s); });
    }
    $('readout').textContent = lines.join('\n');
    renderKpi(a);
  }

  function renderCharts(a) {
    // 弯矩图
    const xs = [], ms = [];
    const model = a.model, result = a.result;
    const deck = model.meta.deck_elements || [];
    deck.forEach(function (idx) {
      const g = model.elementGeometry(idx);
      model.momentDiagram(result, idx, 8).forEach(function (pair) {
        xs.push((g.xi + pair[0] * g.c) * 1e2);
        ms.push(pair[1]);
      });
    });
    const markers = [];
    if (ms.length) {
      let best = 0;
      for (let i = 1; i < ms.length; i++) if (Math.abs(ms[i]) > Math.abs(ms[best])) best = i;
      markers.push({ x: xs[best], y: ms[best], text: '|M|最大', color: '#c62828' });
    }
    momentChart.setData([{ name: '桥面弯矩 M(x)', xs: xs, ys: ms, color: '#1565c0' }], markers);
    momentChart.draw();

    // 载荷–挠度曲线
    const series = [], curveMarkers = [];
    const cur = a.design.live_load;
    const curMm = Math.abs(a.result.maxDeflection) * 1e3;
    if (testResult && testResult.steps.length) {
      const c = testResult.curve();
      series.push({ name: '加载实验', xs: c.loads, ys: c.deflections, color: '#1565c0' });
      if (testResult.limit_load > 0) {
        curveMarkers.push({
          x: testResult.limit_load, y: c.deflections[c.deflections.length - 1],
          color: '#c62828', text: '失效 ' + testResult.failureMode(),
        });
      }
    } else {
      series.push({
        name: '当前状态',
        xs: cur > 0 ? [0, cur] : [0, 1e-9],
        ys: [0, curMm], color: '#1565c0',
      });
    }
    series.push({ name: '当前工作点', xs: [cur], ys: [curMm], color: '#ef6c00', point: true });
    curveChart.setData(series, curveMarkers, cur > 0 ? [cur] : []);
    curveChart.draw();
  }

  // ------------------------------------------------------------------------
  // 加载动画
  // ------------------------------------------------------------------------
  function toggleAnimation() {
    if (animating) { stopAnimation(); setStatus('动画已停止'); return; }
    let design;
    try {
      design = readDesign();
    } catch (err) { setStatus('参数不合法：' + err.message, 'error'); return; }

    setStatus('正在计算极限承载力…');
    let lim;
    try {
      lim = limitResult || Fail.findLimitLoad(design.copyWith({ live_load: 0.0 }));
    } catch (err) { setStatus('计算失败：' + err.message, 'error'); return; }
    limitResult = lim;
    if (!lim.self_weight_safe) {
      view.showAnalysis(Fail.analyze(design.copyWith({ live_load: 0.0 })),
        { collapsed: true, banner: '× 仅自重就已超限' });
      setStatus('仅自重就已超限：先加强截面，再谈加载。', 'error');
      return;
    }
    animTarget = lim.limit_load;
    animFrame = 0;
    animating = true;
    $('btnAnimate').textContent = '停止动画';
    animTick();
  }

  function stopAnimation() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    animating = false;
    $('btnAnimate').textContent = '开始加载动画';
  }

  function animTick() {
    if (!animating) return;
    let design;
    try { design = readDesign(); } catch (err) { stopAnimation(); return; }
    const load = animTarget * Math.min(1.0, animFrame / ANIM_FRAMES);
    const a = Fail.analyze(design.copyWith({ live_load: load }));
    const ur = a.report.max_utilization;
    const collapsed = ur >= 1.0;
    const banner = collapsed
      ? '× 桥塌了！控制失效模式：' + (a.report.governing ? a.report.governing.mode : '—')
      : '加载中… 砝码 ' + (load / G * 1e3).toFixed(0) + ' g（利用率 ' + (ur * 100).toFixed(0) + '%）';
    view.showAnalysis(a, {
      amplify: $('amplify').checked, collapsed: collapsed, banner: banner,
    });
    renderReadout(a);
    renderCharts(a);
    setStatus('加载 ' + (load / G * 1e3).toFixed(0) + ' g / 极限 ' +
      (animTarget / G * 1e3).toFixed(0) + ' g｜利用率 ' + (ur * 100).toFixed(1) + '%');
    animFrame += 1;
    if (collapsed) { stopAnimation(); shake(8, 0); return; }
    if (animFrame > ANIM_FRAMES) {
      stopAnimation();
      setStatus('加载完成：还有余量，可以试试更弱的设计或更多砝码。', 'ok');
      return;
    }
    animTimer = setTimeout(animTick, parseFloat($('speed').value));
  }

  /** 塌陷抖动 */
  function shake(steps, i) {
    if (i >= steps || !view.analysis) {
      view.shake = [0, 0];
      view.draw();
      return;
    }
    const amp = 7.0 * (1.0 - i / steps);
    view.shake = [amp * Math.sin(i * 2.2), amp * Math.cos(i * 1.7)];
    view.draw();
    setTimeout(function () { shake(steps, i + 1); }, 40);
  }

  // ------------------------------------------------------------------------
  // 逐级加载实验 / 极限承载力
  // ------------------------------------------------------------------------
  function runExperiment() {
    let design;
    try { design = readDesign(); } catch (err) {
      setStatus('参数不合法：' + err.message, 'error'); return;
    }
    setStatus('正在做逐级加载实验…');
    let result;
    try {
      result = Exp.runLoadTest(design.copyWith({ live_load: 0.0 }), 15);
    } catch (err) { setStatus('实验失败：' + err.message, 'error'); return; }
    testResult = result;
    const a = Fail.analyze(design);
    renderReadout(a);
    renderCharts(a);
    setStatus('实验完成：极限活载 ' + result.limit_load.toFixed(3) + ' N（' +
      (result.limit_load / G * 1e3).toFixed(0) + ' g），失效模式 ' + result.failureMode(), 'ok');
  }

  function showLimit() {
    let design;
    try { design = readDesign(); } catch (err) {
      setStatus('参数不合法：' + err.message, 'error'); return;
    }
    setStatus('正在二分搜索极限承载力…');
    let lim;
    try { lim = Fail.findLimitLoad(design.copyWith({ live_load: 0.0 })); } catch (err) {
      setStatus('搜索失败：' + err.message, 'error'); return;
    }
    limitResult = lim;
    const a = Fail.analyze(design.copyWith({ live_load: lim.limit_load }));
    const mode = lim.report.governing ? lim.report.governing.mode : '';
    view.showAnalysis(a, {
      amplify: $('amplify').checked,
      collapsed: lim.report.max_utilization >= 1.0,
      banner: '极限状态：' + mode,
    });
    renderReadout(a);
    renderCharts(a);
    if (lim.self_weight_safe) {
      setStatus('极限活载 ' + lim.limit_load.toFixed(3) + ' N（砝码 ' +
        (lim.limit_load / G * 1e3).toFixed(0) + ' g），控制失效模式 ' + mode +
        '（共求解 ' + lim.solves + ' 次）', 'ok');
    } else {
      setStatus('仅自重就已超限：这张桥撑不住自己。', 'error');
    }
  }

  function resetDefaults() {
    stopAnimation();
    testResult = null;
    limitResult = null;
    undoStack.length = 0;
    $('structure').value = 'folded';
    $('support').value = 'simply';
    $('material').value = 'office80';
    $('span').value = 30;
    $('width').value = 15;
    $('depth').value = 40;
    $('foldPanels').value = 6;
    $('webCount').value = 2;
    $('layers').value = 3;
    $('glued').checked = true;
    $('diameter').value = 30;
    $('panels').value = 6;
    $('rise').value = 8;
    $('loadType').value = 'point_center';
    $('mass').value = 0;
    $('speed').value = 120;
    $('amplify').checked = true;
    $('gridSnap').value = '0.01';
    $('memberSection').value = 'folded';
    $('memberKind').value = 'frame';
    updateSliderLabels();
    applyControlStates();
    recompute();
    setStatus('已恢复默认参数', 'ok');
  }

  // ------------------------------------------------------------------------
  // 自建结构编辑
  // ------------------------------------------------------------------------
  function ensureEditor() {
    if (!editor) {
      editor = Custom.demoSimplySupported();
      undoStack.length = 0;
    }
    return editor;
  }

  function snapshot() {
    if (editor) {
      undoStack.push(editor.snapshot());
      if (undoStack.length > 50) undoStack.shift();
    }
  }

  function afterEdit(message) {
    view.pendingNode = null;
    syncView();
    recompute();
    if (message) setStatus(message);
  }

  function undoEdit() {
    if (!isCustom()) return;
    if (!undoStack.length) { setStatus('没有可撤销的操作了'); return; }
    const snap = undoStack.pop();
    if (!editor) editor = Custom.CustomStructure.fromDict(snap);
    else editor.restore(snap);
    afterEdit('已撤销上一步');
  }

  function clearStructure() {
    if (!isCustom()) return;
    snapshot();
    if (!editor) editor = new Custom.CustomStructure();
    editor.clear();
    afterEdit('画布已清空：用「节点」模式点空白处开始搭建');
  }

  function loadDemo(key) {
    const demo = Custom.DEMOS[key];
    if (!demo) return;
    if (isCustom()) snapshot();
    editor = demo.build();
    if (isCustom()) afterEdit('已载入示例：' + demo.label);
    else syncView();
  }

  function exportJson() {
    if (!isCustom()) return;
    ensureEditor();
    const blob = new Blob([editor.toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paper-bridge.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('已导出 paper-bridge.json', 'ok');
  }

  function importJson(file) {
    if (!isCustom()) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const cs = Custom.CustomStructure.fromJSON(String(reader.result));
        snapshot();
        editor = cs;
        afterEdit('已导入 ' + file.name + '（' + cs.nodeCount() + ' 节点 / ' +
          cs.memberCount() + ' 杆件）');
      } catch (err) {
        setStatus('导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(globalThis.PB = globalThis.PB || {});

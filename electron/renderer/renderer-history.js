// renderer-history.js —— 由原 renderer.js 第 1009–1243 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 历史记录弹窗 =====
// v1.12.0 从左侧滑出的抽屉改为居中弹窗（与「设置」同一套），入口也从设置卡挪到左上角菜单。
// 本文件的函数名仍带 Drawer（openHistoryDrawer / closeHistoryDrawer）——只改外观与入口，
// 逻辑一行没动，改名会牵动 renderer-dialogs.js 的调用点，收益不抵风险

const HISTORY_SOURCE_LABELS = {
  'recommend-attach': '推荐牛人页',
  recommend: '推荐牛人页',
  search: '搜索页',
  chat: '沟通页',
};

function historySourceLabel(meta) {
  const s = meta && meta.source;
  return (s && HISTORY_SOURCE_LABELS[s]) || '未知来源';
}

function openHistoryDrawer() {
  loadHistory();
  // 无右上角关闭按钮；焦点先落在弹窗容器（aria-dialog 惯例），Esc / 点空白均可关闭
  openDialog(historyOverlay, historyDrawer);
}

function closeHistoryDrawer() {
  // 带动画关闭：走通用弹窗淡出（overlay-out/box-out），纯关掉会跳过退场动效
  closeDialog(historyOverlay, { animate: true });
}

async function loadHistory() {
  historyList.innerHTML = '';
  historyList.style.display = '';
  historyEmpty.style.display = 'none';
  let data;
  try {
    data = await window.electronAPI.listHistory();
  } catch (err) {
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = '读取历史记录失败：' + err.message;
    return;
  }
  if (data?.error) {
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = data.error;
    return;
  }
  const items = data?.list || [];
  if (items.length === 0) {
    // 空态时隐藏列表容器，空态文字才能在整个中间区域垂直居中（否则被空的列表占一半高度）
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = '暂无历史记录。';
    return;
  }
  // 列表按时间倒序（当前批次置顶）。只给最近 CONTINUE_EXTRACT_LIMIT 条展示「继续提取」——
  // 太旧的批次聊天/页面早已变化，续跑意义不大，且按钮会挤满整个列表
  items.forEach((item, index) => {
    historyList.appendChild(renderHistoryItem(item, index));
  });
}

// 只给最近多少条历史记录保留「继续提取」入口（旧的只能评分/打开/删除）
const CONTINUE_EXTRACT_LIMIT = 3;

function renderHistoryItem(item, index) {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.setAttribute('role', 'listitem');

  const meta = item.meta || {};
  const sourceLabel = historySourceLabel(meta);

  // 摘要行：时间 + 来源/状态标签 + 人数
  const summary = document.createElement('div');
  summary.className = 'history-item-summary';

  const titleEl = document.createElement('div');
  titleEl.className = 'history-item-title';
  const timeEl = document.createElement('span');
  timeEl.className = 'history-item-time';
  timeEl.textContent = item.time || '时间未知';
  const chipWrap = document.createElement('span');
  chipWrap.className = 'history-item-chips';

  // 状态胶囊放前面（已完成=绿/未完成=黄/提取中=蓝），来源标签放后面 —— v1.9.10 顺序调整。
  // 状态文案与颜色在当前批、历史批保持一致；「未完成」不写具体是哪一步。
  const batchDone = item.hasScored || item.hasExcel; // 有评分结果或 Excel = 这批已经跑完
  let stateText = null;
  let stateClass = 'meta-chip--pass';
  if (item.isCurrent) {
    if (item.hasProgress) {
      stateText = '未完成';
      stateClass = 'meta-chip--warn';
    } else if (batchDone) {
      stateText = '已完成';
    } else {
      stateText = '提取中';
      stateClass = 'meta-chip--info';
    }
  } else if (item.hasProgress) {
    stateText = '未完成';
    stateClass = 'meta-chip--warn';
  } else if (batchDone) {
    stateText = '已完成';
  } else if (item.hasCandidates || item.hasScorable) {
    // 简历已提取成功、但评分没产出结果就中断/出错（或只跑了提取）：归档后也没有
    // 结果文件 → 明确标「未完成」，不再让状态位留空；此时可点「评分」把结果补齐
    stateText = '未完成';
    stateClass = 'meta-chip--warn';
  }
  if (stateText) {
    const stateChip = document.createElement('span');
    stateChip.className = `meta-chip ${stateClass}`;
    stateChip.textContent = stateText;
    chipWrap.appendChild(stateChip);
  }

  const srcChip = document.createElement('span');
  srcChip.className = 'meta-chip';
  srcChip.textContent = sourceLabel;
  chipWrap.appendChild(srcChip);
  titleEl.append(timeEl, chipWrap);

  const countEl = document.createElement('div');
  countEl.className = 'history-item-count';
  countEl.textContent = `${item.candidateCount} 人`;

  summary.append(titleEl, countEl);

  // 操作行
  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  const makeBtn = (text, variant, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${variant}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  // 继续提取：该批次还有未完成的提取进度，且位于最近 CONTINUE_EXTRACT_LIMIT 条之内
  if (item.hasProgress && index < CONTINUE_EXTRACT_LIMIT) {
    actions.appendChild(makeBtn('继续提取', 'btn--primary', async () => {
      const res = await window.electronAPI.resumeExtraction(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); return; }
      closeHistoryDrawer();
      resetSteps();
      showState('state-running');
      // 立即按已有进度显示「提取到哪了」，而不是停在「等待开始」；数据直接来自历史列表项，无需再读文件
      initResumeStep({ done: item.candidateCount, hasCandidates: item.hasCandidates });
    }));
  }

  // 评分：该批次有简历数据就能评（完整提取 / 提了一半 / 已评分均可，换模型后重评）
  if (item.hasScorable) {
    actions.appendChild(makeBtn('评分', 'btn--secondary', async () => {
      closeHistoryDrawer();
      resetSteps();
      showState('state-running'); // 先切界面再发请求，避免留在弹窗里等结果
      const res = await window.electronAPI.rescoreFromHistory(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); showState('state-initial'); }
    }));
  }

  actions.appendChild(makeBtn('打开目录', 'btn--ghost', async () => {
    await window.electronAPI.openHistory(item.path);
  }));
  // 当前输出目录不能删除（软件正在用的目录），不显示删除按钮
  if (!item.isCurrent) {
    actions.appendChild(makeBtn('删除', 'btn--danger-ghost', async () => {
      const ok = await confirmDialog({
        title: '删除该记录？',
        message: `将删除「${item.name}」这一条记录，删除后不可恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      const res = await window.electronAPI.deleteHistory(item.path);
      if (res?.error) {
        showToast('删除失败：' + res.error, 'error');
      } else {
        showToast('已删除', 'success', 2000);
        loadHistory();
      }
    }));
  }

  row.append(summary, actions);
  return row;
}

// 与「设置」同一套次序：先把菜单收起、焦点交还 ☰，再开弹窗。
// 顺序不能反 —— openDialog 会把「打开前的焦点」记下来，好让弹窗关闭时还回去；
// 若此刻焦点还停在菜单项上，菜单随后收起会让它在 display:none 里，归还时 focus() 静默失效，
// 键盘用户的焦点直接掉到 body，下一次 Tab 从页面开头重来
btnHistory.addEventListener('click', () => {
  closeMenu({ restoreFocus: true });
  openHistoryDrawer();
});
// 点击遮罩空白处关闭（无右上角 ×，Esc 也能关，见全局 Escape 处理）。
// 走 bindBackdropDismiss（见 renderer-widgets.js）：按下与松开都落在遮罩上才算点空白，
// 在弹窗内拖动选字松手拖到窗外不会把它误关
bindBackdropDismiss(historyOverlay, closeHistoryDrawer);

// 历史弹窗打开时，滚轮只作用于弹窗里的历史列表，不带动背后的主界面滚动。
// 指针在列表上时交给浏览器原生滚动（顺滑、跟手，适配不同鼠标/触控板的滚动增量）；
// 只有滚到列表顶/底不能再滚、指针在标题/底部按钮等非列表区（转发给列表）、
// 或点在遮罩空白上时，才 preventDefault，避免滚轮穿过遮罩带动背后的主界面。
historyOverlay.addEventListener(
  'wheel',
  (e) => {
    if (historyOverlay.style.display !== 'flex') return; // 弹窗没开时不拦截
    if (historyList.contains(e.target)) {
      // 列表还能继续滚 → 放行给原生滚动（不再手动 scrollTop，滚动手感才正常）
      const atBottom = historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 1;
      const atTop = historyList.scrollTop <= 0;
      const blocked = (e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop);
      if (!blocked) return;
    } else if (historyDrawer.contains(e.target)) {
      historyList.scrollTop += e.deltaY; // 指针在标题/底部按钮等非列表区：转发给列表（滚到底自然停）
    }
    e.preventDefault(); // 已到边界 / 非列表区 / 遮罩空白：吞掉，不让页面跟着滚
  },
  { passive: false }
);

// 清空历史记录（弹窗底部）
btnHistoryClearAll.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空历史记录？',
    message: '将删除本地保存的全部历史记录，删除后不可恢复。',
    okText: '确定',
    danger: true,
  });
  if (!ok) return;
  setLoading(btnHistoryClearAll, true);
  try {
    const result = await window.electronAPI.clearHistory();
    if (result.error) {
      showToast('清理失败：' + result.error, 'error');
    } else {
      let parts = [];
      if (result.deleted > 0) parts.push('已删除 ' + result.deleted + ' 条历史记录');
      if (result.errors > 0) parts.push(result.errors + ' 个删除失败');
      if (result.deleted === 0 && result.errors === 0) parts.push('没有找到历史归档数据');
      showToast(parts.join('，'), result.errors > 0 ? 'error' : 'info', 4000);
    }
  } catch (err) {
    showToast('清理失败：' + err.message, 'error');
  } finally {
    setLoading(btnHistoryClearAll, false);
    loadHistory();
  }
});

// 岗位显示更新

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

async function openHistoryDrawer() {
  // **先把数据取回来，再开窗**。弹窗高度是由条目撑出来的（没有固定高，只封顶 78vh）：
  // 先开窗后取数的话，弹窗会先以「标题 + 底部按钮」的空壳出现（实测 133px），等 IPC 回来
  // （实测约 140ms）才撑到真实高度（十几条时 500px 以上）——盒子垂直居中，于是一瞬间上下
  // 同时往外弹开，这就是打开时看到的那一「闪」。
  // 这点等待用户看不见：点菜单项时菜单正在播 150ms 的收起动画（menu-out = --dur-fast），
  // 数据回来时它恰好退场，遮罩接上，观感是「菜单收起 → 弹窗就在了」。
  // 无右上角关闭按钮；焦点先落在弹窗容器（aria-dialog 惯例），Esc / 点空白均可关闭
  await loadHistory();
  openDialog(historyOverlay, historyDrawer);
}

function closeHistoryDrawer() {
  // 带动画关闭：走通用弹窗淡出（overlay-out/box-out），纯关掉会跳过退场动效
  closeDialog(historyOverlay, { animate: true });
}

// 空态（无记录 / 读取出错）统一走这里：藏列表、亮空态文字。
// 空态时隐藏列表容器，空态文字才能在整个中间区域垂直居中（否则被空的列表占一半高度）
function showHistoryEmpty(text) {
  historyList.style.display = 'none';
  historyEmpty.style.display = '';
  historyEmpty.textContent = text;
}

async function loadHistory() {
  let data;
  try {
    data = await window.electronAPI.listHistory();
  } catch (err) {
    showHistoryEmpty('读取历史记录失败：' + err.message);
    return;
  }
  if (data?.error) {
    showHistoryEmpty(data.error);
    return;
  }
  const items = data?.list || [];
  if (items.length === 0) {
    showHistoryEmpty('暂无历史记录。');
    return;
  }
  // **数据到手才动 DOM**：原来是一进来就清空列表再等 IPC，中间那 100 多毫秒弹窗是空的，
  // 高度先塌到最矮再撑回来（打开时那一「闪」的另一半；删记录 / 清空后刷新同理，
  // 列表会当场塌一下）。清空与填充合到一次 replaceChildren 里，中间不存在
  // 「列表已空、还没填」的那一帧——原子换内容这个保证写在 API 上，不靠调用顺序维持。
  // 列表按主进程给的顺序（时间倒序，当前批次置顶）渲染；只给最近 CONTINUE_EXTRACT_LIMIT 条
  // 展示「继续提取」——太旧的批次聊天/页面早已变化，续跑意义不大，且按钮会挤满整个列表
  historyList.replaceChildren(...items.map(renderHistoryItem));
  historyList.style.display = '';
  historyEmpty.style.display = 'none';
}

// 只给最近多少条历史记录保留「继续提取」入口（旧的只能评分/打开/删除）
const CONTINUE_EXTRACT_LIMIT = 3;

function renderHistoryItem(item, index) {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.setAttribute('role', 'listitem');

  const meta = item.meta || {};
  const sourceLabel = historySourceLabel(meta);

  // 第一行：时间（左） + 人数（右）
  // （原先 head / foot 两层包装 div 已删：它们只为把四个格子分成两行，而四格各自有
  //  显式的 grid-area，包装层反而是多余的——还得靠 display:contents 把自己拆掉才不挡网格。
  //   现在四项直接挂到 .history-item 上，见下方 row.append）
  const timeEl = document.createElement('span');
  timeEl.className = 'history-item-time';
  timeEl.textContent = item.time || '时间未知';

  // 第二行：状态/来源胶囊（左） + 操作按钮（右，右对齐）—— 按钮从原来独立的第三行上移到这里，
  // 与「已完成」药丸同行，条目由 3 行压到 2 行。
  const chipWrap = document.createElement('span');
  chipWrap.className = 'history-item-chips';

  // 状态胶囊放前面（进行中=蓝/已完成=绿/未完成=黄），来源标签放后面 —— v1.9.10 顺序调整。
  // 状态文案与颜色在当前批、历史批保持一致；「未完成」不写具体是哪一步。
  const batchDone = item.hasScored || item.hasExcel; // 有评分结果或 Excel = 这批已经跑完
  let stateText = null;
  let stateClass = 'meta-chip--pass';
  // 蓝胶囊只认「这一批此刻真在跑」（isRunning 由主进程查任务状态给，见 ipc.mjs 的 list-history）。
  // 以前是按文件状态猜的（当前批次 + 没进度文件 + 没评分结果 = 蓝「提取中」），结果是两头都错：
  // 提取**真在跑**时进度文件一直在（每提一人写一次），显示的反而是黄「未完成」，蓝从没亮过；
  // 蓝真正会亮的只有「提取已结束（进度文件被删）到评分结果落盘」这段收尾窗口——而这段里要是
  // 用户点了停止或评分报错，这一批就永久卡在蓝「提取中」，明明什么都没在跑。改按任务状态判后：
  // 真在跑=蓝「进行中」，没在跑又没结果=下面的黄「未完成」（与归档批次同一条路），卡蓝随之消失。
  if (item.isRunning) {
    stateText = '进行中';
    stateClass = 'meta-chip--info';
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
  const countEl = document.createElement('div');
  countEl.className = 'history-item-count';
  countEl.textContent = `${item.candidateCount} 人`;

  // 操作按钮：停在第二行右端（见 .history-item-actions 的 justify-self/justify-content，宽度富余时贴右，
  // 挤不下时本行内换行仍贴右）
  // 顺序固定为 继续提取 → 删除 → 打开目录 → 评分（用户指定）：
  //   中间两个是纯图标钮（删除 / 打开目录），两端是文字钮，视觉上「文字-图标-图标-文字」对称；
  //   评分靠最右且唯一实心，是这一行的主 CTA（§8「主 CTA 靠右」）；危险动作留在偏左，避开惯用点击区。
  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  // 造按钮的骨架只留一份：文字钮与纯图标钮只差内容形态，别的（类型/类名/点击）都一样
  const newBtn = (className, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.addEventListener('click', onClick);
    return b;
  };
  const makeBtn = (text, variant, onClick) => {
    const b = newBtn(`btn btn--sm ${variant}`, onClick);
    b.textContent = text;
    return b;
  };

  // 纯图标钮：没有文字兜底，只给 aria-label（读屏用）。**不给 title**——
  // 原生 title 会在悬停时弹出系统提示气泡，用户不要那个；语义已由 aria-label 承担。
  // size 由调用方按「墨迹等高」给，不是所有图标都给同一个 svg 尺寸：
  // Material 的 24 画布自带约 2 单位留白、各图标的墨迹占比还不一样（垃圾桶 18/24 高、文件夹只 16/24 高），
  // 同一个 svg 尺寸下垃圾桶会比文件夹明显大一圈。要让两枚图标看起来一样大，得按墨迹高度反推：
  //   垃圾桶 18px × 18/24 = 13.5px 墨迹
  //   文件夹 20px × 16/24 = 13.3px 墨迹  ← 两枚墨迹等高（用户要求：比原来 16/18 各放大一档）
  const makeIconBtn = (iconId, label, size, onClick) => {
    const b = newBtn('btn btn--icon', onClick);
    b.setAttribute('aria-label', label);
    b.innerHTML = iconSvg(iconId, size); // 图标模板统一走 renderer-dom.js 的 iconSvg()
    return b;
  };

  // 继续提取：该批次还有未完成的提取进度，且位于最近 CONTINUE_EXTRACT_LIMIT 条之内。
  // 空心（secondary，蓝描边蓝字）：本轮把实心让给了「评分」，它降为次要动作
  if (item.hasProgress && index < CONTINUE_EXTRACT_LIMIT) {
    actions.appendChild(makeBtn('继续提取', 'btn--secondary', async () => {
      const res = await window.electronAPI.resumeExtraction(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); return; }
      closeHistoryDrawer();
      resetSteps();
      showState('state-running');
      // 立即按已有进度显示「提取到哪了」，而不是停在「等待开始」；数据直接来自历史列表项，无需再读文件
      initResumeStep({ done: item.candidateCount, hasCandidates: item.hasCandidates });
    }));
  }

  // 删除：当前输出目录不能删（软件正在用的目录），但按钮照常占位、走禁用态——
  // 只删按钮会让每行末端结构不一致、图标位置跳来跳去；禁用理由写进 aria-label，
  // 不让「为什么这行没有删除」只靠用户猜（§0 原则 10 状态双通道：不只靠变灰）。
  // 底色走 btn--ghost（灰）而非 btn--danger-ghost（红）：用户要求与「打开目录」统一成灰，
  // 破坏性语义改由「垃圾桶字形 + 删除确认弹窗」承担，不再靠颜色预警
  const delBtn = makeIconBtn(
    'icon-delete',
    item.isCurrent ? '当前批次正在使用，不能删除' : '删除',
    18, // 垃圾桶墨迹占 18/24，18px 出来约 13.5px（与文件夹 20px 的 13.3px 墨迹等高）
    async () => {
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
    },
  );
  if (item.isCurrent) delBtn.disabled = true; // 禁用态样式见 .btn.btn--icon:disabled（它会盖掉 .btn:disabled 的灰底）；disabled 本身已拦截点击
  actions.appendChild(delBtn);

  // 文件夹墨迹只占 16/24，要 20px 才和垃圾桶 18px 的 13.5px 墨迹等高
  actions.appendChild(makeIconBtn('icon-folder', '打开目录', 20, async () => {
    await window.electronAPI.openHistory(item.path);
  }));

  // 评分：该批次有简历数据就能评（完整提取 / 提了一半 / 已评分均可，换模型后重评）。
  // 实心（primary）：本行唯一主 CTA，放在最右
  if (item.hasScorable) {
    actions.appendChild(makeBtn('评分', 'btn--primary', async () => {
      closeHistoryDrawer();
      resetSteps();
      showState('state-running'); // 先切界面再发请求，避免留在弹窗里等结果
      const res = await window.electronAPI.rescoreFromHistory(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); showState('state-initial'); }
    }));
  }

  // 四格直接挂到网格容器上。**顺序按视觉阅读顺序**（时间 → 人数 → 胶囊 → 按钮）：
  // 四格的 grid-area 都已显式指定，摆放不看 DOM 顺序，但 Tab 顺序看 —— 顺序错了键盘会跳着走
  row.append(timeEl, countEl, chipWrap, actions);
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

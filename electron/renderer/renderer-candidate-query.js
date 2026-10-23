// renderer-candidate-query.js —— 候选人查询（跨批次评价索引）与历史批次详情（v1.20.0）
//
// 候选人查询：每批评分完成后，主进程往索引里追加「一人一条评价」（见 candidate-index.mjs）。
// 几天后候选人回了消息，在这里按姓名（中文 / 拼音首字母 / 全拼）一搜，就能翻到当时的 AI 评价。
//
// 历史批次详情：点历史记录的某一行（有评分结果的那些），显示该批次的评分结果 ——
// 与历史弹窗互切（同目标岗位 ⇄ 编辑岗位那套淡入淡出），关掉后回到历史记录；
// 内容与完成页同一个渲染函数（renderResultsInto），看着完全一样。

// ===== 候选人查询 =====

// 输入停顿多久才去扫索引：索引可能有几十 MB，每敲一个字都扫一遍会卡
const CANDIDATE_QUERY_DEBOUNCE_MS = 120;
const CANDIDATE_QUERY_HINT = '输入候选人姓名开始查询';

let candidateQueryTimer = null;
// 同一时刻只放一次扫描进主进程（索引可能有几十 MB）：扫描期间又输入了，只记最后一次，
// 等这次回来自动重跑 —— 否则连着敲几下就会在主进程里叠起好几个全文件扫描
let candidateQueryBusy = false;
let candidateQueryQueued = null;
// 请求序号：关弹窗 / 清空输入时作废在飞的这次结果
let candidateQuerySeq = 0;

// 空态 / 提示态：藏结果区、亮提示文字
function showCandidateQueryHint(text) {
  candidateQueryHint.textContent = text;
  candidateQueryHint.style.display = '';
  candidateQueryResults.style.display = 'none';
  candidateQueryList.replaceChildren();
}

function resetCandidateQueryView() {
  candidateQueryInput.value = '';
  candidateQueryClearInput.classList.remove('show');
  showCandidateQueryHint(CANDIDATE_QUERY_HINT);
}

function openCandidateQuery() {
  // 同「设置 / 历史记录」：先把菜单收起、焦点交还 ☰，openDialog 才记得住正确的归处
  closeMenu({ restoreFocus: true });
  resetCandidateQueryView();
  openDialog(candidateQueryOverlay, candidateQueryInput);
}

function closeCandidateQuery() {
  clearTimeout(candidateQueryTimer);
  candidateQuerySeq++; // 还在飞的查询结果回来后不要再往已关闭的弹窗里画
  candidateQueryQueued = null; // 排队中的那次也不必再扫了
  closeDialog(candidateQueryOverlay, { animate: true });
}

async function runCandidateQuery(query) {
  if (candidateQueryBusy) {
    candidateQueryQueued = query;
    candidateQuerySeq++; // 在飞的这次作废，它回来自动接着跑排队的这次
    return;
  }
  candidateQueryBusy = true;
  const seq = ++candidateQuerySeq;
  try {
    let data;
    try {
      data = await window.electronAPI.searchCandidateIndex(query);
    } catch (err) {
      if (seq === candidateQuerySeq) showCandidateQueryHint('查询失败：' + (err?.message || err));
      return;
    }
    // 弹窗已关 / 这次已被排队的新查询顶掉：丢掉结果
    if (seq !== candidateQuerySeq || candidateQueryOverlay.style.display !== 'flex') return;
    const candidates = data?.candidates || [];
    if (candidates.length === 0) {
      showCandidateQueryHint('未找到匹配的候选人');
      return;
    }

    candidateQueryHint.style.display = 'none';
    candidateQueryResults.style.display = '';
    // 不显示「评分记录 / N 条评价 · N 人」这一行（用户要求去掉计数）
    // 结果一律折叠，不默认展开任何一条（用户要求）：一个字就能查出一大片人，
    // 默认展开会把一屏塞满；要看评价点行头的展开箭头
    renderResultsList(candidates, { listEl: candidateQueryList });
  } finally {
    candidateQueryBusy = false;
    const next = candidateQueryQueued;
    candidateQueryQueued = null;
    if (next !== null && candidateQueryOverlay.style.display === 'flex') runCandidateQuery(next);
  }
}

function scheduleCandidateQuery() {
  const query = candidateQueryInput.value.trim();
  candidateQueryClearInput.classList.toggle('show', !!candidateQueryInput.value);
  clearTimeout(candidateQueryTimer);
  if (!query) {
    candidateQuerySeq++; // 清空输入：作废在飞的请求，立刻回到提示态
    candidateQueryQueued = null;
    showCandidateQueryHint(CANDIDATE_QUERY_HINT);
    return;
  }
  candidateQueryTimer = setTimeout(() => runCandidateQuery(query), CANDIDATE_QUERY_DEBOUNCE_MS);
}

btnCandidateQuery.addEventListener('click', openCandidateQuery);
candidateQueryInput.addEventListener('input', scheduleCandidateQuery);
// 回车立刻查，不等防抖
candidateQueryInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(candidateQueryTimer);
  const query = candidateQueryInput.value.trim();
  if (query) runCandidateQuery(query);
});
candidateQueryClearInput.addEventListener('click', () => {
  candidateQueryInput.value = '';
  scheduleCandidateQuery();
  candidateQueryInput.focus();
});
// 无右上角 ×：Esc 或点遮罩空白关闭（同历史记录）
bindBackdropDismiss(candidateQueryOverlay, closeCandidateQuery);

btnCandidateQueryClear.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空候选人数据？',
    message: '将删除本地保存的全部候选人数据，删除后不可恢复。',
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  setLoading(btnCandidateQueryClear, true);
  try {
    const res = await window.electronAPI.clearCandidateIndex();
    if (res?.error) {
      showToast('清空失败：' + res.error, 'error');
    } else {
      // 没有可删的数据走中性色（与清空历史记录同一口径：完成了才绿，没东西可删别说成完成）
      if (res?.cleared) showToast('已清空候选人数据', 'success', 2000);
      else showToast('没有找到候选人数据', 'info', 2000);
      resetCandidateQueryView();
    }
  } catch (err) {
    showToast('清空失败：' + (err?.message || err), 'error');
  } finally {
    setLoading(btnCandidateQueryClear, false);
  }
});

// ===== 历史批次详情 =====

// 打开某批次的评分结果。数据到手再开窗（同历史记录的做法）：
// 先开空窗的话，弹窗会以一条空壳撑一下再跳成真实高度，视觉上就是「闪一下」
let batchDetailSeq = 0;
async function openBatchDetail(item, openerEl) {
  const seq = ++batchDetailSeq;
  let data;
  try {
    data = await window.electronAPI.getBatchResults(item.path);
  } catch (err) {
    if (seq !== batchDetailSeq) return;
    showToast('读取批次详情失败：' + (err?.message || err), 'error');
    return;
  }
  // 读完这几百毫秒里用户可能又点了别的批次、或把历史记录关了（正在淡出也算）：只认最后一次点击
  if (seq !== batchDetailSeq
    || historyOverlay.style.display !== 'flex'
    || historyOverlay.classList.contains('dialog-overlay--closing')) return;

  const meta = item.meta || {};
  // 只留时间与来源，不带人数（用户要求）：人数在下面的统计块里已经有了
  batchDetailSub.textContent = [item.time, historySourceLabel(meta)]
    .filter(Boolean).join(' · ');

  if (!data || data.error || !data.available) {
    batchDetailBody.style.display = 'none';
    batchDetailEmpty.style.display = '';
    batchDetailEmpty.textContent = data?.error || '该批次没有评分结果。';
  } else {
    batchDetailEmpty.style.display = 'none';
    batchDetailBody.style.display = '';
    renderResultsInto(data, {
      tierBars: batchDetailTierBars,
      list: batchDetailList,
      statExtracted: batchDetailStatExtracted,
      statPassed: batchDetailStatPassed,
      statAvg: batchDetailStatAvg,
      statRate: batchDetailStatRate,
    });
  }

  // 与历史记录互切，不叠层（用户要求：像目标岗位 ⇄ 编辑岗位那样两个弹窗之间切换）。
  // 第三个参数把「关掉后回到哪条记录」写进焦点层栈，不必另存一个 opener 变量
  swapDialogs(historyOverlay, batchDetailOverlay,
    () => openDialog(batchDetailOverlay, batchDetailBox, openerEl));
}

// 关掉批次详情 = 互切回历史记录（Esc / 点遮罩都走这里），焦点回到刚才那条记录
function closeBatchDetail() {
  const opener = dialogFocusStack.find((layer) => layer.overlay === batchDetailOverlay)?.prev;
  const focusEl = opener && opener.isConnected ? opener : historyDrawer;
  swapDialogs(batchDetailOverlay, historyOverlay, () => openDialog(historyOverlay, focusEl));
}

// 点遮罩空白关闭（无底部「关闭」按钮）。关掉后互切回历史记录，焦点回到刚才那条
// （openDialog 按层记了「打开前的焦点」，见 renderer-dialogs.js 的弹窗栈）
bindBackdropDismiss(batchDetailOverlay, closeBatchDetail);

// 滚轮守卫（两个新弹窗）：通用实现见 renderer-widgets.js 的 bindDialogWheelGuard
bindDialogWheelGuard(candidateQueryOverlay, candidateQueryList);
bindDialogWheelGuard(batchDetailOverlay, batchDetailList);

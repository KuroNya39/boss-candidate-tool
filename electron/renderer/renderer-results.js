// renderer-results.js —— 由原 renderer.js 第 475–608 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 完成页结果可视化 =====

// 档位分布条的元信息（顺序从高分到低分）。颜色用 CSS 类控制，避免内联色值。
const TIER_BAR_META = [
  { tier: 5, label: '五星', className: 'tier-bar-fill--5' },
  { tier: 4, label: '四星', className: 'tier-bar-fill--4' },
  { tier: 3, label: '三星', className: 'tier-bar-fill--3' },
  { tier: 2, label: '二星', className: 'tier-bar-fill--2' },
  { tier: 1, label: '一星', className: 'tier-bar-fill--1' },
];

function renderTierBars(tiers, total) {
  const container = document.getElementById('tier-bars');
  if (!container) return;
  container.innerHTML = '';
  for (const meta of TIER_BAR_META) {
    const count = tiers[meta.tier] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'tier-bar';
    const label = document.createElement('span');
    label.className = 'tier-bar-label';
    label.textContent = meta.label;
    const track = document.createElement('span');
    track.className = 'tier-bar-track';
    const fill = document.createElement('span');
    fill.className = `tier-bar-fill ${meta.className}`;
    fill.style.width = pct + '%';
    track.appendChild(fill);
    const countEl = document.createElement('span');
    countEl.className = 'tier-bar-count';
    countEl.textContent = `${count} 人 · ${pct}%`;
    row.append(label, track, countEl);
    container.appendChild(row);
  }
}

function renderResultsList(candidates) {
  const listEl = document.getElementById('results-list');
  const countEl = document.getElementById('results-count');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (countEl) countEl.textContent = `共 ${candidates.length} 人`;

  for (const c of candidates) {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.setAttribute('role', 'listitem');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'result-item-head';
    head.setAttribute('aria-expanded', 'false');

    const nameEl = document.createElement('span');
    nameEl.className = 'result-item-name';
    nameEl.textContent = c.name;

    const scoreEl = document.createElement('span');
    scoreEl.className = 'result-item-score';
    scoreEl.textContent = c.score + ' 分';

    const tierEl = document.createElement('span');
    tierEl.className = `result-item-tier tier--${c.tier}`;
    tierEl.textContent = '★'.repeat(c.tier) + '☆'.repeat(5 - c.tier);
    tierEl.setAttribute('aria-label', `${c.tier} 星`);

    const arrowEl = document.createElement('span');
    arrowEl.className = 'result-item-arrow';
    arrowEl.setAttribute('aria-hidden', 'true');
    arrowEl.innerHTML = SVG_CHEVRON_RIGHT;

    head.append(nameEl, scoreEl, tierEl, arrowEl);

    const body = document.createElement('div');
    body.className = 'result-item-body';
    body.style.display = 'none';

    const metaEl = document.createElement('div');
    metaEl.className = 'result-item-meta';
    if (c.position) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.textContent = c.position;
      metaEl.appendChild(chip);
    }
    const levelChip = document.createElement('span');
    levelChip.className = `meta-chip ${c.passed ? 'meta-chip--pass' : 'meta-chip--fail'}`;
    levelChip.textContent = c.level;
    metaEl.appendChild(levelChip);
    const passChip = document.createElement('span');
    passChip.className = 'meta-chip';
    passChip.textContent = c.passed ? '通过' : '未通过';
    metaEl.appendChild(passChip);

    const commentEl = document.createElement('div');
    commentEl.className = 'result-item-comment';
    commentEl.textContent = c.comment || '（无评语）';
    commentEl.style.whiteSpace = 'pre-line';

    body.append(metaEl, commentEl);

    // 姓名可拖拽选中复制，但整行又是展开/收起按钮，两种操作共用一次点击。
    // 判定分两种：拖选（按下与松开不在同一处）不切换；双击选词（第二次点击时选区已在姓名里）也不切换。
    // 位置判定不能省：从姓名里按下、拖到分数或星星上松开时，click 的 target 是整行按钮本身、
    // 不在姓名里，只靠下面那道选区判定会误当成点击。
    // 阈值沿用 renderer-dialogs.js 的 SOURCE_DRAG_THRESHOLD（同一个「位移没过阈值算手抖」的概念）——
    // 它定义在后面的文件里，但这里只在 click 回调里读，页面加载完才会执行，不存在暂时性死区。
    // 键盘回车/空格触发的 click 没有 mousedown，clientX/Y 为 0，pressX 为 null → 照常切换
    let pressX = null;
    let pressY = null;
    head.addEventListener('mousedown', (e) => {
      pressX = e.clientX;
      pressY = e.clientY;
    });
    head.addEventListener('click', (e) => {
      const dragged = pressX !== null
        && (Math.abs(e.clientX - pressX) >= SOURCE_DRAG_THRESHOLD || Math.abs(e.clientY - pressY) >= SOURCE_DRAG_THRESHOLD);
      pressX = null;
      pressY = null;
      if (dragged) return;

      // 只在「点在姓名上、且选区也在姓名里」时让路，点分数/箭头仍可正常展开收起
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && e.target && nameEl.contains(e.target) && nameEl.contains(sel.anchorNode)) return;

      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!expanded));
      body.style.display = expanded ? 'none' : '';
      // 箭头图标保持 chevron-right 不变，展开态由 CSS 的 rotate(90deg) 转成向下（带平滑过渡）
    });

    item.append(head, body);
    listEl.appendChild(item);
  }
}

async function loadScoringResults() {
  const resultsVisual = document.getElementById('results-visual');
  if (!resultsVisual) return;
  try {
    const data = await window.electronAPI.getScoringResults();
    if (!data || !data.available || data.total < 1) {
      resultsVisual.style.display = 'none';
      return;
    }
    document.getElementById('stat-extracted').textContent = data.total;
    document.getElementById('stat-passed').textContent = data.passed;
    document.getElementById('stat-avg').textContent = data.avgScore;
    document.getElementById('stat-rate').textContent = data.passRate + '%';
    renderTierBars(data.tiers, data.total);
    renderResultsList(data.candidates);
    resultsVisual.style.display = '';
  } catch {
    resultsVisual.style.display = 'none';
  }
}

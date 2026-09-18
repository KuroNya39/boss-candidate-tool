// renderer-jobs.js —— 由原 renderer.js 第 1244–1351 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
function updateJobDisplay() {
  if (selectedJob) {
    jobDisplay.textContent = selectedJob;
    jobDisplay.className = 'job-display';
  } else {
    jobDisplay.textContent = '请选择岗位';
    jobDisplay.className = 'job-display placeholder';
  }
}

// 加载岗位列表
async function loadJobList() {
  try {
    // 主进程连「可搜索文本」一起送回来（岗位名 + 拼音首字母，见 electron/pinyin.mjs），两者同序
    ({ jobs: jobList, searchText: jobSearchText } = await window.electronAPI.getRecommendJobs());
    // 如果已选岗位不在新列表中，清空选中
    if (selectedJob && !jobList.includes(selectedJob)) {
      selectedJob = '';
    }
    updateJobDisplay();
    renderJobPicker();
  } catch (err) {
    console.error('加载岗位列表失败:', err);
  }
}

// 渲染目标岗位弹窗列表
function renderJobPicker() {
  jobPickerList.innerHTML = '';

  // 顶部：添加新岗位
  const addItem = document.createElement('div');
  addItem.className = 'job-picker-item job-picker-add';
  addItem.setAttribute('role', 'listitem');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'job-picker-item-name';
  addBtn.textContent = '+ 添加新岗位';
  addBtn.addEventListener('click', () => {
    swapJobDialogs(showAddJobDialog);
  });
  addItem.appendChild(addBtn);
  jobPickerList.appendChild(addItem);

  // 岗位列表（按搜索词实时过滤；jobList 保持不变，只过滤副本）
  if (jobList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item empty-state';
    empty.textContent = '暂无岗位';
    jobPickerList.appendChild(empty);
    return;
  }
  // 「可搜索文本」里既有岗位名原文、也有拼音首字母串，故一句 includes 就够：
  // xsqd → 显示驱动…、sz → 深圳、zh → 珠海、35k → 薪资段（原文里本来就有分隔，所以能按单个词搜）
  const query = jobSearchQuery.trim().toLowerCase();
  const filtered = query ? jobList.filter((job, i) => jobSearchText[i].includes(query)) : jobList;
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item empty-state';
    empty.textContent = '未找到匹配的岗位';
    jobPickerList.appendChild(empty);
    return;
  }
  filtered.forEach(job => {
    const item = document.createElement('div');
    item.className = 'job-picker-item';
    item.setAttribute('role', 'listitem');
    if (job === selectedJob) item.classList.add('selected');

    // 岗位名称（可点击/键盘切换）
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'job-picker-item-name';
    nameBtn.textContent = job;
    nameBtn.addEventListener('click', () => {
      selectedJob = job;
      updateJobDisplay();
      hideJobPicker();
    });
    item.appendChild(nameBtn);

    // 操作按钮组
    const actions = document.createElement('span');
    actions.className = 'job-picker-item-actions';

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn btn--sm btn--ghost';
    btnEdit.textContent = '编辑';
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      // 编辑弹窗互切：旧弹窗直接收起（不淡出），由编辑弹窗入场接管，避免两弹窗叠放交叉
      swapJobDialogs(() => showEditJobDialog(job));
    });
    actions.appendChild(btnEdit);

    const btnDelete = document.createElement('button');
    // 与「编辑」同为灰描边灰字：这一行两枚按钮并排，一红一灰会读成「删除比编辑重一级」，
    // 实际是同一层的行内操作；红色留给真正不可逆的主操作（历史记录里的「清空」仍走红）
    btnDelete.className = 'btn btn--sm btn--ghost';
    btnDelete.textContent = '删除';
    btnDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteJob(job);
    });
    actions.appendChild(btnDelete);

    item.appendChild(actions);
    jobPickerList.appendChild(item);
  });
}


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
    jobList = await window.electronAPI.getRecommendJobs();
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
    hideJobPicker();
    showAddJobDialog();
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
  const query = jobSearchQuery.trim().toLowerCase();
  const filtered = query ? jobList.filter(job => job.toLowerCase().includes(query)) : jobList;
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
      // 编辑弹窗层级高于「目标岗位」弹窗，关闭后立即打开即可，无需等待
      hideJobPicker();
      showEditJobDialog(job);
    });
    actions.appendChild(btnEdit);

    const btnDelete = document.createElement('button');
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


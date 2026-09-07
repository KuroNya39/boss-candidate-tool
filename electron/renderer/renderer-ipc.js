// renderer-ipc.js —— 由原 renderer.js 第 609–816 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//

// ===== IPC 监听注册 =====
function setupListeners() {
  cleanupAll();
  registerCleanup(window.electronAPI.onProgress(handleProgress));

  registerCleanup(
    window.electronAPI.onDone(async (data) => {
      resetPauseButton();
      showState('state-done');
      const mailDetails = document.getElementById('mail-error-details');
      const mailDetail = document.getElementById('mail-error-detail');
      // 只留一行核心结果：邮件发送失败时不写「已发送至」，改由下方折叠条展示原因
      if (data.emailError) {
        doneSummary.textContent = '';
        if (mailDetails && mailDetail) {
          mailDetails.style.display = '';
          // 展开显示服务器返回的报错原文；折叠条标题「邮件发送失败的原因」已在 HTML 里写死
          mailDetail.textContent = data.emailError;
        }
      } else {
        doneSummary.textContent = data.emailTo
          ? `结果Excel已发送至：${data.emailTo}`
          : '结果Excel已生成';
        if (mailDetails) mailDetails.style.display = 'none';
      }

      // 完成页结果可视化：统计条 + 档位分布 + 候选人列表
      loadScoringResults();

      // 检查评分数据，显示批量打招呼（只有推荐牛人页支持；沟通页/搜索页不做）
      resetGreetUI();
      if (selectedSource !== 'chat' && selectedSource !== 'search') {
        try {
          const counts = await window.electronAPI.getGreetCandidateCounts();
          if (counts.available) {
            greetSection.style.display = '';
            updateGreetCount(counts);

            // 自动打招呼
            if (autoGreetEnabled) {
              const level = parseInt(autoGreetLevel.value, 10);
              greetLevel.value = String(level);
              updateGreetCount(counts);
              // 延迟片刻让 UI 渲染完成，再自动开始
              setTimeout(async () => {
                btnStartGreet.style.display = 'none';
                btnCancelGreet.style.display = 'none';
                greetResult.style.display = 'none';
                greetProgress.style.display = '';
                greetProgressBar.style.width = '0%';
                if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', '0');
                greetProgressText.textContent = '自动打招呼中…';
                const res = await window.electronAPI.startGreeting(level, selectedSource);
                autoGreetEnabled = false;
                // 已有任务运行中：主进程拒绝，恢复打招呼面板而不是停在假进度
                if (res?.error) {
                  showToast(res.error, 'warning', 4000);
                  greetProgress.style.display = 'none';
                  greetResult.style.display = 'none';
                  btnStartGreet.style.display = '';
                  btnCancelGreet.style.display = 'none';
                }
              }, 500);
            }
          }
        } catch {}
      }
    })
  );

  registerCleanup(
    window.electronAPI.onError((data) => {
      resetPauseButton();
      showState('state-error');
      errorMessage.textContent = data.message || '未知错误';
    })
  );

  // 打招呼事件
  registerCleanup(
    window.electronAPI.onGreetProgress((data) => {
      const cur = data.current || 0;
      const total = data.total || 0;
      const pct = total > 0 ? Math.min(Math.round((cur / total) * 100), 100) : 0;
      greetProgressBar.style.width = pct + '%';
      if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', String(pct));
      greetProgressText.textContent = total > 0 ? `正在打招呼 ${cur}/${total}` : '正在打招呼';
    })
  );

  registerCleanup(
    window.electronAPI.onGreetDone((data) => {
      greetProgress.style.display = 'none';
      btnCancelGreet.style.display = 'none';
      btnStartGreet.style.display = '';
      greetResult.style.display = '';
      greetResult.className = 'greet-result'; // 重置，避免上一次失败的红色样式残留
      greetResult.textContent =
        `成功打招呼 ${data.success} 人` +
        (data.already > 0 ? `，${data.already} 人已打过招呼` : '') +
        (data.notFound > 0 ? `，${data.notFound} 人不在当前列表中` : '') +
        (data.skipped > 0 ? `，${data.skipped} 人跳过` : '');
      autoGreetEnabled = false;
    })
  );

  registerCleanup(
    window.electronAPI.onGreetError((data) => {
      greetProgress.style.display = 'none';
      btnCancelGreet.style.display = 'none';
      btnStartGreet.style.display = '';
      greetResult.style.display = '';
      greetResult.className = 'greet-result greet-result-error';
      greetResult.textContent = '打招呼失败：' + data.message;
      autoGreetEnabled = false;
    })
  );
}

// ===== API 配置 =====
async function loadApiConfig() {
  try {
    const config = await window.electronAPI.getApiConfig();
    if (config.url) apiUrlInput.value = config.url;
    if (config.key) apiKeyInput.value = config.key;
    if (config.model) apiModelInput.value = config.model;
    if (config.emailPrefix) emailPrefixInput.value = config.emailPrefix;
    if (config.smtpPass) smtpPassInput.value = config.smtpPass;
  } catch {}
  updateConfigStatus();
}

// 设置缺失时指出具体缺哪一项（未设置 → 「未设置：缺 API 地址（或 Key / 模型）」）
function missingConfigFields() {
  const missing = [];
  if (!apiUrlInput.value.trim()) missing.push('API 地址');
  if (!apiKeyInput.value.trim()) missing.push('API Key');
  if (!apiModelInput.value.trim()) missing.push('模型名称');
  return missing;
}

// 根据设置是否完整，决定主按钮可用性与下方提示（无状态胶囊，仅做门控）
async function updateConfigStatus() {
  const hint = document.getElementById('btn-start-hint');
  const missing = missingConfigFields();
  const setMissing = (msg) => {
    btnStart.disabled = true;
    if (hint) hint.textContent = msg || '请先展开上方「设置」填写 ' + missing.join('、') + ' 并保存';
  };
  try {
    const status = await window.electronAPI.getApiConfigStatus();
    if (status.configured) {
      btnStart.disabled = false;
      if (hint) hint.textContent = '';
    } else {
      setMissing();
    }
  } catch {
    setMissing();
  }
}

btnSaveConfig.addEventListener('click', async () => {
  const url = apiUrlInput.value.trim();
  const key = apiKeyInput.value.trim();
  const model = apiModelInput.value.trim();

  if (!url || !key || !model) {
    showToast('请把设置填写完整（API 地址、Key、模型名称）', 'warning');
    return;
  }

  try {
    // 简单校验 URL 格式
    new URL(url);
  } catch {
    showToast('API 地址格式不正确', 'warning');
    return;
  }

  // 邮箱可选，但填了就必须是完整地址（含 @），不自动补域名
  const emailVal = emailPrefixInput.value.trim();
  if (emailVal && !emailVal.includes('@')) {
    showToast('邮箱请填完整地址（含 @），如 hr@example.com', 'warning');
    return;
  }

  try {
    await window.electronAPI.setApiConfig({
      url, key, model,
      emailPrefix: emailVal,
      smtpPass: smtpPassInput.value.trim(),
    });
    showToast('设置已保存', 'success', 3000);
    updateConfigStatus();
  } catch (err) {
    showToast('保存失败：' + err.message, 'error', 4000);
  }
});

// Collapsible API Config
apiConfigToggle.addEventListener('click', () => {
  const expanded = apiConfigBody.classList.toggle('expanded');
  apiConfigArrow.classList.toggle('expanded');
  apiConfigToggle.setAttribute('aria-expanded', String(expanded));
});


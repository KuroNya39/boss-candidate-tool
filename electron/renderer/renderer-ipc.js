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
          ? `结果 Excel 已发送至：${data.emailTo}`
          : '结果 Excel 已生成';
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
                // 记录本轮档位，跑完有失败时「重试」沿用同一批（auto-greet 与手动共用 onGreetDone）；
                // 来源统一 greetSource()（共享函数在 renderer-dom.js），不另存（见 renderer-dom.js 状态注释）
                lastGreetRun = { level };
                const source = greetSource();
                const res = await window.electronAPI.startGreeting({ level, source, retry: false });
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
      greetProgressText.textContent = total > 0 ? `正在打招呼… ${cur}/${total}` : '正在打招呼…';
    })
  );

  registerCleanup(
    window.electronAPI.onGreetDone((data) => {
      greetProgress.style.display = 'none';
      btnCancelGreet.style.display = 'none';
      btnStartGreet.style.display = '';
      greetResult.style.display = '';

      const hasRetry = data.retryable > 0;
      // 有可重试失败 → 按钮当场变「重试」，只补「点过没成」的人；全成功 → 回「开始打招呼」。
      // level 取本轮跑的档位；greetRetry 不记 source——重试点击时由 greetSource() 现算（见 renderer-dom.js）
      greetRetry = hasRetry
        ? { level: lastGreetRun ? lastGreetRun.level : parseInt(greetLevel.value, 10) }
        : null;
      updateGreetButton();

      // 可重试失败 ≠ 全红错误（不是流程挂了，是部分人被风控挡下），用警示色区别于红错
      greetResult.className = hasRetry ? 'greet-result greet-result-warn' : 'greet-result';
      greetResult.textContent =
        `成功打招呼 ${data.success} 人` +
        (data.already > 0 ? `，${data.already} 人已打过招呼` : '') +
        (data.notFound > 0 ? `，${data.notFound} 人不在当前列表中` : '') +
        (hasRetry ? `，${data.retryable} 人未成功，可点上方「重试」再试` : '') +
        (data.skipped > 0 ? `，${data.skipped} 人当前无打招呼按钮，未打招呼` : '');
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
      clearGreetRetry(); // 出错不延续「重试」，按钮回「开始打招呼」
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
  updateSmtpPassState(); // 值填完再定密码框的状态，否则会先按空值禁用一次
  updateConfigStatus();
}

// 邮箱密码框跟着邮箱地址走：没填地址就禁用（没地址 = 没发件人，密码填了也发不出去），
// 填了地址才恢复可填。用原生 disabled —— config.css 里 .input-text:disabled /
// .input-toggle:disabled 已备好禁用那一档；placeholder 顺便换一句话，免得灰框看着像坏了
// （§9「状态不只靠颜色」）。禁用不清空已存的密码：把地址填回来，之前的密码还在。
const SMTP_PASS_PLACEHOLDER = smtpPassInput.placeholder; // 原文写在 index.html 的 placeholder 属性上，不在这里抄第二份
function updateSmtpPassState() {
  const off = !emailPrefixInput.value.trim();
  smtpPassInput.disabled = off;
  smtpPassInput.placeholder = off ? '请先填写上方邮箱地址' : SMTP_PASS_PLACEHOLDER;
  smtpPassToggle.disabled = off;
  // 顺手收回「点了眼睛在看明文」的状态：灰框里晾着一个明文密码很怪
  if (off && smtpPassInput.type === 'text') setPasswordHidden(smtpPassToggle);
}
emailPrefixInput.addEventListener('input', updateSmtpPassState);

// 根据设置是否完整决定主按钮能不能点（仅做门控，按钮下方不加说明文字）。
// 未配置时按钮就是灰的，设置入口在左上角「⋮」菜单里
async function updateConfigStatus() {
  try {
    const status = await window.electronAPI.getApiConfigStatus();
    btnStart.disabled = !status.configured;
  } catch {
    btnStart.disabled = true;
  }
}

btnSaveConfig.addEventListener('click', async () => {
  const url = apiUrlInput.value.trim();
  const key = apiKeyInput.value.trim();
  const model = apiModelInput.value.trim();

  if (!url || !key || !model) {
    showToast('请填写完整的设置信息', 'warning');
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


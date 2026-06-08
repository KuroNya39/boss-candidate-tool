# 推荐牛人页手动筛选模式设计

## 背景

当前推荐牛人页提取流程：程序自动打开 `https://www.zhipin.com/web/chat/recommend` 页面，扫描候选人卡片列表并提取简历。

新需求：HR 用户希望能在推荐页手动设置筛选条件（学历、年龄、性别、院校等），筛选出更精准的候选人列表后，程序再对筛选后的列表进行提取。

## 挑战

推荐页的筛选按钮点"确定"后，候选人卡片列表刷新但筛选条件保持在面板中。手动刷新浏览器页面则筛选条件清空。因此需要程序附着到用户已手动筛选好的页面 tab 上工作，而非新开 tab。

## 方案：手动筛选模式（`--attach`）

### 核心思路

Electron UI 新增"推荐牛人页（手动筛选）"选项。程序不自动创建新 tab，而是通过 CDP 的 `/targets` 接口发现用户已打开的推荐页 tab 并附着上去。

### 技术可行性

已有先例：`scripts/open-candidate.mjs:246-268` 中的 `findOrCreateChatTab()` 函数使用 `/targets` 端点查找已有 tab。

CDP Proxy 已暴露 `/targets` 端点（`cdp-proxy.mjs:305-307`），通过 `Target.getTargets` 获取所有 tab 列表，每个 tab 包含 `url` 和 `targetId` 字段。

### 设计细节

#### 1. UI 改动（`electron/renderer/index.html`）

来源选择区新增独立 radio：
```
○ 沟通页
○ 推荐牛人页（自动打开）
● 推荐牛人页（手动筛选）
```

- "推荐牛人页（手动筛选）"选中时，岗位选择/数量等参数与自动模式一致
- 点击"开始提取"前显示确认提示："请确保已在 Chrome 中打开推荐牛人页并设置好筛选条件"

#### 2. 子进程参数传递（`electron/main.mjs`）

根据用户选择的 source 值，向 `extract-recommend-candidates.mjs` 传递参数：

| source 值 | 行为 |
|-----------|------|
| `recommend` | 不变，自动创建新 tab |
| `recommend-attach` | 新增，传递 `--attach` 参数 |

#### 3. 提取脚本改动（`scripts/extract-recommend-candidates.mjs`）

新增 `--attach` 参数解析。

**tab 获取阶段修改**（替换 line 844-847 的新建逻辑）：

```
如果 --attach：
  1. 调用 proxyGet('/targets') 获取所有 tab
  2. 查找 url 包含 '/web/chat/recommend' 的 tab
  3. 未找到 → 抛出明确错误 "未找到已打开的推荐牛人页"
  4. 找到 → 使用该 tab 的 targetId
否则：
  保持现有逻辑：proxyGet('/new?url=RECOMMEND_PAGE_URL')
```

**提取完成后**：
- `--attach` 模式：**不关闭 tab**
- 普通模式：照常关闭 tab

其余逻辑（扫描卡片、点击弹窗、截图 OCR）完全不变。

#### 4. renderer.js 改动

- source radio 的 value 增加 `recommend-attach` 选项
- 岗位选择显示逻辑与 `recommend` 一致

### 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `electron/renderer/index.html` | 修改 | 新增 radio 选项 |
| `electron/renderer/renderer.js` | 修改 | 新增 source 值处理 |
| `electron/main.mjs` | 修改 | 传递 `--attach` 参数 |
| `scripts/extract-recommend-candidates.mjs` | 修改 | 解析 `--attach`，查找现有 tab |
| `references/site-patterns/zhipin.com.md` | 修改 | 补充手动筛选模式说明 |

### 边界情况

1. **找不到推荐页 tab**：显示明确错误信息并提示用户在 Chrome 中打开
2. **同时打开多个推荐页 tab**：取第一个匹配的 tab（一般认为只有一个，因为 Boss 只允许一个登录 session）
3. **提取过程中用户操作 tab**：开始提取时在控制台输出提示"提取过程中请不要操作该页面"
4. **提取中断或取消**：关闭弹窗后停止，不关闭 tab

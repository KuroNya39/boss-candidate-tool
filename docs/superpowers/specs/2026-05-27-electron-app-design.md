---
title: Electron 桌面应用设计
date: 2026-05-27
status: draft
---

# Electron 桌面应用设计

## 1. 目标

为现有的 Boss直聘候选人提取-评分-导出 CLI 工具链增加一层桌面 GUI，实现"一键运行"体验。

### 核心需求

- 用户点击"开始提取分析"→ 自动完成提取→评分→导出 Excel
- 执行过程中实时显示当前步骤和进度
- 完成后弹窗提示，并有一个"打开输出目录"按钮
- 保持现有脚本完全不动（零改动原则）

## 2. 项目结构

```
web-access/
├── scripts/                    # 现有 CLI 脚本，完全不动
│   ├── extract-candidates-full.mjs
│   ├── score-candidates.mjs
│   ├── export-candidates.mjs
│   ├── merge-scores.mjs
│   └── ...
├── electron/
│   ├── main.mjs                # Electron 主进程
│   ├── preload.mjs             # 安全桥接（contextBridge）
│   └── renderer/
│       ├── index.html           # UI 页面
│       ├── style.css            # 样式表
│       └── renderer.js          # 前端逻辑
├── package.json                 # 追加 electron 依赖
├── electron-builder.yml         # 打包配置
└── output/                      # 原有输出目录，不变
```

## 3. 技术栈

| 层 | 技术 | 理由 |
|----|------|------|
| 桌面框架 | Electron | 用户指定 |
| 前端 | 原生 HTML/CSS/JS | 界面简单，无需框架 |
| 后端桥接 | contextBridge + ipcRenderer/ipcMain | Electron 安全最佳实践 |
| 脚本调用 | child_process.spawn | 实时 stdout 捕获 |
| 打包 | electron-builder | 社区标准 |

## 4. 架构与数据流

### 4.1 主进程 (main.mjs)

```
启动 Electron → 创建 BrowserWindow
            → 加载 renderer/index.html
            → 注册 IPC handler
```

**IPC 通道**：

| 通道 | 方向 | 用途 |
|------|------|------|
| `start-extraction` | renderer → main | 用户点击"开始"，携带配置（count） |
| `progress-update` | main → renderer | 实时推送步骤名、进度、日志行 |
| `extraction-done` | main → renderer | 任务完成，携带输出文件路径 |
| `extraction-error` | main → renderer | 任务失败，携带错误信息 |
| `open-output` | renderer → main | 用户点"打开目录"，main 调用 shell.openPath |
| `cancel-extraction` | renderer → main | 用户中途取消 |

### 4.2 脚本执行流程

```
user click [开始提取分析]
  → main spawns: node scripts/extract-candidates-full.mjs --count N
    → stdout 逐行输出 → 解析 → IPC progress-update → UI 更新步骤1进度
    → exit code 0 → 进入下一步
    → exit code != 0 → IPC extraction-error → UI 显示错误

  → main spawns: node scripts/score-candidates.mjs --input output/... --default
    → 同上，更新步骤2

  → main spawns: node scripts/export-candidates.mjs --input output/...
    → 同上，更新步骤3

  → 全部成功 → IPC extraction-done { outputDir, excelPath }
```

### 4.3 stdout 进度解析策略

现有脚本的 console.log 输出中包含结构化信息，通过规则提取：

| 脚本 | 解析规则 |
|------|----------|
| extract | `[N/M] 姓名` → 当前处理人数；`扫描进度: N 人` → 扫描完成；`总计: N 人` → 提取完成 |
| score | `Scored N candidates, M passed` → 评分完成 |
| export | `导出成功: path` → 导出完成；`共导出 N 条记录` → 总数 |

对于进度条百分比，使用"当前数/总数"计算：`progress = current / total * 100`。

## 5. UI 设计

### 5.1 初始状态

- 标题："Boss直聘候选人提取分析"
- "提取数量"输入框，默认 20
- 绿色"开始提取分析"按钮（大，居中）
- 底部显示当前输出目录

### 5.2 执行中状态

三段式进度卡片（垂直排列）：

1. **步骤 1/3: 提取候选人信息**
   - 进度条 + 百分比
   - 当前处理的人名和进度（如"张三 (3/20)"）
2. **步骤 2/3: AI 评分**
   - 进度条 + 百分比 / 或"等待中"
3. **步骤 3/3: 导出 Excel**
   - 进度条 / 或"等待中"

每个卡片由当前步骤高亮激活，未完成步骤灰显。

### 5.3 完成状态

- 大号绿色 ✅ 图标
- 摘要信息：提取人数、评分通过人数、导出文件名
- "📂 打开输出目录"按钮
- "重新开始"按钮（恢复初始状态）

### 5.4 错误状态

- 红色 ❌ 图标
- 错误信息摘要（失败步骤 + 原因）
- "重试"按钮

## 6. 打包与迁移

### 6.1 打包配置

使用 electron-builder，目标 `win32-x64`（portable 或 NSIS 安装包）：

```yml
appId: com.web-access.candidate-tool
productName: Boss直聘候选人提取分析
directories:
  output: dist
files:
  - electron/**/*
  - scripts/**/*
  - package.json
extraResources:
  - from: node_modules
    to: node_modules
    filter: ["**/*", "!electron-builder.yml"]
win:
  target:
    - target: portable
      arch: [x64]
```

### 6.2 迁移流程

1. 在旧机器上：将 output/ 之外的整个项目目录拷到新机器
2. 在新机器上：确保 Node.js 22+、Chrome（端口 3456 CDP）
3. 运行 `npm install` 恢复依赖
4. 双击 exe 启动

## 7. 边界情况

| 情况 | 处理方式 |
|------|----------|
| CDP Proxy 未运行 | 启动时检测 3456 端口，不可用时提示用户启动 Chrome 远程调试 |
| 脚本执行失败 | 终止流程，显示错误步骤和 exit code，允许重试 |
| 用户中途取消 | kill 子进程，清理中间文件 |
| 提取数量为 0 | 校验，不允许提交 |
| 输出目录不存在 | 自动创建 |
| 评分脚本找不到输入文件 | 显示明确的错误信息 |

## 8. 不做的事情（YAGNI）

- 不修改任何现有 `.mjs` 脚本
- 不加配置界面（提取数量用一个输入框就够了）
- 不加历史记录
- 不加数据可视化
- 不加多语言支持

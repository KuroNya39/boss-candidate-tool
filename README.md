# Boss直聘候选人提取分析

基于 Electron 的桌面应用，从 Boss直聘（Boss Zhipin）提取候选人简历，进行 AI 评分，并导出 Excel。

## 功能

支持 **三种数据来源** 提取候选人：

1. **推荐牛人页** — 从 `/web/chat/recommend` 提取推荐候选人
2. **搜索页** — 从 `/web/chat/search` 提取搜索候选人（需手动设置搜索条件）
3. **沟通页** — 从 `/web/chat` 提取已沟通过的候选人

提取完成后自动进行：
- **AI 评分** — 基于岗位 JD 匹配评分（学历、工作年限、岗位相关性）
- **Excel 导出** — 含完整字段（教育经历支持多行展开）
- **自动打招呼** — 批量给符合分数门槛的候选人发送沟通

## 下载安装

### 方式一：安装包（推荐）

从 [GitHub Releases](https://github.com/KuroNya39/boss-candidate-tool/releases) 下载最新版安装包：

```
Boss直聘候选人提取分析 Setup X.X.X.exe
```

双击安装，一路下一步即可。

### 方式二：绿色版

下载 `win-unpacked.zip`，解压后双击 `Boss直聘候选人提取分析.exe` 直接运行。

## 快速开始

### 第一步：准备 Chrome 浏览器

1. 打开 Chrome，访问 `chrome://inspect/#remote-debugging`
2. 勾选 **"Allow remote debugging for this browser instance"**
3. **重启 Chrome** 使设置生效

### 第二步：登录 Boss直聘

在 Chrome 中登录 Boss直聘招聘端（https://www.zhipin.com）

### 第三步：运行应用

双击 `Boss直聘候选人提取分析.exe` 启动。

### 第四步：配置岗位 JD

1. 点击 **「岗位管理」** 
2. 添加目标岗位，填写岗位名称和 JD 描述（AI 评分的依据）
3. 保存

### 第五步：提取候选人

1. 在 Chrome 中打开对应的 Boss直聘页面
2. 在应用中选择数据来源（推荐牛人页/搜索页/沟通页）
3. 设置提取数量
4. 点击 **「开始提取」**

## 使用说明

### 推荐牛人页（自动模式）

- 应用会自动打开推荐牛人页并选择岗位
- 需要先配置好岗位 JD

### 推荐牛人页（手动筛选模式）

1. 先在 Chrome 中打开推荐牛人页，选择岗位、设置筛选条件
2. 在应用中选择 **「推荐牛人页」**
3. 选择目标岗位（用于 AI 评分匹配）
4. 点击 **「开始提取」**

### 搜索页

1. 先在 Chrome 中打开搜索页，输入搜索关键词并设置筛选条件
2. 在应用中选择 **「搜索页」**
3. 选择目标岗位（用于 AI 评分匹配）
4. 点击 **「开始提取」**

### 沟通页

1. 先在 Chrome 中打开 Boss直聘沟通页
2. 在应用中选择 **「沟通页」**
3. 点击 **「开始提取」**

### AI 评分

提取完成后，应用会自动进行 AI 评分：

| 维度 | 分值 |
|------|------|
| 学历分 | 0-20 |
| 工作年限分 | 0-30 |
| 岗位相关性分 | 0-50 |

评分完成后导出 Excel，可选择发送邮件。

### 批量打招呼

评分完成后可自动打招呼（推荐牛人页和搜索页支持，沟通页不支持）：

| 等级 | 分数门槛 | 说明 |
|------|----------|------|
| 5 | ≥91分 | 强烈推荐 |
| 4 | ≥81分 | 推荐（默认） |
| 3 | ≥61分 | 一般 |
| 2 | ≥31分 | 可考虑 |
| 0 | 不限 | 全部 |

## 常见问题

### CDP Proxy 连接失败

应用启动时会自动检测 Chrome 的远程调试端口。如果失败：
1. 确认 Chrome 已开启远程调试（`chrome://inspect/#remote-debugging`）
2. 确认 Chrome 已重启
3. 检查是否有其他程序占用了 9222/9229/9333 端口

### 提取候选人时页面不动

- 确认已在 Chrome 中打开了对应的 Boss直聘页面
- 搜索页和推荐牛人页需要预先设置搜索条件/筛选条件
- 触发了 Boss直聘风控限制时，手动刷新页面后可继续

### AI 评分失败

- 检查 API 配置是否正确
- 确认 API 密钥有效
- 网络连接正常

### 打包后运行时找不到 config

打包后的配置文件存储在用户数据目录：
```
C:\Users\<用户名>\AppData\Roaming\web-access\jd-descriptions\
```

在应用内通过「岗位管理」添加的 JD 会自动写入该目录。

## 隐私说明

- 所有数据通过你的 Chrome 浏览器直连 Boss直聘
- 候选人数据仅保存在本地
- AI 评分可配置为内网或第三方 API
- 不会上传任何数据到第三方服务器（除你配置的 AI API 外）

## 技术架构

```
Electron 桌面应用
├── main process (main.mjs)     — 流程编排、IPC、CDP Proxy 管理
├── renderer (index.html)        — UI 界面
├── CDP Proxy (cdp-proxy.mjs)    — HTTP → WebSocket 代理，控制 Chrome
└── 提取脚本
    ├── extract-recommend-candidates.mjs  — 推荐牛人页
    ├── extract-search-candidates.mjs      — 搜索页
    └── extract-candidates-full.mjs        — 沟通页
```

## 开发

```bash
# 安装依赖
npm install

# 开发运行
npm start

# 运行 CDP Proxy（独立调试）
node scripts/cdp-proxy.mjs

# 打包构建
npm run pack
```

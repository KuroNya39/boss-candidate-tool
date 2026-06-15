# 自动发送候选人评分 Excel 邮件设计

## 背景

当前候选人评分流程会生成 `output/scored-candidates.json`，再通过 `scripts/export-candidates.mjs` 导出 `output/candidates.xlsx`。新需求是在评分与 Excel 导出完成后，自动把导出的 Excel 作为附件发送邮件。

用户希望在开始提取/评分前提供收件人邮箱前缀，默认邮箱后缀为 `allwinnertech.com`。

## 目标

- 开始提取/评分前，要求用户提供收件人邮箱前缀。
- 评分和 Excel 导出完成后，自动发送邮件。
- 邮件附件为导出的 Excel 文件。
- 收件人由 `<邮箱前缀>@allwinnertech.com` 生成。
- SMTP 发件配置通过环境变量提供，不写入仓库。

## 非目标

- 不在仓库中保存 SMTP 密码、授权码或 `.env`。
- 不引入 Outlook、本机邮件客户端、`.eml` 草稿等替代发送方式。
- 不改变现有评分计算和 Excel 导出字段逻辑。

## 推荐方案

新增独立脚本 `scripts/send-candidates-email.mjs`，只负责发送邮件。现有 `scripts/score-candidates.mjs` 和 `scripts/export-candidates.mjs` 保持职责不变。

评分流程文档 `SKILL.md` 增加前置要求和收尾步骤：

1. 在开始提取/评分前询问用户邮箱前缀。
2. 执行现有评分流程。
3. 执行现有 Excel 导出。
4. 调用邮件脚本发送附件。
5. 如果邮件失败，保留已生成 Excel，并明确提示用户失败原因。

## 命令接口

```bash
node scripts/send-candidates-email.mjs \
  --to-prefix zhangsan \
  --attachment output/candidates.xlsx
```

可选参数：

```bash
--domain allwinnertech.com
--subject "候选人评分结果"
```

默认值：

- `--domain`: `allwinnertech.com`
- `--subject`: `候选人评分结果`

## SMTP 环境变量

必填：

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

可选：

- `SMTP_SECURE`：`true` 或 `false`；未设置时根据端口判断，`465` 为 `true`，其他为 `false`
- `SMTP_FROM`：未设置时使用 `SMTP_USER`

脚本不得打印 `SMTP_PASS`。

## 邮件内容

收件人：

```text
<to-prefix>@allwinnertech.com
```

默认主题：

```text
候选人评分结果
```

默认正文：

```text
候选人评分结果已生成，Excel 文件见附件。
```

附件文件名使用 Excel 文件原始 basename，例如 `candidates.xlsx`。

## 校验与错误处理

脚本启动时校验：

- `--to-prefix` 必填。
- `--to-prefix` 只允许邮箱本地部分常见字符：字母、数字、点、下划线、百分号、加号、短横线。
- `--attachment` 必填。
- 附件文件必须存在且是文件。
- 必填 SMTP 环境变量必须存在。
- `SMTP_PORT` 必须是数字。

失败行为：

- 参数或配置错误：脚本退出非 0，并输出明确错误。
- SMTP 发送失败：脚本退出非 0，并输出邮件发送失败原因。
- 在评分流程中，邮件失败不删除或覆盖 Excel；最终回复说明 Excel 路径和邮件失败。

## 依赖

使用 `nodemailer` 发送 SMTP 邮件，需要新增依赖：

```json
"nodemailer": "^6.9.0"
```

项目当前为 ESM，邮件脚本使用 `.mjs`。

## 测试策略

新增轻量单元测试，避免真实外发邮件：

- 地址拼接：`zhangsan` → `zhangsan@allwinnertech.com`
- 非法前缀被拒绝。
- 缺少必填 SMTP 环境变量时报错。
- `SMTP_SECURE` 未设置时，端口 `465` 推导为 `true`。
- 附件不存在时报错。
- 构建出的邮件参数包含 `from`、`to`、`subject`、`text`、`attachments`。

发送函数应允许注入 transport factory，以便测试时使用 fake transport，不连接真实 SMTP。

## 文件影响

- 新增 `scripts/send-candidates-email.mjs`：邮件发送 CLI 和可测试的参数/配置构建函数。
- 修改 `package.json`：增加 `nodemailer` 依赖。
- 修改 `SKILL.md`：评分流程增加“开始前询问邮箱前缀”和“导出后发送邮件”。
- 可选新增测试文件：根据现有测试结构决定路径；若仓库没有测试框架，则使用 Node 内置 `node:test`。

## 用户使用方式

评分/提取开始前，Claude 询问：

```text
请提供收件人邮箱前缀，例如 zhangsan；系统会发送到 zhangsan@allwinnertech.com。
```

评分导出后执行：

```bash
node scripts/send-candidates-email.mjs \
  --to-prefix zhangsan \
  --attachment output/candidates.xlsx
```

成功时输出：

```text
邮件发送成功: zhangsan@allwinnertech.com
附件: output/candidates.xlsx
```

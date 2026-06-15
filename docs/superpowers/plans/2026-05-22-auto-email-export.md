# Auto Email Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the exported candidate scoring Excel file by SMTP after scoring/export, using a user-provided email prefix and the default `allwinnertech.com` domain.

**Architecture:** Add a focused `scripts/send-candidates-email.mjs` CLI that validates inputs, reads SMTP configuration from environment variables, builds a Nodemailer message with the Excel attachment, and sends it. Keep scoring and Excel export scripts unchanged; update `SKILL.md` so the operational workflow asks for the email prefix before extraction/scoring and sends the attachment after export.

**Tech Stack:** Node.js ESM (`.mjs`), Node built-ins (`node:fs`, `node:path`), `node:test`, `node:assert/strict`, Nodemailer SMTP transport.

---

## File Structure

- Create `scripts/send-candidates-email.mjs`
  - Owns CLI parsing, recipient address construction, SMTP env parsing, attachment validation, message construction, and email sending.
  - Exports pure helpers for unit tests: `parseArgs`, `buildRecipient`, `readSmtpConfig`, `validateAttachment`, `buildMailOptions`, `sendCandidateEmail`.
- Create `scripts/send-candidates-email.test.mjs`
  - Uses Node's built-in test runner and fake transport objects; never connects to real SMTP.
- Modify `package.json`
  - Add dependency: `nodemailer`.
  - Add scripts: `test:email` for the new unit test.
- Modify `SKILL.md`
  - Add a pre-step before candidate extraction/scoring: ask for recipient email prefix.
  - Add post-export email sending step and failure behavior.

---

### Task 1: Add email script tests first

**Files:**
- Create: `scripts/send-candidates-email.test.mjs`
- Later implementation target: `scripts/send-candidates-email.mjs`

- [ ] **Step 1: Write the failing test file**

Create `scripts/send-candidates-email.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildRecipient,
  readSmtpConfig,
  validateAttachment,
  buildMailOptions,
  sendCandidateEmail,
} from './send-candidates-email.mjs';

test('buildRecipient appends default allwinnertech.com domain', () => {
  assert.equal(buildRecipient('zhangsan'), 'zhangsan@allwinnertech.com');
});

test('buildRecipient rejects invalid email prefix', () => {
  assert.throws(
    () => buildRecipient('zhang san'),
    /Invalid --to-prefix/
  );
});

test('readSmtpConfig requires mandatory SMTP environment variables', () => {
  assert.throws(
    () => readSmtpConfig({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'sender@example.com',
    }),
    /Missing required environment variable: SMTP_PASS/
  );
});

test('readSmtpConfig infers secure true for port 465', () => {
  const config = readSmtpConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_USER: 'sender@example.com',
    SMTP_PASS: 'secret',
  });

  assert.deepEqual(config, {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'sender@example.com',
    pass: 'secret',
    from: 'sender@example.com',
  });
});

test('validateAttachment rejects missing file', () => {
  assert.throws(
    () => validateAttachment('output/missing.xlsx'),
    /Attachment file not found/
  );
});

test('buildMailOptions includes sender, recipient, subject, text, and attachment', () => {
  const mail = buildMailOptions({
    from: 'sender@example.com',
    to: 'zhangsan@allwinnertech.com',
    subject: '候选人评分结果',
    attachmentPath: '/tmp/candidates.xlsx',
  });

  assert.equal(mail.from, 'sender@example.com');
  assert.equal(mail.to, 'zhangsan@allwinnertech.com');
  assert.equal(mail.subject, '候选人评分结果');
  assert.equal(mail.text, '候选人评分结果已生成，Excel 文件见附件。');
  assert.deepEqual(mail.attachments, [
    {
      filename: 'candidates.xlsx',
      path: '/tmp/candidates.xlsx',
    },
  ]);
});

test('sendCandidateEmail uses injected transport and does not require real SMTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-email-'));
  const attachmentPath = join(dir, 'candidates.xlsx');
  writeFileSync(attachmentPath, 'fake excel content');

  const sent = [];
  const result = await sendCandidateEmail({
    toPrefix: 'zhangsan',
    attachmentPath,
    env: {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'sender@example.com',
      SMTP_PASS: 'secret',
      SMTP_FROM: 'hr-bot@example.com',
      SMTP_SECURE: 'false',
    },
    createTransport: (transportConfig) => ({
      async sendMail(mailOptions) {
        sent.push({ transportConfig, mailOptions });
        return { messageId: 'fake-message-id' };
      },
    }),
  });

  assert.equal(result.to, 'zhangsan@allwinnertech.com');
  assert.equal(result.messageId, 'fake-message-id');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].transportConfig.host, 'smtp.example.com');
  assert.equal(sent[0].transportConfig.port, 587);
  assert.equal(sent[0].transportConfig.secure, false);
  assert.equal(sent[0].transportConfig.auth.user, 'sender@example.com');
  assert.equal(sent[0].transportConfig.auth.pass, 'secret');
  assert.equal(sent[0].mailOptions.from, 'hr-bot@example.com');
  assert.equal(sent[0].mailOptions.to, 'zhangsan@allwinnertech.com');

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails because implementation is missing**

Run:

```bash
node --test scripts/send-candidates-email.test.mjs
```

Expected: FAIL with module not found or missing exports for `./send-candidates-email.mjs`.

---

### Task 2: Implement SMTP email CLI

**Files:**
- Create: `scripts/send-candidates-email.mjs`
- Test: `scripts/send-candidates-email.test.mjs`

- [ ] **Step 1: Create the implementation file**

Create `scripts/send-candidates-email.mjs` with:

```js
#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const DEFAULT_DOMAIN = 'allwinnertech.com';
const DEFAULT_SUBJECT = '候选人评分结果';
const DEFAULT_TEXT = '候选人评分结果已生成，Excel 文件见附件。';
const PREFIX_PATTERN = /^[A-Za-z0-9._%+-]+$/;

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for --${key}`);
    }
    opts[key] = value;
    i++;
  }

  if (!opts['to-prefix']) {
    fail('Missing required argument: --to-prefix');
  }
  if (!opts.attachment) {
    fail('Missing required argument: --attachment');
  }

  return {
    toPrefix: opts['to-prefix'],
    attachmentPath: opts.attachment,
    domain: opts.domain || DEFAULT_DOMAIN,
    subject: opts.subject || DEFAULT_SUBJECT,
  };
}

export function buildRecipient(prefix, domain = DEFAULT_DOMAIN) {
  if (!prefix || !PREFIX_PATTERN.test(prefix)) {
    fail('Invalid --to-prefix: only letters, numbers, dot, underscore, percent, plus, and hyphen are allowed');
  }
  if (!domain || !PREFIX_PATTERN.test(domain.replace(/@/g, ''))) {
    fail('Invalid --domain');
  }
  return `${prefix}@${domain}`;
}

export function readSmtpConfig(env = process.env) {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  for (const key of required) {
    if (!env[key]) {
      fail(`Missing required environment variable: ${key}`);
    }
  }

  const port = Number.parseInt(env.SMTP_PORT, 10);
  if (!Number.isInteger(port) || port <= 0) {
    fail('SMTP_PORT must be a positive number');
  }

  let secure;
  if (env.SMTP_SECURE === undefined || env.SMTP_SECURE === '') {
    secure = port === 465;
  } else if (env.SMTP_SECURE === 'true') {
    secure = true;
  } else if (env.SMTP_SECURE === 'false') {
    secure = false;
  } else {
    fail('SMTP_SECURE must be "true" or "false" when set');
  }

  return {
    host: env.SMTP_HOST,
    port,
    secure,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM || env.SMTP_USER,
  };
}

export function validateAttachment(attachmentPath) {
  const absolutePath = resolve(attachmentPath);
  if (!existsSync(absolutePath)) {
    fail(`Attachment file not found: ${attachmentPath}`);
  }
  if (!statSync(absolutePath).isFile()) {
    fail(`Attachment path is not a file: ${attachmentPath}`);
  }
  return absolutePath;
}

export function buildMailOptions({ from, to, subject = DEFAULT_SUBJECT, attachmentPath }) {
  return {
    from,
    to,
    subject,
    text: DEFAULT_TEXT,
    attachments: [
      {
        filename: basename(attachmentPath),
        path: attachmentPath,
      },
    ],
  };
}

export async function sendCandidateEmail({
  toPrefix,
  attachmentPath,
  domain = DEFAULT_DOMAIN,
  subject = DEFAULT_SUBJECT,
  env = process.env,
  createTransport = nodemailer.createTransport,
}) {
  const smtp = readSmtpConfig(env);
  const to = buildRecipient(toPrefix, domain);
  const absoluteAttachmentPath = validateAttachment(attachmentPath);

  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });

  const mailOptions = buildMailOptions({
    from: smtp.from,
    to,
    subject,
    attachmentPath: absoluteAttachmentPath,
  });

  const info = await transport.sendMail(mailOptions);
  return {
    to,
    attachmentPath: absoluteAttachmentPath,
    messageId: info.messageId,
  };
}

async function main() {
  const opts = parseArgs();
  const result = await sendCandidateEmail(opts);
  console.log(`邮件发送成功: ${result.to}`);
  console.log(`附件: ${result.attachmentPath}`);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile === currentFile) {
  main().catch(error => {
    console.error(`邮件发送失败: ${error.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run the email tests**

Run:

```bash
node --test scripts/send-candidates-email.test.mjs
```

Expected: PASS, all 7 tests pass.

- [ ] **Step 3: Manually verify CLI validation without SMTP**

Run:

```bash
node scripts/send-candidates-email.mjs --to-prefix zhangsan --attachment output/missing.xlsx
```

Expected: FAIL with `邮件发送失败: Missing required environment variable: SMTP_HOST`. This confirms SMTP env validation happens before attachment validation.

- [ ] **Step 4: Commit the email script and tests**

Only commit if the user explicitly requested committing in this session. If committing is authorized, run:

```bash
git add scripts/send-candidates-email.mjs scripts/send-candidates-email.test.mjs
git commit -m "feat: add candidate email sender"
```

---

### Task 3: Add Nodemailer dependency and test script

**Files:**
- Modify: `package.json:6-9`
- Create/modify: `package-lock.json` if `npm install` updates it
- Test: `scripts/send-candidates-email.test.mjs`

- [ ] **Step 1: Update `package.json`**

Change `package.json` from:

```json
{
  "name": "web-access",
  "version": "1.0.0",
  "type": "module",
  "description": "Web access and candidate management tools",
  "dependencies": {
    "tesseract.js": "^7.0.0",
    "xlsx": "^0.18.5"
  }
}
```

to:

```json
{
  "name": "web-access",
  "version": "1.0.0",
  "type": "module",
  "description": "Web access and candidate management tools",
  "scripts": {
    "test:email": "node --test scripts/send-candidates-email.test.mjs"
  },
  "dependencies": {
    "nodemailer": "^6.9.0",
    "tesseract.js": "^7.0.0",
    "xlsx": "^0.18.5"
  }
}
```

- [ ] **Step 2: Install dependency**

Run:

```bash
npm install
```

Expected: `node_modules` contains `nodemailer`; `package-lock.json` is created or updated.

- [ ] **Step 3: Run the package script**

Run:

```bash
npm run test:email
```

Expected: PASS, all email tests pass.

- [ ] **Step 4: Commit dependency changes**

Only commit if the user explicitly requested committing in this session. If committing is authorized, run:

```bash
git add package.json package-lock.json
git commit -m "chore: add nodemailer dependency"
```

---

### Task 4: Update scoring workflow documentation

**Files:**
- Modify: `SKILL.md:154-286`

- [ ] **Step 1: Add the pre-flight email prefix requirement**

In `SKILL.md`, after line 156:

```md
当用户要求对候选人评分或筛选时，**自动完成以下全部步骤**，无需用户手动运行脚本。
```

insert:

```md
### 邮件发送前置要求

在开始提取、评分或筛选前，必须先询问用户收件人邮箱前缀：

```text
请提供收件人邮箱前缀，例如 zhangsan；系统会发送到 zhangsan@allwinnertech.com。
```

用户只需提供前缀，不要要求用户输入完整邮箱。默认后缀固定为 `allwinnertech.com`。

评分导出 Excel 后，使用该前缀发送邮件附件。SMTP 发件配置来自环境变量：`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`，可选 `SMTP_SECURE`、`SMTP_FROM`。不得要求用户在对话中提供 SMTP 密码。
```

- [ ] **Step 2: Update default scoring flow export step**

Replace lines 262-267:

```md
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **展示结果摘要**：向用户展示 Top 候选人列表（姓名、总分、各维度分、评语）、Excel 文件路径
```

with:

```md
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **发送邮件附件**：
   ```bash
   node scripts/send-candidates-email.mjs \
     --to-prefix <用户提供的邮箱前缀> \
     --attachment output/candidates.xlsx
   ```
   - 成功：输出邮件已发送到 `<前缀>@allwinnertech.com`
   - 失败：不要删除或覆盖 Excel，向用户说明 `output/candidates.xlsx` 已生成但邮件发送失败，并展示失败原因
7. **展示结果摘要**：向用户展示 Top 候选人列表（姓名、总分、各维度分、评语）、Excel 文件路径、邮件发送结果
```

- [ ] **Step 3: Update conditional filtering flow export step**

Replace lines 281-286:

```md
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **展示结果摘要**：向用户展示通过/未通过人数、Top 候选人列表、Excel 文件路径
```

with:

```md
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **发送邮件附件**：
   ```bash
   node scripts/send-candidates-email.mjs \
     --to-prefix <用户提供的邮箱前缀> \
     --attachment output/candidates.xlsx
   ```
   - 成功：输出邮件已发送到 `<前缀>@allwinnertech.com`
   - 失败：不要删除或覆盖 Excel，向用户说明 `output/candidates.xlsx` 已生成但邮件发送失败，并展示失败原因
7. **展示结果摘要**：向用户展示通过/未通过人数、Top 候选人列表、Excel 文件路径、邮件发送结果
```

- [ ] **Step 4: Verify the documentation contains the new workflow**

Run:

```bash
grep -n "邮件发送前置要求\|send-candidates-email\|SMTP_HOST" SKILL.md
```

Expected: output includes the pre-flight section, both email send command blocks, and SMTP env variable names.

- [ ] **Step 5: Commit workflow documentation**

Only commit if the user explicitly requested committing in this session. If committing is authorized, run:

```bash
git add SKILL.md
git commit -m "docs: add email sending to scoring workflow"
```

---

### Task 5: End-to-end local verification

**Files:**
- Read/verify: `scripts/send-candidates-email.mjs`
- Read/verify: `scripts/send-candidates-email.test.mjs`
- Read/verify: `package.json`
- Read/verify: `SKILL.md`

- [ ] **Step 1: Run email unit tests**

Run:

```bash
npm run test:email
```

Expected: PASS, all email tests pass.

- [ ] **Step 2: Verify export still works with an existing scored file if available**

If `output/scored-candidates.json` exists, run:

```bash
node scripts/export-candidates.mjs --input output/scored-candidates.json
```

Expected: PASS with output like `导出成功: .../output/candidates.xlsx`.

If `output/scored-candidates.json` does not exist, skip this step and state that no scored candidate file was available for export verification.

- [ ] **Step 3: Verify email CLI fails safely without SMTP secrets**

Run:

```bash
node scripts/send-candidates-email.mjs --to-prefix zhangsan --attachment output/candidates.xlsx
```

Expected when SMTP env is not configured: FAIL with `邮件发送失败: Missing required environment variable: SMTP_HOST`. The output must not contain any password or secret.

- [ ] **Step 4: Verify git diff is limited to intended files**

Run:

```bash
git status --short
git diff -- scripts/send-candidates-email.mjs scripts/send-candidates-email.test.mjs package.json SKILL.md
```

Expected: changes are limited to the new email script, its test, dependency/test script updates, and scoring workflow documentation. Existing unrelated working tree changes remain untouched.

---

## Self-Review Notes

- Spec coverage: Tasks cover script creation, SMTP env config, address construction, attachment validation, fake-transport tests, dependency addition, and workflow documentation.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: Helper names are consistent across tests and implementation: `parseArgs`, `buildRecipient`, `readSmtpConfig`, `validateAttachment`, `buildMailOptions`, `sendCandidateEmail`.

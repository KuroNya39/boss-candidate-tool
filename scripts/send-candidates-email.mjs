#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { sleep } from './extract-common.mjs';

const DEFAULT_SUBJECT = '候选人评分结果';
const DEFAULT_TEXT = '候选人评分结果已生成，Excel 文件见附件。';

function fail(message) {
  throw new Error(message);
}

// v1.8.4: 邮件瞬时断连自动重试。公司邮箱服务器偶发在对话中途掐断连接
// （nodemailer 报 Unexpected socket close / socket hang up），属瞬时故障，重发即可成功。
// 账号/认证类错误（密码或授权码错、服务器返回 526/535）重试无意义，直接报错让人改设置。
const RETRYABLE_MAIL_RE = /socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|greeting|hang\s?up|network|TLS/i;
const AUTH_MAIL_RE = /login|authentication|526|535|username|password/i;
const MAX_MAIL_ATTEMPTS = 3;

function shouldRetryMail(err) {
  const msg = String((err && err.message) || err);
  return RETRYABLE_MAIL_RE.test(msg) && !AUTH_MAIL_RE.test(msg);
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
    subject: opts.subject || DEFAULT_SUBJECT,
  };
}

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// 必须填完整邮箱（含 @）。不再自动补任何默认域名——工具可能给不同公司的人使用，
// 无法猜对方邮箱后缀，只能由使用者填写完整地址
export function buildRecipient(prefix) {
  const input = String(prefix || '');
  if (!input.includes('@')) {
    fail('Invalid --to-prefix: 请填写完整邮箱（含 @），例如 hr@example.com');
  }
  if (!EMAIL_PATTERN.test(input)) {
    fail('Invalid --to-prefix: email address format is wrong');
  }
  return input;
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
  subject = DEFAULT_SUBJECT,
  env = process.env,
  createTransport = nodemailer.createTransport,
}) {
  const smtp = readSmtpConfig(env);
  const to = buildRecipient(toPrefix);
  const absoluteAttachmentPath = validateAttachment(attachmentPath);

  const mailOptions = buildMailOptions({
    from: smtp.from,
    to,
    subject,
    attachmentPath: absoluteAttachmentPath,
  });

  // v1.8.4: 每次尝试都新建连接（断过的 transport 复用可能还是坏的），只对瞬时断连重试
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_MAIL_ATTEMPTS; attempt++) {
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });
    try {
      const info = await transport.sendMail(mailOptions);
      return {
        to,
        attachmentPath: absoluteAttachmentPath,
        messageId: info.messageId,
      };
    } catch (err) {
      lastErr = err;
      if (!shouldRetryMail(err) || attempt >= MAX_MAIL_ATTEMPTS) break;
      console.log(`邮件连接被服务器断开(第 ${attempt} 次)，自动重试…`);
      await sleep(attempt * 1500);
    }
  }
  throw lastErr;
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

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

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function buildRecipient(prefix, domain = DEFAULT_DOMAIN) {
  const input = String(prefix || '');
  // 填的是完整邮箱（含 @）：直接作为收件人，不再拼域名
  if (input.includes('@')) {
    if (!EMAIL_PATTERN.test(input)) {
      fail('Invalid --to-prefix: email address format is wrong');
    }
    return input;
  }
  // 只填了前缀：拼上默认域名（兼容旧配置）
  if (!input || !PREFIX_PATTERN.test(input)) {
    fail('Invalid --to-prefix: only letters, numbers, dot, underscore, percent, plus, and hyphen are allowed');
  }
  if (!domain || !PREFIX_PATTERN.test(domain.replace(/@/g, ''))) {
    fail('Invalid --domain');
  }
  return `${input}@${domain}`;
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

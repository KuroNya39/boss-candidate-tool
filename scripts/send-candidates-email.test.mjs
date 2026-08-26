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

test('buildRecipient requires full email (no auto domain)', () => {
  assert.throws(
    () => buildRecipient('zhangsan'),
    /请填写完整邮箱/
  );
});

test('buildRecipient accepts full email address as-is', () => {
  assert.equal(buildRecipient('hr@example.com'), 'hr@example.com');
  assert.equal(buildRecipient('zhangsan@example.com'), 'zhangsan@example.com');
});

test('buildRecipient rejects invalid full email address', () => {
  assert.throws(
    () => buildRecipient('zhangsan@'),
    /Invalid --to-prefix/
  );
  assert.throws(
    () => buildRecipient('zhang san@example.com'),
    /Invalid --to-prefix/
  );
});

test('buildRecipient rejects bare prefix without @', () => {
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
    to: 'hr@example.com',
    subject: '候选人评分结果',
    attachmentPath: '/tmp/candidates.xlsx',
  });

  assert.equal(mail.from, 'sender@example.com');
  assert.equal(mail.to, 'hr@example.com');
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
    toPrefix: 'zhangsan@example.com',
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

  assert.equal(result.to, 'zhangsan@example.com');
  assert.equal(result.messageId, 'fake-message-id');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].transportConfig.host, 'smtp.example.com');
  assert.equal(sent[0].transportConfig.port, 587);
  assert.equal(sent[0].transportConfig.secure, false);
  assert.equal(sent[0].transportConfig.auth.user, 'sender@example.com');
  assert.equal(sent[0].transportConfig.auth.pass, 'secret');
  assert.equal(sent[0].mailOptions.from, 'hr-bot@example.com');
  assert.equal(sent[0].mailOptions.to, 'zhangsan@example.com');

  rmSync(dir, { recursive: true, force: true });
});

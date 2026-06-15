#!/usr/bin/env node
/**
 * clean-resume-text.mjs - 对已提取的候选人 JSON 做 OCR 文本清洗（回填）
 *
 * Usage:
 *   node scripts/clean-resume-text.mjs --input output/zhipin-candidates.json [--output output/zhipin-candidates.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ===== OCR 文本清洗（与 extract-candidates-full.mjs 保持一致） =====

const OCR_TYPO_MAP = {
  '沟 通': '沟通',
  '管 理': '管理',
  '研 发': '研发',
  '项 目': '项目',
  '公 司': '公司',
  '工 作': '工作',
  '技 术': '技术',
  '教 育': '教育',
  '经 验': '经验',
  '学 校': '学校',
  '专 业': '专业',
  '职 位': '职位',
  '能 力': '能力',
};

export function cleanOcrText(raw) {
  if (!raw) return '';
  let text = raw;

  // 1. 全角标点规范化
  text = text.replace(/：/g, '：').replace(/，/g, '，');

  // 2. 去除中文字符间的多余空格
  const CJK = '[\u4e00-\u9fa5\uff00-\uffef\u3000-\u303f]';
  const cjkSpaceRe = new RegExp(`(${CJK})\\s+(${CJK})`, 'g');
  for (let i = 0; i < 3; i++) {
    text = text.replace(cjkSpaceRe, '$1$2');
  }

  // 3. 中文与标点之间的空格
  text = text.replace(/([\u4e00-\u9fa5])\s+([\uff0c\u3002\uff1f\uff01\uff1b\uff1a\u201d\u2019\uff09])/g, '$1$2');
  text = text.replace(/([\uff0c\u3002\uff1a\u201c\u2018\uff08])\s+([\u4e00-\u9fa5])/g, '$1$2');

  // 4. 多个空格/制表符 → 单个空格
  text = text.replace(/[ \t]+/g, ' ');

  // 5. 行首行尾空白
  text = text.split('\n').map(l => l.trim()).join('\n');

  // 6. 压缩连续空行
  text = text.replace(/\n{3,}/g, '\n\n');

  // 7. 常见错字
  for (const [wrong, right] of Object.entries(OCR_TYPO_MAP)) {
    text = text.split(wrong).join(right);
  }

  // 8. 去除孤立单字符行
  text = text.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (t.length === 1 && /[^\u4e00-\u9fa5\w]/.test(t)) return false;
    return true;
  }).join('\n');

  // 9. 去除页面底部"其他名校毕业的牛人"推荐列表（BOSS直聘）
  // 正则容错常见 OCR 错字：其/共、他/她、牛/午、人/入
  const bottomMarkerRe = /[其共][他她]名校毕业的[牛午][人入]/;
  const otherSchoolLine = text.split('\n').findIndex(l => bottomMarkerRe.test(l));
  if (otherSchoolLine !== -1) {
    text = text.split('\n').slice(0, otherSchoolLine).join('\n');
  }

  return text.trim();
}

// ===== CLI =====

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      opts[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  if (!opts.input) {
    console.error('Usage: node scripts/clean-resume-text.mjs --input <file> [--output <file>]');
    process.exit(1);
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const inputPath = resolve(opts.input);
  const outputPath = resolve(opts.output || opts.input);

  const data = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const candidates = data.candidates || data;

  let cleanedCount = 0;
  let totalSaved = 0;

  for (const c of candidates) {
    if (!c.resumeText) continue;
    const before = c.resumeText;
    const after = cleanOcrText(before);
    if (before !== after) {
      c.resumeText = after;
      cleanedCount++;
      totalSaved += before.length - after.length;
    }
  }

  writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');

  console.log(`清洗完成: ${cleanedCount}/${candidates.length} 条简历被调整`);
  console.log(`字符数减少: ${totalSaved}`);
  console.log(`输出: ${outputPath}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) main();

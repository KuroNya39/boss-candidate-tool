#!/usr/bin/env node
/**
 * collect-agent-results.mjs
 *
 * 从 Agent 回复文本中提取结构化评分结果。
 * Agent 回复末尾必须包含标记:
 *   ===AGENT_RESULT_START===
 *   [{"candidateIndex": 0, ...}]
 *   ===AGENT_RESULT_END===
 *
 * 评语要求:
 *   - 结合岗位 JD，突出候选人匹配点
 *   - 100 字左右，简洁扼要
 *   - 非空即可，不限制格式模板
 *
 * 用法:
 *   方式1 - 从文件读取:
 *     node scripts/collect-agent-results.mjs \
 *       --agent-output <path> \
 *       --output <path>
 *
 *   方式2 - 从 stdin 读取（管道传入 agent 回复）:
 *     echo '...===AGENT_RESULT_START===[{...}]===AGENT_RESULT_END===' |
 *       node scripts/collect-agent-results.mjs --output <path>
 *
 *   方式3 - 只校验:
 *     node scripts/collect-agent-results.mjs --agent-output <path> --validate-only
 *
 * 返回值: 成功 0，失败 1（至少需 1 条有效结果才视为成功）
 */

import fs from 'fs';
import path from 'path';

const START_MARKER = '===AGENT_RESULT_START===';
const END_MARKER = '===AGENT_RESULT_END===';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-output') opts.agentOutput = args[++i];
    else if (args[i] === '--output') opts.output = args[++i];
    else if (args[i] === '--validate-only') opts.validateOnly = true;
  }
  return opts;
}

function extractJsonBetweenMarkers(content) {
  const startIdx = content.lastIndexOf(START_MARKER);
  if (startIdx === -1) {
    return { error: `未找到起始标记 ${START_MARKER}` };
  }

  const endIdx = content.indexOf(END_MARKER, startIdx + START_MARKER.length);
  if (endIdx === -1) {
    return { error: `未找到结束标记 ${END_MARKER}` };
  }

  const jsonStr = content.slice(startIdx + START_MARKER.length, endIdx).trim();
  if (!jsonStr) {
    return { error: `${START_MARKER} 和 ${END_MARKER} 之间内容为空` };
  }

  try {
    const data = JSON.parse(jsonStr);
    return { data };
  } catch (e) {
    return { error: `JSON 解析失败: ${e.message}\n提取的内容:\n${jsonStr.slice(0, 500)}` };
  }
}

function validateStructure(data) {
  if (!Array.isArray(data)) {
    return { valid: false, error: '结果必须是 JSON 数组', results: [] };
  }

  const errors = [];
  const validItems = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const itemErrors = [];

    if (typeof item.candidateIndex !== 'number' || item.candidateIndex < 0) {
      itemErrors.push(`[${i}] candidateIndex 必须为非负数字`);
    }

    if (typeof item.jobRelevanceScore !== 'number' ||
        item.jobRelevanceScore < 0 || item.jobRelevanceScore > 50) {
      itemErrors.push(`[${i}] jobRelevanceScore 必须为 0-50 的数字`);
    }

    if (typeof item.jobRelevanceComment !== 'string' || item.jobRelevanceComment.length === 0) {
      itemErrors.push(`[${i}] jobRelevanceComment 缺失或为空`);
    }

    if (itemErrors.length === 0) {
      validItems.push(item);
    } else {
      errors.push(...itemErrors);
    }
  }

  return {
    valid: errors.length === 0,
    error: errors.length > 0 ? errors.join('\n') : null,
    results: validItems,
    totalItems: data.length,
    validCount: validItems.length,
    errorCount: errors.length
  };
}

function writeOutput(outputPath, data) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`已提取 ${data.length} 条结果到 ${outputPath}`);
}

async function main() {
  const opts = parseArgs();

  let content;

  if (opts.agentOutput) {
    // 方式1：从文件读取
    if (!fs.existsSync(opts.agentOutput)) {
      console.error(`错误: 文件不存在: ${opts.agentOutput}`);
      process.exit(1);
    }
    content = fs.readFileSync(opts.agentOutput, 'utf-8');
  } else if (!process.stdin.isTTY) {
    // 方式2：从 stdin 读取（管道）
    content = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', chunk => buf += chunk);
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  } else {
    console.error('用法:\n  管道输入: echo "..." | node scripts/collect-agent-results.mjs --output <path>\n  文件读取: node scripts/collect-agent-results.mjs --agent-output <path> --output <path>');
    process.exit(1);
  }

  const { data, error } = extractJsonBetweenMarkers(content);
  if (error) {
    console.error(`提取失败: ${error}`);
    process.exit(1);
  }

  const validation = validateStructure(data);
  if (!validation.valid) {
    console.error(`结构校验失败:\n${validation.error}`);
    console.error(`有效 ${validation.validCount}/${validation.totalItems} 项`);
    if (validation.results.length === 0) {
      process.exit(1);
    }
    console.warn('警告: 部分数据有误，只保留有效项继续...');
  }

  if (opts.validateOnly) {
    console.log(`校验通过: ${validation.validCount}/${validation.totalItems} 项有效`);
    process.exit(validation.valid ? 0 : 1);
  }

  if (opts.output) {
    writeOutput(opts.output, validation.valid ? data : validation.results);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }

  process.exit(0);
}

main();

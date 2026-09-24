// electron/config.mjs — API/邮件/评分配置持久化（userData）与岗位（JD）文件读写。
import { app } from 'electron';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { termLog } from './util.mjs';
import { setApiConfig, setOutputDir } from './state.mjs';

const CONFIG_DIR = resolve(app.getPath('userData'), 'web-access');
const CONFIG_PATH = resolve(CONFIG_DIR, 'api-config.json');
// 岗位描述统一存 userData（开发/打包一致）：重新安装/升级不丢，且各电脑独立。
// 旧的 config/jd-descriptions 已废弃（原始 JD 未处理格式），不再使用。
export const JD_DIR = resolve(CONFIG_DIR, 'jd-descriptions');

export function loadApiConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (saved.url && saved.key && saved.model) {
        // 合并保存的字段，保留默认值补全缺失字段（setApiConfig 即 merge 语义）
        setApiConfig(saved);
        termLog(`[config] 已加载持久化配置： url=${saved.url}, model=${saved.model}`);
      }
      // outputDir 独立于 API 配置加载
      if (saved.outputDir) {
        setOutputDir(resolve(saved.outputDir, 'output'));
        termLog(`[config] 输出目录： ${resolve(saved.outputDir, 'output')}`);
      }
    }
  } catch (err) {
    termLog(`[config] 加载持久化配置失败： ${err.message}`, 'stderr');
  }
}

export function saveApiConfig(config) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    termLog(`[config] 配置已保存到 ${CONFIG_PATH}`);
  } catch (err) {
    termLog(`[config] 保存配置失败： ${err.message}`, 'stderr');
  }
}

// —— 岗位存储（jd-descriptions/*.txt，文件名即岗位名，全角符号避开 Windows 非法字符） ——
// 与 JD 读取逻辑保持一致：替换 Windows 不允许的字符（全角化）。评分侧（scoring.mjs 的
// createPositionPromptBuilder）保有一份相同映射，两边各自独立、行为一致。
function safeJdName(jobName) {
  return jobName.replace(/[\\/:*?"<>|]/g, (c) => ({
    '\\': '＼', '/': '／', ':': '：', '*': '＊',
    '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
  })[c]);
}

// 岗位名排序用的比较器：默认的 .sort() 比的是 UTF-16 码点，中文顺序在用户看来等于乱序
// （「云」4E91 < 「产」4EA7 < 「嵌」5D4C …，跟读音毫无关系），改用拼音序（zh 默认排序规则即拼音）。
// numeric 让名字里的数字按数值比（「P7」排在「P10」前面，而不是按字符比）。
// 注意与 pinyin.mjs 的区别：那边用 pinyin-pro 取岗位名首字母做搜索匹配，Collator 只能排序、取不出首字母，
// 两件事别互相替代（见 CLAUDE.md 里试过但不能用的两个方案）。
const jobNameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true });

// 字母 / 数字开头的排最前，汉字开头的按拼音跟在后面（zh 排序规则本身把汉字排在拉丁字母前，
// 与我们想要的相反，所以先按这个分组）。用 Unicode 属性而不是 [A-Za-z]：带重音的拉丁字母、
// 全角数字也算「字母数字开头」
const isLatinOrDigitStart = (name) => /^[\p{Script=Latin}\p{Nd}]/u.test(name);

// 读取推荐牛人页岗位列表（从 jd-descriptions/ 目录的 .txt 文件名反解）
export function listRecommendJobs() {
  const dir = JD_DIR;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.txt'));
  return files
    .map(f => f.replace(/\.txt$/, ''))
    // 反转文件名中的全角符号 → 半角（/ 是 Windows 不允许的字符）
    .map(name => name.replace(/／/g, '/').replace(/：/g, ':').replace(/＊/g, '*'))
    .sort((a, b) => (isLatinOrDigitStart(a) ? 0 : 1) - (isLatinOrDigitStart(b) ? 0 : 1)
      || jobNameCollator.compare(a, b));
}

// 添加新岗位：创建对应的 .txt 文件并写入 JD 描述
export function addRecommendJob(jobName, jobDesc) {
  if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
  const safeName = safeJdName(jobName);
  const dir = JD_DIR;
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, safeName + '.txt');
  if (existsSync(filePath)) throw new Error(`岗位「${jobName}」已存在`);
  writeFileSync(filePath, jobDesc || '', 'utf-8');
  termLog(`[config] 已添加新岗位： ${jobName}`);
  return { ok: true };
}

// 读取岗位 JD 描述
export function getRecommendJobDesc(jobName) {
  if (!jobName) return '';
  const safeName = safeJdName(jobName);
  const filePath = resolve(JD_DIR, safeName + '.txt');
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

// 更新岗位描述（岗位名不可改，只更新 .txt 内容）
export function updateRecommendJob(jobName, jobDesc) {
  if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
  const safeName = safeJdName(jobName);
  const filePath = resolve(JD_DIR, safeName + '.txt');
  if (!existsSync(filePath)) throw new Error(`岗位「${jobName}」不存在`);
  writeFileSync(filePath, jobDesc || '', 'utf-8');
  termLog(`[config] 已更新岗位描述： ${jobName}`);
  return { ok: true };
}

// 重命名岗位：文件名即岗位名，改名 = 重命名 .txt 文件（描述内容原样保留）。
// 注意：历史批次的记录仍记旧岗位名，不追溯改名；仅新批次使用新名（见 CLAUDE.md 岗位链说明）
export function renameRecommendJob(oldName, newName) {
  if (!oldName || typeof oldName !== 'string') throw new Error('原岗位名不能为空');
  if (!newName || typeof newName !== 'string') throw new Error('岗位名不能为空');
  const oldSafe = safeJdName(oldName);
  const newSafe = safeJdName(newName);
  const oldPath = resolve(JD_DIR, oldSafe + '.txt');
  const newPath = resolve(JD_DIR, newSafe + '.txt');
  if (!existsSync(oldPath)) throw new Error(`岗位「${oldName}」不存在`);
  if (existsSync(newPath)) throw new Error(`岗位「${newName}」已存在`);
  mkdirSync(JD_DIR, { recursive: true });
  renameSync(oldPath, newPath);
  termLog(`[config] 已重命名岗位： ${oldName} → ${newName}`);
  return { ok: true };
}

// 删除岗位
export function deleteRecommendJob(jobName) {
  if (!jobName) throw new Error('岗位名不能为空');
  const safeName = safeJdName(jobName);
  const filePath = resolve(JD_DIR, safeName + '.txt');
  if (!existsSync(filePath)) throw new Error(`岗位「${jobName}」不存在`);
  unlinkSync(filePath);
  termLog(`[config] 已删除岗位： ${jobName}`);
  return { ok: true };
}

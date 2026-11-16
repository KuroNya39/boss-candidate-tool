// electron/config.mjs — API/邮件/评分配置持久化（userData）与岗位（JD）文件读写。
import { app } from 'electron';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { termLog } from './util.mjs';
import { setApiConfig, setOutputDir } from './state.mjs';
import { compareNames } from './name-sort.mjs';

// 用户数据目录（= userData/web-access）：配置、JD、候选人评分索引都放这里
export const CONFIG_DIR = resolve(app.getPath('userData'), 'web-access');
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

// JD 文件路径：文件名即岗位名。六个读写/改名/删除入口共用这一处，
// 改映射只动 safeJdName 与这里（评分侧 scoring.mjs 另有一份同映射，见上）
function jdFilePath(jobName) {
  return resolve(JD_DIR, safeJdName(jobName) + '.txt');
}

// 读取推荐牛人页岗位列表（从 jd-descriptions/ 目录的 .txt 文件名反解）
export function listRecommendJobs() {
  const dir = JD_DIR;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.txt'));
  return files
    .map(f => f.replace(/\.txt$/, ''))
    // 反转文件名中的全角符号 → 半角（/ 是 Windows 不允许的字符）
    .map(name => name.replace(/／/g, '/').replace(/：/g, ':').replace(/＊/g, '*'))
    .sort(compareNames);
}

// 添加新岗位：创建对应的 .txt 文件并写入 JD 描述
export function addRecommendJob(jobName, jobDesc) {
  if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
  const dir = JD_DIR;
  mkdirSync(dir, { recursive: true });
  const filePath = jdFilePath(jobName);
  if (existsSync(filePath)) throw new Error(`岗位「${jobName}」已存在`);
  writeFileSync(filePath, jobDesc || '', 'utf-8');
  termLog(`[config] 已添加新岗位： ${jobName}`);
  return { ok: true };
}

// 读取岗位 JD 描述
export function getRecommendJobDesc(jobName) {
  if (!jobName) return '';
  const filePath = jdFilePath(jobName);
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

// 岗位描述够不够用：文件不在 / 内容为空 / 太短，都算「没有可用的 JD」。
// 评分时读不到 JD 会被静默吞掉（提示词里的维度与筛选项变成空槽），模型就自己编一份岗位描述——
// 所以「开始提取前」与「评分发第一个请求前」都按这同一个口径拦下。
// 30 字是人为下限，标题行也算在内：一份真 JD 的结构化段落远不止这些。
// 三态：missing（文件不在 / 读不出来）与 short（在，但空或不够长）——两个消费方都只需要
// 「文件有没有」和「能不能用」这一层区分，空文件与太短在处置上相同（请用户补内容）
const JD_MIN_LENGTH = 30;
export function inspectJobDescription(jobName) {
  if (!jobName) return { state: 'missing' };
  const filePath = jdFilePath(jobName);
  let raw;
  try {
    if (!existsSync(filePath)) return { state: 'missing' };
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { state: 'missing' }; // 读不出来（被占用/权限）与不存在同样处理：不能拿它去评分
  }
  return raw.trim().length >= JD_MIN_LENGTH ? { state: 'ok' } : { state: 'short' };
}

// 更新岗位描述（岗位名不可改，只更新 .txt 内容）
export function updateRecommendJob(jobName, jobDesc) {
  if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
  const filePath = jdFilePath(jobName);
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
  const oldPath = jdFilePath(oldName);
  const newPath = jdFilePath(newName);
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
  const filePath = jdFilePath(jobName);
  if (!existsSync(filePath)) throw new Error(`岗位「${jobName}」不存在`);
  unlinkSync(filePath);
  termLog(`[config] 已删除岗位： ${jobName}`);
  return { ok: true };
}

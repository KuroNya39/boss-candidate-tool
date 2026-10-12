// electron/pinyin.mjs — 汉字取拼音（岗位搜索用：输入 xsqd、neihe、neih 都能匹配到对应岗位）
//
// 用 pinyin-pro 的完整拼音表：按**词**判多音字（重庆 → cq、银行 → yh），常用字与次常用字都覆盖
// （深圳 → sz、东莞 → dg）。选型理由、以及两个试过但不能用的无依赖方案（GB2312 边界法、
// Intl.Collator 排序法），记在 CLAUDE.md「目标岗位搜索支持拼音」，别再手写一遍。
//
// 依赖 pinyin-pro（纯 JS、无原生模块），所以本模块只能跑在主进程，由 ipc.mjs 的 get-recommend-jobs
// 通道随岗位列表一起供渲染进程使用（渲染进程拿不到 Node 模块）。
import { pinyin } from 'pinyin-pro';

// 岗位名 → 可搜索文本。纯函数，结果只取决于入参，故缓存下来：
// 岗位列表每次增删改都会重算一遍，但其中最多只有一个名字变了
const cache = new Map();

// pinyin-pro 的两趟取音共用同一组选项
const PINYIN_OPTS = {
  toneType: 'none',      // 不带声调
  type: 'string',        // 直接返回字符串，不是数组
  separator: '',         // 音节之间不留空格（默认是空格，会把 xsqd 拆成 "x s q d"、neihe 拆成 "nei he" 而搜不到）
  nonZh: 'consecutive',  // 非汉字段原样保留（英文单词/数字不被拆散）
};

/**
 * 取字符串的「可搜索文本」= 原文 + 拼音首字母串 + 全拼串（全小写，三段之间空一格）。
 * 原文放在最前，是让「什么算可搜索」只在本模块定义一处：调用方拿到就能直接 includes，
 * 不必记得自己补原文、也不必再转一次小写（原文里的大写字母如 Java/AI 由这里一并转掉）。
 * 首字母串：汉字取声母、非汉字段（英文单词、数字、括号、下划线…）原样保留，
 * 于是「显示驱动工程师 _ 深圳 25-35K」→ "xsqdgcs _ sz 25-35k"，
 * xsqd（岗位名首字母）、sz（深圳）、35k（薪资段）都能搜到它。
 * 全拼串：汉字取完整拼音，于是「内核」→ "neihe"，
 * neihe（全拼）、neih（全拼前缀）都能搜到它。
 * 三段拼在一条里，渲染进程只做一句 includes 即可同时命中原文/首字母/全拼（见 renderer-jobs.js）。
 * @param {string} text
 * @returns {string}
 */
export function pinyinSearchText(text) {
  const key = String(text ?? '');
  let searchable = cache.get(key);
  if (searchable === undefined) {
    const initials = pinyin(key, { ...PINYIN_OPTS, pattern: 'first' });
    const full = pinyin(key, { ...PINYIN_OPTS, pattern: 'pinyin' });
    searchable = `${key} ${initials} ${full}`.toLowerCase();
    cache.set(key, searchable);
  }
  return searchable;
}

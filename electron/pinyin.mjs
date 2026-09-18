// electron/pinyin.mjs — 汉字取拼音首字母（岗位搜索用：输入 xsqd 也能匹配到「显示驱动工程师」）
//
// 用 pinyin-pro 的完整拼音表：按**词**判多音字（重庆 → cq、银行 → yh），常用字与次常用字都覆盖
// （深圳 → sz、东莞 → dg）。选型理由、以及两个试过但不能用的无依赖方案（GB2312 边界法、
// Intl.Collator 排序法），记在 CLAUDE.md「目标岗位搜索支持拼音首字母」，别再手写一遍。
//
// 依赖 pinyin-pro（纯 JS、无原生模块），所以本模块只能跑在主进程，由 ipc.mjs 的 get-recommend-jobs
// 通道随岗位列表一起供渲染进程使用（渲染进程拿不到 Node 模块）。
import { pinyin } from 'pinyin-pro';

// 岗位名 → 首字母串。纯函数，结果只取决于入参，故缓存下来：
// 岗位列表每次增删改都会重算一遍，但其中最多只有一个名字变了
const cache = new Map();

/**
 * 取字符串的拼音首字母串（全小写）。
 * 汉字取声母；非汉字段（英文单词、数字、括号、下划线…）原样保留，
 * 于是「显示驱动工程师 _ 深圳 25-35K」→ "xsqdgcs _ sz 25-35k"：
 * xsqd（岗位名）、sz（深圳）、35k（薪资段）都能搜到它。
 * @param {string} text
 * @returns {string}
 */
export function pinyinInitials(text) {
  const key = String(text ?? '');
  let initials = cache.get(key);
  if (initials === undefined) {
    initials = pinyin(key, {
      pattern: 'first',   // 只要声母
      toneType: 'none',   // 不带声调
      type: 'string',     // 直接返回字符串，不是数组
      separator: '',      // 首字母之间不留空格（默认是空格，会把 xsqd 拆成 "x s q d" 而搜不到）
      nonZh: 'consecutive', // 非汉字段原样保留（英文单词/数字不被拆散）
    }).toLowerCase();
    cache.set(key, initials);
  }
  return initials;
}

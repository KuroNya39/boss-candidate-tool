// electron/name-sort.mjs — 岗位名 / 候选人姓名共用的拼音排序。
//
// 默认的 .sort() 比的是 UTF-16 码点，中文顺序在用户看来等于乱序
// （「云」4E91 < 「产」4EA7 < 「嵌」5D4C …，跟读音毫无关系），改用拼音序（zh 默认排序规则即拼音）。
// numeric 让名字里的数字按数值比（「P7」排在「P10」前面，而不是按字符比）。
//
// 注意与 pinyin.mjs 的区别：那边用 pinyin-pro 取首字母做**搜索匹配**，Collator 只能排序、
// 取不出首字母，两件事别互相替代（见 CLAUDE.md 里试过但不能用的两个方案）。
//
// 纯函数、不依赖 electron：config.mjs 的岗位列表与 candidate-index.mjs 的查询结果共用，
// 后者要能整份文件在纯 Node 下跑（便于验证 / 重算）。
const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true });

// 字母 / 数字开头的排最前，汉字开头的按拼音跟在后面（zh 排序规则本身把汉字排在拉丁字母前，
// 与我们想要的相反，所以先按这个分组）。用 Unicode 属性而不是 [A-Za-z]：带重音的拉丁字母、
// 全角数字也算「字母数字开头」
const isLatinOrDigitStart = (name) => /^[\p{Script=Latin}\p{Nd}]/u.test(name);

export function compareNames(a, b) {
  return (isLatinOrDigitStart(a) ? 0 : 1) - (isLatinOrDigitStart(b) ? 0 : 1)
    || nameCollator.compare(a, b);
}

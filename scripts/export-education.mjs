// scripts/export-education.mjs — 导出前的教育经历修正与排序
// OCR 从简历里抠教育经历对噪音很脆弱（校名吞字、把二级学院当学校），
// 所以导出前用 AI 评语里格式稳定的「第一学历 / 最高学历」两行做准绳修正，
// 再用简历正文补时间/专业，最后按学历层次重排（最高学历在第一行）。
import { DEGREE_ANY_RE, degreeRank } from './degree.mjs';

// ===== 教育经历修正：以 AI 评语中的「第一学历/最高学历」为准绳 =====
// 正则从 OCR 简历文本里抠教育经历对噪音很脆弱：OCR 会把校名前的汉字吞进学校名
// （'起东北财经大学'）、把校内二级学院误当学校（'通识学院 2022-2023'）。
// 而 AI 评语模板强制含格式稳定的两行（提示词要求按竖线分隔；老评语是逗号分隔的，也照旧能解析）：
//   第一学历：重庆工商大学 | 大数据管理与应用 | 本科 | 2016-2020 | 全日制
//   最高学历：重庆工商大学 | 大数据管理与应用 | 本科（在读）| 2020-2023 | 全日制
// 导出前用这两行修正 educationExperience：校名/专业/学历以 AI 为准，时间沿用原条目。

// 校名后缀（本文件共用）：比别处多认「分校 / 校区 / 研究生院」——
// 「东北大学秦皇岛分校」「哈尔滨工业大学(威海)」这类校区名结尾不是「大学」，
// 只认大学/学院会把校名截成「东北大学」、剩下的「秦皇岛分校」被当成专业塞进 major（实测踩过）
const SCHOOL_SUFFIX_SRC = '(?:大学|学院|学校|研究所|分校|校区|研究生院)(?:[（(][^）)]*[）)])?';
const SCHOOL_END_RE = new RegExp(SCHOOL_SUFFIX_SRC + '$');
// 回退用的贪心匹配（校名被专业粘连时取最长校名）：按候选人批量跑，模块级建一次
const SCHOOL_GREEDY_RE = new RegExp('([一-龥]{2,}' + SCHOOL_SUFFIX_SRC + ')');
// 「整段就是一个学历词」的精确匹配（判定学历段用）。DEGREE_ANY_RE 是 A|B|C 形式，
// 必须自己套 (?:…)：直接拼 '^' + source + '$' 只锚得住首尾两个词，中间的词照样乱命中
const DEGREE_EXACT_RE = new RegExp('^(?:' + DEGREE_ANY_RE.source + ')$');

// 校名像不像真学校：以大学/学院/学校/研究所（含分校/校区/研究生院）结尾、不含 OCR 噪音词
// （证书/资格/收藏/英语等）。用于过滤 OCR 把证书列表、页面文案误认成学校的假条目（如'资格证书大学'）。
function schoolLooksReal(name) {
  const n = (name || '').replace(/\s+/g, '');
  if (!n || n.length < 4) return false;
  if (!SCHOOL_END_RE.test(n)) return false;
  if (/证书|资格|英语|人力资源|收藏|经历概览|招聘|比赛|大赛|奖学金|志愿|竞赛|实习/.test(n)) return false;
  return true;
}

// 从 AI 评语解析教育条目，返回 [{school, major, degree}]，按「学校+学历」去重。
// AI 分隔「学校/专业/学历」可能用逗号、空格、顿号、竖线或「+」任一种
// （如'××大学××学院+电子科学与技术+本科+2011-2015，全日制'），统一按这些分隔符切段解析。
function parseEducationFromComment(comment) {
  if (!comment) return [];
  // 学历词用 scripts/degree.mjs 的共用词汇表（DEGREE_ANY_RE）；校名后缀见上面的 SCHOOL_SUFFIX_SRC
  const SEP_RE = /[+，,、|\s]+/;
  const results = [];
  const seen = new Set();
  const lineRe = /(?:第一学历|最高学历)\s*[:：]\s*([^\n。；;]+)/g;
  let m;
  while ((m = lineRe.exec(comment)) !== null) {
    const raw = m[1].trim();
    if (!raw || /^(无|未明确|未提供|不详|未找到|没有)/.test(raw)) continue;
    // 去掉「毕业院校/学校」前缀、时间区间及「全日制/在读」等注释，
    // 让行内只剩「学校+专业+学历」；时间区间先捕获，供教育条目补空时间用。
    let line = raw.replace(/^(?:毕业院校|学校)\s*[:：]?\s*/, '').trim();
    const timeMatch = line.match(/(\d{4})\s*[-–—~～至]\s*(\d{4})/);
    const aiTime = timeMatch ? `${timeMatch[1]} - ${timeMatch[2]}` : '';
    // 不整行剥括号：校名和专业里的括号是内容本身（「中国地质大学（武汉）」「工商管理(MBA)」
    // 「软件工程（微电子）」），剥了校区/方向就丢了。括号里的注释（如「本科（在读）」的「在读」）
    // 在取到学历段之后单独剥，见下面的 degree。
    line = line.replace(/\d{4}\s*[-–—~～至]\s*\d{4}[^+，,。；;]*/g, '')
               .replace(/[,，、+]?\s*(?:全日制|非全日制)\s*[^+，,。；;]*/g, '')
               .replace(/[+，,、|\s]+$/, '').trim();
    if (!line) continue;
    // 按分隔符切段。独立学院校名是整体（如'××大学××学院'），
    // 必须以整个首段作为学校，不能用非贪婪正则提前切断在第一个「大学」处。
    const segs = line.split(SEP_RE).map(s => s.trim()).filter(Boolean);
    if (segs.length === 0) continue;
    let school = SCHOOL_END_RE.test(segs[0]) ? segs[0] : '';
    if (!school) {
      // 首段不像学校（整行无分隔符、校名被专业粘连）：回退贪心匹配最长校名
      const sm = line.match(SCHOOL_GREEDY_RE);
      school = sm ? sm[1] : '';
    }
    if (!school || !schoolLooksReal(school)) continue; // 疑似识别错误的垃圾校名，跳过该行
    const si = segs.indexOf(school);
    let major = '';
    let degree = '';
    if (si >= 0) {
      // 学历段优先取「整段就是一个学历词」的段（本科/硕士…），没有再退回「第一个含学历词的段」。
      // 不优先精确匹配的话，「工商管理硕士」这类专业名里含学历词，会被当成学历段 →
      // 学历填成「工商管理硕士」、专业反而空掉（实测踩过）。
      let di = -1;    // 精确命中：整段就是一个学历词
      let loose = -1; // 兜底命中：段里含学历词（如「本科（在读）」）
      for (let i = si + 1; i < segs.length; i++) {
        if (loose < 0 && DEGREE_ANY_RE.test(segs[i])) loose = i;
        if (DEGREE_EXACT_RE.test(segs[i])) { di = i; break; }
      }
      if (di < 0) di = loose;
      if (di >= 0) {
        degree = segs[di].replace(/[（(][^）)]*[）)]/g, '').trim(); // 「本科（在读）」→「本科」
        major = segs.slice(si + 1, di).join(' ').replace(/专业$/, '').trim();
      }
    } else {
      // 校名非完整段（粘连场景）：学历词取行内第一个，专业取校名与学历词之间
      const dm = line.match(DEGREE_ANY_RE);
      if (dm) {
        degree = dm[0];
        const start = line.indexOf(school) + school.length;
        major = line.slice(start, dm.index).replace(/[+，,、|\s]+/g, ' ').replace(/专业$/, '').trim();
      }
    }
    const key = school + '|' + degree;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ school, major, degree, time: aiTime });
  }
  return results;
}

// 学校名模糊匹配：OCR 抓出的校名可能带前缀噪音（'起东北财经大学' vs '东北财经大学'）
function schoolNamesMatch(a, b) {
  const na = (a || '').replace(/\s+/g, '');
  const nb = (b || '').replace(/\s+/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) {
    // 短名要足够具体，避免 'XX大学' 与 'XX大学附属中学' 这类包含关系乱配
    return Math.min(na.length, nb.length) >= 4;
  }
  return false;
}

// 用 AI 评语修正候选人的 educationExperience
export function enrichEducationFromComment(c) {
  const aiList = parseEducationFromComment(c.jobRelevanceComment);
  if (aiList.length === 0) return;
  const existing = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  const merged = [];
  const used = new Set();
  for (const ai of aiList) {
    // 找现有条目里学校模糊匹配的，复用其时间
    let hit = -1;
    for (let i = 0; i < existing.length; i++) {
      if (used.has(i)) continue;
      if (schoolNamesMatch(existing[i].school, ai.school)) { hit = i; break; }
    }
    if (hit >= 0) {
      used.add(hit);
      const ex = existing[hit];
      merged.push({
        time: ai.time || ex.time || '',
        school: ai.school,
        major: ai.major || ex.major || '',
        degree: ai.degree || ex.degree || '',
      });
    } else {
      merged.push({ time: ai.time || '', school: ai.school, major: ai.major, degree: ai.degree });
    }
  }
  // 现有条目若与 AI 校名都不匹配：多是误抓的二级学院名/OCR噪音（特征：缺学历或缺专业，或校名不像真学校），丢弃；
  // 完整（有学历+专业）且校名像真学校的条目 AI 漏了也保留，避免误删。
  for (let i = 0; i < existing.length; i++) {
    if (used.has(i)) continue;
    const ex = existing[i];
    if (ex.degree && ex.major && schoolLooksReal(ex.school)) merged.push(ex);
  }
  if (merged.length > 0) c.educationExperience = merged;
}

// ===== 从简历文本补教育条目的时间/专业（导出兜底） =====
// OCR 常把一条教育记录拆到相邻两行（一行校名、一行时间），parseEduLine 要求学历词/时间
// 紧跟校名后，跨行的条目会被漏掉；AI 补进的条目时间/专业因此是空（如徐女士本科）。
// 这里在校名前后窗口里找年份区间补时间；专业只在「校名后是干净文本」时才补，防把
// "负责人/专业排名"这类 OCR 噪音当专业。
// 专业字段的终止锚点：数字 / 常见栏目标题 / 学历词 / 「学历」。学历词走 scripts/degree.mjs
// 共用词汇表，别再手写一份 —— 漏掉大专/中专/专升本，专业字段就会把学历词吞进去
const MAJOR_END_RE = new RegExp(String.raw`^[,，、|\s:：·]*([^,，、|\s:：·\d][^,，、|\s:：·\n]{1,24}?)(?=\s*(?:\d{4}|专业排名|主修课程|排名|在校经历|荣誉|工作经历|经历概览|证书|` + DEGREE_ANY_RE.source + String.raw`|学历))`);

function findSchoolContextFromText(resumeText, school) {
  if (!resumeText || !school) return { time: '', major: '' };
  const t = resumeText.replace(/[ \t]+/g, ' ').trim();
  const idx = t.indexOf(school);
  if (idx < 0) return { time: '', major: '' };
  const before = t.slice(Math.max(0, idx - 60), idx);
  const after = t.slice(idx + school.length, Math.min(t.length, idx + school.length + 90));
  const win = before + school + after;
  const tm = win.match(/(\d{4})\s*[-–—~～至]\s*(\d{4})/);
  const time = tm ? `${tm[1]} - ${tm[2]}` : '';
  // 专业：校名后到「时间/专业排名/主修课程」等锚点前的文本；含 OCR 噪音词则放弃
  const mj = after.match(MAJOR_END_RE);
  let major = '';
  // 必须含汉字（防 OCR 标点残片如 '.…' 当专业），且不含噪音词
  if (mj && /[一-龥]/.test(mj[1]) &&
      !/负责人|专业排名|主修课程|统计|调研|收藏|经历概览|排名|四级|六级|证[书件]|竞赛|协会|社团|志愿服务|奖学金|主修/.test(mj[1])) {
    major = mj[1];
  }
  return { time, major };
}

export function fillEducationGapsFromResumeText(c) {
  const edu = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  if (edu.length === 0) return;
  const text = c.resumeText || c.rawVisibleText || '';
  for (const e of edu) {
    if (e.time && e.major) continue;
    const { time, major } = findSchoolContextFromText(text, e.school);
    if (e.time || !time) { /* 已有时间则不动 */ } else { e.time = time; }
    if (e.major || !major) { /* 已有专业则不动 */ } else { e.major = major; }
  }
}

// ===== 教育经历排序：最高学历排最上面 =====
// AI 评语按「第一学历 → 最高学历」顺序生成，直接照搬会让本科排硕士上面。
// 导出前按学历层次从高到低重排（层次分见 scripts/degree.mjs 的共用词汇表），同级别保持原顺序。
export function sortEducationByDegree(c) {
  const edu = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  if (edu.length < 2) return;
  c.educationExperience = edu
    .map((e, i) => ({ e, i }))
    .sort((a, b) => degreeRank(b.e.degree) - degreeRank(a.e.degree) || a.i - b.i)
    .map((x) => x.e);
}

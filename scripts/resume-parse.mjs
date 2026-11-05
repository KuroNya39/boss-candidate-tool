// scripts/resume-parse.mjs — 从简历文本里解析教育经历与工作经历
// 纯函数：只吃文本、只吐结构化数据，不碰 CDP 与文件系统。
// 提取侧（截图 OCR / DOM / 模拟复制三条路汇成的 resumeText）与导出兜底共用这一份。
import { DEGREE_EXTRACT_KEYS, normalizeDegreeWord, degreeRank } from './degree.mjs';

// ===== 分行简历文本的教育经历解析（模拟复制 / DOM 提取的文本） =====
// 这类文本是按行排的，一段教育经历就是连续的「学校 / 专业 / 学历 / 时间」四行。
// 校名整行判定比下面的 SCHOOL_RE 多认「分校 / 校区 / 研究生院 / 中学」：
// 「东北大学秦皇岛分校」「哈尔滨工业大学深圳研究生院」「天峨县高级中学」都是整行一个校名，
// 少这几个后缀就会被当普通行跳过，或把校名截成「东北大学」。
const EDU_SCHOOL_LINE_RE = /^[一-龥]{2,}(?:大学|学院|研究所|学校|分校|校区|研究生院|中学)(?:[（(][^）)]*[）)])?$/;
// 时间整行：简历里的写法几乎都是「2016 - 2019」（分隔符 OCR 常认成 – — ~ ～）
const EDU_TIME_LINE_RE = /^(\d{4})\s*[-–—~～至]\s*(\d{4})$/;
// 标签整行（院校等级 / 在校经历标题）：出现在专业位置说明这段没有专业
const EDU_LABEL_LINE_RE = /院校$|QS|排名|在校经历|奖学金|荣誉|资格证书|技能|主修/;

/**
 * 该行命中的学历词（不是学历行则返回 ''）：含学历词、够短，且本身不是校名
 * （「哈尔滨工业大学深圳研究生院」含「研究生」但不是学历行）。
 * 直接返回命中的词，调用方拿去当 degree，不用再扫一遍词表
 */
function eduDegreeWordIn(line) {
  if (!line || line.length > 16 || EDU_SCHOOL_LINE_RE.test(line)) return '';
  return DEGREE_EXTRACT_KEYS.find(d => line.includes(d)) || '';
}

/**
 * 按行解析教育经历：以「学历行 + 紧随其后的时间行」为锚点，往上取专业与学校。
 * 专业可能没有（只有「学校 / 学历 / 时间」三行），这时学历行上一行就是学校。
 * 返回空数组表示这段文本不是分行结构，交给调用方的正则路径。
 */
function parseEducationByLines(section) {
  const lines = section.split('\n').map(l => l.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const degreeWord = eduDegreeWordIn(lines[i]);
    if (!degreeWord) continue;
    const tm = (lines[i + 1] || '').match(EDU_TIME_LINE_RE);
    if (!tm) continue;
    const prev = lines[i - 1] || '';
    let school, major;
    if (EDU_SCHOOL_LINE_RE.test(prev)) { school = prev; major = ''; }
    else { school = lines[i - 2] || ''; major = prev; }
    if (!EDU_SCHOOL_LINE_RE.test(school)) continue;
    if (EDU_TIME_LINE_RE.test(major) || EDU_LABEL_LINE_RE.test(major)) major = '';
    // 学历行常带后缀（「硕士 · 非全日制」），取词表里那个词
    out.push({
      time: `${tm[1]} - ${tm[2]}`,
      school,
      major,
      degree: normalizeDegreeWord(degreeWord),
    });
  }
  return out;
}

/**
 * 从简历文本中解析教育经历条目（时间、学校、专业、学历）
 * BOSS直聘 OCR 简历文本典型格式：教育经历X大学X专业X学历 YYYY-YYYY
 */
export function parseEducationFromResume(resumeText) {
  if (!resumeText || resumeText.length < 50) return [];
  const results = [];

  const TIME_RANGE_RE = /(\d{4})\s*[-–—~～]\s*(\d{4})/;
  const SCHOOL_RE = /([一-龥]{2,}(?:大学|学院|研究所|学校))/;

  const text = resumeText.replace(/[ \t]+/g, ' ').trim();

  // 定位教育经历段落
  const eduHeaders = ['教育经历', '教育背景', '学历背景', '教朋经历', '教肓经历', '教育情况'];
  let eduSection = '';
  for (const header of eduHeaders) {
    const idx = text.indexOf(header);
    if (idx < 0) continue;
    eduSection = text.substring(idx);
    break;
  }
  if (!eduSection) {
    for (const line of text.split('\n')) {
      const eduEntries = parseEduLine(line, TIME_RANGE_RE, SCHOOL_RE);
      if (eduEntries) { for (const e of eduEntries) { if (e.time) results.push(e); } }
    }
    return dedupeEduResults(results);
  }

  // 截断到下一段落
  for (const m of ['工作经历', '工作经验']) {
    const i = eduSection.indexOf(m);
    if (i > 0) eduSection = eduSection.substring(0, i);
  }

  // 模拟复制 / DOM 提取的简历文本按行排，先走按行解析：一段教育经历就是连续的
  // 「学校 / 专业 / 学历 / 时间」四行，按行取字段最准。下面的正则那套是给 OCR 那种
  // 整段挤成一行、字段顺序还乱的文本准备的，用在分行文本上会误伤 ——
  // 例如在校经历里的「…国家奖学金、XX大学优秀研究生、…」会被当成一条教育经历。
  const byLines = parseEducationByLines(eduSection);
  if (byLines.length > 0) {
    // 去重只认「学校 + 专业 + 学历」全同（简历里同一段教育写了两遍）。
    // 不能走 dedupeEduResults：它按「同校同学历」合并，会把双学位 / 第二专业
    // （同校同层次、专业不同）并成一条丢掉。
    const seen = new Set();
    return byLines
      .filter((e) => {
        const key = `${e.school}|${e.major}|${e.degree}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => degreeRank(b.degree) - degreeRank(a.degree));
  }

  for (const rawLine of eduSection.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.length < 5 || line.includes('推荐')) continue;
    for (const h of eduHeaders) {
      if (line.startsWith(h)) { line = line.slice(h.length).trim(); break; }
    }
    line = line.replace(/^[^一-龥]+/, '').trim();
    if (line.length < 4) continue;
    // DOM 提取的简历文本通常没有换行，整段教育经历（可能含主修课程/在校经历/社团经历等干扰内容）
    // 会连成一个超长行。parseEduLine 有 200 字上限，直接解析会整段被拒。
    // 这里先把超长行按「学校名」切成多个短窗口，每个窗口单独解析，避免漏掉多段教育。
    const linesToParse = line.length > 200
      ? splitEduLongLine(line, TIME_RANGE_RE, SCHOOL_RE)
      : [line];
    for (const subLine of linesToParse) {
      const eduEntries = parseEduLine(subLine, TIME_RANGE_RE, SCHOOL_RE);
      if (eduEntries) { for (const e of eduEntries) results.push(e); }
    }
  }

  // 全文本扫描补充
  const seenKeys = new Set(results.map(r => r.school.substring(0, 3) + '|' + r.degree));
  for (const extraLine of text.split('\n')) {
    const extraEntries = parseEduLine(extraLine.trim(), TIME_RANGE_RE, SCHOOL_RE);
    if (!extraEntries) continue;
    for (const extraEntry of extraEntries) {
      if (!extraEntry.time) continue;
      const key = extraEntry.school.substring(0, 3) + '|' + extraEntry.degree;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      results.push(extraEntry);
    }
  }

  return dedupeEduResults(results);
}

/**
 * 从简历文本中解析工作经历条目（时间、公司、职位）
 *
 * BOSS直聘简历文本里每段工作经历是「公司名 / 职位 / 时间区间」三行打头，后面跟职责描述：
 *   深圳市德明利技术股份有限公司
 *   项目经理/主管
 *   2026.06 - 至今
 * 故以时间行为锚点、回看紧邻的两行取职位与公司（中间可能夹着技能标签等噪音行，
 * 但紧邻时间行的两行始终是公司/职位）。搜索页卡片不带在职时间，Excel「在职时间」列靠这里补。
 * 简历按时间倒序，返回结果的 [0] 即最近一段工作。
 * 返回项带 embedded 标记：true 表示这个日期区间出现在描述正文里、不是条目头（公司/职位不可信）。
 */
export function parseWorkExperienceFromResume(resumeText) {
  if (!resumeText || resumeText.length < 50) return [];

  // 时间行：2026.06 - 2024.05 / 2022.6-至今 / 2022年6月—2024年5月（OCR 常把 - 认成 – — ~ 等）
  // 起点也接受「1990年以前」这种简历原话（Boss 卡片会把它渲染成 1989.01）
  const TIME_RE = /((?:19|20)\d{2}\s*(?:年\s*(?:以前|之前)|[.\-/年]\s*\d{1,2}\s*月?))\s*[-–—~～至]+\s*((?:19|20)\d{2}\s*[.\-/年]\s*\d{1,2}\s*月?|至今|今|现在)/;
  // 条目头判定的余量：时间行后面最多还能跟这么几个字符（如句末标点）仍算「日期独占一行」
  const EMBEDDED_SLACK = 3;
  // 归一成推荐页卡片的写法（'2025.03' / '至今'）；认不出的原样保留
  const fmt = (s) => {
    const m = s.match(/((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})/);
    return m ? `${m[1]}.${m[2].padStart(2, '0')}` : s.replace(/\s+/g, '');
  };

  // 定位「工作经历」段落（取最先出现的那个标题）
  const header = ['工作经历', '工作经验', '工作履历'].find((h) => resumeText.includes(h));
  if (!header) return [];
  let section = resumeText.substring(resumeText.indexOf(header) + header.length);

  // 截断到下一段落（只认行首标题，避免把描述里的词当标题）
  const NEXT_HEADERS = [
    '项目经验', '项目经历', '教育经历', '教育背景', '专业技能', '技能特长', '资格证书',
    '证书', '自我评价', '个人评价', '获奖经历', '荣誉奖项', '在校经历',
  ];
  let cut = section.length;
  for (const h of NEXT_HEADERS) {
    const i = section.indexOf('\n' + h);
    if (i >= 0 && i < cut) cut = i;
  }
  section = section.substring(0, cut);

  const lines = section.replace(/\r/g, '').split('\n').map(l => l.trim());
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TIME_RE);
    if (!m) continue;
    // 与推荐页卡片保持同一种写法：'2025.03 - 至今'
    const time = `${fmt(m[1])} - ${fmt(m[2])}`;
    // 日期区间在描述正文里也会出现（如「跨部门专案支援（2025.06 - 2025.10） | 核心成果…」），
    // 那种不是条目头、前面的两行也不是公司/职位。条目头的日期基本独占一行，据此标记 embedded。
    const embedded = lines[i].length > m[0].length + EMBEDDED_SLACK;
    const prev = [];
    for (let j = i - 1; j >= 0 && prev.length < 2; j--) {
      if (lines[j]) prev.push(lines[j]);
    }
    results.push({ time, position: prev[0] || '', company: prev[1] || '', embedded });
  }
  return results;
}

/**
 * 把超长无换行的教育经历段落切成多个短窗口，每个窗口以学校名为锚点。
 * DOM 提取文本形如：'XX大学工业工程硕士 2025-2027 211院校QS世界大学排名TOP500YY学院机械设计制造及其自动化本科 2017-2021'
 * 以每个学校名为起点，截取到下一个学校名（或段落尾）前，得到一个独立的候选教育条目。
 */
function splitEduLongLine(line, TIME_RANGE_RE, SCHOOL_RE) {
  const globalRE = new RegExp(SCHOOL_RE.source, 'g');
  const anchors = [];
  let m;
  while ((m = globalRE.exec(line)) !== null) {
    const afterChar = line[m.index + m[0].length] || '';
    if (afterChar === '生') continue; // 'XX大学生/高中生/中学生' 是身份称谓或竞赛名，不是学校名
    // 过滤 'QS世界大学排名' 这类把"世界大学"当学校名的噪音：学校名前面紧邻 QS/排名 等标识
    const before = line.slice(Math.max(0, m.index - 8), m.index);
    // 只跳过「QS世界大学/排名」这类噪音锚点本身（其后的真实校名不受影响）。
    // 例：'QS世界大学排名TOP500XX师范大学' → '世界大学' 是噪音应跳过，
    // 但紧跟其后的 'XX师范大学' 前面是 '500' 数字，不算噪音，必须保留。
    if (/QS\s*(?:世界|亚洲|地区)?大学|世界大学排名|院校等级|院校级/.test(before + m[0])) continue;
    // 只保留「学校名后跟学历关键词 或 时间区间」的锚点
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const hasDegreeAfter = DEGREE_EXTRACT_KEYS.some(d => after.includes(d));
    const hasTimeAfter = TIME_RANGE_RE.test(after);
    if (!hasDegreeAfter && !hasTimeAfter) continue;
    // 贪婪匹配可能把校名前的主修课程/经历内容吞进来（如"文化活动与会展策划XX大学"），
    // 校名起点修正为串内最后一个「XX大学/学院」出现的位置，保证窗口从真实校名开始。
    const lastIdx = m[1].lastIndexOf(line.match(/[一-龥]{2,}(?:大学|学院)$/) ? m[1].match(/([一-龥]{2,}(?:大学|学院))$/)[1] : '');
    const schoolStart = m.index + m[0].length - m[1].length; // match 串起点
    const realStart = schoolStart + (m[1].match(/([一-龥]{2,}(?:大学|学院))$/) ? m[1].length - m[1].match(/([一-龥]{2,}(?:大学|学院))$/)[1].length : 0);
    // 切窗边界用所有「大学/学院/学校」匹配（含噪音如"世界大学"），保证窗口短小不粘连；
    // 噪音条目在 parseEduLine 内通过 QS/排名/无学历词时间 过滤掉。
    anchors.push({ start: m.index, len: m[0].length });
  }
  if (anchors.length === 0) return [line];

  const windows = [];
  let prevEnd = 0; // 前一锚点结束位置，避免窗口重叠把前一校名尾部残余带进来
  for (let i = 0; i < anchors.length; i++) {
    const start = Math.max(prevEnd, anchors[i].start - 20); // 学校名前留一点上下文，但不越过前一锚点
    // 末尾取：下一个学校名前，或本学校名 + 时间区间 + 一小段尾巴
    let end;
    if (i + 1 < anchors.length) {
      end = anchors[i + 1].start;
    } else {
      // 最后一个学校名：取到时间区间结束后约 30 字符（学历信息通常在时间区间附近）
      const seg = line.slice(anchors[i].start);
      const tm = seg.match(TIME_RANGE_RE);
      end = tm ? anchors[i].start + tm.index + tm[0].length + 30 : line.length;
    }
    const win = line.slice(start, end).trim();
    if (win.length > 4 && win.length <= 300) windows.push(win);
    prevEnd = end;
  }
  return windows;
}

function parseEduLine(line, TIME_RANGE_RE, SCHOOL_RE) {
  const t = line.trim();
  if (!t || t.length < 5 || t.length > 200) return null;

  // 行内须含学历关键词；或（学校名 + 4位年份区间）。
  // OCR 教育条目常见 '学校 | 专业 YYYY - YYYY'，行内未必带学历词（学历在卡片/正文其他位置）。
  const hasDegree = DEGREE_EXTRACT_KEYS.some(d => t.includes(d));
  if (!hasDegree) {
    if (!t.match(SCHOOL_RE)) return null;
    if (!TIME_RANGE_RE.test(t)) return null;
  }

  const cleanedLine = t.replace(/^(?:办|色|刺|RN|R |esy |h s |nme|[^一-龥])+/g, '');

  const eduPos = cleanedLine.indexOf('教育经历');
  const searchArea = eduPos >= 0 ? cleanedLine.substring(eduPos + 4) : cleanedLine;

  // 找行中所有学校名，每个学校名生成一条记录
  const globalRE = new RegExp(SCHOOL_RE.source, 'g');
  const NOISE_PREFIXES = ['佛', '岑', '志', '心', '办', '策划'];
  const noiseWords = ['荣誉', '奖学金', '优秀', '共建', '获荣', '一等', '二等', '院校'];
  const entries = [];
  let match;

  while ((match = globalRE.exec(searchArea)) !== null) {
    let schoolName = match[1];

    // 'XX大学生/高中生/中学生' 是身份称谓或竞赛名（如"广西高校大学生翻译大赛"），不是学校名
    const afterChar = searchArea[match.index + match[0].length] || '';
    if (afterChar === '生') continue;
    // 组织名后缀：'XX大学研究生会/学生会/校友会/团委' 是学生组织，不是学历教育。
    // '广西大学公共管理学院研究生会' → 校名后紧跟 '研究生会'，'研究生' 是组织名的一部分，不是学历词。
    const afterOrg = searchArea.slice(match.index + match[0].length, match.index + match[0].length + 4);
    if (/^(研究生会|学生会|校友会|团委|党支部|研究生处)/.test(afterOrg)) continue;

    // 'QS世界大学排名' 等把"世界大学/XX大学"当学校名的噪音：学校名前面紧邻 QS/排名 等标识
    // 只跳过噪音锚点本身（如 '世界大学'），不误杀紧跟其后的真实校名：
    // 'QS世界大学排名TOP500XX师范大学' 中 'XX师范大学' 前是 '500' 数字，不是噪音。
    const beforeSchool = searchArea.slice(Math.max(0, match.index - 8), match.index);
    if (/QS\s*(?:世界|亚洲|地区)?大学|世界大学排名|院校等级|院校级/.test(beforeSchool + schoolName)) continue;

    // 取学校名附近上下文
    const schoolIdx = searchArea.indexOf(schoolName);
    const contextStart = Math.max(0, schoolIdx - 30);
    const contextEnd = Math.min(searchArea.length, schoolIdx + schoolName.length + 60);
    const context = searchArea.substring(contextStart, contextEnd);

    // 学历关键词或年份区间必须紧贴学校名之后（20字符内）。
    // 真实教育条目形如 'XX大学工业工程硕士 2025-2027'/'YY大学美术学本科 2021-2025'，
    // 学历词和时间都在学校名紧后；而'曾任学校招生办学生代表，支持学校本科...'里"本科"距学校名很远，
    // 不该构成教育条目。
    const afterSchool = searchArea.slice(schoolIdx + schoolName.length, schoolIdx + schoolName.length + 20);
    const degree = DEGREE_EXTRACT_KEYS.find(d => afterSchool.includes(d));
    // 时间区间可能在专业名之后较远处（如 '劳动与社会保障本科 2023 - 2027'），
    // 20字符截断会把年份尾部切掉（'2023 - 2'），导致 time 缺失。
    // 改为在 context（学校名后 60 字符）内找时间区间；degree 仍用紧邻 20 字符判断。
    const afterWide = searchArea.slice(schoolIdx + schoolName.length, Math.min(searchArea.length, schoolIdx + schoolName.length + 60));
    const tm = afterWide.match(TIME_RANGE_RE);
    // 无学历词且无紧邻时间区间的学校名不算教育条目（过滤社团/活动/经历里提到的学校名）
    if (!degree && !tm) continue;
    // '曾任学校招生办学生代表，支持学校本科...'里"曾任学校/支持学校"不是学校名。
    // 以"学校"结尾的校名（如"XX外国语学校"）合法，但若没有时间区间且degree靠"本科"等远距词，
    // 多为"支持学校本科招生"这类非教育表述，丢弃。
    if (/学校$/.test(schoolName) && !tm) continue;

    // OCR噪声前缀：'策划XX大学'→'XX大学'（主修课程内容"文化活动与会展策划"粘上了校名）
    for (const noise of NOISE_PREFIXES) {
      if (schoolName.startsWith(noise) && schoolName.length > 4) {
        const stripped = schoolName.slice(noise.length);
        if (stripped.length >= 4 && /^[一-龥]{2,}(?:大学|学院)$/.test(stripped)) {
          schoolName = stripped; break;
        }
      }
    }
    if (schoolName.length > 6) {
      // 贪婪匹配可能把校名前的描述性内容吞进来（如"文化活动与会展策划XX大学"、
      // "审计职业道德等YY工业大学"）。正常长校名（"XX农业大学"）不含这些噪音词，
      // 只在匹配串含噪音词时，取最后一个噪音词之后的合法校名子串。
      // 用 lastIndexOf 逐个噪音词取最靠后的结束位置，避免 matchAll 因「曾任/任职」等
      // 重叠词只匹配第一个、丢掉后面的真实校名。
      const NOISE_WORDS = ['策划','曾任','支持','荣誉','经历','课程','描述','职业道德','专业排名','主修','在校','任职','负责','参与','协助','主管','运营','从事','等','暨','期间','就读','就职',
        // 主修课程内容粘上校名的长词（'数据库原理与应用XX师范学院'→'XX师范学院'）。
        // 用长词避免误伤真实校名（如"XX农业大学"不含这些长词）。
        '数据库原理','机器学习','数据分析','数据挖掘','与应用','心理测评','与测评','原理','测评','统计学','测量','咨询','建模','管理科学','研究','人工智能',
        // 平台前缀标签（'新就业形态劳动者XX学院'→'XX学院'）
        '新就业形态劳动者'];
      let lastNoiseEnd = -1;
      for (const w of NOISE_WORDS) {
        const idx = schoolName.lastIndexOf(w);
        if (idx >= 0) lastNoiseEnd = Math.max(lastNoiseEnd, idx + w.length);
      }
      if (lastNoiseEnd >= 0) {
        // '文化活动与会展策划XX大学'→尾'XX大学'；剥掉开头连接字（于/在/就/等）：
        // '曾任职于YY理工大学'→'YY理工大学'
        let candidate = schoolName.slice(lastNoiseEnd).replace(/^[于在就其的等暨、]+/, '');
        // 只接受"2字以上汉字 + 大学/学院/学校/研究所"的合法校名，
        // 否则保留原值（防 'XX大学'→'X大学' 这种误剥）。
        if (/^[一-龥]{2,}(?:大学|学院|学校|研究所)$/.test(candidate)) schoolName = candidate;
      }
      // 无噪音词但超长：校名后粘了院系名（'XX农业大学经济管理学院'）。
      // 取「第一个大学」之后、以学院/学校/研究所结尾的段作院系后缀剥离，只留主校名。
      // 只剥后缀段 ≤12 字、且整串确以院系后缀收尾的（防误伤"大学附属中学"这类校名，
      // 中学不在后缀列表里，自然不剥；'数据库原理与应用XX师范学院' 已由 NOISE_WORDS 处理）。
      if (schoolName.length > 10) {
        const m = schoolName.match(/^(.+?大学)(?:[一-龥]{1,12}(?:学院|学校|研究所))$/);
        if (m && m[1].length >= 4) schoolName = m[1];
      }
    }
    // 'XX大学附属中学/附属高中' 是中学全名的一部分，不是专业：
    // 'XX大学附属中学高中' → SCHOOL_RE 只匹配到 'XX大学'，'附属中学' 会被误当专业。
    // 把紧贴校名后的 '附属+中学/学校' 续名并入校名（'附属' 前无空格才合并，防误伤真专业）。
    // 中间段用惰性匹配取最短（'附属中学高中' → 只并入 '附属中学'，不吃掉紧跟的学历词 '高中'）。
    const affix = afterSchool.match(/^附属[一-龥]{0,8}?(?:中学|初中|高中|学校)/);
    if (affix) schoolName += affix[0];
    if (noiseWords.some(w => schoolName.includes(w))) continue;

    let major = '';
    const sIdx = context.indexOf(schoolName);
    if (degree) {
      const dIdx = context.indexOf(degree);
      if (sIdx >= 0 && dIdx > sIdx) {
        let mt = context.substring(sIdx + schoolName.length, dIdx).trim();
        mt = mt.replace(/^[,，、|\s]+/, '').replace(/[,，、|\s]+$/, '').replace(/[“”"]/g, '');
        if (mt && mt.length < 60) major = mt;
      }
    } else if (tm) {
      // 无学历关键词：取学校名到时间区间之间的文本作为专业
      // 'XX大学 | 国际中文教育 2024 - 2027' → 国际中文教育
      const tIdx = context.indexOf(tm[0]);
      if (sIdx >= 0 && tIdx > sIdx) {
        let mt = context.substring(sIdx + schoolName.length, tIdx).trim();
        mt = mt.replace(/^[,，、|\s·]+/, '').replace(/[,，、|\s·….…]+$/, '').replace(/[“”"|]+/g, '').replace(/\.{2,}|…+/g, '');
        if (mt && mt.length < 60) major = mt;
      }
    }

    const normalizedDegree = degree ? normalizeDegreeWord(degree) : '';
    entries.push({ time: tm ? tm[0].trim() : '', school: schoolName, major, degree: normalizedDegree });
  }

  return entries.length > 0 ? entries : null;
}

function dedupeEduResults(results) {
  // OCR常见错字纠正
  const OCR_CORRECTIONS = [
    ['碑腕', ''], ['碑胺', ''], ['碑腐', ''], ['春学院', '科学院'],
    ['时学院', '科学院'], ['拼泓', '指挥'], ['州拼泓', '州指挥'],
    ['R 其', '及其'], ['R其', '及其'], ['友其', '及其'],
    ['基尿', '基层'], ['春南', '暨南'],
    ['咤昏', '暨'],
    ['万程', '工程'], ['万喜理万', '万隆理工'],
    ['深圭', '深圳'], ['研完生', '研究生'],
    ['北京理工学院', '北京理工大学'],
  ];
  for (const entry of results) {
    for (const [wrong, right] of OCR_CORRECTIONS) {
      if (entry.school) entry.school = entry.school.split(wrong).join(right);
      if (entry.major) entry.major = entry.major.split(wrong).join(right);
    }
    if (entry.school) entry.school = entry.school.replace(/^中国中国/, '中国科学院').trim();
  }

  const final = [];
  for (const r of results) {
    let isDup = false;
    for (const existing of final) {
      if (existing.degree !== r.degree) continue;
      if (existing.school.includes(r.school) || r.school.includes(existing.school) || (existing.school.length >= 4 && r.school.length >= 4 && existing.school.substring(0,3) === r.school.substring(0,3))) {
        isDup = true;
        if (r.school.length < existing.school.length) {
          existing.school = r.school;
          if (r.time && !existing.time) existing.time = r.time;
          if (r.major && !existing.major) existing.major = r.major;
        }
        break;
      }
    }
    if (!isDup) final.push({ ...r });
  }
  // 最高学历排最前（层次分见 scripts/degree.mjs；认不出学历的排最后）
  final.sort((a, b) => degreeRank(b.degree) - degreeRank(a.degree));
  return final;
}


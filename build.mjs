#!/usr/bin/env node
/**
 * build.mjs — 完整构建脚本
 * 1. 生成 ICO
 * 2. electron-builder 打包（signAndEditExecutable: false，无需 winCodeSign）
 * 3. 手动嵌入图标到 exe（绕开 electron-builder 的 rcedit 兼容问题）
 * 4. 重建 NSIS 安装包（含修复图标的 exe）
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '.');

// 版本号不再由脚本自动递增：打包前由人工/Claude 根据改动性质判断改哪一段（见 CLAUDE.md「版本号规则」）。
// 这里只读取当前版本并校验格式；「目标版本是否已发布过」的校验放在 main() 开头。
const pkgPath = resolve(ROOT, 'package.json');
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(pkgPath, 'utf-8')));
const VERSION = pkg.version;
const _vParts = VERSION.split('.').map(Number);
if (_vParts.length !== 3 || _vParts.some(n => Number.isNaN(n))) {
  throw new Error(`package.json 版本号格式不正确: "${VERSION}"（应为 x.y.z 三段数字）`);
}

const APP_NAME = 'BOSS直聘候选人AI评分助手';
const REPO = 'KuroNya39/boss-candidate-tool';
const OUT = 'build-tmp';
const EXE_NAME = `${APP_NAME}.exe`;
const SETUP_NAME = `${APP_NAME} Setup ${VERSION}.exe`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Windows 下刚生成的安装包可能被 Defender 实时扫描短暂占用（EPERM），
// 直接 rename 会失败。重试几次等锁释放（v1.3.16 实测撞车一次）。
async function retryRenameSync(from, to, label, retries = 5, delayMs = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (i === retries) {
        throw new Error(`${label}失败（重试 ${retries} 次仍被占用）: ${e.message}`);
      }
      console.warn(`  ${label}被占用（第 ${i}/${retries} 次），${delayMs / 1000}s 后重试 (${e.code})`);
      await sleep(delayMs);
    }
  }
}

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

/**
 * curl 直传单个资产到 GitHub uploads API。
 * 背景：gh release create 带上大文件（>100MB 的 exe/zip）上传时会卡死（v1.8.0/v1.8.1 连续踩坑），
 * curl 直传一直稳定（HTTP 201）。spawnSync 用参数数组传值，避开 shell 转义中文路径/空格的问题。
 */
function uploadAsset(releaseId, filePath, assetName) {
  const token = execSync('gh auth token', { cwd: ROOT, encoding: 'utf-8' }).trim();
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
  const mb = (statSync(filePath).size / 1024 / 1024).toFixed(0);
  console.log(`  ⬆️  上传 ${assetName}（约 ${mb} MB）...`);
  const r = spawnSync('curl', [
    '-sS', '-f',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${filePath}`,
    url
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 600000 });
  if (r.status !== 0) {
    throw new Error(`上传 ${assetName} 失败: ${(r.stderr || r.stdout || '').trim() || `curl 退出码 ${r.status}`}`);
  }
  console.log(`  ✅ ${assetName} 上传完成`);
}

// 校验某版本 tag 是否已存在（即已发布过）
function tagExists(tag) {
  try {
    execSync(`git show-ref --verify --quiet refs/tags/${tag}`, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// 取最近一个已发布版本的 tag（排除当前版本），用于生成更新说明的提交范围
function getLastTag() {
  try {
    const tags = execSync('git tag --sort=-v:refname', { cwd: ROOT, encoding: 'utf-8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    return tags.find(t => t !== `v${VERSION}`) || null;
  } catch { return null; }
}

/**
 * 生成 Release 更新说明（手写友好格式，参考 v1.3.14 样式）
 * 优先使用 ROOT/RELEASE_NOTES.md 手写定稿（完整「更新内容」，不叠加 commit 列表）；
 * 没有手写文件时自动生成草稿——「## 更新内容（M月D日）」+「### vX.Y.Z 更新内容」小节头 + 最近 tag 到 HEAD 的 commit 列表。
 * 注意：当天多版本合并的完整内容由发布前手写 RELEASE_NOTES.md 保证（自动草稿只覆盖最近 tag 之后的提交）。
 */
function buildReleaseNotes() {
  // 注意：此时 build-tmp 已被移动到 release，必须写进 release 目录
  const notesPath = resolve(ROOT, 'release', 'release-notes.md');
  // 安装包在 GitHub 上的资产名是 Boss.AI.Setup.X.X.X.exe（gh 上传后如此命名，README 也一致）
  const downloadTable = `## 下载\n| 文件 | 说明 |\n|------|------|\n| Boss.AI.Setup.${VERSION}.exe | 安装包 |\n| win-unpacked.zip | 绿色版（解压即用） |\n`;

  // 优先使用手写的 RELEASE_NOTES.md 作为完整更新内容（含日期头与版本小节头）
  const manualFile = resolve(ROOT, 'RELEASE_NOTES.md');
  try {
    if (existsSync(manualFile)) {
      const manual = readFileSync(manualFile, 'utf-8').trim();
      if (manual) {
        // 只取第一个「## 更新内容（X月X日）」段落：GitHub release 只保留当天最新一版，
        // 即使 RELEASE_NOTES.md 里堆积了历史日期，发布说明也不会把多天内容混在一起
        let section = manual;
        const firstHead = manual.indexOf('## 更新内容（');
        if (firstHead >= 0) {
          const secondHead = manual.indexOf('## 更新内容（', firstHead + 1);
          if (secondHead > firstHead) section = manual.slice(firstHead, secondHead).trim();
        }
        // 手写定稿里已含下载表则直接使用，避免重复追加
        const final = section.includes('## 下载')
          ? section
          : `${section}\n\n${downloadTable}`;
        writeFileSync(notesPath, final, 'utf-8');
        console.log(`  Release 说明已生成（使用 RELEASE_NOTES.md 手写定稿）: ${notesPath}`);
        return notesPath;
      }
    }
  } catch {}

  // 无手写文件：自动生成友好结构草稿
  const prevTag = getLastTag();
  let commits = [];
  try {
    if (prevTag) {
      const log = execSync(`git log ${prevTag}..HEAD --no-merges --pretty=%s`, { cwd: ROOT, encoding: 'utf-8' });
      commits = log.split('\n').filter(Boolean);
    }
  } catch {
    commits = [];
  }
  const items = commits.length > 0
    ? commits.map(c => `- ${c}`).join('\n')
    : '- 自动构建发布';

  const now = new Date();
  const dateHead = `${now.getMonth() + 1}月${now.getDate()}日`;
  const notes = `## 更新内容（${dateHead}）\n\n### v${VERSION} 更新内容\n\n${items}\n\n${downloadTable}`;
  writeFileSync(notesPath, notes, 'utf-8');
  console.log(`  Release 说明已生成（自动草稿，发布前可手写 RELEASE_NOTES.md 定稿）: ${notesPath}`);
  return notesPath;
}

// 同一天只保留最新一版：发布新版后删除当天较早发布的 release 及其本地/远程 tag
// （规则见 CLAUDE.md「版本号规则」——一天可多次 bump，但 GitHub release 只留当天最新）
function removeSameDayEarlierReleases() {
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let releases;
  try {
    // 用 publishedAt 而非 createdAt：release 可能是先建草稿、后正式发布的，
    // createdAt 会落在建草稿的那天（可能比正式发布早一天），导致当天清理漏删
    const json = execSync('gh release list --limit 30 --json tagName,publishedAt', { cwd: ROOT, encoding: 'utf-8' });
    releases = JSON.parse(json);
  } catch {
    console.warn('  无法读取 release 列表，跳过当天旧版清理');
    return;
  }
  for (const r of releases) {
    if (r.tagName === `v${VERSION}`) continue; // 保留刚发布的这一版
    const published = new Date(r.publishedAt);
    const publishedKey = `${published.getFullYear()}-${String(published.getMonth() + 1).padStart(2, '0')}-${String(published.getDate()).padStart(2, '0')}`;
    if (publishedKey !== todayKey) continue; // 只看当天发布的
    console.log(`  删除当天较早版本: ${r.tagName}（只保留最新 v${VERSION}）`);
    try {
      execSync(`gh release delete "${r.tagName}" --yes`, { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      console.warn(`    删除 release 失败: ${e.message}`);
      continue;
    }
    try { execSync(`git tag -d "${r.tagName}"`, { cwd: ROOT, stdio: 'pipe' }); } catch {}
    try { execSync(`git push origin ":refs/tags/${r.tagName}"`, { cwd: ROOT, stdio: 'pipe' }); } catch {}
  }
}

function findRcedit() {
  const cacheDir = resolve(
    process.env.USERPROFILE || '',
    'AppData/Local/electron-builder/Cache/winCodeSign'
  );
  if (!existsSync(cacheDir)) return null;

  const subdirs = readdirSync(cacheDir).filter(d => /^\d+$/.test(d)).sort().reverse();
  for (const d of subdirs) {
    const candidate = resolve(cacheDir, d, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  const rootCandidate = resolve(cacheDir, 'rcedit-x64.exe');
  if (existsSync(rootCandidate)) return rootCandidate;
  for (const d of readdirSync(cacheDir)) {
    const candidate = resolve(cacheDir, d, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  // 防重校验：目标版本 tag 已存在说明发布过了，需要先升版本号
  if (tagExists(`v${VERSION}`)) {
    throw new Error(`版本号 v${VERSION} 已发布过。请先根据本轮改动性质更新 package.json 的 version（见 CLAUDE.md「版本号规则」）再打包。`);
  }
  console.log(`\n版本号: ${VERSION}（打包前已确认，不再自动递增）`);

  // 1. 生成 ICO
  console.log('\n=== 1/4: 生成 ICO ===');
  run('node scripts/make-ico.mjs');

  // 清理旧构建产物
  if (existsSync(resolve(ROOT, OUT))) {
    rmSync(resolve(ROOT, OUT), { recursive: true, force: true });
  }

  // 2. electron-builder 打包
  console.log('\n=== 2/4: electron-builder 打包 ===');
  run('npx electron-builder --win');

  // 3. 手动嵌入图标
  console.log('\n=== 3/4: 嵌入图标 ===');
  const exePath = resolve(ROOT, OUT, 'win-unpacked', EXE_NAME);
  const icoPath = resolve(ROOT, 'build', 'icon.ico');
  const rceditPath = findRcedit();

  if (!rceditPath) throw new Error('未找到 rcedit-x64.exe');
  execSync(`"${rceditPath}" "${exePath}" --set-icon "${icoPath}"`, { stdio: 'inherit' });
  console.log('图标嵌入完成');

  // 4. 重建安装包（先清理旧安装包文件，避免 NSIS 输出文件被锁）
  console.log('\n=== 4/4: 重建安装包 ===');
  // 剔除 electron 分发的 Chromium 许可证文件（约 20M，无功能作用）：
  // electron-builder 的 files 排除管不到它，需在重建 NSIS 前手动删除
  try {
    rmSync(resolve(ROOT, OUT, 'win-unpacked', 'LICENSES.chromium.html'));
    console.log('  已剔除 LICENSES.chromium.html');
  } catch {}
  const setupPath = resolve(ROOT, OUT, SETUP_NAME);
  const blockMap = setupPath + '.blockmap';
  const uninstaller = setupPath.replace(/\.exe$/, '.__uninstaller.exe');
  const nsis7z = resolve(ROOT, OUT, `web-access-${VERSION}-x64.nsis.7z`);
  if (existsSync(setupPath)) rmSync(setupPath);
  if (existsSync(blockMap)) rmSync(blockMap);
  if (existsSync(uninstaller)) rmSync(uninstaller);
  if (existsSync(nsis7z)) rmSync(nsis7z);
  run(`npx electron-builder --win --prepackaged "${resolve(ROOT, OUT, 'win-unpacked')}"`);

  // 5. 输出到 release 目录
  // v1.3.12 修复: 原实现用 cmd rmdir/move，旧 release 被占用（旧版 exe 残留锁）时
  // rmdir 只删掉一半、move 把 build-tmp 嵌套成 release/build-tmp，Setup exe 找不到 → 发布失败。
  // 改为 Node 原生 rename：旧 release 改名让位（rename 不删文件，遇文件锁更宽容），
  // build-tmp 原子替换成 release，最后尽力清理旧目录，清不掉只告警、不影响构建。
  console.log('\n=== 5/6: 输出到 release ===');
  const finalDist = resolve(ROOT, 'release');
  const tmpDist = resolve(ROOT, OUT);
  // 先清理历史遗留的 release-old-*（占用中的跳过，下次构建再清）
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('release-old-')) {
      try { rmSync(resolve(ROOT, entry), { recursive: true, force: true }); }
      catch { console.warn(`  警告: ${entry} 仍被占用，保留待下次清理`); }
    }
  }
  if (existsSync(finalDist)) {
    const oldDist = resolve(ROOT, `release-old-${Date.now()}`);
    try {
      await retryRenameSync(finalDist, oldDist, '旧 release 让位');
    } catch (e) {
      throw new Error(`release 目录被占用（旧版程序可能仍在运行），请关闭后重试。\n详情: ${e.message}`);
    }
    // 尽力清理改名让位出的旧目录；被占用则保留，下次构建自动清
    try { rmSync(oldDist, { recursive: true, force: true }); }
    catch { console.warn(`  警告: 旧 release 部分文件仍被占用，保留在 release-old-*（下次构建自动清理）`); }
  }
  await retryRenameSync(tmpDist, finalDist, '新构建替换到 release');

  // 6. 创建绿色版压缩包
  console.log('\n=== 6/6: 创建绿色版压缩包 ===');
  const zipPath = resolve(finalDist, 'win-unpacked.zip');
  const unpackedDir = resolve(finalDist, 'win-unpacked');
  execSync(
    `powershell -NoProfile -Command "& { Compress-Archive -Path '${unpackedDir}\\*' -DestinationPath '${zipPath}' -Force }"`,
    { stdio: 'pipe' }
  );
  console.log(`绿色版压缩包已创建: ${zipPath}`);

  // 7. 清理不必要的构建文件
  const cleanupFiles = ['builder-debug.yml'];
  for (const f of cleanupFiles) {
    const fp = resolve(finalDist, f);
    try { if (existsSync(fp)) rmSync(fp); } catch {}
  }

  // 8. 上传到 GitHub Releases
  // 本地测试模式：SKIP_UPLOAD=1 时只打安装包、不上传 GitHub（先让用户测试，通过后再正式发布）
  if (process.env.SKIP_UPLOAD === '1') {
    console.log('\n（SKIP_UPLOAD=1，跳过 GitHub 上传，仅生成本地测试安装包）');
    console.log(`   安装包: ${resolve(finalDist, SETUP_NAME)}`);
    console.log(`   绿色版: ${resolve(finalDist, 'win-unpacked', EXE_NAME)}`);
    return;
  }
  const tag = `v${VERSION}`;
  console.log(`\n=== 7/7: 上传到 GitHub Releases (${tag}) ===`);
  try {
    // 先检查 tag 是否已存在，不存在则创建
    execSync(`git tag "${tag}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git push origin "${tag}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch {
    console.log(`  Tag ${tag} 已存在，跳过创建`);
  }

  // 自动生成 Release 更新说明（从 git log 收集本次改动）
  const notesPath = buildReleaseNotes();

  // gh 只用来建 release 草稿（不带资产）——gh 上传大文件会卡死，资产统一用 curl 直传（见 uploadAsset）
  execSync(
    `gh release create "${tag}" --title "${APP_NAME} ${tag}" --notes-file "${notesPath}" --draft`,
    { cwd: ROOT, stdio: 'inherit' }
  );
  // 注意：草稿 release 用 releases/tags/{tag} 查不到（该接口对草稿返回 404），
  // gh release create 的输出里也只有 URL、没有 id。刚建的草稿就是最新的草稿，从草稿列表取第一个。
  // 用 spawnSync 传参数数组：jq 表达式里的 | 和空格若走 cmd 会被当成管道符拆掉，参数数组则无此问题。
  const draftList = spawnSync('gh', [
    'api', `repos/${REPO}/releases?per_page=20`,
    '--jq', '[.[] | select(.draft == true)] | .[0].id'
  ], { cwd: ROOT, encoding: 'utf-8' });
  if (draftList.status !== 0) {
    throw new Error(`查询草稿 release 失败: ${(draftList.stderr || draftList.stdout || '').trim()}`);
  }
  const releaseId = draftList.stdout.trim();
  if (!releaseId || releaseId === 'null') {
    throw new Error('创建草稿后未找到对应的 release id（草稿列表为空？）');
  }

  // 资产名和 README 下载表保持一致：Boss.AI.Setup.X.Y.Z.exe / win-unpacked.zip。
  // 安装包先复制成 ASCII 文件名再上传（curl 读中文文件名偶发失败，规避掉）
  const asciiSetup = resolve(finalDist, `Boss.AI.Setup.${VERSION}.exe`);
  copyFileSync(resolve(finalDist, SETUP_NAME), asciiSetup);
  try {
    uploadAsset(releaseId, asciiSetup, `Boss.AI.Setup.${VERSION}.exe`);
    uploadAsset(releaseId, zipPath, 'win-unpacked.zip');
  } finally {
    try { rmSync(asciiSetup, { force: true }); } catch {}
  }

  // 资产齐了再解除草稿正式发布
  execSync(
    `gh api --method PATCH "repos/${REPO}/releases/${releaseId}" -f draft=false`,
    { cwd: ROOT, stdio: 'pipe' }
  );
  console.log(`  已上传到: https://github.com/${REPO}/releases/tag/${tag}`);

  // 同一天只保留最新一版：删除当天较早发布的 release 及 tag（规则见 CLAUDE.md「版本号规则」）
  removeSameDayEarlierReleases();

  console.log('\n✅ 构建完成');
  console.log(`   安装包: ${resolve(finalDist, SETUP_NAME)}`);
  console.log(`   绿色版: ${resolve(finalDist, 'win-unpacked', EXE_NAME)}`);
  console.log(`   绿色版压缩包: ${zipPath}`);
  console.log(`   输出目录: ${finalDist}`);
  console.log(`   GitHub Release: https://github.com/${REPO}/releases/tag/${tag}`);
}

main().catch(err => {
  console.error('❌ 构建失败:', err.message);
  process.exit(1);
});

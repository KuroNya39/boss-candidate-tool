#!/usr/bin/env node
/**
 * build.mjs — 完整构建脚本
 * 1. 生成 ICO
 * 2. electron-builder 打包（signAndEditExecutable: false，无需 winCodeSign）
 * 3. 手动嵌入图标到 exe（绕开 electron-builder 的 rcedit 兼容问题）
 * 4. 重建 NSIS 安装包（含修复图标的 exe）
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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

const APP_NAME = 'Boss直聘候选人AI评分助手';
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
 * 生成 Release 更新说明（格式参考 v1.3.2）
 * 从上一个 tag 到当前 HEAD 收集提交作为「更新内容」，
 * 若存在 RELEASE_NOTES.md 则将其内容（主题/简介）插在最前面。
 */
function buildReleaseNotes() {
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

  let header = '';
  const notesFile = resolve(ROOT, 'RELEASE_NOTES.md');
  try {
    if (existsSync(notesFile)) {
      header = readFileSync(notesFile, 'utf-8').trim() + '\n\n';
    }
  } catch {}

  // 注意：此时 build-tmp 已被移动到 release，必须写进 release 目录
  const notesPath = resolve(ROOT, 'release', 'release-notes.md');
  const notes = `${header}## 更新内容\n${items}\n\n## 下载\n| 文件 | 说明 |\n|------|------|\n| ${SETUP_NAME} | 安装包 |\n| win-unpacked.zip | 绿色版（解压即用） |\n`;
  writeFileSync(notesPath, notes, 'utf-8');
  console.log(`  Release 说明已生成: ${notesPath}`);
  return notesPath;
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

  execSync(
    `gh release create "${tag}" ` +
    `--title "${APP_NAME} ${tag}" ` +
    `--notes-file "${notesPath}" ` +
    `"${resolve(finalDist, SETUP_NAME)}" ` +
    `"${zipPath}"`,
    { cwd: ROOT, stdio: 'inherit' }
  );
  console.log(`  已上传到: https://github.com/${REPO}/releases/tag/${tag}`);

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

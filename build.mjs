#!/usr/bin/env node
/**
 * build.mjs — 完整构建脚本
 * 1. 生成 ICO
 * 2. electron-builder 打包（signAndEditExecutable: false，无需 winCodeSign）
 * 3. 手动嵌入图标到 exe（绕开 electron-builder 的 rcedit 兼容问题）
 * 4. 重建 NSIS 安装包（含修复图标的 exe）
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '.');

// 自动递增补丁版本号（如 1.3.0 → 1.3.1）
const pkgPath = resolve(ROOT, 'package.json');
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(pkgPath, 'utf-8')));
const OLD_VERSION = pkg.version;
const _vParts = OLD_VERSION.split('.').map(Number);
_vParts[2] = (_vParts[2] || 0) + 1;
const NEW_VERSION = _vParts.join('.');
pkg.version = NEW_VERSION;
await import('node:fs').then(fs => fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8'));

const APP_NAME = 'Boss直聘候选人AI评分助手';
const VERSION = NEW_VERSION;
const REPO = 'KuroNya39/boss-candidate-tool';
const OUT = 'build-tmp';
const EXE_NAME = `${APP_NAME}.exe`;
const SETUP_NAME = `${APP_NAME} Setup ${VERSION}.exe`;

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
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
  console.log(`\n版本号: ${OLD_VERSION} → ${VERSION}`);

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
  const setupPath = resolve(ROOT, OUT, SETUP_NAME);
  const blockMap = setupPath + '.blockmap';
  const uninstaller = setupPath.replace(/\.exe$/, '.__uninstaller.exe');
  const nsis7z = resolve(ROOT, OUT, `web-access-${VERSION}-x64.nsis.7z`);
  if (existsSync(setupPath)) rmSync(setupPath);
  if (existsSync(blockMap)) rmSync(blockMap);
  if (existsSync(uninstaller)) rmSync(uninstaller);
  if (existsSync(nsis7z)) rmSync(nsis7z);
  run(`npx electron-builder --win --prepackaged "${resolve(ROOT, OUT, 'win-unpacked')}"`);

  // 5. 输出到 release 目录（先 rm 清理再 mv，避免 Windows rename 跨设备/锁问题）
  console.log('\n=== 5/6: 输出到 release ===');
  const finalDist = resolve(ROOT, 'release');
  execSync(`cmd.exe /c "if exist "${finalDist}" rmdir /s /q "${finalDist}""`, { stdio: 'pipe' });
  execSync(`cmd.exe /c "move /y "${resolve(ROOT, OUT)}" "${finalDist}" "`, { stdio: 'pipe' });

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

  execSync(
    `gh release create "${tag}" ` +
    `--title "${APP_NAME} ${tag}" ` +
    `--notes "自动构建发布" ` +
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

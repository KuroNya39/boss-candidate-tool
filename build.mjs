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
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(resolve(ROOT, 'package.json'), 'utf-8')));

const APP_NAME = 'Boss直聘候选人提取分析';
const VERSION = pkg.version;
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

  // 优先检查子目录（electron-builder 缓存结构）
  const subdirs = readdirSync(cacheDir).filter(d => /^\d+$/.test(d)).sort().reverse();
  for (const d of subdirs) {
    const candidate = resolve(cacheDir, d, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  // 兜底：winCodeSign 根目录或任意子目录
  const rootCandidate = resolve(cacheDir, 'rcedit-x64.exe');
  if (existsSync(rootCandidate)) return rootCandidate;
  for (const d of readdirSync(cacheDir)) {
    const candidate = resolve(cacheDir, d, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  // 1. 生成 ICO
  console.log('\n=== 1/4: 生成 ICO ===');
  run('node scripts/make-ico.mjs');

  // 2. electron-builder 打包（首次，不嵌入图标）
  console.log('\n=== 2/4: electron-builder 打包 ===');
  run('npx electron-builder --win');

  // 3. 手动嵌入图标
  console.log('\n=== 3/4: 嵌入图标 ===');
  const exePath = resolve(ROOT, 'dist', 'win-unpacked', EXE_NAME);
  const icoPath = resolve(ROOT, 'build', 'icon.ico');
  const rceditPath = findRcedit();

  if (!rceditPath) throw new Error('未找到 rcedit-x64.exe，请先正常执行一次 electron-builder 打包');
  execSync(`"${rceditPath}" "${exePath}" --set-icon "${icoPath}"`, { stdio: 'inherit' });
  console.log('图标嵌入完成');

  // 4. 重建安装包
  console.log('\n=== 4/4: 重建安装包 ===');
  const setupPath = resolve(ROOT, 'dist', SETUP_NAME);
  const blockMap = setupPath + '.blockmap';
  if (existsSync(setupPath)) rmSync(setupPath);
  if (existsSync(blockMap)) rmSync(blockMap);
  run(`npx electron-builder --win --prepackaged "${resolve(ROOT, 'dist', 'win-unpacked')}"`);

  console.log('\n✅ 构建完成');
  console.log(`   安装包: ${setupPath}`);
  console.log(`   绿色版: ${exePath}`);
}

main().catch(err => {
  console.error('❌ 构建失败:', err.message);
  process.exit(1);
});

// 构建 dist/web-access-trial/：复制源文件、OCR 语言包、README，并安装 node_modules
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve('.');
const DIST = resolve('dist/web-access-trial');

function copy(src, dst, opts = {}) {
  const s = resolve(ROOT, src);
  const d = resolve(DIST, dst);
  if (!existsSync(s)) {
    console.warn(`[skip] 源不存在: ${src}`);
    return;
  }
  cpSync(s, d, { recursive: true, ...opts });
  console.log(`[copy] ${src} -> dist/web-access-trial/${dst}`);
}

console.log('=== 1. 准备目录 ===');
mkdirSync(DIST, { recursive: true });

console.log('\n=== 2. 复制源文件 ===');
// 先清理旧的 scripts 和 config（避免残留已删除的文件）
for (const sub of ['scripts', 'config']) {
  rmSync(resolve(DIST, sub), { recursive: true, force: true });
}
copy('scripts', 'scripts');
// 构建脚本本身不要包进试用包
const selfInDist = resolve(DIST, 'scripts/build-trial.mjs');
if (existsSync(selfInDist)) unlinkSync(selfInDist);
copy('config', 'config');
copy('references', 'references');
copy('ocr-lang', 'ocr-lang');
copy('SKILL.md', 'SKILL.md');
copy('用户使用指引.md', '用户使用指引.md');
copy('package.json', 'package.json');
copy('.claude-plugin', '.claude-plugin');

console.log('\n=== 3. 创建空的 output/ 和 data/ ===');
mkdirSync(resolve(DIST, 'output'), { recursive: true });
writeFileSync(resolve(DIST, 'output/.gitkeep'), '');
mkdirSync(resolve(DIST, 'data'), { recursive: true });
writeFileSync(resolve(DIST, 'data/candidates.json'), '[]\n');

console.log('\n=== 4. 写 .gitignore ===');
writeFileSync(resolve(DIST, '.gitignore'), [
  'node_modules/',
  'output/',
  'output-*/',
  'data/candidates.json',
  '.DS_Store',
  '',
].join('\n'));

console.log('\n=== 5. 安装依赖（tesseract.js + xlsx）===');
execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: DIST,
  stdio: 'inherit',
});

console.log('\n=== 完成 ===');
console.log(`输出目录: ${DIST}`);

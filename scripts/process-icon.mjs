/**
 * 处理应用图标：缩放 + 圆角
 * 输入: app_icon.png (项目根目录)
 * 输出: app_icon_rounded.png (项目根目录)
 */
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');

const INPUT = resolve(APP_ROOT, 'app_icon.png');
const OUTPUT = resolve(APP_ROOT, 'app_icon_rounded.png');
const SIZE = 256;          // 输出尺寸
const RADIUS = 48;         // 圆角半径 (相对于 256px)

async function main() {
  // 1. 创建圆角遮罩 SVG
  const roundedRect = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}">
      <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/>
    </svg>`
  );

  // 2. 读取原图 -> 缩放 -> 合成圆角遮罩 -> 输出 PNG
  await sharp(INPUT)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
    .composite([
      {
        input: roundedRect,
        blend: 'dest-in',  // 用遮罩裁剪原图
      },
    ])
    .png()
    .toFile(OUTPUT);

  console.log(`✅ 图标已生成: ${OUTPUT} (${SIZE}x${SIZE}, 圆角半径=${RADIUS}px)`);
}

main().catch(err => {
  console.error('❌ 图标处理失败:', err.message);
  process.exit(1);
});

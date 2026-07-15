/**
 * 生成 .ico 图标文件（纯 BMP 格式，含 256x256）
 * 输出到 build/icon.ico（electron-builder 默认路径）
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');

const INPUT = resolve(APP_ROOT, 'app_icon_rounded.png');
const OUTPUT = resolve(APP_ROOT, 'build', 'icon.ico');

// electron-builder 要求至少 256x256
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function createBmpEntry(rgba, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);      // biSize
  header.writeInt32LE(w, 4);        // biWidth
  header.writeInt32LE(h * 2, 8);    // biHeight (×2 for AND mask)
  header.writeUInt16LE(1, 12);      // biPlanes
  header.writeUInt16LE(32, 14);     // biBitCount
  header.writeUInt32LE(0, 16);      // biCompression (BI_RGB)
  header.writeUInt32LE(w * h * 4, 20); // biSizeImage

  // BGRA 像素，BMP 从 bottom-left 开始
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4;
      const dst = (y * w + x) * 4;
      pixels[dst] = rgba[src + 2];     // B
      pixels[dst + 1] = rgba[src + 1]; // G
      pixels[dst + 2] = rgba[src];     // R
      pixels[dst + 3] = rgba[src + 3]; // A
    }
  }

  const andMask = Buffer.alloc(Math.ceil(w / 32) * 4 * h, 0);
  return Buffer.concat([header, pixels, andMask]);
}

async function main() {
  // 确保 build 目录存在
  const { mkdirSync } = await import('node:fs');
  mkdirSync(resolve(APP_ROOT, 'build'), { recursive: true });

  const entries = [];
  let offset = 6 + SIZES.length * 16;

  for (const size of SIZES) {
    const raw = await sharp(INPUT).resize(size, size, { fit: 'cover' }).ensureAlpha().raw().toBuffer();
    const bmp = createBmpEntry(raw, size, size);

    entries.push({
      w: size >= 256 ? 0 : size,
      h: size >= 256 ? 0 : size,
      dataSize: bmp.length,
      offset,
      data: bmp,
    });
    offset += bmp.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // ICO
  header.writeUInt16LE(SIZES.length, 4); // count

  const dirBuf = Buffer.alloc(SIZES.length * 16);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const base = i * 16;
    dirBuf.writeUInt8(e.w, base);
    dirBuf.writeUInt8(e.h, base + 1);
    dirBuf.writeUInt8(0, base + 2);
    dirBuf.writeUInt8(0, base + 3);
    dirBuf.writeUInt16LE(1, base + 4);
    dirBuf.writeUInt16LE(32, base + 6);
    dirBuf.writeUInt32LE(e.dataSize, base + 8);
    dirBuf.writeUInt32LE(e.offset, base + 12);
  }

  const ico = Buffer.concat([header, dirBuf, ...entries.map(e => e.data)]);
  writeFileSync(OUTPUT, ico);
  console.log(`✅ ICO 已生成: ${OUTPUT} (${SIZES.length} 种尺寸, ${(ico.length / 1024).toFixed(0)} KB)`);
}

main().catch(err => { console.error(err.message); process.exit(1); });

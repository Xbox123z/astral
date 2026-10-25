// 视觉预览：输出纯文本形状（写入文件，避免管道吞掉 ANSI 造成误判）
import { writeFileSync } from 'node:fs';
import { jupiter, saturn, renderPlanet } from '../dist/render/planet.js';
import { bootFrame, bigText } from '../dist/render/logo.js';
import { starfield } from '../dist/render/starfield.js';

const arg = process.argv[2] ?? 'all';
const out = [];
function show(title, frame) {
  out.push(`=== ${title} (${frame.width}x${frame.height}) ===`);
  out.push(frame.toPlain());
}

if (arg === 'all' || arg === 'jupiter') show('JUPITER', jupiter({ diameter: 60, spin: 0.12 }));
if (arg === 'all' || arg === 'saturn') show('SATURN', saturn({ diameter: 44, spin: 0.3 }));
if (arg === 'all' || arg === 'mars') show('MARS', renderPlanet('mars', { diameter: 40 }));
if (arg === 'all' || arg === 'earth') show('EARTH', renderPlanet('earth', { diameter: 40 }));
if (arg === 'all' || arg === 'logo') show('LOGO', bigText('ASTRAL'));
if (arg === 'all' || arg === 'boot') show('BOOT-1', bootFrame({ width: 96, height: 30, progress: 1.0 }));
if (arg === 'all' || arg === 'stars') show('STARFIELD', starfield({ width: 96, height: 18, t: 1 }));

const text = out.join('\n');
writeFileSync('preview.txt', text, 'utf8');
console.log('written preview.txt, bytes=' + Buffer.byteLength(text));

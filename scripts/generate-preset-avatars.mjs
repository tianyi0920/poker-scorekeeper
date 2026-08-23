import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const sharp = requireFromApi('sharp');
const seeds = ['Amber', 'Coco', 'Daisy', 'Emery', 'Felix', 'Ginger',
  'Hazel', 'Jasper', 'Kiki', 'Luna', 'Milo', 'Nova'];
const outputDir = path.resolve('apps/web/public/avatars');
await mkdir(outputDir, { recursive: true });

for (const [offset, seed] of seeds.entries()) {
  const id = `preset-${String(offset + 13).padStart(2, '0')}`;
  const url = new URL('https://api.dicebear.com/10.x/lorelei/svg');
  url.searchParams.set('seed', seed);
  for (const color of ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf']) {
    url.searchParams.append('backgroundColor', color);
  }
  const response = await fetch(url, { headers: { 'User-Agent': 'poker-scorekeeper-avatar-generator' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const svg = Buffer.from(await response.arrayBuffer());
  await sharp(svg).resize(256, 256, { fit: 'cover' }).webp({ quality: 88 })
    .toFile(path.join(outputDir, `${id}.webp`));
}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';

const root = path.resolve('desktop');
const tools = path.join(root, 'tools');
await fs.mkdir(tools, { recursive: true });
const headers = { 'User-Agent': 'Spotitube-desktop-build', Accept: 'application/vnd.github+json' };
async function get(url) { const response = await fetch(url, { headers }); if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`); return response; }
let versions;
try { versions = JSON.parse(await fs.readFile(path.join(tools, 'versions.json'), 'utf8')); } catch {}
if (!versions || !await fs.stat(path.join(tools, 'yt-dlp.exe')).catch(() => null)) {
  const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  const asset = release.assets.find(asset => asset.name === 'yt-dlp.exe');
  const sums = await (await get(release.assets.find(asset => asset.name === 'SHA2-256SUMS').browser_download_url)).text();
  const expected = sums.split('\n').find(line => /\s\*?yt-dlp\.exe\r?$/.test(line))?.split(/\s/)[0];
  const binary = Buffer.from(await (await get(asset.browser_download_url)).arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
  if (!expected || sha256 !== expected) throw new Error('yt-dlp checksum verification failed.');
  await fs.writeFile(path.join(tools, 'yt-dlp.exe'), binary);
  await fs.writeFile(path.join(tools, 'yt-dlp-LICENSE.txt'), await (await get(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/LICENSE`)).text());
  versions = { ytDlp: release.tag_name, ytDlpSha256: sha256 };
}
const nodeBinary = await fs.readFile(process.execPath);
await fs.writeFile(path.join(tools, 'node.exe'), nodeBinary);
versions.node = process.version;
versions.nodeSha256 = crypto.createHash('sha256').update(nodeBinary).digest('hex');
await fs.writeFile(path.join(tools, 'node-LICENSE.txt'), await (await get(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`)).text());
await fs.writeFile(path.join(tools, 'versions.json'), JSON.stringify(versions, null, 2));

// Render the existing Android vector mark into Windows icon sizes; no new branding.
function crc(data) { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const bytes = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([bytes, data]))); return Buffer.concat([len, bytes, data, checksum]); }
const size = 256, rows = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const pixel = [0, 0, 0];
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const px = (x + (sx + .5) / 4) / size * 108, py = (y + (sy + .5) / 4) / size * 108;
    const circle = (px - 54) ** 2 + (py - 54) ** 2 <= 40 ** 2;
    const triangle = px >= 44 && px <= 74 && Math.abs(py - 54) <= (74 - px) * .65;
    const color = circle && !triangle ? [30, 215, 96] : [16, 23, 20];
    color.forEach((v, n) => pixel[n] += v / 16);
  }
  const at = y * (size * 4 + 1) + 1 + x * 4; pixel.forEach((v, n) => rows[at + n] = Math.round(v)); rows[at + 3] = 255;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
await fs.writeFile(path.join(root, 'icon.png'), png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await fs.writeFile(path.join(root, 'icon.ico'), Buffer.concat([ico, png]));
console.log('Desktop tools verified:', versions.ytDlp, versions.node);

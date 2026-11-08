import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

// Run only after installer verification. Publish the immutable binary first,
// verify GitHub's digest, then update the feed as the final publication step.
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable desktop version');
const version = pkg.version, tag = `desktop-v${version}`, name = `Spotitube-Setup-${version}.exe`;
const file = path.resolve('desktop-release', name);
const binary = await fs.readFile(file);
const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
const sha512 = crypto.createHash('sha512').update(binary).digest('base64');
const info = yaml.load(await fs.readFile('desktop-release/latest.yml', 'utf8'));
if (info.version !== version || info.files[0].sha512 !== sha512 || info.files[0].size !== binary.length) throw new Error('Build metadata does not match installer');
const notes = process.argv[2];
if (!notes) throw new Error('Pass a release-notes file');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let exists = false; try { gh(['release', 'view', tag, '--repo', 'just-crow/Spotitube']); exists = true; } catch {}
if (!exists) gh(['release', 'create', tag, file, file + '.blockmap', '--repo', 'just-crow/Spotitube', '--target', commit, '--title', `Spotitube Desktop ${version}`, '--notes-file', notes, '--latest=false']);
const release = JSON.parse(gh(['release', 'view', tag, '--repo', 'just-crow/Spotitube', '--json', 'assets']));
const asset = release.assets.find(a => a.name === name);
if (asset?.digest !== `sha256:${sha256}`) throw new Error('Published installer missing or checksum mismatch; update feed was not changed');
info.files[0].url = asset.url;
info.path = asset.url;
info.sha512 = sha512;
await fs.mkdir('docs/desktop', { recursive: true });
await fs.writeFile('docs/desktop/latest.yml', yaml.dump(info, { lineWidth: -1 }));
console.log(`Verified ${name}. Feed written to docs/desktop/latest.yml; commit and push it to enable automatic updates.`);

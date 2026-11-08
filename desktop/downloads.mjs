import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validId } from './catalog.mjs';

export class Downloads {
  constructor(directory, catalog, changed, fetcher = fetch) {
    this.directory = directory; this.catalog = catalog; this.changed = changed; this.fetcher = fetcher; this.jobs = []; this.active = new Map(); this.stopping = false;
    fs.mkdirSync(directory, { recursive: true });
    this.manifest = path.join(directory, 'queue.json');
    try { this.jobs = JSON.parse(fs.readFileSync(this.manifest, 'utf8')).filter(j => validId(j.id)); } catch {}
    for (const job of this.jobs) {
      if (['preparing', 'downloading'].includes(job.status)) { job.status = 'queued'; job.received = 0; }
      if (job.status === 'completed' && (!fs.existsSync(this.file(job.id)) || fs.statSync(this.file(job.id)).size !== job.received || !job.received)) { job.status = 'failed'; job.error = 'Downloaded file is missing or incomplete.'; }
      fs.rmSync(this.file(job.id) + '.part', { force: true });
    }
    this.save();
  }
  file(id) { if (!validId(id)) throw new Error('Invalid video.'); return path.join(this.directory, id + '.audio'); }
  snapshot() { return this.jobs.map(j => ({ ...j })); }
  completed() { return this.jobs.filter(j => j.status === 'completed').map(j => ({ ...j, size: j.received })); }
  local(id) { return this.jobs.some(j => j.id === id && j.status === 'completed') && fs.existsSync(this.file(id)) ? this.file(id) : null; }
  mime(id) { return this.jobs.find(j => j.id === id)?.mime || 'application/octet-stream'; }
  save() {
    fs.writeFileSync(this.manifest + '.tmp', JSON.stringify(this.jobs)); fs.renameSync(this.manifest + '.tmp', this.manifest);
    this.changed?.(this.snapshot());
  }
  enqueue(item) {
    if (!validId(item?.id)) throw new Error('Invalid video.');
    if (this.jobs.some(j => j.id === item.id)) return;
    this.jobs.push({ id: item.id, title: String(item.title || '').slice(0, 500), author_name: String(item.artist || '').slice(0, 300), thumbnail_url: String(item.thumb || '').slice(0, 2000), status: 'queued', received: 0, total: 0, at: Date.now() });
    this.save(); this.pump();
  }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id); if (!job || job.status === 'completed') return;
    job.status = 'canceled'; this.active.get(id)?.abort(); this.save();
  }
  retry(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !['failed', 'canceled'].includes(job.status) || this.active.has(id)) return;
    Object.assign(job, { status: 'queued', received: 0, total: 0, error: '' }); this.save(); this.pump();
  }
  remove(id) {
    if (this.active.has(id)) { this.cancel(id); return; }
    fs.rmSync(this.file(id), { force: true }); fs.rmSync(this.file(id) + '.part', { force: true });
    this.jobs = this.jobs.filter(j => j.id !== id); this.save();
  }
  pump() {
    if (this.stopping) return;
    while (this.active.size < 3) {
      const job = this.jobs.find(j => j.status === 'queued'); if (!job) break;
      const controller = new AbortController(); this.active.set(job.id, controller);
      job.status = 'preparing'; this.save();
      this.run(job, controller.signal).finally(() => { this.active.delete(job.id); this.pump(); });
    }
  }
  async run(job, signal) {
    const partial = this.file(job.id) + '.part';
    try {
      const stream = await this.catalog.resolve(job.id, true, signal);
      const response = await this.fetcher(stream.url, { headers: stream.headers, signal });
      if (!response.ok || !response.body || !/^(audio|video|application\/octet-stream)/i.test(response.headers.get('content-type') || '')) throw new Error('The audio server rejected this download.');
      job.status = 'downloading'; job.total = Number(response.headers.get('content-length')) || 0; job.received = 0; this.save();
      job.mime = response.headers.get('content-type');
      let last = 0;
      const body = Readable.fromWeb(response.body);
      body.on('data', chunk => { job.received += chunk.length; if (Date.now() - last > 400) { last = Date.now(); this.changed?.(this.snapshot()); } });
      await pipeline(body, fs.createWriteStream(partial), { signal });
      if (!job.received || (job.total && job.received !== job.total)) throw new Error('The download was incomplete. Please retry.');
      if (signal.aborted) throw new Error('Canceled');
      fs.renameSync(partial, this.file(job.id)); job.status = 'completed';
    } catch (error) {
      job.status = signal.aborted ? (this.stopping ? 'queued' : 'canceled') : 'failed';
      job.error = signal.aborted ? '' : error.message; fs.rmSync(partial, { force: true });
    } finally { this.save(); }
  }
  close() { this.stopping = true; for (const controller of this.active.values()) controller.abort(); }
}

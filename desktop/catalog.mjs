import { execFile } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);
export const video = item => ({
  id: item.id, title: item.title || 'Untitled', author_name: item.channel || item.uploader || '',
  thumbnail_url: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
  duration: Math.max(0, Number(item.duration) || 0), channel_url: item.channel_url || item.uploader_url,
});

export class Catalog {
  constructor(tools, { fetcher = fetch, activationDelayMs = 3100 } = {}) { this.tools = tools; this.streams = new Map(); this.pending = new Map(); this.children = new Set(); this.details = new Map(); this.fetcher = fetcher; this.activationDelayMs = activationDelayMs; }
  run(args, { signal, timeout = 65000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(path.join(this.tools, 'yt-dlp.exe'), [
        '--ignore-config', '--no-warnings', '--no-colors', '--socket-timeout', '15', '--retries', '2',
        '--js-runtimes', `node:${path.join(this.tools, 'node.exe')}`, ...args,
      ], { windowsHide: true, timeout, signal, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        this.children.delete(child);
        if (error) reject(new Error(signal?.aborted ? 'Canceled' : error.killed ? 'YouTube request timed out.' : 'YouTube could not process this request. The video may be unavailable or the connection interrupted.'));
        else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('YouTube returned an incomplete response.')); } }
      });
      this.children.add(child);
    });
  }
  async metadata(id) {
    if (!validId(id)) throw new Error('Invalid video link.');
    if (this.details.has(id)) return this.details.get(id);
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('This video is private, unavailable or removed.');
    const data = await response.json();
    const result = { id, title: data.title, author_name: data.author_name || '', thumbnail_url: data.thumbnail_url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, channel_url: data.author_url };
    if (!result.title) throw new Error('YouTube returned incomplete video details.');
    this.details.set(id, result);
    if (this.details.size > 300) this.details.delete(this.details.keys().next().value);
    return result;
  }
  async search(query, musicOnly = true) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Enter a song or artist (up to 200 characters).');
    // Music search, rather than the all-videos catalog, keeps interviews and tutorials out.
    const target = musicOnly
      ? `https://music.youtube.com/search?q=${encodeURIComponent(query)}&sp=EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D`
      : `ytsearch20:${query}`;
    const result = await this.run(['--flat-playlist', '--playlist-end', '20', '--dump-single-json', '--', target]);
    const videos = (result.entries || []).filter(item => validId(item.id)).map(video);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, videos.length) }, async () => {
      while (next < videos.length) {
        const at = next++;
        if (!videos[at].author_name) { try { videos[at] = { ...videos[at], ...await this.metadata(videos[at].id) }; } catch {} }
      }
    }));
    return videos;
  }
  async playlist(id) {
    if (typeof id !== 'string' || !/^[\w-]{10,100}$/.test(id)) throw new Error('Invalid playlist link.');
    const data = await this.run(['--flat-playlist', '--dump-single-json', '--', `https://www.youtube.com/playlist?list=${id}`], { timeout: 180000 });
    if (!Array.isArray(data.entries) || data.entries.some(item => !item || !validId(item.id))) throw new Error('The complete playlist could not be loaded. Your saved copy has been kept.');
    return { name: data.title || 'YouTube playlist', videos: data.entries.map(video) };
  }
  async artist(url) {
    if (typeof url !== 'string' || !/^https:\/\/(www\.)?youtube\.com\/(channel\/[\w-]+|@[\w.%\-]+)\/?$/.test(url)) throw new Error('Invalid artist channel.');
    const data = await this.run(['--flat-playlist', '--playlist-end', '30', '--dump-single-json', '--', url.replace(/\/$/, '') + '/videos']);
    return { name: data.channel || data.uploader || data.title, description: data.description || '', avatar_url: '', channel_url: url, uploads: (data.entries || []).filter(item => validId(item.id)).map(video), playlists: [] };
  }
  async resolve(id, refresh = false, signal) {
    if (!validId(id)) throw new Error('Invalid video.');
    if (refresh) this.streams.delete(id);
    const cached = this.streams.get(id);
    if (cached && cached.until > Date.now()) return cached;
    if (!refresh && !signal && this.pending.has(id)) return this.pending.get(id);
    const started = Date.now();
    const promise = this.run(['--socket-timeout', '8', '--retries', '0', '--no-playlist', '-f', 'bestaudio[protocol=https]/bestaudio', '--dump-single-json', '--', `https://www.youtube.com/watch?v=${id}`], { signal, timeout: 20000 }).then(async data => {
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || !(url.hostname.endsWith('.googlevideo.com'))) throw new Error('No supported audio stream is available.');
      // YouTube requires a short wait before a newly generated media URL is usable.
      // Retrying extraction immediately creates another not-yet-ready URL.
      await delay(this.activationDelayMs, undefined, { signal });
      let ready = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const probeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
        const response = await this.fetcher(url.href, { headers: { ...data.http_headers, Range: 'bytes=0-1023' }, signal: probeSignal });
        ready = (response.status === 200 || response.status === 206) && /^(audio|video|application\/octet-stream)/i.test(response.headers.get('content-type') || '');
        await response.body?.cancel();
        if (ready) break;
        if (attempt === 0 && [403, 429, 503].includes(response.status)) await delay(1200, undefined, { signal });
        else throw new Error(`The audio server rejected this stream (${response.status}).`);
      }
      if (!ready) throw new Error('The audio stream is not ready. Please retry.');
      signal?.throwIfAborted();
      const stream = { url: url.href, headers: data.http_headers || {}, format: `${data.acodec || 'audio'} · ${Math.round(data.abr || 0)} kbps`, until: Math.min(Date.now() + 5 * 60000, (Number(url.searchParams.get('expire')) || Infinity) * 1000 - 60000), prepareMs: Date.now() - started };
      this.streams.set(id, stream);
      return stream;
    });
    if (!signal) this.pending.set(id, promise);
    try { return await promise; } finally { if (this.pending.get(id) === promise) this.pending.delete(id); }
  }
  close() { for (const child of this.children) child.kill(); }
}

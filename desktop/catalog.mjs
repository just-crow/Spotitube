import { execFile } from 'node:child_process';
import path from 'node:path';

export const validId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);
export const video = item => ({
  id: item.id, title: item.title || 'Untitled', author_name: item.channel || item.uploader || '',
  thumbnail_url: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
  duration: Math.max(0, Number(item.duration) || 0), channel_url: item.channel_url || item.uploader_url,
});

export class Catalog {
  constructor(tools) { this.tools = tools; this.streams = new Map(); this.pending = new Map(); this.children = new Set(); this.details = new Map(); }
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
    const promise = this.run(['--no-playlist', '-f', 'bestaudio[protocol=https]/bestaudio', '--dump-single-json', '--', `https://www.youtube.com/watch?v=${id}`], { signal }).then(data => {
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || !(url.hostname.endsWith('.googlevideo.com'))) throw new Error('No supported audio stream is available.');
      const stream = { url: url.href, headers: data.http_headers || {}, format: `${data.acodec || 'audio'} · ${Math.round(data.abr || 0)} kbps`, until: Date.now() + 5 * 60000 };
      this.streams.set(id, stream);
      return stream;
    });
    if (!signal) this.pending.set(id, promise);
    try { return await promise; } finally { if (this.pending.get(id) === promise) this.pending.delete(id); }
  }
  close() { for (const child of this.children) child.kill(); }
}

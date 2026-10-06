// MediaFire Folder Grabber - no dependencies, needs Node 18+
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_DEST = path.join(os.homedir(), 'Downloads', 'MediaFire');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function folderKeyFromUrl(u) {
  const m = String(u).match(/mediafire\.com\/(?:folder|\?)\/?([a-z0-9]+)/i);
  return m ? m[1] : null;
}

async function api(endpoint, params) {
  const qs = new URLSearchParams({ ...params, response_format: 'json' });
  const r = await fetch(`https://www.mediafire.com/api/1.5/${endpoint}?${qs}`, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  if (!j.response || j.response.result !== 'Success') {
    throw new Error((j.response && j.response.message) || 'MediaFire API error');
  }
  return j.response;
}

async function listFolder(key, prefix, out) {
  // files (paged)
  for (let chunk = 1; ; chunk++) {
    const res = await api('folder/get_content.php', { folder_key: key, content_type: 'files', chunk, chunk_size: 1000 });
    const files = res.folder_content.files || [];
    for (const f of files) {
      out.push({
        name: f.filename,
        path: prefix + f.filename,
        size: Number(f.size || 0),
        link: f.links && f.links.normal_download,
      });
    }
    if (res.folder_content.more_chunks !== 'yes') break;
  }
  // subfolders
  for (let chunk = 1; ; chunk++) {
    const res = await api('folder/get_content.php', { folder_key: key, content_type: 'folders', chunk, chunk_size: 1000 });
    const folders = res.folder_content.folders || [];
    for (const d of folders) await listFolder(d.folderkey, prefix + d.name + '/', out);
    if (res.folder_content.more_chunks !== 'yes') break;
  }
}

async function directLink(pageUrl) {
  const u = new URL(pageUrl);
  if (!/(^|\.)mediafire\.com$/i.test(u.hostname)) throw new Error('Only mediafire.com links are allowed');
  const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return { url: r.url, res: r }; // already a file
  const html = await r.text();
  const m = html.match(/id="downloadButton"[^>]*href="([^"]+)"/i) ||
            html.match(/href="(https?:\/\/download[^"]+mediafire\.com[^"]+)"/i) ||
            html.match(/aria-label="Download file"[^>]*href="([^"]+)"/i);
  if (!m) throw new Error('Direct link not found (file may be removed or password protected)');
  return { url: m[1].replace(/&amp;/g, '&') };
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/list') {
      const key = folderKeyFromUrl(url.searchParams.get('url') || '');
      if (!key) return send(res, 400, { error: 'Could not find a folder key in that link. Use a link like https://www.mediafire.com/folder/abc123xyz/Name' });
      const info = await api('folder/get_info.php', { folder_key: key });
      const files = [];
      await listFolder(key, '', files);
      return send(res, 200, { name: info.folder_info.name, files });
    }

    if (url.pathname === '/api/download') {
      const page = url.searchParams.get('link');
      const name = url.searchParams.get('name') || 'file';
      const { url: direct } = await directLink(page);
      const upstream = await fetch(direct, { headers: { 'User-Agent': UA } });
      if (!upstream.ok) throw new Error('Upstream returned ' + upstream.status);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      };
      const len = upstream.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      res.writeHead(200, headers);
      const reader = upstream.body.getReader();
      req.on('close', () => reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise(r => res.once('drain', r));
      }
      return res.end();
    }

    if (url.pathname === '/api/defaultdest') {
      return send(res, 200, { dest: DEFAULT_DEST });
    }

    // Save a file straight to disk on this computer (no browser save prompt)
    if (url.pathname === '/api/save' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      let dest = String(body.dest || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
      const base = path.resolve(dest || DEFAULT_DEST);
      const rel = String(body.relpath || body.name || 'file')
        .split(/[\\/]+/)
        .map(s => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim())
        .filter(s => s && s !== '.' && s !== '..');
      if (!rel.length) throw new Error('Bad file name');
      const target = path.join(base, ...rel);
      if (!target.startsWith(base + path.sep)) throw new Error('Bad file path');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const { url: direct } = await directLink(body.link);
      const upstream = await fetch(direct, { headers: { 'User-Agent': UA } });
      if (!upstream.ok) throw new Error('Upstream returned ' + upstream.status);
      try {
        await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(target));
      } catch (e) {
        fs.rmSync(target, { force: true });
        throw e;
      }
      return send(res, 200, { ok: true, path: target });
    }

    // static UI
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`MediaFire Grabber running at http://localhost:${PORT}`));

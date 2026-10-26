// @ts-check
/**
 * Dev + preview server plugin: READ-ONLY, localhost-only access to local files the browser
 * cannot open by itself (CapCut drafts and the media they point at).
 *
 *   GET /__local/capcut/projects          → [{ id, name, duration, modified, cover }]
 *   GET /__local/capcut/project?id=<dir>  → { id, folder, name, draft, resolved: { raw → abs | null } }
 *   GET /__local/file?path=<abs>          → the file, with HTTP Range support
 *   GET  /__local/inbox                   → pending requests [{ id, project, aspect, files, place? }]
 *   POST /__local/inbox/done?id=<id>      → body = result JSON; moves the request to inbox/done/
 *
 * Only paths under ~/Movies/CapCut and ~/Desktop/ai/ are served (after resolving symlinks); every
 * other path is 403. Only GET / HEAD, except the inbox ack; the only thing written is in
 * ~/.our-editor/inbox/<server port>/ (requests dropped there by scripts/add-media.sh).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
export const CAPCUT_ROOT = path.join(HOME, 'Movies/CapCut/User Data/Projects/com.lveditor.draft');
export const ALLOWED_ROOTS = [path.join(HOME, 'Movies/CapCut'), path.join(HOME, 'Desktop/ai')];

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', json: 'application/json',
};

/** True when `p` (absolute) lies inside one of the allowed roots, symlinks resolved. */
export function isAllowedPath(p, roots = ALLOWED_ROOTS) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return false;
  let real;
  try {
    real = fs.realpathSync(path.resolve(p));
  } catch {
    return false;
  }
  return roots.some((r) => {
    let rr;
    try {
      rr = fs.realpathSync(r);
    } catch {
      rr = r;
    }
    return real === rr || real.startsWith(rr + path.sep);
  });
}

export const INBOX = path.join(HOME, '.our-editor/inbox');

/**
 * One inbox per server port (~/.our-editor/inbox/5173/): a request for the user's editor is never
 * picked up by another editor server on this Mac (e2e runs, agents' worktrees on other ports).
 */
function inboxDir(req) {
  const port = /:(\d+)$/.exec(String(req.headers.host ?? ''))?.[1] ?? '80';
  return path.join(INBOX, port);
}

function listInbox(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = readJson(path.join(dir, f));
      const files = Array.isArray(r.files) ? r.files.filter((p) => typeof p === 'string') : [];
      out.push({ id: f.slice(0, -5), project: typeof r.project === 'string' ? r.project : '', aspect: r.aspect ?? null, files, ...(Array.isArray(r.place) ? { place: r.place } : {}) });
    } catch {
      /* half-written or broken: picked up on a later poll, or ignored */
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

async function ackInbox(req, res, id) {
  if (!validId(id)) return send(res, 400, { error: 'bad id' });
  const dir = inboxDir(req);
  const src = path.join(dir, `${id}.json`);
  if (!fs.existsSync(src)) return send(res, 404, { error: 'no such request' });
  let result = {};
  try {
    result = JSON.parse((await readBody(req)) || '{}');
  } catch {
    /* keep the request even if the result is unreadable */
  }
  const done = path.join(dir, 'done');
  fs.mkdirSync(done, { recursive: true });
  const request = readJson(src);
  fs.writeFileSync(path.join(done, `${id}.json`), JSON.stringify({ request, result, doneAt: new Date().toISOString() }, null, 2));
  fs.unlinkSync(src);
  return send(res, 200, { ok: true });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocal(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK.has(req.socket?.remoteAddress ?? '') && ['localhost', '127.0.0.1', '::1'].includes(host);
}

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const validId = (id) => typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\0') && id !== '.' && id !== '..';
const fileUrl = (p) => `/__local/file?path=${encodeURIComponent(p)}`;

function listProjects() {
  const out = [];
  for (const id of fs.readdirSync(CAPCUT_ROOT)) {
    const dir = path.join(CAPCUT_ROOT, id);
    const meta = path.join(dir, 'draft_meta_info.json');
    if (!fs.existsSync(meta)) continue;
    try {
      const m = readJson(meta);
      const cover = path.join(dir, 'draft_cover.jpg');
      out.push({
        id,
        name: m.draft_name || id,
        duration: Number(m.tm_duration) || 0,
        modified: Math.round((Number(m.tm_draft_modified) || 0) / 1000),
        cover: fs.existsSync(cover) ? fileUrl(cover) : null,
      });
    } catch {
      /* unreadable meta: skip */
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Every media path written in a draft (recursing into embedded compound drafts). */
function collectPaths(o, acc = new Set()) {
  if (Array.isArray(o)) for (const x of o) collectPaths(x, acc);
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'path' || k === 'image') && typeof v === 'string' && v) acc.add(v);
      else if (typeof v === 'object') collectPaths(v, acc);
    }
  }
  return acc;
}

export function resolveDraftPath(raw, folder) {
  if (!raw) return null;
  const p = raw.replace(/^##_draftpath_placeholder_[0-9A-Fa-f-]+_##/, folder);
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  const local = path.join(folder, path.basename(p));
  return fs.existsSync(local) ? local : null;
}

function loadProject(id) {
  const folder = path.join(CAPCUT_ROOT, id);
  const info = path.join(folder, 'draft_info.json');
  const text = fs.readFileSync(info, 'utf8');
  if (!text.trimStart().startsWith('{')) throw new Error('draft_info.json is encrypted or not JSON (newer CapCut drafts cannot be read)');
  const draft = JSON.parse(text);
  let name = id;
  try {
    name = readJson(path.join(folder, 'draft_meta_info.json')).draft_name || id;
  } catch {
    /* ignore */
  }
  const resolved = {};
  for (const raw of collectPaths({ tracks: draft.tracks, materials: draft.materials })) resolved[raw] = resolveDraftPath(raw, folder);
  return { id, folder, name, draft, resolved };
}

function serveFile(req, res, p) {
  const st = fs.statSync(p);
  if (!st.isFile()) return send(res, 404, { error: 'not a file' });
  const ext = path.extname(p).slice(1).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Last-Modified', st.mtime.toUTCString());
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = st.size - 1;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    } else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  } else res.statusCode = 200;
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function middleware(req, res, next) {
  const url = req.url ?? '';
  if (!url.startsWith('/__local/')) return next();
  if (!isLocal(req)) return send(res, 403, { error: 'localhost only' });
  const u = new URL(url, 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/__local/inbox/done') {
    return void ackInbox(req, res, u.searchParams.get('id')).catch((e) => send(res, 500, { error: String(e) }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read-only' });
  try {
    if (u.pathname === '/__local/inbox') return send(res, 200, listInbox(inboxDir(req)));
    if (u.pathname === '/__local/capcut/projects') return send(res, 200, listProjects());
    if (u.pathname === '/__local/capcut/project') {
      const id = u.searchParams.get('id');
      if (!validId(id)) return send(res, 400, { error: 'bad id' });
      if (!fs.existsSync(path.join(CAPCUT_ROOT, id, 'draft_info.json'))) return send(res, 404, { error: `no CapCut draft "${id}"` });
      return send(res, 200, loadProject(id));
    }
    if (u.pathname === '/__local/file') {
      const p = u.searchParams.get('path') ?? '';
      if (!isAllowedPath(p)) return send(res, 403, { error: 'path not allowed' });
      return serveFile(req, res, p);
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** @returns {import('vite').Plugin} */
export function localFiles() {
  return {
    name: 'our-editor-local-files',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

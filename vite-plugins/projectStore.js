// @ts-check
/**
 * Dev + preview server plugin: the on-disk project library. The browser keeps working in IndexedDB
 * (fast, offline); every save is mirrored here, so the home screen shows every project in any
 * Chrome profile or browser on this machine (src/store/diskSync.ts). localhost only.
 *
 *   ~/.our-editor/library/projects/<id>.json   Project JSON
 *   ~/.our-editor/library/views/<id>.json      ProjectView (playhead, zoom, cover)
 *   ~/.our-editor/library/blobs/<key>          media blob (written once)
 *   ~/.our-editor/library/deleted/<id>.json    tombstone: deleted in some browser, delete everywhere
 *
 *   GET    /__store/projects            → { projects: Project[], views: {id: view}, deleted: {id: ms} }
 *   PUT    /__store/project?id=          body = Project JSON (kept only when newer: updatedAt)
 *   DELETE /__store/project?id=          → moves it to deleted/ (recoverable) + tombstone
 *   PUT    /__store/view?id=             body = ProjectView JSON
 *   HEAD   /__store/blob?key=            200 / 204 (not there — no 404: Chrome logs those as console errors)
 *   GET    /__store/blob?key=            the blob / 204
 *   PUT    /__store/blob?key=            body = the blob (streamed; ignored when it exists)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** OUR_EDITOR_LIBRARY overrides it (the e2e server uses a temp folder). */
export const LIBRARY = process.env.OUR_EDITOR_LIBRARY || path.join(os.homedir(), '.our-editor/library');
/** OUR_EDITOR_LIBRARY_OPT_IN=1: only requests with the `oe-library=1` cookie see the library. */
const OPT_IN = process.env.OUR_EDITOR_LIBRARY_OPT_IN === '1';
const dir = (name) => {
  const d = path.join(LIBRARY, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocal(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK.has(req.socket?.remoteAddress ?? '') && ['localhost', '127.0.0.1', '::1'].includes(host);
}
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Writes atomically (temp file + rename): a crash never leaves half a project. */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function listLibrary() {
  const projects = [];
  const views = {};
  const deleted = {};
  for (const f of fs.readdirSync(dir('projects'))) {
    if (!f.endsWith('.json')) continue;
    try {
      projects.push(readJson(path.join(dir('projects'), f)));
    } catch {
      /* unreadable: skipped */
    }
  }
  for (const f of fs.readdirSync(dir('views'))) {
    if (!f.endsWith('.json')) continue;
    try {
      views[f.slice(0, -5)] = readJson(path.join(dir('views'), f));
    } catch {
      /* ignore */
    }
  }
  for (const f of fs.readdirSync(dir('deleted'))) {
    if (!f.endsWith('.tomb')) continue;
    deleted[f.slice(0, -5)] = Number(fs.readFileSync(path.join(dir('deleted'), f), 'utf8')) || 0;
  }
  return { projects, views, deleted };
}

async function putProject(req, res, id) {
  const body = (await readBody(req)).toString('utf8');
  const p = JSON.parse(body);
  if (p?.id !== id) return send(res, 400, { error: 'id mismatch' });
  const file = path.join(dir('projects'), `${id}.json`);
  if (fs.existsSync(file)) {
    try {
      if ((readJson(file).updatedAt ?? 0) > (p.updatedAt ?? 0)) return send(res, 200, { ok: true, kept: 'newer on disk' });
    } catch {
      /* overwrite an unreadable file */
    }
  }
  // saved again after a delete (undo in another tab, or re-created): it is alive
  fs.rmSync(path.join(dir('deleted'), `${id}.tomb`), { force: true });
  writeAtomic(file, body);
  return send(res, 200, { ok: true });
}

function deleteProject(res, id) {
  const file = path.join(dir('projects'), `${id}.json`);
  if (fs.existsSync(file)) fs.renameSync(file, path.join(dir('deleted'), `${id}.json`));
  fs.rmSync(path.join(dir('views'), `${id}.json`), { force: true });
  writeAtomic(path.join(dir('deleted'), `${id}.tomb`), String(Date.now()));
  return send(res, 200, { ok: true });
}

async function putBlob(req, res, key) {
  const file = path.join(dir('blobs'), key);
  if (fs.existsSync(file)) {
    req.resume();
    return send(res, 200, { ok: true, existed: true });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  fs.renameSync(tmp, file);
  return send(res, 200, { ok: true });
}

function getBlob(req, res, key) {
  const file = path.join(dir('blobs'), key);
  if (!fs.existsSync(file)) {
    res.statusCode = 204;
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  const st = fs.statSync(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function middleware(req, res, next) {
  const url = req.url ?? '';
  if (!url.startsWith('/__store/')) return next();
  if (!isLocal(req)) return send(res, 403, { error: 'localhost only' });
  // e2e: the library is opt-in per browser context (cookie), so tests stay isolated by default
  if (OPT_IN && !/(?:^|;\s*)oe-library=1(?:;|$)/.test(String(req.headers.cookie ?? ''))) return send(res, 200, { off: true });
  const u = new URL(url, 'http://localhost');
  const m = req.method;
  try {
    if (u.pathname === '/__store/projects' && m === 'GET') return send(res, 200, listLibrary());
    const id = u.searchParams.get('id') ?? '';
    const key = u.searchParams.get('key') ?? '';
    if (u.pathname === '/__store/project') {
      if (!validId(id)) return send(res, 400, { error: 'bad id' });
      if (m === 'PUT') return await putProject(req, res, id);
      if (m === 'DELETE') return deleteProject(res, id);
    }
    if (u.pathname === '/__store/view' && m === 'PUT') {
      if (!validId(id)) return send(res, 400, { error: 'bad id' });
      writeAtomic(path.join(dir('views'), `${id}.json`), await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/__store/blob') {
      if (!validId(key)) return send(res, 400, { error: 'bad key' });
      if (m === 'PUT') return await putBlob(req, res, key);
      if (m === 'GET' || m === 'HEAD') return getBlob(req, res, key);
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** @returns {import('vite').Plugin} */
export function projectStore() {
  return {
    name: 'our-editor-project-store',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
}

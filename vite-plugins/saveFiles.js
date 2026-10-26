// @ts-check
/**
 * Dev + preview server plugin: saves files the editor makes (Export frame) straight into a folder
 * on this Mac. Chrome's folder picker refuses ~/Downloads, ~/Desktop and other "system" folders,
 * so the server writes the file and macOS's own Finder dialog picks the folder. localhost only.
 *
 *   GET  /__save/defaults                → { home, downloads }
 *   POST /__save/choose-folder?start=    → Finder "choose folder" → { path } | { cancelled: true }
 *   PUT  /__save/file?dir=<abs>&name=    body = the file → { name, path } (never overwrites: "x (2).png")
 *
 * Writes only inside the home folder; never overwrites.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DOWNLOADS = path.join(HOME, 'Downloads');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocal(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK.has(req.socket?.remoteAddress ?? '') && ['localhost', '127.0.0.1', '::1'].includes(host);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** An existing folder inside the home folder (symlinks resolved), or null. */
export function safeDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) return null;
  try {
    const real = fs.realpathSync(dir);
    const home = fs.realpathSync(HOME);
    if (real !== home && !real.startsWith(home + path.sep)) return null;
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** A plain file name (no folders, no control characters). */
export const safeName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !/[/\\\0]/.test(n) && n !== '.' && n !== '..' && !n.startsWith('.');

/** "x.png" → the first of "x.png", "x (2).png", … that does not exist. */
export function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const n = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
  return `${stem} ${Date.now()}${ext}`;
}

/** macOS "choose folder" (brought to the front). Resolves the POSIX path, or null when cancelled. */
function chooseFolder(start) {
  const from = safeDir(start) ?? DOWNLOADS;
  const script = [
    'activate',
    `set f to choose folder with prompt "Where should the frame be saved?" default location (POSIX file ${JSON.stringify(from)})`,
    'POSIX path of f',
  ];
  return new Promise((resolve) => {
    execFile('osascript', script.flatMap((l) => ['-e', l]), { timeout: 10 * 60_000 }, (err, stdout) => {
      if (err) return resolve(null); // cancelled (error -128) or no GUI
      const p = stdout.trim().replace(/\/$/, '');
      resolve(p || null);
    });
  });
}

async function writeFile(req, res, dirParam, nameParam) {
  const dir = safeDir(dirParam);
  if (!dir) return send(res, 400, { error: 'That folder does not exist or is outside your home folder' });
  if (!safeName(nameParam)) return send(res, 400, { error: 'Bad file name' });
  const name = freeName(dir, nameParam);
  const file = path.join(dir, name);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx' });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  return send(res, 200, { name, path: file });
}

async function middleware(req, res, next) {
  const url = req.url ?? '';
  if (!url.startsWith('/__save/')) return next();
  if (!isLocal(req)) return send(res, 403, { error: 'localhost only' });
  const u = new URL(url, 'http://localhost');
  try {
    if (u.pathname === '/__save/defaults' && req.method === 'GET') return send(res, 200, { home: HOME, downloads: DOWNLOADS });
    if (u.pathname === '/__save/choose-folder' && req.method === 'POST') {
      const p = await chooseFolder(u.searchParams.get('start') ?? '');
      return send(res, 200, p ? { path: p } : { cancelled: true });
    }
    if (u.pathname === '/__save/file' && req.method === 'PUT') return await writeFile(req, res, u.searchParams.get('dir'), u.searchParams.get('name'));
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** @returns {import('vite').Plugin} */
export function saveFiles() {
  return {
    name: 'our-editor-save-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
}

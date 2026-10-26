// @ts-check
/**
 * Dev + preview server plugin: speech-to-text for Captions › Auto captions, with whisper.cpp
 * running on this Mac (Metal). The editor renders the timeline's audio mix itself (the same mix
 * as the export), encodes it as 16 kHz mono WAV and posts it here; the job runs in the
 * background and the editor polls it. localhost only.
 *
 *   GET  /__transcribe/info                         → { available, cli, models: [{ id, file, dtw }], model }
 *   POST /__transcribe/start?lang=he|en|auto&model= body = WAV → { id }
 *   GET  /__transcribe/status?id=                   → { state, progress, language?, result?, error? }
 *   POST /__transcribe/cancel?id=                   → { ok }
 *
 * whisper-cli flags: -l <lang> -nfa -dtw <preset> -ojf -pp (full JSON with token timestamps and
 * DTW token alignment; DTW needs flash attention off). Word timing is derived from that JSON in
 * the browser (src/captions/whisper.ts). Env overrides: OUR_EDITOR_WHISPER_CLI,
 * OUR_EDITOR_WHISPER_MODELS (folder of ggml-*.bin).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CLI = process.env.OUR_EDITOR_WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
const MODELS_DIR = process.env.OUR_EDITOR_WHISPER_MODELS || path.join(os.homedir(), '.whisper-models');
const WORK = path.join(os.tmpdir(), 'our-editor-transcribe');
const MAX_BODY = 1024 * 1024 * 1024; // 1 GB of 16 kHz mono WAV ≈ 9 hours
const KEEP_MS = 30 * 60_000;

/** Preferred models, best first, with the DTW alignment-heads preset whisper.cpp knows them by. */
const MODEL_PRESETS = [
  ['large-v3-turbo', 'large.v3.turbo'],
  ['large-v3', 'large.v3'],
  ['large-v2', 'large.v2'],
  ['medium', 'medium'],
  ['medium.en', 'medium.en'],
  ['small', 'small'],
  ['small.en', 'small.en'],
  ['base', 'base'],
  ['base.en', 'base.en'],
  ['tiny', 'tiny'],
  ['tiny.en', 'tiny.en'],
];

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocal(req) {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK.has(req.socket?.remoteAddress ?? '') && ['localhost', '127.0.0.1', '::1'].includes(host);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Installed models, best first. */
export function listModels(dir = MODELS_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return MODEL_PRESETS.filter(([id]) => files.includes(`ggml-${id}.bin`)).map(([id, dtw]) => ({ id, file: path.join(dir, `ggml-${id}.bin`), dtw }));
}

export const LANGS = new Set(['auto', 'he', 'en', 'ar', 'ru', 'fr', 'es', 'de', 'it', 'pt', 'yi', 'ro']);

/** The whisper-cli arguments for one job (exported for the unit test). */
export function whisperArgs({ model, dtw, lang, wav, outBase, threads }) {
  const args = ['-m', model, '-f', wav, '-l', lang, '-ojf', '-of', outBase, '-pp', '-t', String(threads)];
  if (dtw) args.push('-nfa', '-dtw', dtw);
  return args;
}

/** @type {Map<string, { state: string, progress: number, child?: import('node:child_process').ChildProcess, dir: string, result?: unknown, error?: string, language?: string, at: number, log: string }>} */
const jobs = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && now - j.at > KEEP_MS) {
      fs.rm(j.dir, { recursive: true, force: true }, () => undefined);
      jobs.delete(id);
    }
  }
}

async function readBody(req, file) {
  await new Promise((resolve, reject) => {
    let n = 0;
    const out = fs.createWriteStream(file);
    req.on('data', (chunk) => {
      n += chunk.length;
      if (n > MAX_BODY) {
        req.destroy();
        out.destroy();
        reject(new Error('Audio too large'));
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
}

async function start(req, res, u) {
  sweep();
  const lang = u.searchParams.get('lang') || 'auto';
  if (!LANGS.has(lang)) return send(res, 400, { error: `Unknown language "${lang}"` });
  const models = listModels();
  const model = models.find((m) => m.id === u.searchParams.get('model')) ?? models[0];
  if (!fs.existsSync(CLI)) return send(res, 503, { error: `whisper-cli not found at ${CLI} (brew install whisper-cpp)` });
  if (!model) return send(res, 503, { error: `No whisper model in ${MODELS_DIR}` });
  const id = crypto.randomUUID();
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'audio.wav');
  await readBody(req, wav);
  const outBase = path.join(dir, 'out');
  const threads = Math.max(4, Math.min(8, os.cpus().length - 2));
  const job = { state: 'running', progress: 0, dir, at: Date.now(), log: '' };
  jobs.set(id, job);
  const child = spawn(CLI, whisperArgs({ model: model.file, dtw: model.dtw, lang, wav, outBase, threads }), { stdio: ['ignore', 'ignore', 'pipe'] });
  job.child = child;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => {
    job.log = (job.log + s).slice(-4000);
    for (const m of String(s).matchAll(/progress\s*=\s*(\d+)%/g)) job.progress = Math.max(job.progress, Number(m[1]) / 100);
    const lm = String(s).match(/auto-detected language:\s*(\w+)/);
    if (lm) job.language = lm[1];
  });
  child.on('error', (e) => {
    job.state = 'error';
    job.error = e.message;
    job.at = Date.now();
  });
  child.on('close', (code) => {
    job.child = undefined;
    job.at = Date.now();
    if (job.state === 'cancelled') return;
    if (code !== 0) {
      job.state = 'error';
      job.error = `whisper-cli exited with ${code}: ${job.log.split('\n').filter(Boolean).slice(-3).join(' | ')}`;
      return;
    }
    try {
      // tokens can hold half a UTF-8 letter; the decoder replaces those bytes (the segment text stays whole)
      const text = fs.readFileSync(`${outBase}.json`).toString('utf8');
      job.result = JSON.parse(text);
      job.state = 'done';
      job.progress = 1;
    } catch (e) {
      job.state = 'error';
      job.error = `Could not read whisper output: ${e instanceof Error ? e.message : e}`;
    }
    fs.rm(wav, { force: true }, () => undefined);
  });
  return send(res, 200, { id, model: model.id });
}

async function middleware(req, res, next) {
  const url = req.url ?? '';
  if (!url.startsWith('/__transcribe/')) return next();
  if (!isLocal(req)) return send(res, 403, { error: 'localhost only' });
  const u = new URL(url, 'http://localhost');
  try {
    if (u.pathname === '/__transcribe/info' && req.method === 'GET') {
      const models = listModels();
      return send(res, 200, { available: fs.existsSync(CLI) && models.length > 0, cli: CLI, models: models.map(({ id, dtw }) => ({ id, dtw })), model: models[0]?.id ?? null });
    }
    if (u.pathname === '/__transcribe/start' && req.method === 'POST') return await start(req, res, u);
    const job = jobs.get(u.searchParams.get('id') ?? '');
    if (u.pathname === '/__transcribe/status' && req.method === 'GET') {
      if (!job) return send(res, 404, { error: 'unknown job' });
      const body = { state: job.state, progress: job.progress, language: job.language, error: job.error, ...(job.state === 'done' ? { result: job.result } : {}) };
      return send(res, 200, body);
    }
    if (u.pathname === '/__transcribe/cancel' && req.method === 'POST') {
      if (!job) return send(res, 404, { error: 'unknown job' });
      if (job.state === 'running') {
        job.state = 'cancelled';
        job.child?.kill('SIGTERM');
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** @returns {import('vite').Plugin} */
export function transcribe() {
  return {
    name: 'our-editor-transcribe',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
}

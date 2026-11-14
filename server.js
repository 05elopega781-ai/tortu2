import 'dotenv/config';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import voicePriority from './server/voice-priority.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = resolve(ROOT, 'public');
const HTML_FILE = resolve(ROOT, 'v21_voz_saludos_backend.html');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 600 * 1024;
const MAX_LOG_BATCH = 200;
const RETENTION_DAYS = Math.min(90, Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 90));
const EVENT_TYPES = new Set(['member', 'chat', 'gift', 'like', 'follow', 'share']);
const COMMANDS = new Set(['refresh', 'turbo-down', 'turbo-up']);
const COUNTRIES = [
  ['PY', 'Paraguay', ['paraguay', '🇵🇾', 'py']],
  ['AR', 'Argentina', ['argentina', '🇦🇷', 'ar']],
  ['BR', 'Brasil', ['brasil', 'brazil', '🇧🇷', 'br']],
  ['UY', 'Uruguay', ['uruguay', '🇺🇾', 'uy']],
  ['CL', 'Chile', ['chile', '🇨🇱', 'cl']],
  ['BO', 'Bolivia', ['bolivia', '🇧🇴', 'bo']],
  ['PE', 'Perú', ['peru', 'perú', '🇵🇪', 'pe']],
  ['CO', 'Colombia', ['colombia', '🇨🇴', 'co']],
  ['EC', 'Ecuador', ['ecuador', '🇪🇨', 'ec']],
  ['VE', 'Venezuela', ['venezuela', '🇻🇪', 've']],
  ['MX', 'México', ['mexico', 'méxico', '🇲🇽', 'mx']],
  ['US', 'Estados Unidos', ['estados unidos', 'usa', '🇺🇸', 'us']],
  ['CA', 'Canadá', ['canada', 'canadá', '🇨🇦', 'ca']],
  ['ES', 'España', ['espana', 'españa', '🇪🇸', 'es']],
  ['PT', 'Portugal', ['portugal', '🇵🇹', 'pt']],
  ['FR', 'Francia', ['francia', '🇫🇷', 'fr']],
  ['GB', 'Inglaterra', ['inglaterra', 'england', '🇬🇧', '🏴', 'gb']],
  ['DE', 'Alemania', ['alemania', 'germany', '🇩🇪', 'de']],
  ['IT', 'Italia', ['italia', '🇮🇹', 'it']],
  ['NL', 'Países Bajos', ['paises bajos', 'países bajos', 'holanda', '🇳🇱', 'nl']],
  ['JP', 'Japón', ['japon', 'japón', '🇯🇵', 'jp']]
].map(([code, name, aliases]) => ({ code, name, aliases }));
const ALLOWED_STATE_KEY = /^cluss\.(?:v1|torneoLock|lang|crest\.[\w-]+|vs|fans|stats|libreVotes|chatArchive|log\.[\w.-]+)$/;

const clients = new Set();
const toolClients = new Set();
const heartbeats = new Map();
const recentUsers = [];
const seenEventIds = new Map();
const comboCounts = new Map();
const pendingCountryComments = Object.fromEntries([...COUNTRIES.map(country => country.code), 'sin-pais'].map(code => [code, 0]));
const connection = { connected: false, status: 'connecting', username: '' };
let connector = null;
let connecting = false;
let retryTimer = null;
let retryDeadline = 0;
let retryCount = 0;
let shuttingDown = false;
let adminToken = process.env.BACKEND_ADMIN_TOKEN || '';
let chatMetaQueue = Promise.resolve();
let settings = {
  username: '',
  giftTurboProgress: 6,
  tapTurboProgress: 20,
  timerStartedAt: Date.now(),
  giftCount: 0,
  tournamentEnabled: false,
  recentUsers: [],
  countryStats: Object.fromEntries([...COUNTRIES.map(country => country.code), 'sin-pais'].map(code => [code, { comments: 0, cups: 0 }]))
};
let overlayActive = false;

function normalizeUsername(value) {
  return String(value || '').trim().replace(/@/g, '').replace(/\s+/g, '');
}

function eventUser(data) {
  return data?.user || data?.author || data?.member || {};
}

function eventId(data) {
  return String(data?.msgId || data?.messageId || data?.eventId || data?.id || '');
}

function eventUsername(data) {
  const user = eventUser(data);
  return normalizeUsername(user.uniqueId || user.unique_id || user.username || data?.uniqueId || '');
}

function eventAvatar(data) {
  const user = eventUser(data);
  const candidates = [
    user.profilePictureUrl, user.profilePicture?.url, user.profilePicture,
    user.avatarUrl, user.avatar, user.userImage, user.imageUrl,
    data?.profilePictureUrl, data?.profilePicture, data?.avatarUrl, data?.avatar, data?.userImage, data?.imageUrl
  ];
  for (const candidate of candidates) {
    const url = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return url;
  }
  return '';
}

function dedupeEvent(data, type) {
  const id = eventId(data);
  if (!id) return false;
  const now = Date.now();
  for (const [key, seenAt] of seenEventIds) {
    if (now - seenAt > 10 * 60 * 1000) seenEventIds.delete(key);
  }
  const key = `${type}:${id}:${type === 'gift' ? data.repeatCount ?? '' : ''}`;
  if (seenEventIds.has(key)) return true;
  seenEventIds.set(key, now);
  return false;
}

function normalizeTikTokEvent(type, data) {
  if (!EVENT_TYPES.has(type) || !data || typeof data !== 'object') return null;
  const entry = {
    type,
    username: eventUsername(data),
    content: type === 'chat' ? String(data.comment ?? data.content ?? '').slice(0, 500) : '',
    activityCount: 1,
    giftName: '',
    profilePictureUrl: eventAvatar(data)
  };
  if (type === 'like') {
    entry.activityCount = Math.max(1, Math.floor(Number(data.activityCount ?? data.likeCount ?? data.count ?? 1) || 1));
  } else if (type === 'gift') {
    entry.activityCount = Math.max(1, Math.floor(Number(data.activityCount ?? data.repeatCount ?? data.count ?? 1) || 1));
    entry.giftName = String(data.giftName || data.gift_name || data.giftDetails?.giftName || data.gift?.name || data.gift || data.giftId || '').slice(0, 120);
  }
  if (!entry.username && type !== 'chat') return null;
  if (type === 'chat' && !entry.content) return null;
  return entry;
}

function comboDelta(data) {
  const giftType = Number(data.giftType ?? data.giftDetails?.giftType ?? 0);
  const repeatCount = Math.max(1, Math.floor(Number(data.repeatCount ?? 1) || 1));
  if (giftType !== 1) return repeatCount;
  const user = eventUsername(data);
  const giftId = String(data.giftId || data.giftDetails?.giftId || 'unknown');
  const groupId = String(data.groupId || data.comboId || data.msgId || `${user}:${giftId}`);
  const key = `${user}:${giftId}:${groupId}`;
  const previous = comboCounts.get(key) || 0;
  const delta = Math.max(0, repeatCount - previous);
  if (data.repeatEnd === true || data.streaking === false) comboCounts.delete(key);
  else comboCounts.set(key, repeatCount);
  return delta;
}

function identifyCountry(text) {
  const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return COUNTRIES.find(country => country.aliases.some(alias => {
    const needle = alias.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return needle.startsWith('🇵') || needle.startsWith('🇦') || needle.startsWith('🇧') ||
      needle.startsWith('🇺') || needle.startsWith('🇨') || needle.startsWith('🇲') ||
      needle.startsWith('🇪') || needle.startsWith('🇫') || needle.startsWith('🇬') ||
      needle.startsWith('🇮') || needle.startsWith('🇳') || needle.startsWith('🇯')
      ? String(text || '').includes(alias)
      : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, 'iu').test(value);
  })) || null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setStatus(status, connected) {
  connection.status = status;
  connection.connected = connected;
  broadcastSse(clients, 'status', { connected, status });
}

function broadcastSse(pool, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of pool) {
    if (!response.write(frame)) pool.delete(response);
  }
}

function broadcastTool(event, data) {
  broadcastSse(toolClients, event, data);
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), 'utf8');
  await rename(temp, path);
}

function statePath(key) {
  if (!ALLOWED_STATE_KEY.test(key)) return null;
  return resolve(DATA_DIR, 'state', `${Buffer.from(key).toString('base64url')}.json`);
}

function logPath(flow) {
  if (flow !== 'chat-texts' && flow !== 'user-events') return null;
  return resolve(DATA_DIR, 'logs', `${flow}.jsonl`);
}

async function readLog(flow) {
  const path = logPath(flow);
  if (!path) return [];
  try {
    const text = await readFile(path, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendRecords(flow, records) {
  const path = logPath(flow);
  if (!path || !Array.isArray(records) || records.length > MAX_LOG_BATCH) {
    throw new Error('Flujo o lote inválido.');
  }
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const clean = [];
  for (const record of records) {
    if (flow === 'chat-texts') {
      if (!Array.isArray(record) || record.length < 2) continue;
      const timestamp = Number(record[0]);
      const text = String(record[1] || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (Number.isFinite(timestamp) && timestamp >= cutoff && text) clean.push([timestamp, text]);
    } else {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const timestamp = Number(record.t);
      const username = normalizeUsername(record.u).toLowerCase();
      const type = String(record.type || '');
      if (!Number.isFinite(timestamp) || timestamp < cutoff || !username || !EVENT_TYPES.has(type)) continue;
      const item = { u: username, name: String(record.name || username).slice(0, 100), t: timestamp, type };
      if (Number.isFinite(Number(record.n))) item.n = Math.max(1, Math.floor(Number(record.n)));
      if (typeof record.text === 'string') item.text = record.text.slice(0, 500);
      if (typeof record.gift === 'string') item.gift = record.gift.slice(0, 120);
      clean.push(item);
    }
  }
  if (clean.length) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, clean.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    if (flow === 'chat-texts') {
      chatMetaQueue = chatMetaQueue.catch(error => {
        console.error('Falló la actualización del índice del chat:', error.message);
      }).then(async () => {
        const metaPath = resolve(DATA_DIR, 'chat-archive-meta.json');
        const meta = await loadJson(metaPath, { v: 1, created: clean[0][0], updated: clean[0][0], trimmed: 0, count: 0 });
        const times = clean.map(record => record[0]);
        meta.created = meta.count ? Math.min(meta.created, ...times) : times.reduce((min, time) => Math.min(min, time), Infinity);
        meta.updated = times.reduce((max, time) => Math.max(max, time), meta.updated);
        meta.count += clean.length;
        await writeJsonAtomic(metaPath, meta);
      });
      await chatMetaQueue;
    }
  }
  return clean.length;
}

async function pruneLogs() {
  for (const flow of ['chat-texts', 'user-events']) {
    const path = logPath(flow);
    if (!existsSync(path)) continue;
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const records = (await readLog(flow)).filter(record => {
      const timestamp = Array.isArray(record) ? Number(record[0]) : Number(record.t);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const temp = path.replace(/\.jsonl$/, '.prune.tmp');
    await writeFile(temp, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    await rename(temp, path);
    if (flow === 'chat-texts') {
      const metaPath = resolve(DATA_DIR, 'chat-archive-meta.json');
      const meta = await loadJson(metaPath, { v: 1, created: Date.now(), updated: Date.now(), trimmed: 0, count: 0 });
      const oldCount = meta.count || 0;
      const times = records.map(record => Number(record[0])).filter(Number.isFinite);
      meta.trimmed = (meta.trimmed || 0) + Math.max(0, oldCount - records.length);
      meta.count = records.length;
      if (times.length) {
        meta.created = times.reduce((min, time) => Math.min(min, time), Infinity);
        meta.updated = times.reduce((max, time) => Math.max(max, time), -Infinity);
      }
      await writeJsonAtomic(metaPath, meta);
    }
  }
}

function refreshOverlayPresence() {
  const cutoff = Date.now() - 90000;
  for (const [id, at] of heartbeats) if (at < cutoff) heartbeats.delete(id);
  const active = heartbeats.size > 0;
  if (overlayActive && !active) void sendWhatsApp({ type: 'overlay-inactive', at: Date.now() });
  overlayActive = active;
}

async function getState(key) {
  const path = statePath(key);
  if (!path) return { found: false };
  try {
    return { found: true, value: JSON.parse(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false };
    throw error;
  }
}

async function setState(key, value) {
  const path = statePath(key);
  if (!path) throw new Error('Clave de estado no permitida.');
  await writeJsonAtomic(path, value);
}

async function deleteState(key) {
  const path = statePath(key);
  if (!path) throw new Error('Clave de estado no permitida.');
  await rm(path, { force: true });
}

async function stateSnapshot() {
  const dir = resolve(DATA_DIR, 'state');
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const state = {};
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let key;
    try {
      key = Buffer.from(name.slice(0, -5), 'base64url').toString('utf8');
    } catch {
      continue;
    }
    if (!ALLOWED_STATE_KEY.test(key) || key.startsWith('cluss.log.')) continue;
    const item = await getState(key);
    if (item.found) state[key] = item.value;
  }
  if (!state['cluss.chatArchive']) {
    const meta = await loadJson(resolve(DATA_DIR, 'chat-archive-meta.json'), null);
    state['cluss.chatArchive'] = {
      v: 1,
      created: meta?.created || Date.now(),
      updated: meta?.updated || Date.now(),
      trimmed: meta?.trimmed || 0,
      count: meta?.count || 0
    };
  }
  return state;
}

async function persistSettings() {
  await writeJsonAtomic(resolve(DATA_DIR, 'settings.json'), settings);
}

async function createConnection(username) {
  if (connecting) return;
  if (connection.connected && connection.username === username) return;
  connecting = true;
  connection.username = username;
  setStatus(retryCount ? 'reconnecting' : 'connecting', false);
  let attemptConnection = null;
  try {
    const module = await import('tiktok-live-connector');
    const Connector = module.TikTokLiveConnection || module.WebcastPushConnection ||
      module.default?.TikTokLiveConnection || module.default?.WebcastPushConnection;
    if (typeof Connector !== 'function') throw new Error('No se encontró el conector de TikTok compatible.');
    const instance = new Connector(username, { processInitialData: false });
    attemptConnection = instance;
    connector = instance;
    const eventTypes = ['member', 'chat', 'gift', 'like', 'social'];
    for (const type of eventTypes) {
      instance.on(type, raw => {
        if (connector === instance) handleTikTokEvent(type, raw);
      });
    }
    instance.on('disconnected', () => {
      if (!shuttingDown && connector === instance && connection.connected) {
        scheduleReconnect(new Error('TikTok desconectó el live.'));
      }
    });
    instance.on('error', error => {
      if (!shuttingDown && connector === instance && connection.connected) {
        scheduleReconnect(error instanceof Error ? error : new Error(String(error)));
      }
    });
    let timeout;
    try {
      await Promise.race([
        instance.connect(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Tiempo de conexión agotado (10 s).')), 10000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    setStatus('connected', true);
    retryCount = 0;
    retryDeadline = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  } catch (error) {
    if (attemptConnection?.disconnect) {
      try {
        await attemptConnection.disconnect();
      } catch (disconnectError) {
        console.error('No se pudo cerrar el intento de TikTok:', disconnectError.message);
      }
    }
    setStatus('reconnecting', false);
    scheduleReconnect(error);
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(error) {
  if (shuttingDown || retryTimer) return;
  const now = Date.now();
  if (!retryDeadline) {
    retryDeadline = now + 5 * 60 * 1000;
    retryCount = 0;
  }
  if (now >= retryDeadline) {
    setStatus('failed', false);
    retryDeadline = 0;
    console.error(`TikTok: ciclo de reconexión agotado: ${error.message}`);
    return;
  }
  retryCount++;
  setStatus('reconnecting', false);
  const remaining = retryDeadline - now;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const username = process.env.TIKTOK_USERNAME
      ? normalizeUsername(process.env.TIKTOK_USERNAME)
      : normalizeUsername(settings.username || 'd4n1el325');
    createConnection(username);
  }, Math.min(5000, remaining));
}

function handleTikTokEvent(type, raw) {
  if (type === 'social') {
    const description = String(raw?.displayType || raw?.label || '').toLowerCase();
    if (raw?.follow === true || /follow|seguir/.test(description)) type = 'follow';
    else if (raw?.share === true || /share|compart/.test(description)) type = 'share';
    else return;
  }
  if (!EVENT_TYPES.has(type) || dedupeEvent(raw, type)) return;
  const entry = normalizeTikTokEvent(type, raw);
  if (!entry) return;
  if (type === 'gift') {
    entry.activityCount = comboDelta(raw);
    if (entry.activityCount < 1) return;
    settings.giftCount += entry.activityCount;
    void persistSettings().catch(error => console.error('No se pudo guardar el contador de regalos:', error.message));
    broadcastTool('game-tools', { timerStartedAt: settings.timerStartedAt, giftCount: settings.giftCount });
    sendWhatsApp({ type: 'gift', username: entry.username, giftName: entry.giftName, activityCount: entry.activityCount });
  }
  if (type === 'member' && entry.username) {
    const existing = recentUsers.findIndex(user => user.username.toLowerCase() === entry.username.toLowerCase());
    if (existing >= 0) recentUsers.splice(existing, 1);
    recentUsers.unshift({ username: entry.username, avatar: entry.profilePictureUrl });
    recentUsers.splice(4);
    settings.recentUsers = recentUsers.slice();
    void persistSettings().catch(error => console.error('No se pudo guardar la lista de usuarios recientes:', error.message));
  } else if (entry.username) {
    const user = recentUsers.find(item => item.username.toLowerCase() === entry.username.toLowerCase());
    if (user && entry.profilePictureUrl) {
      user.avatar = entry.profilePictureUrl;
      settings.recentUsers = recentUsers.slice();
      void persistSettings().catch(error => console.error('No se pudo guardar el avatar del usuario:', error.message));
    }
  }
  if (type === 'chat') {
    const country = identifyCountry(entry.content);
    pendingCountryComments[country ? country.code : 'sin-pais']++;
    if (settings.tournamentEnabled && entry.username) void registerTournamentVote(entry.username, entry.content);
  }
  broadcastSse(clients, 'update', { entry });
  void appendRecords('user-events', [{
    u: entry.username,
    name: entry.username,
    t: Date.now(),
    type,
    n: entry.activityCount,
    ...(entry.content ? { text: entry.content } : {}),
    ...(entry.giftName ? { gift: entry.giftName } : {})
  }]).catch(error => console.error('No se pudo guardar el evento de usuario:', error.message));
}

async function sendWhatsApp(event) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== 'true' || !process.env.WHATSAPP_WEBHOOK_URL) return;
  try {
    const headers = { 'content-type': 'application/json' };
    if (process.env.WHATSAPP_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.WHATSAPP_WEBHOOK_TOKEN}`;
    const response = await fetch(process.env.WHATSAPP_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`webhook respondió ${response.status}`);
  } catch (error) {
    console.error('No se pudo enviar la alerta de WhatsApp:', error.message);
  }
}

async function registerTournamentVote(username, text) {
  const state = await getState('cluss.libreVotes');
  const document = state.found && state.value && typeof state.value === 'object'
    ? state.value
    : { v: 1, salt: randomBytes(16).toString('hex'), total: {}, round: {}, all: [], rounds: [] };
  if (!document.salt) document.salt = randomBytes(16).toString('hex');
  const voteKey = createHmac('sha256', document.salt).update(username.trim().toLowerCase()).digest('hex');
  const team = text.trim().slice(0, 80);
  if (!team) return;
  const row = document.round[team] || (document.round[team] = { votes: 0, u: [] });
  if (row.u.includes(voteKey)) return;
  row.votes++;
  row.u.push(voteKey);
  const total = document.total[team] || (document.total[team] = { votes: 0, u: [] });
  total.votes++;
  if (!total.u.includes(voteKey)) total.u.push(voteKey);
  if (!document.all.includes(voteKey)) document.all.push(voteKey);
  document.updated = Date.now();
  await setState('cluss.libreVotes', document);
}

function safeJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Solicitud demasiado grande.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { status: 400 });
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.host &&
      (url.protocol === 'https:' || url.protocol === 'http:');
  } catch {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
    safeJson(res, 401, { message: 'Se requiere el token de administración configurado en BACKEND_ADMIN_TOKEN.' });
    return false;
  }
  return true;
}

function sse(req, res, pool, initialEvents = []) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  for (const [event, data] of initialEvents) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  pool.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    pool.delete(res);
  });
}

function contentType(path) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  })[extname(path)] || 'application/octet-stream';
}

async function serveFile(req, res, path, options = {}) {
  try {
    let body = await readFile(path);
    if (options.deploymentSignature) {
      const signature = `sha256-${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
      body = Buffer.from(body.toString('utf8').replaceAll('__CLUSS_DEPLOYMENT_SIGNATURE__', signature));
      res.setHeader('x-cluss-deployment-signature', signature);
    }
    res.writeHead(200, {
      'content-type': options.contentType || contentType(path),
      'cache-control': options.cache || 'no-cache',
      'content-length': body.length,
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT') safeJson(res, 404, { message: 'No encontrado.' });
    else throw error;
  }
}

const backendPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TortuWorld · Backend</title>
<style>body{font:15px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;background:#1a1109;color:#fff}section{padding:1rem;margin:1rem 0;background:#302114;border-radius:12px}button,input{padding:.6rem;margin:.25rem;border-radius:6px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>🐢 TortuWorld · Backend</h1><label>Token de administración <input id="token" type="password" autocomplete="current-password"></label>
<section><h2>Conexión TikTok</h2><p id="status">Conectando…</p><form id="connect"><input name="username" placeholder="Usuario TikTok (sin @)" required><button>Conectar</button><button type="button" id="reconnect">Reintentar</button></form></section>
<section><h2>Herramientas</h2><label>Turbo regalo % <input id="gift" type="number" min="0" max="100" value="6"></label><label>Turbo taps % <input id="tap" type="number" min="0" max="100" value="20"></label><button id="save">Guardar ajustes</button><button id="reset">Reiniciar cronómetro y regalos</button><p><button data-command="turbo-down">Turbo −</button><button data-command="turbo-up">Turbo +</button><button data-command="refresh">Recargar overlay</button></p><pre id="tools"></pre></section>
<section><h2>Torneo Libre</h2><label><input id="tournamentEnabled" type="checkbox"> Registrar votos de comentarios reales</label><button id="saveTournament">Guardar</button></section>
<section><h2>Overlay activo</h2><pre id="presence"></pre></section><section><h2>Estadísticas por país</h2><pre id="countries"></pre></section><p id="message"></p>
<script>
const $=s=>document.querySelector(s),token=()=>$('#token').value,headers=()=>({'content-type':'application/json','authorization':'Bearer '+token()}),msg=t=>$('#message').textContent=t;
async function admin(path,body){const r=await fetch(path,{method:'POST',headers:headers(),body:JSON.stringify(body||{})});const j=await r.json();if(!r.ok)throw Error(j.message||r.status);return j}
$('#connect').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:e.target.username.value})});const j=await r.json();if(!r.ok)throw Error(j.message);msg('Conectando con @'+j.username)}catch(x){msg(x.message)}};
$('#reconnect').onclick=async()=>{try{await admin('/api/admin/reconnect');msg('Reconexión solicitada')}catch(e){msg(e.message)}};
$('#save').onclick=async()=>{try{await admin('/api/admin/game-settings',{giftTurboProgress:+$('#gift').value,tapTurboProgress:+$('#tap').value});msg('Ajustes guardados')}catch(e){msg(e.message)}};
$('#saveTournament').onclick=async()=>{try{await admin('/api/admin/tournament-enabled',{enabled:$('#tournamentEnabled').checked});msg('Configuración de Torneo Libre guardada')}catch(e){msg(e.message)}};
$('#reset').onclick=async()=>{try{await admin('/api/admin/game-tools/reset');msg('Cronómetro reiniciado')}catch(e){msg(e.message)}};
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=async()=>{try{await admin('/api/admin/game-command',{command:b.dataset.command});msg('Comando enviado')}catch(e){msg(e.message)}});
const source=new EventSource('/api/events');source.addEventListener('status',e=>$('#status').textContent=JSON.stringify(JSON.parse(e.data)));
const tools=new EventSource('/api/game-tools/events');tools.addEventListener('game-tools',e=>$('#tools').textContent=JSON.stringify(JSON.parse(e.data),null,2));tools.addEventListener('game-settings',e=>{const x=JSON.parse(e.data);$('#gift').value=x.giftTurboProgress;$('#tap').value=x.tapTurboProgress});
async function refresh(){try{const [p,c]=await Promise.all([fetch('/api/admin/presence',{headers:headers()}),fetch('/api/admin/country-stats',{headers:headers()})]);$('#presence').textContent=JSON.stringify(await p.json(),null,2);$('#countries').textContent=JSON.stringify(await c.json(),null,2)}catch(e){msg(e.message)}}
setInterval(refresh,15000);refresh();
</script>`;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS' }).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    safeJson(res, 403, { message: 'Origen no permitido.' });
    return;
  }

  if ((path === '/' || path === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveFile(req, res, HTML_FILE, { deploymentSignature: true });
    return;
  }
  if (path === '/backend' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(backendPage);
    return;
  }
  if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/activity-policy.js') {
    const filename = path === '/activity-policy.js' ? 'activity-policy.js' : path.slice(1);
    await serveFile(req, res, resolve(PUBLIC_DIR, filename));
    return;
  }
  if (/^\/icons\/tortu2-(?:192|512)\.(?:png|svg)$/.test(path) && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveFile(req, res, resolve(PUBLIC_DIR, path.slice(1)));
    return;
  }
  if (path === '/api/events' && req.method === 'GET') {
    sse(req, res, clients, [['status', { connected: connection.connected, status: connection.status }]]);
    return;
  }
  if (path === '/api/game-tools/events' && req.method === 'GET') {
    sse(req, res, toolClients, [
      ['game-settings', { giftTurboProgress: settings.giftTurboProgress, tapTurboProgress: settings.tapTurboProgress }],
      ['game-tools', { timerStartedAt: settings.timerStartedAt, giftCount: settings.giftCount }]
    ]);
    return;
  }
  if (path === '/api/state.js' && req.method === 'GET') {
    const state = await stateSnapshot();
    const js = `window.CLUSS_STATE = ${JSON.stringify(state).replace(/</g, '\\u003c')};`;
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(js);
    return;
  }
  if (path === '/api/deployment-signature' && req.method === 'GET') {
    const html = await readFile(HTML_FILE);
    const signature = `sha256-${createHash('sha256').update(html).digest('hex').slice(0, 16)}`;
    safeJson(res, 200, { signature });
    return;
  }
  if (path === '/api/voice-priority' && req.method === 'GET') {
    safeJson(res, 200, voicePriority);
    return;
  }
  if (path === '/api/recent-users' && req.method === 'GET') {
    safeJson(res, 200, { users: recentUsers.slice(0, 4) });
    return;
  }
  if (path === '/api/reconnect' && req.method === 'POST') {
    if (connection.connected) {
      safeJson(res, 409, { ok: true, username: connection.username, message: 'Ya está conectado.' });
      return;
    }
    const username = process.env.TIKTOK_USERNAME
      ? normalizeUsername(process.env.TIKTOK_USERNAME)
      : normalizeUsername(settings.username || 'd4n1el325');
    if (!username) {
      safeJson(res, 400, { message: 'El usuario de TikTok no puede estar vacío.' });
      return;
    }
    retryDeadline = Date.now() + 5 * 60 * 1000;
    retryCount = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void createConnection(username);
    safeJson(res, 200, { ok: true, username });
    return;
  }
  if (path === '/api/connect' && req.method === 'POST') {
    const body = await readBody(req);
    const requested = normalizeUsername(body.username);
    if (!requested) {
      safeJson(res, 400, { ok: false, message: 'El usuario de TikTok no puede estar vacío.' });
      return;
    }
    settings.username = requested;
    await persistSettings();
    const username = process.env.TIKTOK_USERNAME ? normalizeUsername(process.env.TIKTOK_USERNAME) : requested;
    retryDeadline = Date.now() + 5 * 60 * 1000;
    retryCount = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void createConnection(username);
    safeJson(res, 200, { ok: true, username, message: 'Conexión iniciada.' });
    return;
  }
  if (path === '/api/game-tools/overlay-heartbeat' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.clientId !== 'string' || body.clientId.length > 100 || typeof body.visible !== 'boolean') {
      safeJson(res, 400, { message: 'Heartbeat inválido.' });
      return;
    }
    if (body.visible) heartbeats.set(body.clientId, Date.now());
    else heartbeats.delete(body.clientId);
    refreshOverlayPresence();
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/round/complete' && req.method === 'POST') {
    await readBody(req);
    for (const [code, count] of Object.entries(pendingCountryComments)) {
      if (count > 0) settings.countryStats[code].comments += count;
      pendingCountryComments[code] = 0;
    }
    await persistSettings();
    const round = { completedAt: Date.now(), countryComments: { ...settings.countryStats } };
    await writeJsonAtomic(resolve(DATA_DIR, 'rounds', `${round.completedAt}.json`), round);
    safeJson(res, 200, { ok: true, completedAt: round.completedAt });
    return;
  }
  if (path === '/api/tournament/vote' && req.method === 'POST') {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    if (!settings.tournamentEnabled || !username || typeof body.team !== 'string' || !body.team.trim()) {
      safeJson(res, 400, { ok: false, message: 'Voto inválido o Torneo Libre deshabilitado.' });
      return;
    }
    await registerTournamentVote(username, body.team.trim().slice(0, 80));
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/country/cup' && req.method === 'POST') {
    const body = await readBody(req);
    const country = COUNTRIES.find(item => item.code === String(body.countryCode || '').toUpperCase());
    if (!country) {
      safeJson(res, 400, { ok: false, message: 'Código de país no válido.' });
      return;
    }
    settings.countryStats[country.code].cups++;
    await persistSettings();
    safeJson(res, 200, { ok: true });
    return;
  }

  const stateMatch = path.match(/^\/api\/state\/(.+)$/);
  if (stateMatch && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
    const key = stateMatch[1];
    if (!statePath(key)) {
      safeJson(res, 400, { message: 'Clave de estado no permitida.' });
      return;
    }
    if (req.method === 'GET') {
      const result = await getState(key);
      if (!result.found) safeJson(res, 404, { message: 'Estado no encontrado.' });
      else safeJson(res, 200, result.value);
    } else if (req.method === 'PUT') {
      const value = await readBody(req);
      await setState(key, value);
      safeJson(res, 200, { ok: true });
    } else {
      await deleteState(key);
      safeJson(res, 200, { ok: true });
    }
    return;
  }
  const logMatch = path.match(/^\/api\/log\/([^/]+)$/);
  if (logMatch && ['POST', 'DELETE'].includes(req.method)) {
    const flow = logMatch[1];
    if (!logPath(flow)) {
      safeJson(res, 404, { message: 'Flujo de log no permitido.' });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.records) || body.records.length > MAX_LOG_BATCH) {
        safeJson(res, 400, { message: `records debe contener como máximo ${MAX_LOG_BATCH} elementos.` });
        return;
      }
      const saved = await appendRecords(flow, body.records);
      safeJson(res, 200, { ok: true, saved });
    } else {
      await rm(logPath(flow), { force: true });
      if (flow === 'chat-texts') {
        await writeJsonAtomic(resolve(DATA_DIR, 'chat-archive-meta.json'), {
          v: 1, created: Date.now(), updated: Date.now(), trimmed: 0, count: 0
        });
        const path = statePath('cluss.chatArchive');
        if (path) await rm(path, { force: true });
      }
      safeJson(res, 200, { ok: true });
    }
    return;
  }
  if (path === '/api/log/chat-texts.json' && req.method === 'GET') {
    const records = await readLog('chat-texts');
    const body = JSON.stringify(records);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="chat-texts.json"',
      'cache-control': 'no-store'
    }).end(body);
    return;
  }
  if (path === '/api/log/chat-texts.txt' && req.method === 'GET') {
    const records = await readLog('chat-texts');
    const body = records.map(record => `${new Date(Number(record[0])).toISOString()}\t${record[1]}`).join('\n');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="chat-texts.txt"',
      'cache-control': 'no-store'
    }).end(body);
    return;
  }
  if (path === '/api/admin/reconnect' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    retryDeadline = Date.now() + 5 * 60 * 1000;
    retryCount = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (connector?.disconnect) await connector.disconnect().catch(() => {});
    connector = null;
    void createConnection(process.env.TIKTOK_USERNAME
      ? normalizeUsername(process.env.TIKTOK_USERNAME)
      : normalizeUsername(settings.username || 'd4n1el325'));
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/game-settings' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const gift = Number(body.giftTurboProgress);
    const tap = Number(body.tapTurboProgress);
    if (![gift, tap].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
      safeJson(res, 400, { message: 'Los valores deben estar entre 0 y 100.' });
      return;
    }
    settings.giftTurboProgress = gift;
    settings.tapTurboProgress = tap;
    await persistSettings();
    broadcastTool('game-settings', { giftTurboProgress: gift, tapTurboProgress: tap });
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/game-tools/reset' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await readBody(req);
    settings.timerStartedAt = Date.now();
    settings.giftCount = 0;
    await persistSettings();
    broadcastTool('game-tools', { timerStartedAt: settings.timerStartedAt, giftCount: 0 });
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/game-command' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (!COMMANDS.has(body.command)) {
      safeJson(res, 400, { message: 'Comando no permitido.' });
      return;
    }
    if (path === '/api/admin/tournament-enabled' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (typeof body.enabled !== 'boolean') {
        safeJson(res, 400, { message: 'enabled debe ser booleano.' });
        return;
      }
      settings.tournamentEnabled = body.enabled;
      await persistSettings();
      safeJson(res, 200, { ok: true, enabled: settings.tournamentEnabled });
      return;
    }
    broadcastTool('game-command', { command: body.command });
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/presence' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const cutoff = Date.now() - 90000;
    for (const [id, at] of heartbeats) if (at < cutoff) heartbeats.delete(id);
    safeJson(res, 200, { active: heartbeats.size > 0, clients: heartbeats.size });
    return;
  }
  if (path === '/api/admin/country-stats' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    safeJson(res, 200, {
      countries: [
        ...COUNTRIES.map(country => ({ code: country.code, name: country.name, ...settings.countryStats[country.code] })),
        { code: 'sin-pais', name: 'Sin país', ...settings.countryStats['sin-pais'] }
      ]
    });
    return;
  }

  safeJson(res, 404, { message: 'No encontrado.' });
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  settings = { ...settings, ...(await loadJson(resolve(DATA_DIR, 'settings.json'), {})) };
  if (Array.isArray(settings.recentUsers)) recentUsers.push(...settings.recentUsers.slice(0, 4));
  settings.countryStats ||= Object.fromEntries([...COUNTRIES.map(country => country.code), 'sin-pais'].map(code => [code, { comments: 0, cups: 0 }]));
  for (const country of COUNTRIES) {
    settings.countryStats[country.code] ||= { comments: 0, cups: 0 };
  }
  settings.countryStats['sin-pais'] ||= { comments: 0, cups: 0 };
  if (!adminToken) {
    adminToken = randomBytes(24).toString('base64url');
    console.log(`Token BACKEND_ADMIN_TOKEN generado para esta sesión: ${adminToken}`);
  }
  await pruneLogs();
  setInterval(refreshOverlayPresence, 15000).unref();
  setInterval(() => {
    void pruneLogs().catch(error => console.error('No se pudieron depurar logs:', error.message));
  }, 15 * 60 * 1000).unref();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, seenAt] of seenEventIds) if (seenAt < cutoff) seenEventIds.delete(id);
  }, 60000).unref();
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      console.error('Error de solicitud:', error);
      if (!res.headersSent) safeJson(res, error.status || 500, { message: error.status ? error.message : 'Error interno del servidor.' });
      else res.destroy();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`TortuWorld escuchando en http://${HOST}:${PORT}`);
    const username = process.env.TIKTOK_USERNAME
      ? normalizeUsername(process.env.TIKTOK_USERNAME)
      : normalizeUsername(settings.username || 'd4n1el325');
    if (username) void createConnection(username);
  });
  const shutdown = async () => {
    shuttingDown = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      if (connector?.disconnect) await connector.disconnect();
    } catch (error) {
      console.error('Error al cerrar TikTok:', error.message);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export {
  normalizeUsername,
  normalizeTikTokEvent,
  comboDelta,
  identifyCountry,
  appendRecords,
  stateSnapshot,
  main
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}

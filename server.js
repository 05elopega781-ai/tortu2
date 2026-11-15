import 'dotenv/config';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import voicePriority from './server/voice-priority.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = resolve(ROOT, 'public');
const HTML_FILE = resolve(ROOT, 'overlay.html');
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
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
const motorClients = new Set();
const heartbeats = new Map();
const adminSessions = new Map();
const recentUsers = [];
const seenEventIds = new Map();
const comboCounts = new Map();
const technicalLogs = [];
const pendingCountryComments = Object.fromEntries([...COUNTRIES.map(country => country.code), 'sin-pais'].map(code => [code, 0]));
const connection = { connected: false, status: 'connecting', username: '' };
let connector = null;
let connectionAttemptId = 0;
let retryTimer = null;
let retryDeadline = 0;
let retryCount = 0;
let shuttingDown = false;
let adminToken = process.env.BACKEND_ADMIN_TOKEN || '';
const ADMIN_SESSION_COOKIE = 'tortu_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TECHNICAL_LOGS = 200;
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
let motorTelemetry = null;

function normalizeUsername(value) {
  return String(value || '').trim().replace(/@/g, '').replace(/\s+/g, '');
}

function configuredUsername(savedUsername = settings.username) {
  return normalizeUsername(savedUsername || process.env.TIKTOK_USERNAME || 'd4n1el325');
}

function eventUser(data) {
  return data?.user || data?.author || data?.member || {};
}

function eventId(data) {
  return String(data?.msgId || data?.messageId || data?.eventId || '');
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
    const diamonds = Number(data.diamondCount ?? data.diamond_count ?? data.giftDetails?.diamondCount ?? data.giftDetails?.diamond_count ?? data.gift?.diamondCount ?? data.gift?.diamond_count ?? 0);
    entry.giftDiamonds = Number.isFinite(diamonds) && diamonds > 0 ? Math.floor(diamonds) : 0;
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

function socialEventType(data) {
  const action = String(data?.action || data?.displayType || data?.label || '').toLowerCase();
  if (data?.follow === true || /follow|seguir/.test(action)) return 'follow';
  if (data?.share === true || data?.shareType || data?.shareTarget || /share|compart/.test(action)) return 'share';
  return '';
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

function safeLogMessage(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redactado]')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[redactado]')
    .slice(0, 500);
}

function recordTechnicalLog(level, message) {
  const entry = { timestamp: Date.now(), level, message: safeLogMessage(message) };
  technicalLogs.unshift(entry);
  if (technicalLogs.length > MAX_TECHNICAL_LOGS) technicalLogs.length = MAX_TECHNICAL_LOGS;
  if (level === 'error') console.error(entry.message);
  else console.log(entry.message);
}

function setStatus(status, connected) {
  connection.status = status;
  connection.connected = connected;
  recordTechnicalLog('info', `TikTok: ${status}${connection.username ? ` · @${connection.username}` : ''}`);
  broadcastSse(clients, 'status', { connected, status, username: connection.username });
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

function normalizeMotorTelemetry(value) {
  const phases = new Set(['starting', 'running', 'finished', 'waiting']);
  const types = ['member', 'chat', 'gift', 'like', 'follow', 'share'];
  if (!value || typeof value !== 'object' || !phases.has(value.phase) || !Array.isArray(value.teams) || value.teams.length !== 2) {
    return null;
  }
  const teams = value.teams.map(team => {
    if (!team || typeof team.id !== 'string' || typeof team.name !== 'string') return null;
    const number = (input, max) => {
      const result = Number(input);
      return Number.isFinite(result) ? Math.min(max, Math.max(0, result)) : null;
    };
    const progress = number(team.progress, 100);
    const taps = number(team.taps, 1000000);
    const tapLimit = number(team.tapLimit, 100);
    const eventTotal = number(team.eventTotal, 100000000);
    const turboMs = number(team.turboMs, 60000);
    const giftTurboMs = number(team.giftTurboMs, 60000);
    if ([progress, taps, tapLimit, eventTotal, turboMs, giftTurboMs].some(item => item === null) || tapLimit < 1) return null;
    return {
      id: team.id.slice(0, 40),
      name: team.name.slice(0, 80),
      progress,
      taps,
      tapLimit,
      eventTotal,
      turboMs,
      giftTurboMs
    };
  });
  if (teams.some(team => team === null)) return null;
  const stats = {};
  for (const type of types) {
    const count = Number(value.stats?.[type]);
    stats[type] = Number.isFinite(count) ? Math.min(100000000, Math.max(0, Math.floor(count))) : 0;
  }
  const elapsedMs = Number(value.elapsedMs);
  const idleSeconds = Number(value.idleSeconds);
  const turboValue = (input, max) => {
    const result = Number(input);
    return Number.isFinite(result) ? Math.min(max, Math.max(0, result)) : 0;
  };
  return {
    updatedAt: Date.now(),
    phase: value.phase,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.min(86400000, Math.max(0, elapsedMs)) : 0,
    idleSeconds: Number.isFinite(idleSeconds) ? Math.min(86400, Math.max(0, idleSeconds)) : 0,
    winner: typeof value.winner === 'string' ? value.winner.slice(0, 80) : '',
    stats,
    teams,
    turbo: {
      tapProgress: turboValue(value.turbo?.tapProgress, 100),
      tapDurationMs: turboValue(value.turbo?.tapDurationMs, 60000),
      giftProgress: turboValue(value.turbo?.giftProgress, 100),
      giftDurationMs: turboValue(value.turbo?.giftDurationMs, 60000)
    }
  };
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
        recordTechnicalLog('error', `Falló la actualización del índice del chat: ${error.message}`);
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
  const requestedUsername = normalizeUsername(username);
  if (!requestedUsername || (connection.connected && connection.username === requestedUsername)) return;
  const attemptId = ++connectionAttemptId;
  const previousConnection = connector;
  connector = null;
  connection.username = requestedUsername;
  setStatus(retryCount ? 'reconnecting' : 'connecting', false);
  let attemptConnection = null;
  try {
    if (previousConnection?.disconnect) {
      try {
        await previousConnection.disconnect();
      } catch (error) {
        recordTechnicalLog('error', `No se pudo cerrar la conexión anterior de TikTok: ${error.message}`);
      }
    }
    if (attemptId !== connectionAttemptId) return;
    const module = await import('tiktok-live-connector');
    const Connector = module.TikTokLiveConnection || module.WebcastPushConnection ||
      module.default?.TikTokLiveConnection || module.default?.WebcastPushConnection;
    if (typeof Connector !== 'function') throw new Error('No se encontró el conector de TikTok compatible.');
    if (attemptId !== connectionAttemptId) return;
    const instance = new Connector(requestedUsername, { processInitialData: false });
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
    if (attemptId !== connectionAttemptId) return;
    setStatus('connected', true);
    retryCount = 0;
    retryDeadline = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  } catch (error) {
    if (attemptId !== connectionAttemptId) return;
    if (connector === attemptConnection) connector = null;
    if (attemptConnection?.disconnect) {
      try {
        await attemptConnection.disconnect();
      } catch (disconnectError) {
        recordTechnicalLog('error', `No se pudo cerrar el intento de TikTok: ${disconnectError.message}`);
      }
    }
    if (attemptId !== connectionAttemptId) return;
    setStatus('reconnecting', false);
    scheduleReconnect(error);
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
    recordTechnicalLog('error', `TikTok: ciclo de reconexión agotado: ${error.message}`);
    return;
  }
  retryCount++;
  setStatus('reconnecting', false);
  const remaining = retryDeadline - now;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    createConnection(configuredUsername());
  }, Math.min(5000, remaining));
}

function handleTikTokEvent(type, raw) {
  if (type === 'social') {
    type = socialEventType(raw);
    if (!type) return;
  }
  if (!EVENT_TYPES.has(type) || dedupeEvent(raw, type)) return;
  const entry = normalizeTikTokEvent(type, raw);
  if (!entry) return;
  if (type === 'gift') {
    entry.activityCount = comboDelta(raw);
    if (entry.activityCount < 1) return;
    entry.giftDiamonds *= entry.activityCount;
    settings.giftCount += entry.activityCount;
    void persistSettings().catch(error => recordTechnicalLog('error', `No se pudo guardar el contador de regalos: ${error.message}`));
    broadcastTool('game-tools', { timerStartedAt: settings.timerStartedAt, giftCount: settings.giftCount });
    sendWhatsApp({ type: 'gift', username: entry.username, giftName: entry.giftName, activityCount: entry.activityCount, giftDiamonds: entry.giftDiamonds });
  }
  if (type === 'member' && entry.username) {
    const existing = recentUsers.findIndex(user => user.username.toLowerCase() === entry.username.toLowerCase());
    if (existing >= 0) recentUsers.splice(existing, 1);
    recentUsers.unshift({ username: entry.username, avatar: entry.profilePictureUrl });
    recentUsers.splice(4);
    settings.recentUsers = recentUsers.slice();
    void persistSettings().catch(error => recordTechnicalLog('error', `No se pudo guardar la lista de usuarios recientes: ${error.message}`));
  } else if (entry.username) {
    const user = recentUsers.find(item => item.username.toLowerCase() === entry.username.toLowerCase());
    if (user && entry.profilePictureUrl) {
      user.avatar = entry.profilePictureUrl;
      settings.recentUsers = recentUsers.slice();
      void persistSettings().catch(error => recordTechnicalLog('error', `No se pudo guardar el avatar del usuario: ${error.message}`));
    }
  }
  if (type === 'chat') {
    const country = identifyCountry(entry.content);
    pendingCountryComments[country ? country.code : 'sin-pais']++;
    if (settings.tournamentEnabled && entry.username) void registerTournamentVote(entry.username, entry.content);
  }
  const receivedAt = Date.now();
  entry.receivedAt = receivedAt;
  broadcastSse(clients, 'update', { entry });
  void appendRecords('user-events', [{
    u: entry.username,
    name: entry.username,
    t: receivedAt,
    type,
    n: entry.activityCount,
    ...(entry.content ? { text: entry.content } : {}),
    ...(entry.giftName ? { gift: entry.giftName } : {}),
    ...(type === 'gift' ? { giftDiamonds: entry.giftDiamonds } : {})
  }]).catch(error => recordTechnicalLog('error', `No se pudo guardar el evento de usuario: ${error.message}`));
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
    recordTechnicalLog('error', `No se pudo enviar la alerta de WhatsApp: ${error.message}`);
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
  const configuredToken = process.env.BACKEND_ADMIN_TOKEN || adminToken;
  const providedToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(configuredToken);
  const provided = Buffer.from(providedToken);
  const validToken = Boolean(configuredToken) && expected.length === provided.length && timingSafeEqual(expected, provided);
  if (!hasAdminSession(req) && !validToken) {
    safeJson(res, 401, { message: 'Se requiere el token de administración configurado en BACKEND_ADMIN_TOKEN.' });
    return false;
  }
  return true;
}

function adminSessionId(req) {
  const prefix = `${ADMIN_SESSION_COOKIE}=`;
  const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : '';
}

function hasAdminSession(req) {
  const id = adminSessionId(req);
  const expiresAt = adminSessions.get(id);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminSessions.delete(id);
    return false;
  }
  return true;
}

function startAdminSession(req, res) {
  const now = Date.now();
  for (const [id, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(id);
  }
  const id = randomBytes(32).toString('base64url');
  adminSessions.set(id, now + ADMIN_SESSION_TTL_MS);
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('set-cookie', `${ADMIN_SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
}

function endAdminSession(req, res) {
  adminSessions.delete(adminSessionId(req));
  res.setHeader('set-cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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

  function deploymentSignature(body) {
    const html = body.toString('utf8').replaceAll('__TORTUWORLD_PACKAGE_VERSION__', PACKAGE_VERSION);
    return `sha256-${createHash('sha256').update(html).digest('hex').slice(0, 16)}`;
  }

async function serveFile(req, res, path, options = {}) {
  try {
    let body = await readFile(path);
    if (options.deploymentSignature) {
        const signature = deploymentSignature(body);
        body = Buffer.from(body.toString('utf8')
          .replaceAll('__TORTUWORLD_PACKAGE_VERSION__', PACKAGE_VERSION)
          .replaceAll('__CLUSS_DEPLOYMENT_SIGNATURE__', signature));
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

const backendPage = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#090e18"><title>Negocio · Game Server</title>
<style>
:root{color-scheme:dark;--bg:#090e18;--panel:#111a29;--panel2:#0d1523;--line:#24364b;--text:#eaf3ff;--muted:#91a4bc;--cyan:#62e6ff;--lime:#a4f36d;--amber:#ffc86b;--red:#ff7189}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 75% -15%,#18314a 0,transparent 42%),var(--bg);color:var(--text);font:14px/1.5 Inter,Segoe UI,system-ui,sans-serif;min-height:100vh}
button,input{font:inherit}button{border:1px solid #33516c;background:#18283b;color:var(--text);border-radius:9px;padding:.7rem 1rem;cursor:pointer;transition:.18s}button:hover{border-color:var(--cyan);transform:translateY(-1px);box-shadow:0 5px 22px #36c5e622}button.primary{background:linear-gradient(120deg,#1d7884,#27604a);border-color:#57d3ce;font-weight:750}
input{border:1px solid #31435a;background:#0a1220;color:var(--text);padding:.65rem .8rem;border-radius:8px;outline:none}input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px #62e6ff1b}
.shell{max-width:1240px;margin:auto;padding:0 28px 42px}.topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #203044}
.brand{display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none}.brandmark{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(145deg,#8ff3c0,#54d8ee);color:#08202a;font-size:17px;font-weight:950;box-shadow:0 0 26px #62e6ff30}.brand b{letter-spacing:.13em;font-size:13px}.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.18em}
.topmeta{display:flex;align-items:center;gap:18px;color:var(--muted);font-size:12px}.live-tag,.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid #29465b;border-radius:999px;padding:6px 11px;background:#0d1a26;color:#b9d1e6;font-size:10px;font-weight:800;letter-spacing:.1em}.dot{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 12px var(--lime)}
.hero{padding:42px 0 22px;display:grid;grid-template-columns:1fr;gap:36px;align-items:end}.eyebrow{color:var(--cyan);font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase}.hero h1{font-size:clamp(34px,5vw,56px);line-height:1.03;letter-spacing:-.05em;margin:12px 0}.hero h1 em{font-style:normal;color:var(--lime)}.hero p{color:var(--muted);max-width:570px;margin:0}.hero-actions{display:flex;gap:10px;align-items:center;margin-top:22px}.hero-actions a{color:var(--cyan);text-decoration:none;font-weight:700;padding:10px 12px}
.connection-card,.panel,.stat{border:1px solid var(--line);border-radius:15px;background:linear-gradient(145deg,#142033,#0f1725);box-shadow:0 16px 40px #0002}.connection-card{padding:18px}.connection-card header,.panel header{display:flex;align-items:center;justify-content:space-between;gap:12px}.connection-card h2,.panel h2{margin:0;font-size:14px;letter-spacing:.02em}.status-pill{color:var(--amber);font-size:11px;font-weight:800}.status-pill.online{color:var(--lime)}.subtle{font-size:12px;color:var(--muted)}.user-connection{margin-top:16px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 14px}.stat{padding:15px 17px}.stat-label{display:block;color:var(--muted);font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.stat strong{display:block;font-size:22px;margin-top:7px;letter-spacing:-.03em}.stat small{color:var(--muted)}
.unit-nav{display:flex;gap:8px;overflow-x:auto;padding:7px 2px 14px;margin:4px 0 8px;scrollbar-width:thin}.unit-nav button{flex:0 0 auto;padding:.58rem .85rem;font-size:12px}.unit-nav button.active{border-color:var(--cyan);background:#173449;color:#fff;box-shadow:0 0 0 2px #62e6ff18}
.layout{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.panel{padding:19px;margin-bottom:14px}.panel header{margin-bottom:16px}.panel h2{display:flex;align-items:center;gap:9px}.icon{width:30px;height:30px;border-radius:9px;display:inline-grid;place-items:center;background:#1b3341;color:var(--cyan)}
.voice-panel{border-color:#355654;background:linear-gradient(140deg,#13231f,#101827)}.voice-order{list-style:none;padding:0;margin:15px 0 0;display:grid;gap:9px}.voice-card{display:grid;grid-template-columns:39px 1fr auto;gap:12px;align-items:start;padding:13px;border:1px solid #294237;border-radius:11px;background:#0d191b}.voice-rank{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;color:#0a1a1b;background:var(--lime);font-weight:950}.voice-copy b{font-size:13px}.voice-copy p{margin:3px 0;color:var(--muted);font-size:12px}.voice-copy small{display:block;color:#a8c0bd;overflow-wrap:anywhere;font-size:11px}.voice-level{color:#8da69e;font-size:9px;letter-spacing:.08em;font-weight:800}.voice-hint{margin:12px 0 0;padding:10px 12px;background:#152b24;border-radius:9px;color:#c4e7c4;font-size:12px}
.form-row{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.field{display:grid;gap:5px;color:var(--muted);font-size:11px}.field input{width:130px}.field.token{min-width:min(100%,340px);flex:1}.field.token input{width:100%}.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.toolbar p{display:flex;gap:8px;margin:0;flex-wrap:wrap}.checkrow{display:flex;align-items:center;gap:9px;color:#c9d6e5}.checkrow input{accent-color:var(--lime)}.message{min-height:24px;color:var(--cyan);font-size:12px;margin:14px 0 0}.pre{padding:11px;border:1px solid #25374a;border-radius:9px;background:#0a111c;color:#b9c9dc;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,Consolas,monospace;max-height:230px;overflow:auto}.country-box{margin-top:12px}.motor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.motor-card{border:1px solid #25374a;border-radius:11px;background:#0a111c;padding:12px}.motor-card h3{margin:0 0 8px;font-size:13px}.motor-card .meter{height:8px;background:#1a2938;border-radius:8px;overflow:hidden;margin:8px 0}.motor-card .meter i{display:block;height:100%;background:linear-gradient(90deg,#62e6ff,#a4f36d)}.motor-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;color:var(--muted);font-size:11px}.motor-values b{color:var(--text);font-weight:700}.unit-empty{padding:14px;border:1px dashed #29465b;border-radius:10px;color:var(--muted)}.server-footer{display:flex;justify-content:space-between;gap:12px;color:#657b94;font-size:10px;padding:18px 0}
.event-list{list-style:none;padding:0;margin:0;display:grid;gap:8px;max-height:430px;overflow-y:auto}.event-row{display:grid;grid-template-columns:72px 100px minmax(100px,.55fr) minmax(0,1.45fr);gap:10px;align-items:start;padding:10px 12px;border:1px solid #25374a;border-radius:9px;background:#0a111c;font-size:12px}.event-row time,.event-user{color:var(--muted)}.event-kind{color:var(--cyan);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.event-detail{overflow-wrap:anywhere;white-space:pre-wrap}.log-row{display:grid;grid-template-columns:78px 70px minmax(0,1fr);gap:10px;align-items:start;padding:10px 12px;border:1px solid #25374a;border-radius:9px;background:#0a111c;font-size:12px}.log-row time{color:var(--muted)}.log-level{font-size:10px;font-weight:800;letter-spacing:.05em}.log-level.error{color:var(--red)}.log-level.info{color:var(--cyan)}.log-message{overflow-wrap:anywhere;white-space:pre-wrap}
@media(max-width:850px){.hero,.layout{grid-template-columns:1fr}.hero{gap:20px;padding-top:30px}.connection-card{max-width:none}}@media(max-width:560px){.shell{padding:0 14px 28px}.topbar{height:68px}.topmeta{gap:8px}.live-tag{font-size:9px}.hero h1{font-size:37px}.stats{gap:7px}.stat{padding:12px 10px}.panel{padding:15px}.voice-card{grid-template-columns:34px 1fr}.voice-level{grid-column:2}.field.token{min-width:100%}.event-row{grid-template-columns:60px 1fr;gap:6px}.event-user,.event-detail{grid-column:2}.event-kind{grid-column:1;grid-row:2}.log-row{grid-template-columns:60px 1fr;gap:6px}.log-message{grid-column:2}}
</style></head>
<body><div class="shell">
<header class="topbar"><a class="brand" href="/backend"><span class="brandmark">NG</span><span><b>NEGOCIO</b><small>GAME SERVER · CONTROL ROOM</small></span></a><div class="topmeta"><span class="live-tag"><i class="dot"></i> LIVE OPS</span><span id="clock">--:--:--</span></div></header>
<main>
<section class="hero"><div><span class="eyebrow">Game operations / servidor 01</span><h1>Controla la partida.<br><em>Domina el live.</em></h1><p>Centro de mando organizado por unidades de negocio de TortuWorld.</p><div class="hero-actions"><a href="/">Abrir overlay ↗</a><button class="primary" id="voiceToggle">♫ Voz en off</button></div></div></section>
<section class="stats"><article class="stat"><span class="stat-label">Eventos recibidos</span><strong id="eventCount">0</strong><small>En esta sesión</small></article><article class="stat"><span class="stat-label">Regalos recibidos</span><strong id="giftCount">0</strong><small>Contador del servidor</small></article><article class="stat"><span class="stat-label">Overlay</span><strong id="overlayState">Verificando</strong><small id="overlayClients">Buscando clientes activos</small></article></section>
<nav class="unit-nav" id="businessUnits" aria-label="Unidades de negocio">
<button type="button" class="active" data-unit="eventos">Eventos</button><button type="button" data-unit="usuarios">Usuarios</button><button type="button" data-unit="regalos">Regalos</button><button type="button" data-unit="equipos">Equipos</button><button type="button" data-unit="torneos">Torneos</button><button type="button" data-unit="estadisticas">Estadísticas</button><button type="button" data-unit="motor">Motor tiempo real</button><button type="button" data-unit="turbo-equipos">Turbo contador equipos</button><button type="button" data-unit="turbo-regalos">Turbo regalos</button><button type="button" data-unit="voz">Voz en off</button><button type="button" data-unit="honor">Cuadro de honor</button><button type="button" data-unit="narrador">Narrador</button><button type="button" data-unit="acciones">CTAs / Acciones</button><button type="button" data-unit="logs">Logs</button>
</nav>
<section class="panel business-panel" data-units="eventos"><header><h2><span class="icon">⚡</span> Eventos LIVE</h2><span class="pill">ÚLTIMOS 50</span></header><p class="subtle">Eventos recibidos en esta sesión: <b id="eventUnitCount">0</b>. Los más recientes aparecen primero.</p><p class="unit-empty" id="eventEmpty">Esperando el primer evento…</p><ol class="event-list" id="eventList" aria-live="polite"></ol><pre class="pre" id="tools" hidden></pre></section>
<section class="panel business-panel" data-units="logs" id="logsPanel"><header><h2><span class="icon">📜</span> Logs técnicos</h2><span class="pill" id="logsCount">SESIÓN ACTUAL</span></header><p class="subtle">Avisos y errores recientes del servidor. Se conservan mientras esta sesión del servidor está activa.</p><div class="toolbar"><button id="refreshLogs">Actualizar</button></div><p class="unit-empty" id="logsEmpty">Sin registros técnicos todavía.</p><ol class="event-list" id="serverLogs" aria-live="polite"></ol><p class="message" id="logsError" role="status"></p></section>
<section class="panel business-panel" data-units="usuarios"><header><h2><span class="icon">👤</span> Usuarios</h2><span class="pill">LIVE</span></header><pre class="pre" id="recentUsers">Cargando usuarios…</pre><article class="connection-card user-connection"><header><h2>Conexión TikTok</h2><span class="status-pill" id="status">CONECTANDO</span></header><p class="subtle">Usuario actual: <b id="currentUsername">Sin usuario</b></p><p class="subtle" id="statusDetail">Esperando estado del servidor…</p><form id="connect" class="form-row"><label class="field">Usuario del live<input name="username" placeholder="Ingresa el usuario sin @" required></label><button class="primary">Conectar</button><button type="button" id="reconnect">Reintentar</button></form></article></section>
<section class="panel business-panel" data-units="regalos turbo-regalos"><header><h2><span class="icon">🎁</span> Regalos y turbo de regalos</h2><span class="pill">CONTROL</span></header><p class="subtle">Total recibidos: <b id="giftUnitCount">0</b></p><div class="form-row"><label class="field">Avance total del turbo por regalos (%)<input id="gift" type="number" min="0" max="100" value="6"></label><button class="primary" id="saveGiftTurbo">Guardar turbo de regalos</button></div></section>
<section class="panel business-panel" data-units="equipos turbo-equipos"><header><h2><span class="icon">🐢</span> Equipos y turbo del contador</h2><span class="pill">MOTOR</span></header><div class="form-row"><label class="field">Avance del turbo por taps (%)<input id="tap" type="number" min="0" max="100" value="20"></label><button class="primary" id="saveTapTurbo">Guardar turbo de equipos</button><button data-command="turbo-down">Turbo −</button><button data-command="turbo-up">Turbo +</button></div><div class="motor-grid" id="teamTelemetry"><div class="unit-empty">Esperando valores del motor…</div></div></section>
<section class="panel business-panel" data-units="motor"><header><h2><span class="icon">⚙</span> Motor en tiempo real</h2><span class="pill" id="motorStatus">SIN TELEMETRÍA</span></header><p class="subtle">Valores actuales reportados por el overlay y retransmitidos por el servidor.</p><div class="stats"><article class="stat"><span class="stat-label">Fase</span><strong id="motorPhase">—</strong><small id="motorUpdated">Esperando al overlay</small></article><article class="stat"><span class="stat-label">Duración</span><strong id="motorElapsed">—</strong><small>Tiempo de carrera</small></article><article class="stat"><span class="stat-label">Inactividad</span><strong id="motorIdle">—</strong><small>Cuenta regresiva</small></article></div><p class="subtle">Ganador: <b id="motorWinner">—</b> · Eventos procesados: <b id="motorEvents">0</b></p><div class="motor-grid" id="motorTeams"><div class="unit-empty">El overlay debe estar abierto para publicar telemetría.</div></div><pre class="pre" id="motorStats">Estadísticas del motor: esperando datos…</pre></section>
<section class="panel business-panel" data-units="torneos"><header><h2><span class="icon">🏆</span> Torneos</h2><span class="pill">VOTACIÓN</span></header><label class="checkrow"><input id="tournamentEnabled" type="checkbox"> Registrar votos de comentarios reales</label><div class="toolbar"><button class="primary" id="saveTournament">Guardar configuración</button></div></section>
<section class="panel business-panel" data-units="estadisticas"><header><h2><span class="icon">📊</span> Estadísticas por país y presencia</h2><span class="pill">LIVE DATA</span></header><pre class="pre" id="countries">Esperando datos…</pre><div class="country-box"><span class="subtle">Estado del overlay</span><pre class="pre" id="presence">Verificando clientes…</pre></div></section>
<section class="panel business-panel" data-units="voz"><header><h2><span class="icon">♫</span> Voz en off</h2><span class="pill">PRIORIDADES EN VIVO</span></header><p class="subtle">Los números más bajos hablan primero. Un regalo interrumpe los mensajes de menor prioridad.</p><ol class="voice-order" id="voiceOrder"></ol><p class="voice-hint">🎁 Cada regalo se agradece. Desde 1 diamante suena una alerta alegre. Luego: cambios de equipo → comentarios → saludos/acciones → avance y distancia a la meta.</p><p class="message" id="voiceError" role="status"></p></section>
<section class="panel business-panel" data-units="honor"><header><h2><span class="icon">🥇</span> Cuadro de honor</h2><span class="pill">TORNEOS</span></header><pre class="pre" id="honorBoard">Cargando resultados guardados…</pre></section>
<section class="panel business-panel" data-units="narrador voz"><header><h2><span class="icon">🎙</span> Narrador</h2><span class="pill">PROTOCOLO</span></header><p class="subtle">Prioridad actual de narración y reglas de interrupción de voz.</p><ol class="voice-order" id="narratorOrder"></ol><p class="message" id="narratorError" role="status"></p></section>
<section class="panel business-panel" data-units="acciones"><header><h2><span class="icon">🛠</span> CTAs / Acciones</h2><span class="pill">OPERADOR</span></header><p class="subtle">Herramientas de operación del live y la sesión.</p><div class="toolbar"><button id="reset">Reiniciar cronómetro y regalos</button><button data-command="refresh">Recargar overlay</button><button id="logout">Cerrar sesión protegida</button></div></section>
<p class="message" id="message" role="status"></p>
</main><footer class="server-footer"><span>NEGOCIO GAME SERVER</span><span>Control local · datos en tiempo real</span></footer></div>
<script>
const $=s=>document.querySelector(s),headers=()=>({'content-type':'application/json'}),msg=t=>$('#message').textContent=t;
async function admin(path,body){const r=await fetch(path,{method:'POST',headers:headers(),credentials:'same-origin',body:JSON.stringify(body||{})});const j=await r.json();if(!r.ok)throw Error(j.message||r.status);return j}
$('#logout').onclick=async()=>{await fetch('/api/admin/session',{method:'DELETE',credentials:'same-origin'});location.replace('/backend')};
const unitButtons=[...document.querySelectorAll('[data-unit]')];
function showUnit(unit,scrollToPanel=false){
 unitButtons.forEach(button=>{const active=button.dataset.unit===unit;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
 const panels=[...document.querySelectorAll('[data-units]')];
 panels.forEach(panel=>{panel.hidden=!panel.dataset.units.split(/\\s+/).includes(unit)});
 if(scrollToPanel)panels.find(panel=>panel.dataset.units.split(/\\s+/).includes(unit))?.scrollIntoView({behavior:'smooth',block:'start'});
 if(unit==='logs')loadTechnicalLogs();
}
$('#businessUnits').addEventListener('click',event=>{
 const button=event.target.closest('button[data-unit]');
 if(!button)return;
 event.preventDefault();
 const unit=button.dataset.unit;
 showUnit(unit,true);
 if(unit==='voz'||unit==='narrador')loadVoice();
 if(unit==='honor')loadHonorBoard();
});
showUnit('eventos');
$('#clock').textContent=new Date().toLocaleTimeString('es');
setInterval(()=>$('#clock').textContent=new Date().toLocaleTimeString('es'),1000);
$('#refreshLogs').onclick=loadTechnicalLogs;
$('#connect').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:e.target.username.value})});const j=await r.json();if(!r.ok)throw Error(j.message);msg('Conectando con @'+j.username)}catch(x){msg(x.message)}};
$('#reconnect').onclick=async()=>{try{await admin('/api/admin/reconnect');msg('Reconexión solicitada')}catch(e){msg(e.message)}};
$('#saveGiftTurbo').onclick=async()=>{try{await admin('/api/admin/game-settings',{giftTurboProgress:+$('#gift').value,tapTurboProgress:+$('#tap').value});msg('Turbo de regalos guardado')}catch(e){msg(e.message)}};
$('#saveTapTurbo').onclick=async()=>{try{await admin('/api/admin/game-settings',{giftTurboProgress:+$('#gift').value,tapTurboProgress:+$('#tap').value});msg('Turbo del contador de equipos guardado')}catch(e){msg(e.message)}};
$('#saveTournament').onclick=async()=>{try{await admin('/api/admin/tournament-enabled',{enabled:$('#tournamentEnabled').checked});msg('Configuración de Torneo Libre guardada')}catch(e){msg(e.message)}};
$('#reset').onclick=async()=>{if(!confirm('¿Reiniciar el cronómetro y el contador de regalos?'))return;try{await admin('/api/admin/game-tools/reset');msg('Cronómetro reiniciado')}catch(e){msg(e.message)}};
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=async()=>{try{await admin('/api/admin/game-command',{command:b.dataset.command});msg('Comando enviado')}catch(e){msg(e.message)}});
const voiceInfo={gift:['Regalo','Agradece el regalo y activa la alerta alegre desde 1 diamante.','🎁'],move:['Cambio de equipo','Anuncia cuando alguien se une o cambia de equipo.','🔁'],chat:['Comentario','Lee el comentario real del usuario.','💬'],welcome:['Ingreso al live','Da la bienvenida a quien entra.','👋'],action:['Acciones','Agradece likes, seguidores y compartidos.','⚡'],match:['Relato de carrera','Informa posiciones, metros restantes y llegada a la meta.','🏁']};
function renderVoice(data){
 ['voiceOrder','narratorOrder'].forEach(id=>{
  const order=$('#'+id);if(!order)return;order.replaceChildren();
  data.levels.slice().sort((a,b)=>a.priority-b.priority).forEach(level=>{
   const info=voiceInfo[level.id]||[level.id,'Evento de voz configurado.','•'],item=document.createElement('li'),rank=document.createElement('span'),copy=document.createElement('div'),title=document.createElement('b'),desc=document.createElement('p'),phrases=document.createElement('small'),badge=document.createElement('span');
   item.className='voice-card';rank.className='voice-rank';rank.textContent=info[2];copy.className='voice-copy';title.textContent=info[0];desc.textContent=info[1];
   const say=typeof level.say==='string'?[level.say]:Object.entries(level.say||{}).map(([key,value])=>key+': '+value);
   phrases.textContent=say.join(' · ');badge.className='voice-level';badge.textContent='PRIORIDAD '+String(level.priority).padStart(2,'0')+(level.interrupt?' · INTERRUMPE':'');
   copy.append(title,desc,phrases);item.append(rank,copy,badge);order.append(item);
  });
 });
}
async function loadVoice(){
 try{const r=await fetch('/api/voice-priority',{cache:'no-store'});if(!r.ok)throw Error('No se pudo cargar el protocolo de voz ('+r.status+').');const data=await r.json();if(!Array.isArray(data.levels))throw Error('La configuración de voz no tiene niveles válidos.');renderVoice(data);$('#voiceError').textContent='Configuración recibida del servidor · meta a '+data.trackMeters+' m.';$('#narratorError').textContent='Prioridades cargadas desde el servidor.'}
 catch(e){$('#voiceError').textContent=e.message;$('#narratorError').textContent=e.message}
}
$('#voiceToggle').onclick=()=>{showUnit('voz');loadVoice()};
async function loadHonorBoard(){
 try{const response=await fetch('/api/state/cluss.v1',{cache:'no-store'});if(response.status===404){$('#honorBoard').textContent='Todavía no hay resultados guardados.';return}const result=await response.json();if(!response.ok)throw Error(result.message||response.status);$('#honorBoard').textContent=JSON.stringify({wins:result.wins||[],cups:result.cp||{},races:result.races||0,tournamentMode:result.tournamentMode||'clasico'},null,2)}
 catch(error){$('#honorBoard').textContent=error.message}
}
function formatTime(ms){const seconds=Math.floor(Math.max(0,ms)/1000);return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')}
function renderMotorTeams(teams,target){
 target.replaceChildren();
 if(!Array.isArray(teams)||!teams.length){const empty=document.createElement('div');empty.className='unit-empty';empty.textContent='Esperando valores del motor…';target.append(empty);return}
 teams.forEach(team=>{
  const card=document.createElement('article'),title=document.createElement('h3'),meter=document.createElement('div'),fill=document.createElement('i'),values=document.createElement('div');
  card.className='motor-card';title.textContent=team.name;meter.className='meter';fill.style.width=Math.max(0,Math.min(100,team.progress))+'%';meter.append(fill);values.className='motor-values';
  [['Avance',team.progress.toFixed(1)+'%'],['Taps',Math.floor(team.taps)+' / '+team.tapLimit],['Eventos',Math.floor(team.eventTotal)],['Turbo taps',Math.ceil(team.turboMs/1000)+' s'],['Turbo regalos',Math.ceil(team.giftTurboMs/1000)+' s']].forEach(([label,value])=>{const cell=document.createElement('span');cell.textContent=label+': ';const strong=document.createElement('b');strong.textContent=value;cell.append(strong);values.append(cell)});
  card.append(title,meter,values);target.append(card);
 });
}
let lastMotorUpdate=0;
function renderMotor(state){
 if(!state)return;
 lastMotorUpdate=state.updatedAt||Date.now();$('#motorStatus').textContent=state.phase.toUpperCase();$('#motorStatus').classList.toggle('online',state.phase==='running');
 $('#motorPhase').textContent=state.phase.toUpperCase();$('#motorUpdated').textContent='Actualizado '+new Date(lastMotorUpdate).toLocaleTimeString('es');
 $('#motorElapsed').textContent=formatTime(state.elapsedMs);$('#motorIdle').textContent=state.idleSeconds+' s';$('#motorWinner').textContent=state.winner||'—';
 $('#motorEvents').textContent=String(Object.values(state.stats||{}).reduce((sum,value)=>sum+(Number(value)||0),0));
 $('#motorStats').textContent=JSON.stringify(state.stats,null,2);renderMotorTeams(state.teams,$('#motorTeams'));renderMotorTeams(state.teams,$('#teamTelemetry'));
}
function renderTechnicalLogs(logs){
 const list=$('#serverLogs');list.replaceChildren();$('#logsCount').textContent=logs.length+' REGISTROS';$('#logsEmpty').hidden=logs.length>0;
 logs.forEach(log=>{
  const row=document.createElement('li'),time=document.createElement('time'),level=document.createElement('span'),message=document.createElement('span'),timestamp=Number(log.timestamp);
  const date=new Date(Number.isFinite(timestamp)?timestamp:Date.now());
  row.className='log-row';time.dateTime=date.toISOString();time.textContent=date.toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  level.className='log-level '+(log.level==='error'?'error':'info');level.textContent=String(log.level||'info').toUpperCase();
  message.className='log-message';message.textContent=String(log.message||'');row.append(time,level,message);list.append(row);
 });
}
async function loadTechnicalLogs(){
 try{
  const response=await fetch('/api/admin/logs?limit=200',{credentials:'same-origin',cache:'no-store'}),result=await response.json();
  if(!response.ok)throw Error(result.message||response.status);
  if(!Array.isArray(result.logs))throw Error('El servidor devolvió logs inválidos.');
  renderTechnicalLogs(result.logs);$('#logsError').textContent='';
 }catch(error){$('#logsError').textContent=error.message}
}
const eventLabels={member:'Se unió',chat:'Comentario',gift:'Regalo',like:'Me gusta',follow:'Seguidor',share:'Compartido'};
function eventDetail(entry){
 const count=Math.max(1,Math.floor(Number(entry.activityCount)||1));
 if(entry.type==='chat')return entry.content||'Comentario';
 if(entry.type==='gift')return (entry.giftName||'Regalo')+(count>1?' × '+count:'');
 if(entry.type==='like')return count+' me gusta';
 if(entry.type==='follow')return 'Empezó a seguir';
 if(entry.type==='share')return 'Compartió el live';
 return 'Se unió al live';
}
function renderLiveEvent(entry){
 const list=$('#eventList'),row=document.createElement('li'),time=document.createElement('time'),kind=document.createElement('span'),user=document.createElement('span'),detail=document.createElement('span');
 const receivedAt=Number(entry.receivedAt)||Date.now();
 row.className='event-row';time.dateTime=new Date(receivedAt).toISOString();time.textContent=new Date(receivedAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
 kind.className='event-kind';kind.textContent=eventLabels[entry.type]||'Evento';user.className='event-user';user.textContent=entry.username?'@'+entry.username:'—';
 detail.className='event-detail';detail.textContent=eventDetail(entry);row.append(time,kind,user,detail);$('#eventEmpty').hidden=true;list.prepend(row);
 while(list.children.length>50)list.lastElementChild.remove();
}
let received=0;const source=new EventSource('/api/events');
source.addEventListener('status',e=>{const s=JSON.parse(e.data),online=!!s.connected;$('#status').textContent=online?'ONLINE':String(s.status||'DESCONECTADO').toUpperCase();$('#status').classList.toggle('online',online);$('#currentUsername').textContent=s.username?'@'+s.username:'Sin usuario';$('#statusDetail').textContent=online?'Conectado a @'+(s.username||'TikTok'):'Estado del conector: '+(s.status||'sin conexión')+(s.username?' · @'+s.username:'')});
source.addEventListener('update',e=>{const payload=JSON.parse(e.data),entry=payload.entry||{};received++;$('#eventCount').textContent=String(received);$('#eventUnitCount').textContent=String(received);renderLiveEvent(entry)});
setInterval(()=>{if(!$('#logsPanel').hidden)loadTechnicalLogs()},5000);
const motorSource=new EventSource('/api/admin/motor/events');
motorSource.addEventListener('motor-state',event=>renderMotor(JSON.parse(event.data)));
setInterval(()=>{if(lastMotorUpdate&&Date.now()-lastMotorUpdate>2500){$('#motorStatus').textContent='TELEMETRÍA ATRASADA';$('#motorStatus').classList.remove('online')}},1000);
const tools=new EventSource('/api/game-tools/events');
tools.addEventListener('game-tools',e=>{const x=JSON.parse(e.data);$('#tools').textContent=JSON.stringify(x,null,2);$('#giftCount').textContent=String(x.giftCount||0);$('#giftUnitCount').textContent=String(x.giftCount||0)});
tools.addEventListener('game-settings',e=>{const x=JSON.parse(e.data);$('#gift').value=x.giftTurboProgress;$('#tap').value=x.tapTurboProgress});
fetch('/api/recent-users',{cache:'no-store'}).then(async response=>{const result=await response.json();if(!response.ok)throw Error(result.message||response.status);$('#recentUsers').textContent=JSON.stringify(result.users||[],null,2)}).catch(error=>{$('#recentUsers').textContent=error.message});
fetch('/api/admin/tournament-enabled',{credentials:'same-origin',cache:'no-store'}).then(async response=>{const result=await response.json();if(!response.ok)throw Error(result.message||response.status);$('#tournamentEnabled').checked=!!result.enabled}).catch(error=>msg(error.message));
async function refresh(){
 try{
  const [p,c]=await Promise.all([fetch('/api/admin/presence',{credentials:'same-origin'}),fetch('/api/admin/country-stats',{credentials:'same-origin'})]);
  const presence=await p.json(),countries=await c.json();if(!p.ok)throw Error(presence.message||p.status);if(!c.ok)throw Error(countries.message||c.status);
  $('#presence').textContent=JSON.stringify(presence,null,2);$('#countries').textContent=JSON.stringify(countries,null,2);
  $('#overlayState').textContent=presence.active?'ACTIVO':'OFFLINE';$('#overlayClients').textContent=presence.clients+' cliente(s) conectado(s)';
 }catch(e){msg(e.message)}
}
setInterval(refresh,15000);refresh();
</script></body></html>`;

const backendLoginPage = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090e18"><title>Acceso · TortuWorld</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090e18;color:#eaf3ff;font:15px/1.5 Segoe UI,system-ui,sans-serif}.card{width:min(420px,calc(100% - 32px));padding:28px;border:1px solid #29465b;border-radius:16px;background:#111a29;box-shadow:0 16px 40px #0005}h1{font-size:21px;margin:0 0 8px}p{color:#91a4bc;margin:0 0 20px}label{display:grid;gap:7px;color:#91a4bc;font-size:12px}input,button{font:inherit;border-radius:8px;padding:11px 13px}input{width:100%;border:1px solid #31435a;background:#0a1220;color:#eaf3ff}button{margin-top:14px;border:1px solid #57d3ce;background:#1d7884;color:#fff;font-weight:700;cursor:pointer}.error{min-height:22px;margin-top:12px;color:#ff7189;font-size:13px}</style>
<main class="card"><h1>Acceso al backend</h1><p>Ingresa el token de administración para iniciar una sesión protegida de 12 horas.</p><form id="login"><label>Token de administración<input name="token" type="password" autocomplete="current-password" required autofocus></label><button>Iniciar sesión</button></form><div class="error" id="error" role="status"></div></main>
<script>document.getElementById('login').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,error=document.getElementById('error');error.textContent='';try{const response=await fetch('/api/admin/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:form.token.value})});const result=await response.json();if(!response.ok)throw new Error(result.message||'No se pudo iniciar sesión.');location.replace('/backend')}catch(e){error.textContent=e.message;form.token.select()}});</script></html>`;

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

  if (path === '/api/admin/session' && req.method === 'POST') {
    const body = await readBody(req);
    const provided = Buffer.from(typeof body.token === 'string' ? body.token : '');
    const configuredToken = process.env.BACKEND_ADMIN_TOKEN || adminToken;
    const expected = Buffer.from(configuredToken);
    if (!configuredToken || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      safeJson(res, 401, { message: 'Token de administración incorrecto.' });
      return;
    }
    startAdminSession(req, res);
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/session' && req.method === 'DELETE') {
    endAdminSession(req, res);
    safeJson(res, 200, { ok: true });
    return;
  }
  if ((path === '/' || path === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    await serveFile(req, res, HTML_FILE, { deploymentSignature: true });
    return;
  }
  if (path === '/backend' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(req.method === 'HEAD' ? undefined : hasAdminSession(req) ? backendPage : backendLoginPage);
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
    sse(req, res, clients, [['status', {
      connected: connection.connected,
      status: connection.status,
      username: connection.username
    }]]);
    return;
  }
  if (path === '/api/motor/telemetry' && req.method === 'POST') {
    const telemetry = normalizeMotorTelemetry(await readBody(req));
    if (!telemetry) {
      safeJson(res, 400, { message: 'Telemetría del motor inválida.' });
      return;
    }
    motorTelemetry = telemetry;
    broadcastSse(motorClients, 'motor-state', motorTelemetry);
    broadcastSse(clients, 'motor-state', motorTelemetry);
    safeJson(res, 200, { ok: true, updatedAt: motorTelemetry.updatedAt });
    return;
  }
  if (path === '/api/admin/motor/events' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    sse(req, res, motorClients, [['motor-state', motorTelemetry]]);
    return;
  }
  if (path === '/api/admin/logs' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const limitParam = url.searchParams.get('limit');
    const requestedLimit = limitParam === null ? 100 : Number(limitParam);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(MAX_TECHNICAL_LOGS, Math.max(1, Math.floor(requestedLimit)))
      : 100;
    safeJson(res, 200, { logs: technicalLogs.slice(0, limit) });
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
    safeJson(res, 200, { signature: deploymentSignature(html) });
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
    const username = configuredUsername();
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
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const requested = normalizeUsername(body.username);
    if (!requested) {
      safeJson(res, 400, { ok: false, message: 'El usuario de TikTok no puede estar vacío.' });
      return;
    }
    settings.username = requested;
    await persistSettings();
    const username = requested;
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
    void createConnection(configuredUsername());
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
    broadcastTool('game-command', { command: body.command });
    safeJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/admin/tournament-enabled' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    safeJson(res, 200, { enabled: settings.tournamentEnabled });
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
    void pruneLogs().catch(error => recordTechnicalLog('error', `No se pudieron depurar logs: ${error.message}`));
  }, 15 * 60 * 1000).unref();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, seenAt] of seenEventIds) if (seenAt < cutoff) seenEventIds.delete(id);
  }, 60000).unref();
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      recordTechnicalLog('error', `Error de solicitud: ${error.message}`);
      if (!res.headersSent) safeJson(res, error.status || 500, { message: error.status ? error.message : 'Error interno del servidor.' });
      else res.destroy();
    });
  });
  server.listen(PORT, HOST, () => {
    recordTechnicalLog('info', `TortuWorld escuchando en http://${HOST}:${PORT}`);
    const username = configuredUsername();
    if (username) void createConnection(username);
  });
  const shutdown = async () => {
    shuttingDown = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      if (connector?.disconnect) await connector.disconnect();
    } catch (error) {
      recordTechnicalLog('error', `Error al cerrar TikTok: ${error.message}`);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export {
  normalizeUsername,
  configuredUsername,
  normalizeTikTokEvent,
  comboDelta,
  dedupeEvent,
  identifyCountry,
  socialEventType,
  appendRecords,
  stateSnapshot,
  handle,
  main
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}

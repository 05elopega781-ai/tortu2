import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { comboDelta, configuredUsername, dedupeEvent, handle, identifyCountry, normalizeTikTokEvent, normalizeUsername, socialEventType } from './server.js';
import voicePriority from './server/voice-priority.js';

test('live event counters count events, not weighted interaction points', () => {
  const browser = { window: {} };
  runInNewContext(readFileSync(new URL('./public/activity-policy.js', import.meta.url), 'utf8'), browser);
  const policy = browser.window.TORTUWORLD_ACTIVITY_POLICY;
  assert.equal(policy.HEART_MAX, 100);
  assert.equal(policy.eventCountDelta('chat', 8), 1);
  assert.equal(policy.eventCountDelta('follow', 8), 1);
  assert.equal(policy.eventCountDelta('share', 8), 1);
  assert.equal(policy.eventCountDelta('like', 8), 8);
  assert.equal(policy.eventCountDelta('gift', 3), 3);
  assert.equal(policy.eventCountDelta('unknown', 3), 0);
  assert.equal(policy.statEventDelta('chat', 8), 5);
  assert.equal(policy.statEventDelta('gift', 3), 30);
});

test('deployment check accepts the current signature and reloads a stale overlay once', async () => {
  const html = readFileSync(new URL('./v21_voz_saludos_backend.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const loadCheck = (pageSignature, serverSignature) => {
    let replacedUrl = '';
    const window = { caches: { keys: async () => [], delete: async () => true } };
    const context = {
      window,
      caches: window.caches,
      document: { querySelector: () => ({ content: pageSignature }) },
      fetch: async () => ({ ok: true, json: async () => ({ signature: serverSignature }) }),
      location: { href: 'https://overlay.example/', replace: url => { replacedUrl = url; } },
      history: { replaceState() {} },
      URL,
      Promise,
      console
    };
    runInNewContext(script, context);
    return { ready: window.clussDeploymentReady, replacedUrl: () => replacedUrl };
  };
  const current = loadCheck('sha256-aaaaaaaaaaaaaaaa', 'sha256-aaaaaaaaaaaaaaaa');
  assert.equal(await current.ready, true);
  assert.equal(current.replacedUrl(), '');
  const stale = loadCheck('sha256-aaaaaaaaaaaaaaaa', 'sha256-bbbbbbbbbbbbbbbb');
  assert.equal(await stale.ready, false);
  assert.match(stale.replacedUrl(), /_cluss_deploy=sha256-bbbbbbbbbbbbbbbb/);
});

test('username normalization strips leading @ and whitespace', () => {
  assert.equal(normalizeUsername('  @@ tortu  '), 'tortu');
  assert.equal(normalizeUsername('  '), '');
});

test('a username selected in the backend takes precedence over the environment default', () => {
  const previous = process.env.TIKTOK_USERNAME;
  process.env.TIKTOK_USERNAME = 'default_account';
  try {
    assert.equal(configuredUsername('  @selected_account  '), 'selected_account');
    assert.equal(configuredUsername(''), 'default_account');
  } finally {
    if (previous === undefined) delete process.env.TIKTOK_USERNAME;
    else process.env.TIKTOK_USERNAME = previous;
  }
});

test('backend login protects the panel and admin APIs until a session cookie is set', async () => {
  const previousToken = process.env.BACKEND_ADMIN_TOKEN;
  process.env.BACKEND_ADMIN_TOKEN = 'test-admin-token';
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lockedPage = await fetch(`${baseUrl}/backend`);
    assert.match(await lockedPage.text(), /Acceso al backend/);
    const lockedApi = await fetch(`${baseUrl}/api/admin/presence`);
    assert.equal(lockedApi.status, 401);
    const lockedConnect = await fetch(`${baseUrl}/api/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'other_account' })
    });
    assert.equal(lockedConnect.status, 401);

    const rejectedLogin = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' })
    });
    assert.equal(rejectedLogin.status, 401);
    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-admin-token' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.match(cookie, /^tortu_admin_session=/);

    const unlockedPage = await fetch(`${baseUrl}/backend`, { headers: { cookie } });
    assert.match(await unlockedPage.text(), /Controla la partida/);
    const unlockedApi = await fetch(`${baseUrl}/api/admin/presence`, { headers: { cookie } });
    assert.equal(unlockedApi.status, 200);

    const logout = await fetch(`${baseUrl}/api/admin/session`, { method: 'DELETE', headers: { cookie } });
    assert.equal(logout.status, 200);
    const lockedAgain = await fetch(`${baseUrl}/backend`, { headers: { cookie } });
    assert.match(await lockedAgain.text(), /Acceso al backend/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.BACKEND_ADMIN_TOKEN;
    else process.env.BACKEND_ADMIN_TOKEN = previousToken;
  }
});

test('TikTok events are normalized to the six allowed types without forwarding bot', () => {
  const entry = normalizeTikTokEvent('chat', {
    user: { uniqueId: 'fan1', profilePictureUrl: 'https://example.test/avatar.jpg' },
    comment: 'Hola',
    bot: true
  });
  assert.deepEqual(entry, {
    type: 'chat',
    username: 'fan1',
    content: 'Hola',
    activityCount: 1,
    giftName: '',
    profilePictureUrl: 'https://example.test/avatar.jpg'
  });
  assert.equal(normalizeTikTokEvent('emote', { comment: 'ignored' }), null);
  assert.equal(normalizeTikTokEvent('gift', {
    user: { uniqueId: 'fan1', avatarUrl: 'https://example.test/avatar.png' },
    gift_name: 'Rose',
    diamondCount: 1,
    repeatCount: 2
  })?.giftName, 'Rose');
  assert.equal(normalizeTikTokEvent('gift', {
    user: { uniqueId: 'fan1' },
    gift_name: 'Rose',
    diamondCount: 1,
    repeatCount: 2
  })?.giftDiamonds, 1);
});

test('repeated likes from one user pass event dedupe and contribute to live stats and taps', () => {
  const browser = { window: {} };
  runInNewContext(readFileSync(new URL('./public/activity-policy.js', import.meta.url), 'utf8'), browser);
  const policy = browser.window.TORTUWORLD_ACTIVITY_POLICY;
  const events = [
    { id: 'user-id-42', user: { uniqueId: 'fan1' }, likeCount: 3 },
    { id: 'user-id-42', user: { uniqueId: 'fan1' }, likeCount: 2 }
  ];
  const entries = events
    .filter(event => !dedupeEvent(event, 'like'))
    .map(event => normalizeTikTokEvent('like', event));

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.username), ['fan1', 'fan1']);
  assert.deepEqual(entries.map(entry => entry.activityCount), [3, 2]);
  assert.equal(entries.reduce((total, entry) => total + policy.eventCountDelta(entry.type, entry.activityCount), 0), 5);
  assert.equal(entries.reduce((total, entry) => total + policy.statEventDelta(entry.type, entry.activityCount), 0), 5);
  assert.equal(entries.reduce((total, entry) => total + policy.tapEventDelta(entry.type, entry.activityCount), 0), 5);
  assert.equal(dedupeEvent({ msgId: 'like-event-1' }, 'like'), false);
  assert.equal(dedupeEvent({ msgId: 'like-event-1' }, 'like'), true);
});

test('gift combos emit only the new repeat-count delta', () => {
  const item = count => ({
    user: { uniqueId: 'fan2' },
    giftId: 7,
    groupId: 'combo-a',
    giftType: 1,
    repeatCount: count
  });
  assert.equal(comboDelta(item(1)), 1);
  assert.equal(comboDelta(item(3)), 2);
  assert.equal(comboDelta(item(3)), 0);
});

test('social event actions classify follows and shares for live counters', () => {
  assert.equal(socialEventType({ action: 'follow' }), 'follow');
  assert.equal(socialEventType({ action: 'share' }), 'share');
  assert.equal(socialEventType({ shareTarget: 'chat' }), 'share');
  assert.equal(socialEventType({ action: 'like' }), '');
});

test('country recognition accepts names and ISO codes', () => {
  assert.equal(identifyCountry('Vamos Paraguay')?.code, 'PY');
  assert.equal(identifyCountry('🇨🇱 Chile')?.code, 'CL');
  assert.equal(identifyCountry('🇬🇧')?.code, 'GB');
});

test('PWA manifest is named tortu2 and requests fullscreen with install icons', () => {
  const manifest = JSON.parse(readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'tortu2');
  assert.equal(manifest.short_name, 'tortu2');
  assert.equal(manifest.display, 'fullscreen');
  assert.deepEqual(manifest.icons.filter(icon => icon.type === 'image/png').map(icon => icon.sizes), ['192x192', '512x512']);
  for (const size of [192, 512]) {
    const icon = readFileSync(new URL(`./public/icons/tortu2-${size}.png`, import.meta.url));
    assert.equal(icon.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
});

test('service worker caches only the shell and bypasses live API responses', () => {
  const worker = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /tortu2-shell-/);
});

test('voice-priority response matches the overlay speech template contract', () => {
  const levels = Object.fromEntries(voicePriority.levels.map(level => [level.id, level]));
  assert.deepEqual(Object.keys(levels.move.say).sort(), ['from', 'to']);
  assert.match(levels.chat.say, /\{text\}/);
  assert.deepEqual(Object.keys(levels.action.say).sort(), ['follow', 'like', 'share']);
  assert.deepEqual(Object.keys(levels.match.say).sort(), ['final', 'normal', 'start', 'win']);
  assert.match(levels.welcome.say, /\{user\}/);
  assert.deepEqual(['gift', 'move', 'chat', 'welcome', 'action', 'match'].map(id => levels[id].priority), [0, 1, 2, 3, 3, 4]);
  assert.equal(levels.gift.ttlMs, 0);
  assert.equal(levels.gift.max, 0);
});

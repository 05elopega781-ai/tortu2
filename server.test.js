import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
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

test('backend exposes business-unit buttons and live motor telemetry', async () => {
  const previousToken = process.env.BACKEND_ADMIN_TOKEN;
  process.env.BACKEND_ADMIN_TOKEN = 'motor-test-token';
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'motor-test-token' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const page = await fetch(`${baseUrl}/backend`, { headers: { cookie } });
    const html = await page.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
    for (const unit of ['eventos', 'usuarios', 'regalos', 'equipos', 'torneos', 'estadisticas', 'motor', 'turbo-equipos', 'turbo-regalos', 'voz', 'honor', 'narrador', 'acciones']) {
      assert.match(html, new RegExp(`data-unit="${unit}"`));
    }

    const invalid = await fetch(`${baseUrl}/api/motor/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'running', teams: [] })
    });
    assert.equal(invalid.status, 400);

    const telemetry = {
      phase: 'running',
      elapsedMs: 12000,
      idleSeconds: 47,
      winner: '',
      stats: { like: 24, chat: 2 },
      turbo: { tapProgress: 20, tapDurationMs: 7000, giftProgress: 6, giftDurationMs: 15000 },
      teams: [
        { id: 'ol', name: 'Olimpia', progress: 12.5, taps: 4, tapLimit: 50, eventTotal: 7, turboMs: 3000, giftTurboMs: 0 },
        { id: 'cp', name: 'Cerro Porteño', progress: 9, taps: 0, tapLimit: 50, eventTotal: 2, turboMs: 0, giftTurboMs: 1000 }
      ]
    };
    const overlayStream = await fetch(`${baseUrl}/api/events`);
    const overlayReader = overlayStream.body.getReader();
    await overlayReader.read();
    const published = await fetch(`${baseUrl}/api/motor/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(telemetry)
    });
    assert.equal(published.status, 200);
    try {
      const relayed = await overlayReader.read();
      assert.match(new TextDecoder().decode(relayed.value), /event: motor-state[\s\S]*"phase":"running"/);
    } finally {
      await overlayReader.cancel();
    }

    const stream = await fetch(`${baseUrl}/api/admin/motor/events`, { headers: { cookie } });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    try {
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /event: motor-state[\s\S]*"phase":"running"/);
    } finally {
      await reader.cancel();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.BACKEND_ADMIN_TOKEN;
    else process.env.BACKEND_ADMIN_TOKEN = previousToken;
  }
});

test('overlay keeps its race design and opens monitor tabs matching the backend units', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  assert.match(html, /<main id="app">/);
  assert.match(html, /id="bMonitor"/);
  assert.match(html, /aria-label="Monitor por unidad de negocio"/);
  for (const unit of ['eventos', 'usuarios', 'regalos', 'equipos', 'torneos', 'estadisticas', 'motor', 'turbo-equipos', 'turbo-regalos', 'voz', 'honor', 'narrador', 'acciones']) {
    assert.match(html, new RegExp(`data-tab="${unit}"`));
  }
  assert.match(html, /addEventListener\('motor-state'/);
});

test('overlay displays package.json version and uses it in deployment signature', async () => {
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
    const pageResponse = await fetch(`${baseUrl}/`);
    const page = await pageResponse.text();
    assert.match(page, new RegExp(`aria-label="Versión ${packageVersion}">v${packageVersion}`));

    const source = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8')
      .replaceAll('__TORTUWORLD_PACKAGE_VERSION__', packageVersion);
    const expectedSignature = `sha256-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
    const signatureResponse = await fetch(`${baseUrl}/api/deployment-signature`);
    const { signature } = await signatureResponse.json();
    assert.equal(pageResponse.headers.get('x-cluss-deployment-signature'), expectedSignature);
    assert.equal(signature, expectedSignature);
  } finally {
    await new Promise(resolve => server.close(resolve));
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

test('raw TikTok likes pass the frontend statistics and per-team tap counter', () => {
  const browser = { window: {} };
  runInNewContext(readFileSync(new URL('./public/activity-policy.js', import.meta.url), 'utf8'), browser);
  const policy = browser.window.TORTUWORLD_ACTIVITY_POLICY;
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const entryHandler = html.match(/function handleLiveEntry\(entry\)\{[\s\S]*?\n\}(?=\n\/\* Pinta el estado de conexion)/)?.[0];
  const tapHandler = html.match(/function heartAdd\(t,n\)\{[\s\S]*?\n\}/)?.[0];
  const statisticsHandler = html.match(/const _hleSt=handleLiveEntry;\nhandleLiveEntry=function\(e\)\{[\s\S]*?\n\};(?=\n\/\* ===== MEDICIÓN DE ACTIVIDAD)/)?.[0];
  assert.ok(entryHandler);
  assert.ok(tapHandler);
  assert.ok(statisticsHandler);

  const context = {
    window: { TORTUWORLD_ACTIVITY_POLICY: policy },
    document: { querySelector: () => null },
    console,
    Date,
    setTimeout,
    clearTimeout
  };
  runInNewContext(`
    const TAP_POLICY = window.TORTUWORLD_ACTIVITY_POLICY;
    const T = [{id:'team-0'}, {id:'team-1'}];
    let HEART_N = 50;
    const HEART_TURBO_MS = 7000, HEART_TURBO_PROGRESS = 20, HEART_TURBO_PPS = 20 / 7;
    const heart = [0, 0];
    const ST = {member:0, chat:0, gift:0, like:0, follow:0, share:0};
    const teamStatistics = [0, 0], activations = [0, 0], lastChat = new Map(), picks = new Map();
    let sel = 0, over = false, lead = -1, lastInteractionAt = 0, matchInteractionCount = 0;
    const heartElement = {classList:{remove(){},add(){}}, offsetWidth:0};
    const $ = () => heartElement, tapStep = () => {}, renderHeart = () => {}, tapPop = () => {};
    const update = () => 0, turboOn = team => { activations[team]++ }, float = () => {}, hype = () => {}, A = {sfx(){}};
    const recentChatTeam = () => -1, trackTournamentMentions = () => false, trackLaneInteraction = () => {};
    const push = () => {}, stUser = () => {}, saveTournamentProgress = () => {}, logStat = () => {}, stFmt = String;
    const DUELO = [];
    window.addTeamEventTotal = (team, count) => { if(Number.isInteger(team)) teamStatistics[team] += count };
    window.resolveSupportTeamFor = username => username === 'fan1' ? 0 : 1;
    ${tapHandler}
    window.recordLiveTap=(team,count)=>heartAdd(team,count);
    ${entryHandler}
    ${statisticsHandler}
    globalThis.processEvent = entry => handleLiveEntry(entry);
    globalThis.snapshot = () => ({heart, teamStatistics, activations, liveStatistics:ST});
  `, context);

  const events = [
    { id: 'user-id-42', user: { uniqueId: 'fan1' }, likeCount: 3 },
    { id: 'user-id-42', user: { uniqueId: 'fan1' }, likeCount: 2 },
    { id: 'user-id-73', user: { uniqueId: 'fan2' }, likeCount: 4 },
    { id: 'user-id-42', user: { uniqueId: 'fan1' }, likeCount: 45 }
  ];
  events.forEach(event => {
    if (!dedupeEvent(event, 'like')) context.processEvent(normalizeTikTokEvent('like', event));
  });
  const result = JSON.parse(JSON.stringify(context.snapshot()));
  assert.deepEqual(result.heart, [0, 4]);
  assert.deepEqual(result.activations, [1, 0]);
  assert.deepEqual(result.teamStatistics, [50, 4]);
  assert.equal(result.liveStatistics.like, 54);
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

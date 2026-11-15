import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { comboDelta, configuredUsername, dedupeEvent, handle, handleTikTokEvent, identifyCountry, normalizeTikTokEvent, normalizeUsername, socialEventType } from './server.js';
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
    const lockedLogs = await fetch(`${baseUrl}/api/admin/logs`);
    assert.equal(lockedLogs.status, 401);
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
    const unlockedLogs = await fetch(`${baseUrl}/api/admin/logs?limit=20`, { headers: { cookie } });
    assert.equal(unlockedLogs.status, 200);
    assert.deepEqual((await unlockedLogs.json()).logs, []);

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

test('backend VS settings default to the two requested fixtures and validate saved selections', async () => {
  const previousToken = process.env.BACKEND_ADMIN_TOKEN;
  process.env.BACKEND_ADMIN_TOKEN = 'vs-config-test-token';
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let previousState;
  let hadPreviousState = false;

  try {
    const savedState = await fetch(`${baseUrl}/api/state/cluss.vs`);
    if (savedState.ok) {
      hadPreviousState = true;
      previousState = await savedState.json();
    }
    await fetch(`${baseUrl}/api/state/cluss.vs`, { method: 'DELETE' });

    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'vs-config-test-token' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const headers = { cookie, 'content-type': 'application/json' };

    const defaults = await fetch(`${baseUrl}/api/admin/vs-config`, { headers });
    assert.equal(defaults.status, 200);
    const defaultList = (await defaults.json()).list;
    assert.equal(defaultList.length, 20);
    assert.deepEqual(defaultList.filter(item => item.on).map(item => item.k), ['cp|ol', 'ucl-bc|ucl-rm']);
    assert.deepEqual(defaultList.filter(item => item.popular).map(item => item.k), ['cp|ol', 'ucl-bc|ucl-rm']);

    await fetch(`${baseUrl}/api/state/cluss.vs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 3,
        cur: 'ucl-bc|ucl-rm',
        list: [{ k: 'cp|ol', on: false }, { k: 'ucl-bc|ucl-rm', on: true }],
        st: { 'ucl-bc|ucl-rm': { r: 2 } }
      })
    });
    const migrated = await fetch(`${baseUrl}/api/admin/vs-config`, { headers });
    const migratedList = (await migrated.json()).list;
    assert.deepEqual(migratedList.filter(item => item.on).map(item => item.k), ['ucl-bc|ucl-rm']);
    assert.deepEqual(migratedList.filter(item => item.popular).map(item => item.k), ['cp|ol', 'ucl-bc|ucl-rm']);

    const saved = await fetch(`${baseUrl}/api/admin/vs-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabledKeys: ['ucl-bc|ucl-rm'], popularKeys: [] })
    });
    assert.equal(saved.status, 200);
    const updated = await fetch(`${baseUrl}/api/admin/vs-config`, { headers });
    const updatedList = (await updated.json()).list;
    assert.deepEqual(updatedList.filter(item => item.on).map(item => item.k), ['ucl-bc|ucl-rm']);
    assert.deepEqual(updatedList.filter(item => item.popular), []);

    const invalid = await fetch(`${baseUrl}/api/admin/vs-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabledKeys: ['ucl-bc|ucl-rm'], popularKeys: ['not-a-fixture'] })
    });
    assert.equal(invalid.status, 400);
  } finally {
    if (hadPreviousState) {
      await fetch(`${baseUrl}/api/state/cluss.vs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(previousState)
      });
    } else {
      await fetch(`${baseUrl}/api/state/cluss.vs`, { method: 'DELETE' });
    }
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.BACKEND_ADMIN_TOKEN;
    else process.env.BACKEND_ADMIN_TOKEN = previousToken;
  }
});

test('gift catalog starts with Rose enabled and validates the rotation interval', async () => {
  const previousToken = process.env.BACKEND_ADMIN_TOKEN;
  process.env.BACKEND_ADMIN_TOKEN = 'gift-config-test-token';
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let previousState;
  let hadPreviousState = false;

  try {
    const savedState = await fetch(`${baseUrl}/api/state/cluss.gifts`);
    if (savedState.ok) {
      hadPreviousState = true;
      previousState = await savedState.json();
    }
    await fetch(`${baseUrl}/api/state/cluss.gifts`, { method: 'DELETE' });

    const login = await fetch(`${baseUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'gift-config-test-token' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const headers = { cookie, 'content-type': 'application/json' };

    const defaults = await fetch(`${baseUrl}/api/admin/gifts-config`, { headers });
    assert.equal(defaults.status, 200);
    const defaultConfig = await defaults.json();
    assert.equal(defaultConfig.rotationSeconds, 10);
    assert.equal(defaultConfig.catalog.length, 28);
    assert.deepEqual(defaultConfig.catalog.map(item => [item.key, item.value]), [
      ['rose', 1], ['tiktok', 1], ['ice-cream-cone', 1], ['finger-heart', 5],
      ['panda', 5], ['mic', 5], ['doughnut', 30], ['toilet-paper', 50],
      ['swan', 99], ['heart', 100], ['confetti', 100], ['sunglasses', 199],
      ['crown', 199], ['boxing-gloves', 299], ['corgi', 299], ['money-rain', 500],
      ['diamond', 1000], ['fireworks', 1088], ['train', 2988], ['motorcycle', 2988],
      ['private-jet', 6000], ['sports-car', 7000], ['yacht', 9888], ['eagle', 10999],
      ['rocket', 20000], ['fantasy-castle', 20000], ['lion', 29999], ['tiktok-universe', 44999],
    ]);
    assert.deepEqual(defaultConfig.catalog.filter(item => item.enabled).map(item => item.key), ['rose']);

    await fetch(`${baseUrl}/api/state/cluss.gifts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        rotationSeconds: 14,
        catalog: [{ key: 'rose', name: 'Rose (Rosita)', value: 1, enabled: true, aliases: ['rose'] }]
      })
    });
    const migratedResponse = await fetch(`${baseUrl}/api/admin/gifts-config`, { headers });
    const migrated = await migratedResponse.json();
    assert.equal(migrated.catalog.length, 28);
    assert.equal(migrated.rotationSeconds, 14);
    assert.equal(migrated.catalog.find(item => item.key === 'tiktok-universe').value, 44999);
    assert.deepEqual(migrated.catalog.filter(item => item.enabled).map(item => item.key), ['rose']);

    const invalid = await fetch(`${baseUrl}/api/admin/gifts-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabledKeys: ['rose'], rotationSeconds: 0 })
    });
    assert.equal(invalid.status, 400);

    const saved = await fetch(`${baseUrl}/api/admin/gifts-config`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabledKeys: ['rose'], rotationSeconds: 12 })
    });
    assert.equal(saved.status, 200);
    const updated = await saved.json();
    assert.equal(updated.config.rotationSeconds, 12);
    assert.deepEqual(updated.config.catalog.filter(item => item.enabled).map(item => item.key), ['rose']);
  } finally {
    if (hadPreviousState) {
      await fetch(`${baseUrl}/api/state/cluss.gifts`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(previousState)
      });
    } else {
      await fetch(`${baseUrl}/api/state/cluss.gifts`, { method: 'DELETE' });
    }
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.BACKEND_ADMIN_TOKEN;
    else process.env.BACKEND_ADMIN_TOKEN = previousToken;
  }
});

test('overlay retains the active VS until inactivity and resets cups only on the next VS', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const script = html.match(/<script id="vs-motor-js">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const fixtures = [
    ['ol', 'cp', 'Superclásico'],
    ['ucl-bc', 'ucl-rm', 'El Clásico'],
    ['lib-boc', 'lib-riv', 'Superclásico'],
    ['cl-cel', 'cl-ran', 'Old Firm'],
  ];
  const listeners = new Map();
  const app = { appendChild() {} };
  const foot = { appendChild() {} };
  const panelBody = {};
  const panel = {
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    querySelector: () => panelBody,
  };
  const savedStates = [];
  const window = {
    liveEventMonitor: { completeRound() { return Promise.resolve(); } },
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  let nextMatchCalls = 0;
  const context = {
    window,
    document: {
      getElementById: id => id === 'app' ? app : null,
      querySelector: () => foot,
      createElement: () => panel,
    },
    CLASSIC_DEFS: fixtures,
    SRV: {
      get: () => null,
      set: (key, value) => savedStates.push({ key, value }),
    },
    T: [{ id: 'ol', n: 'Olimpia', c: '#fff' }, { id: 'cp', n: 'Cerro', c: '#f00' }],
    P: { cl: { 'ucl-bc|ucl-rm': { 'ucl-bc': 4 } }, cp: { ol: 7 }, wins: [1, 0] },
    tournamentItem: id => ({ n: id }),
    tournamentMode: 'clasico',
    classicFixtureIndex: 0,
    BR: null,
    brNew() {
      const fixture = fixtures[context.classicFixtureIndex];
      return { duel: fixture.slice(0, 2), r: [] };
    },
    brCur: () => null,
    nextMatch() { nextMatchCalls++; },
    reset() {},
    lowActivityFinished: false,
  };
  runInNewContext(script, context);

  const vs = window.gamiVS;
  assert.deepEqual(Array.from(vs.data.list.filter(item => item.on), item => item.k), ['cp|ol', 'ucl-bc|ucl-rm']);
  assert.deepEqual(Array.from(vs.data.list.filter(item => item.popular), item => item.k), ['cp|ol', 'ucl-bc|ucl-rm']);
  const currentKey = vs.data.cur;
  listeners.get('vs-config-update')({ detail: { enabledKeys: ['ucl-bc|ucl-rm'] } });
  assert.equal(vs.curVS().k, currentKey);
  assert.equal(context.P.cl['ucl-bc|ucl-rm']['ucl-bc'], 4);

  context.lowActivityFinished = true;
  window.liveEventMonitor.completeRound('ol');
  assert.equal(vs.data.cur, 'ucl-bc|ucl-rm');
  assert.equal(context.P.cl['ucl-bc|ucl-rm']['ucl-bc'], 4);
  context.nextMatch();
  assert.equal(nextMatchCalls, 1);
  assert.deepEqual(Array.from(context.P.wins), [0, 0]);
  assert.equal(Object.keys(context.P.cl['ucl-bc|ucl-rm']).length, 0);
  assert.deepEqual(context.P.cp, { ol: 7 });
  assert.equal(JSON.stringify(context.P.br.duel), JSON.stringify(['ucl-bc', 'ucl-rm']));
  assert.ok(savedStates.some(item => item.key === 'cluss.vs'));

  listeners.get('vs-config-update')({ detail: {
    enabledKeys: ['cp|ol', 'ucl-bc|ucl-rm', 'lib-boc|lib-riv', 'cl-cel|cl-ran'],
    popularKeys: ['cp|ol', 'ucl-bc|ucl-rm']
  } });
  vs.data.cur = 'cp|ol';
  const next = () => {
    vs.data.cur = vs.advance();
    return vs.data.cur;
  };
  assert.equal(next(), 'ucl-bc|ucl-rm');
  assert.equal(next(), 'lib-boc|lib-riv');
  assert.equal(next(), 'cp|ol');
  assert.equal(next(), 'ucl-bc|ucl-rm');
  assert.equal(next(), 'cl-cel|cl-ran');
});

test('honor avatar uses a pulsing TikTok rose without placeholder text when no photo exists', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const marker = "const box=document.createElement('section');box.id='honor'";
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const scriptStart = html.lastIndexOf('<script>', markerIndex);
  const scriptEnd = html.indexOf('</script>', markerIndex);
  const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
  let honorMarkup = '';
  const pd = {};
  Object.defineProperty(pd, 'innerHTML', {
    get: () => honorMarkup,
    set: value => { honorMarkup = value; },
  });
  const box = {
    setAttribute() {},
    querySelector: () => pd,
    set innerHTML(value) { honorMarkup = value; },
  };
  const side = { firstChild: {}, querySelector: () => null, insertBefore() {} };
  const context = {
    window: { addEventListener() {} },
    document: {
      querySelector: () => side,
      createElement: () => box,
    },
    setInterval: () => 1,
    clearInterval() {},
    safe: callback => {
      try { return callback(); } catch { return undefined; }
    },
    SRV: { get: () => null },
    T: [],
    recentChatTeam: () => -1,
    handleLiveEntry() {},
    reset() {},
  };
  runInNewContext(script, context);

  assert.match(honorMarkup, /class="av rose" aria-hidden="true">🌹/);
  assert.doesNotMatch(honorMarkup, /—/);
  context.handleLiveEntry({ bot: false, type: 'gift', username: 'ana', activityCount: 1 });
  assert.match(honorMarkup, /class="av rose" aria-hidden="true">🌹/);
  assert.match(html, /@keyframes hnRosePulse/);
});

test('team event totals reset on each race and cup cards omit audience', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const resetCode = html.match(/function resetTeamEventTotals\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(resetCode);
  const renderedTeams = [];
  const eventTotals = new Map([['ol', 6], ['cp', 3]]);
  const resetTotals = new Function(
    'teamEventTotals', 'T', 'renderTeamEventTotal',
    `${resetCode}; return resetTeamEventTotals;`
  )(eventTotals, [{ id: 'ol' }, { id: 'cp' }], index => renderedTeams.push(index));
  resetTotals();
  assert.equal(eventTotals.size, 0);
  assert.deepEqual(renderedTeams, [0, 1]);
  assert.match(html, /resetTeamEventTotals\(\);\s*_resetTurboLimit/);
  assert.doesNotMatch(html, /class="cc-fans"|fans-copas-js|gamiFans/);
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
    assert.match(html, /id="eventList"/);
    assert.match(html, /id="copyEvents"/);
    assert.match(html, /ÚLTIMOS 50/);
    assert.match(html, /<aside class="event-filters" aria-label="Filtrar eventos">/);
    for (const type of ['member', 'chat', 'like', 'follow', 'share', 'gift']) {
      assert.match(html, new RegExp(`data-event-filter="${type}"`));
    }
    assert.match(script, /while\(list\.children\.length>50\)/);
    assert.match(script, /navigator\.clipboard\.writeText\(text\)/);
    assert.match(script, /row\.dataset\.eventType=entry\.type/);
    const filterCode = script.match(/function applyEventFilters\(\)\{[\s\S]*?\n\}/)?.[0];
    assert.ok(filterCode);
    const filterInputs = ['all', 'member', 'chat', 'like', 'follow', 'share', 'gift'].map(type => ({
      dataset: { eventFilter: type },
      checked: true
    }));
    const eventRows = ['chat', 'like'].map(type => ({ dataset: { eventType: type }, hidden: false }));
    const eventList = { children: eventRows };
    const eventEmpty = { hidden: true, textContent: '' };
    const filter = new Function(
      'eventFilterInputs',
      'eventTypeFilters',
      '$',
      `${filterCode}; return applyEventFilters;`
    )(
      filterInputs,
      filterInputs.filter(input => input.dataset.eventFilter !== 'all'),
      selector => selector === '#eventList' ? eventList : eventEmpty
    );
    filter();
    filterInputs.find(input => input.dataset.eventFilter === 'chat').checked = false;
    filter();
    assert.equal(eventRows[0].hidden, true);
    assert.equal(eventRows[1].hidden, false);
    assert.equal(filterInputs[0].checked, false);
    filterInputs.find(input => input.dataset.eventFilter === 'like').checked = false;
    filter();
    assert.equal(eventEmpty.hidden, false);
    assert.match(eventEmpty.textContent, /No hay eventos/);
    assert.match(html, /<button type="button" class="active" data-unit="eventos">/);
    const userPanel = html.match(/<section class="panel business-panel" data-units="usuarios">([\s\S]*?)<\/section>/)?.[1];
    assert.ok(userPanel);
    assert.match(userPanel, /id="currentUsername"/);
    assert.match(userPanel, /id="status"/);
    assert.match(userPanel, /<form id="connect"/);
    assert.match(userPanel, /name="username"/);
    for (const unit of ['eventos', 'usuarios', 'regalos', 'equipos', 'torneos', 'estadisticas', 'motor', 'turbo-equipos', 'turbo-regalos', 'voz', 'honor', 'narrador', 'acciones', 'logs']) {
      assert.match(html, new RegExp(`data-unit="${unit}"`));
    }
    assert.match(html, /id="serverLogs"/);
    assert.match(html, /Logs técnicos/);
    const vsPanel = html.match(/<section class="panel business-panel" data-units="equipos torneos">([\s\S]*?)<\/section>/)?.[1];
    assert.ok(vsPanel);
    assert.match(vsPanel, /rotación de VS/);
    assert.match(script, /dataset\.vsPopularKey=duel\.k/);
    assert.match(script, /unit==='equipos'\)loadVsConfig\(\)/);
    const navigationStart = script.indexOf('const unitButtons=');
    const navigationEnd = script.indexOf("$('#clock').textContent");
    const navigationCode = script.slice(navigationStart, navigationEnd);
    const buttons = ['eventos', 'usuarios'].map(unit => ({
      dataset: { unit },
      classList: { active: false, toggle(name, force) { if (name === 'active') this.active = force; } },
      setAttribute(name, value) { this[name] = value; }
    }));
    const panels = ['eventos', 'usuarios'].map(units => ({
      dataset: { units },
      hidden: false,
      scrolled: false,
      scrollIntoView() { this.scrolled = true; }
    }));
    let navigationClick;
    const navigation = { addEventListener(_type, listener) { navigationClick = listener; } };
    const mockDocument = {
      querySelectorAll(selector) { return selector === '[data-unit]' ? buttons : panels; },
      querySelector(selector) { return selector === '#businessUnits' ? navigation : null; }
    };
    new Function('document', '$', 'loadTechnicalLogs', navigationCode)(
      mockDocument,
      selector => mockDocument.querySelector(selector),
      () => {}
    );
    const clickUnit = unit => navigationClick({
      target: { closest: () => buttons.find(button => button.dataset.unit === unit) },
      preventDefault() {}
    });
    clickUnit('usuarios');
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);
    assert.equal(buttons[1].classList.active, true);
    assert.equal(panels[1].scrolled, true);
    clickUnit('eventos');
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[1].hidden, true);

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

test('tap counter heart has no pulse animation while gift rotation remains configurable', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /@keyframes\s+(?:gmHeart|hbp)\b/);
  assert.doesNotMatch(html, /\.hb(?:\.bump|\.full)?\s+\.hi\s*\{[^}]*animation/s);
  assert.match(html, /rotationTimer=setInterval\(rotate,giftConfig\.rotationSeconds\*1000\)/);
  assert.match(html, /gift-config-update/);
});

test('honor rotates only enabled gifts at the configured interval', () => {
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const marker = "const box=document.createElement('section');box.id='honor'";
  const markerIndex = html.indexOf(marker);
  const scriptStart = html.lastIndexOf('<script>', markerIndex);
  const scriptEnd = html.indexOf('</script>', markerIndex);
  const script = html.slice(scriptStart + '<script>'.length, scriptEnd);
  const eventListeners = {};
  const intervals = [];
  let honorMarkup = '';
  const pd = {};
  Object.defineProperty(pd, 'innerHTML', { set: value => { honorMarkup = value; } });
  const box = {
    setAttribute() {},
    querySelector: () => pd,
    set innerHTML(value) { honorMarkup = value; },
  };
  const side = { firstChild: {}, querySelector: () => null, insertBefore() {} };
  const context = {
    window: { addEventListener: (name, callback) => { eventListeners[name] = callback; } },
    document: { querySelector: () => side, createElement: () => box },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    safe: callback => {
      try { return callback(); } catch { return undefined; }
    },
    SRV: { get: () => ({
      rotationSeconds: 7,
      catalog: [
        { key: 'rose', name: 'Rosita', value: 1, enabled: true, aliases: ['rose'] },
        { key: 'heart', name: 'Corazón', value: 5, enabled: true, aliases: ['heart'] },
        { key: 'star', name: 'Estrella', value: 2, enabled: false, aliases: ['star'] },
      ]
    }) },
    T: [],
    recentChatTeam: () => -1,
    handleLiveEntry() {},
    reset() {},
  };
  runInNewContext(script, context);

  assert.equal(intervals.length, 2);
  context.handleLiveEntry({ type: 'gift', username: 'ana', giftName: 'Rose', activityCount: 1 });
  context.handleLiveEntry({ type: 'gift', username: 'luz', giftName: 'Heart', activityCount: 2 });
  assert.match(honorMarkup, /@luz/);
  assert.match(honorMarkup, /Corazón · 5 🪙 ×2/);

  intervals[1]();
  assert.match(honorMarkup, /@ana/);
  intervals[1]();
  assert.match(honorMarkup, /@luz/);
  context.handleLiveEntry({ type: 'gift', username: 'sol', giftName: 'Star', activityCount: 1 });
  assert.match(honorMarkup, /@luz/);

  eventListeners['gift-config-update']({ detail: {
    rotationSeconds: 7,
    catalog: [
      { key: 'rose', name: 'Rosita', value: 1, enabled: true, aliases: ['rose'] },
      { key: 'heart', name: 'Corazón', value: 5, enabled: false, aliases: ['heart'] },
    ]
  } });
  assert.match(honorMarkup, /@ana/);
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
    displayName: '',
    content: 'Hola',
    activityCount: 1,
    giftName: '',
    profilePictureUrl: 'https://example.test/avatar.jpg'
  });
  assert.equal(normalizeTikTokEvent('emote', { comment: 'ignored' }), null);
  const gift = normalizeTikTokEvent('gift', {
    user: { uniqueId: 'fan1', avatarUrl: 'https://example.test/avatar.png' },
    gift_name: 'Rose',
    giftId: 123,
    diamondCount: 1,
    repeatCount: 2
  });
  assert.equal(gift?.giftName, 'Rose');
  assert.equal(gift?.giftId, '123');
  assert.equal(gift?.giftValue, 1);
  assert.equal(gift?.giftDiamonds, 1);
  assert.equal(normalizeTikTokEvent('gift', {
    user: { uniqueId: 'fan1' },
    gift_name: 'Rose',
    diamondCount: 1,
    repeatCount: 2
  })?.giftDiamonds, 1);
  const member = normalizeTikTokEvent('member', { user: { nickname: 'Fan nickname' } });
  assert.equal(member.username, '');
  assert.equal(member.displayName, 'Fan nickname');
  assert.equal(normalizeTikTokEvent('member', {
    user: {
      nickname: 'Fan nickname',
      profilePicture: { urlList: ['https://example.test/member.jpg'] }
    }
  })?.profilePictureUrl, 'https://example.test/member.jpg');
  assert.equal(normalizeTikTokEvent('follow', {
    user: { displayName: 'Fan Display', avatarLarge: 'https://example.test/fan.jpg' }
  })?.profilePictureUrl, 'https://example.test/fan.jpg');
  assert.equal(normalizeTikTokEvent('member', {
    user: { uniqueId: 'fan1', userDetails: { profilePictureUrls: 'https://example.test/late-avatar.jpg' } }
  })?.profilePictureUrl, 'https://example.test/late-avatar.jpg');
  assert.equal(normalizeTikTokEvent('share', { user: { displayId: 'fan2' } })?.username, 'fan2');
});

test('a late TikTok avatar travels through SSE and appears on the existing overlay alert after decoding', async () => {
  const server = createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const controller = new AbortController();
  let reader;

  class TestElement {
    constructor(tagName, root = false) {
      this.tagName = tagName.toUpperCase();
      this.root = root;
      this.parentElement = null;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = { opacity: '0', setProperty() {} };
      this.className = '';
      this.textContent = '';
    }
    get isConnected() { return this.root || Boolean(this.parentElement?.isConnected); }
    get firstElementChild() { return this.children[0] || null; }
    append(...elements) {
      elements.forEach(element => {
        element.parentElement = this;
        this.children.push(element);
      });
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return name === 'src' && this.src ? this.src : this.attributes[name] || null; }
    querySelector(selector) {
      if (selector === 'img') return this.querySelectorAll('img')[0] || null;
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const expected = selector.startsWith('.') ? selector.slice(1).split('.') : null;
      const matches = element => expected
        ? expected.every(className => element.className.split(/\s+/).includes(className))
        : element.tagName.toLowerCase() === selector;
      return this.children.flatMap(child => [
        ...(matches(child) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
  }
  class TestImage extends TestElement {
    constructor() {
      super('img');
      this.naturalWidth = 0;
      this.src = '';
    }
    decode() { return new Promise(resolve => { this.resolveDecode = resolve; }); }
  }

  const eventLayer = new TestElement('div', true);
  const lane = { getBoundingClientRect: () => ({ left: 0, width: 180 }) };
  const board = { getBoundingClientRect: () => ({ left: 0, width: 380 }) };
  const html = readFileSync(new URL('./overlay.html', import.meta.url), 'utf8');
  const extract = (pattern, name) => {
    const source = html.match(pattern)?.[0];
    assert.ok(source, `overlay function ${name} exists`);
    return source;
  };
  const processSource = extract(/function processLiveEvent\(item\)\{[\s\S]*?\n\}(?=\nfunction receiveLiveEvent)/, 'processLiveEvent');
  const receiveSource = extract(/function receiveLiveEvent\(payload\)\{[\s\S]*?\n\}(?=\nwindow\.liveEventMonitor)/, 'receiveLiveEvent');
  const showSource = extract(/function showEv\(t,type,n,u\)\{[\s\S]*?\n\}/, 'showEv');
  const imageSource = extract(/function setAvatarImage\(el,url,userKey\)\{[\s\S]*?\n\}/, 'setAvatarImage');
  const cachedImageSource = extract(/function appendCachedAvatar\(el,cached\)\{[\s\S]*?\n\}/, 'appendCachedAvatar');
  const avatarSource = extract(/function avatar\(e\)\{[\s\S]*?\n\}/, 'avatar');
  const context = {
    document: {
      createElement: tagName => new TestElement(tagName),
      querySelector: selector => selector === '#event-alerts' ? eventLayer
        : selector === '#ln0' ? lane
          : selector === '.board' ? board : null
    },
    Image: TestImage,
    setTimeout: () => 1,
    console,
    window: {}
  };
  runInNewContext(`
    const $ = selector => document.querySelector(selector);
    const supportedLiveTypes = new Set(['member','chat','gift','like','follow','share']);
    const liveEventIds = new Set(), pendingLiveEvents = [], receivedEvents = [], eventTimers = new Set();
    const LIVE_EVENT_ID_CACHE_LIMIT = 64;
    let localEventNumber = 0, liveEventProcessor = entry => avatar(entry);
    const EI = {chat:['💬','#888'],like:['❤️','#f57'],follow:['➕','#29d'],share:['↗️','#29d'],member:['👋','#2a5']};
    const T = [{id:'ol',n:'OLIMPIA',c:'#fff'},{id:'cp',n:'CERRO',c:'#38f'}];
    const known = new Map(), userScore = new Map(), greeted = new Set(), seen = new Set(), recent = [[],[]];
    const avatarImageCache = new Map(), avatarUrlCache = new Map();
    const SCORE = {member:1,chat:5,like:1,follow:3,share:3,gift:0};
    let over = false;
    const supportTeamFor = () => 0, grow = () => {}, greet = () => {}, trimNest = () => {};
    const renderNest = () => {}, renderPod = () => {}, toast = () => {}, who = value => value;
    const A = {sfx(){}};
    const recordReceivedEvent = (type,payload) => {
      const item = {type,payload};
      receivedEvents.push(item);
      return item;
    };
    const addLiveEventStage = () => {}, trimReceivedEvents = () => {}, notifyReceivedEvents = () => {};
    const recordLiveDiagnostic = () => {}, isLiveDiagnosticActive = () => false, snapshotLiveState = () => null;
    ${processSource}
    ${receiveSource}
    ${showSource}
    ${imageSource}
    ${cachedImageSource}
    ${avatarSource}
    globalThis.receiveEvent = receiveLiveEvent;
    globalThis.avatarCache = avatarImageCache;
  `, context);

  const decoder = new TextDecoder();
  let buffer = '';
  async function readFrame() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('event:')) return frame;
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE stream stays open');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  async function receiveSseEvent() {
    const frame = await readFrame();
    const event = frame.match(/^event:\s*(.+)$/m)?.[1];
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    assert.ok(data, `SSE ${event} frame contains data`);
    return { event, payload: JSON.parse(data) };
  }

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    assert.equal((await receiveSseEvent()).event, 'status');

    const id = `avatar-test-${Date.now()}`;
    handleTikTokEvent('member', { msgId: `${id}-member`, user: { nickname: 'Avatar Fan' } });
    const first = await receiveSseEvent();
    assert.equal(first.event, 'update');
    const firstResult = context.receiveEvent(first.payload);
    assert.equal(firstResult.state, 'processed', firstResult.error);
    const existingAlert = eventLayer.querySelector('.fan-alert');
    const existingAvatar = existingAlert.querySelector('.ua.hero');
    assert.equal(existingAvatar.textContent, 'A');
    assert.equal(existingAvatar.querySelector('img'), null);

    handleTikTokEvent('follow', {
      msgId: `${id}-follow`,
      user: { nickname: 'Avatar Fan', profilePictureUrl: 'https://example.test/avatar.jpg' }
    });
    const second = await receiveSseEvent();
    assert.equal(second.event, 'update');
    assert.equal(second.payload.entry.profilePictureUrl, 'https://example.test/avatar.jpg');
    assert.equal(context.receiveEvent(second.payload).state, 'processed');

    const cache = context.avatarCache.get('display:avatar fan');
    assert.ok(cache, 'the avatar is cached by the user identity');
    assert.equal(cache.image.src, 'https://example.test/avatar.jpg');
    assert.equal(existingAvatar.querySelector('img'), null, 'the initial remains while the shared image is loading');
    cache.image.naturalWidth = 64;
    cache.image.onload();
    cache.image.resolveDecode();
    await new Promise(resolve => setImmediate(resolve));
    const image = existingAvatar.querySelector('img');
    assert.ok(image, 'late avatar URL is attached to the already visible alert');
    assert.equal(image.src, 'https://example.test/avatar.jpg');
    assert.equal(image.style.opacity, '1', 'loaded avatar is revealed after decoding');
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
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
  assert.equal(socialEventType({ common: { displayText: { key: 'follow' } } }), 'follow');
  assert.equal(socialEventType({ common: { displayText: { key: 'share' } } }), 'share');
  assert.equal(socialEventType({ shareTarget: 'chat' }), 'share');
  assert.equal(socialEventType({ action: 'like' }), '');
});

test('country recognition accepts names and ISO codes', () => {
  assert.equal(identifyCountry('Vamos Paraguay')?.code, 'PY');
  assert.equal(identifyCountry('🇨🇱 Chile')?.code, 'CL');
  assert.equal(identifyCountry('🇬🇧')?.code, 'GB');
});

test('PWA manifest is named Negocio and requests fullscreen with install icons', () => {
  const manifest = JSON.parse(readFileSync(new URL('./public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Negocio');
  assert.equal(manifest.short_name, 'Negocio');
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

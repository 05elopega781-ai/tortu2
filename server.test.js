import test from 'node:test';
import assert from 'node:assert/strict';
import { comboDelta, identifyCountry, normalizeTikTokEvent, normalizeUsername } from './server.js';

test('username normalization strips leading @ and whitespace', () => {
  assert.equal(normalizeUsername('  @@ tortu  '), 'tortu');
  assert.equal(normalizeUsername('  '), '');
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
    repeatCount: 2
  })?.giftName, 'Rose');
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

test('country recognition accepts names and ISO codes', () => {
  assert.equal(identifyCountry('Vamos Paraguay')?.code, 'PY');
  assert.equal(identifyCountry('🇨🇱 Chile')?.code, 'CL');
  assert.equal(identifyCountry('🇬🇧')?.code, 'GB');
});

// node --test test/  (no dependencies)
const test = require('node:test');
const assert = require('node:assert');
require('../src/format.js');
const F = globalThis.SBFormat;

const row = (id, extra = {}) => Object.assign({ id, channel_id: '222222222222222222', author: 'ann', ts: new Date(F.msFromSnowflake(id)).toISOString(), content: 'hi', attachments: [], embeds: [], reactions: [] }, extra);

test('snowflake round trip', () => {
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.strictEqual(F.msFromSnowflake(F.snowflakeForMs(ms)), ms);
});

test('sortKey keeps numeric order as string order', () => {
  const ids = ['99999999999999999', '100000000000000000', '1234567890123456789'];
  const sorted = ids.slice().sort((a, b) => F.sortKey(a) < F.sortKey(b) ? -1 : 1);
  assert.deepStrictEqual(sorted, ids);
});

test('parseLocation', () => {
  assert.deepStrictEqual(F.parseLocation('/channels/@me/123456789012345678'), { guildId: null, channelId: '123456789012345678' });
  assert.deepStrictEqual(F.parseLocation('/channels/111111111111111111/222222222222222222'), { guildId: '111111111111111111', channelId: '222222222222222222' });
  // a message link must not be read as a channel
  assert.deepStrictEqual(F.parseLocation('/channels/111111111111111111/222222222222222222/333333333333333333'), { guildId: '111111111111111111', channelId: '222222222222222222' });
  assert.deepStrictEqual(F.parseLocation('/channels/111111111111111111/222222222222222222/threads/444444444444444444'), { guildId: '111111111111111111', channelId: '444444444444444444' });
  assert.deepStrictEqual(F.parseLocation('/app'), { guildId: null, channelId: null });
});

test('sliceDays and isCoveredBack', () => {
  const old = row(F.snowflakeForMs(Date.now() - 40 * 864e5)), fresh = row(F.snowflakeForMs(Date.now() - 864e5));
  assert.strictEqual(F.sliceDays([old, fresh], 30).length, 1);
  assert.strictEqual(F.sliceDays([old, fresh], 0).length, 2);
  assert.strictEqual(F.isCoveredBack([old, fresh], 30), true);
  assert.strictEqual(F.isCoveredBack([fresh], 30), false);
  assert.strictEqual(F.isCoveredBack([fresh], 30, { reachedStart: true }), true);
});

test('html export escapes content and drops unsafe links', () => {
  const r = row(F.snowflakeForMs(Date.now()), {
    author: '<b>x</b>', content: '<img src=x onerror=alert(1)>',
    attachments: ['javascript:alert(1)', 'https://cdn.discordapp.com/a/b/pic.png?ex=1'],
    embeds: [{ title: 't', url: 'javascript:alert(2)' }]
  });
  const h = F.html([r], { title: '"><script>' });
  assert.ok(!h.includes('<img src=x'));
  assert.ok(!h.includes('javascript:'));
  assert.ok(!h.includes('<script>'));
  assert.ok(h.includes('https://cdn.discordapp.com/a/b/pic.png'));
});

test('csv neutralises formulas and quotes', () => {
  const r = row(F.snowflakeForMs(Date.now()), { content: '=HYPERLINK("http://x")', author: 'a,b' });
  const c = F.csv([r]);
  assert.ok(c.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(c.includes('"a,b"'));
});

test('text export shows replies, reactions and who reacted', () => {
  const r = row(F.snowflakeForMs(Date.now()), {
    replyTo: { id: '1', author: 'bob', content: 'q' },
    reactions: [{ emoji: '🔥', count: 2 }], reactionUsers: { '🔥': ['ann', 'bob'] }
  });
  const t = F.text([r], { title: 'gen' });
  assert.match(t, /↳ reply to bob: q/);
  assert.match(t, /🔥×2 \(ann, bob\)/);
});

test('every format renders', () => {
  const rows = [row(F.snowflakeForMs(Date.now()))];
  for (const k of Object.keys(F.FORMATS)) assert.ok(F.render(k, rows, { title: 'x' }).length > 10, k);
  JSON.parse(F.json(rows, { title: 'x' }));
});

test('filename is safe', () => {
  const n = F.filename('../../etc/passwd 😀 #general', 'md', 30);
  assert.ok(!n.includes('/'));
  assert.match(n, /-30d-.*\.md$/);
});

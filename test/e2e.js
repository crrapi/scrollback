// End-to-end: load the unpacked extension in Chromium, serve a fake Discord
// client from test/fake-discord.html, and check capture, jobs, migration and
// the extension pages. Run: npm run test:e2e
const fs = require('fs');
const path = require('path');
const { launch, DATA, NOW, DAY, EXT, apiCalls } = require('./harness');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { ctx, sw, extId, errors, downloads } = await launch();
  ok(!!extId, 'service worker started: ' + extId);

  // --- v1 migration ---
  const migrated = await sw.evaluate(async () => {
    await chrome.storage.local.set({
      'ch:999999999999999999': { map: { '999999999999999991': { id: '999999999999999991', author: 'old', ts: '2025-01-01T00:00:00Z', content: 'from v1', attachments: [] } } },
      'dpe:meta': { '999999999999999999': { title: 'legacy-chan', count: 1 } }
    });
    await SBDB.kvSet('migratedV1', false);
    await migrateV1();
    const left = await chrome.storage.local.get(null);
    const ch = await SBDB.getChannel('999999999999999999');
    return { left: Object.keys(left), ch };
  });
  ok(migrated.left.length === 0, 'v1 keys removed after migration');
  ok(migrated.ch && migrated.ch.count === 1 && migrated.ch.title === 'legacy-chan', 'v1 channel migrated with title');

  // --- passive capture ---
  const page = await ctx.newPage();
  await page.goto('https://discord.com/channels/111111111111111111/222222222222222222');
  await sleep(2500);
  let ch = await sw.evaluate(() => SBDB.getChannel('222222222222222222'));
  ok(ch && ch.count === 50, 'first page captured passively: ' + (ch && ch.count));
  ok(ch && ch.title === 'general' && ch.guildId === '111111111111111111' && ch.guildName === 'Test Server', 'title + guild reported: ' + JSON.stringify(ch && [ch.title, ch.guildId, ch.guildName]));
  const top = await sw.evaluate(() => SBDB.getMessages('222222222222222222').then((r) => r[r.length - 1]));
  ok(top.reactionUsers && top.reactionUsers['🔥'] && top.reactionUsers['🔥'].join() === 'ann,Bob', 'reaction users captured');
  const reply = await sw.evaluate(() => SBDB.getMessages('222222222222222222').then((r) => r[r.length - 2].replyTo));
  ok(reply && reply.author === 'bob' && reply.content === 'parent', 'reply context captured');
  const apiBefore = apiCalls.length;

  // --- channel job, 30 days ---
  const lib = await ctx.newPage();
  await lib.goto(`chrome-extension://${extId}/library/library.html`);
  const sendJob = (scope, days) => lib.evaluate(async ([scope, days]) => {
    const [t] = await chrome.tabs.query({ url: 'https://discord.com/*' });
    return chrome.tabs.sendMessage(t.id, { type: 'job', scope, days });
  }, [scope, days]);
  const dl1 = page.waitForEvent('download', { timeout: 120e3 });
  ok((await sendJob('channel', 30)).ok, 'channel job accepted');
  ok((await sendJob('channel', 30)).busy, 'second job refused while busy');
  const d1 = await dl1;
  const txt = fs.readFileSync(await d1.path(), 'utf8');
  const expect30 = DATA['222222222222222222'].filter((m) => Date.parse(m.timestamp) >= NOW - 30 * DAY).length;
  const got30 = (txt.match(/^\[/gm) || []).length;
  ok(Math.abs(got30 - expect30) <= 1, `30d export has ${got30} msgs (expected ~${expect30}) as ${d1.suggestedFilename()}`);
  ok(/↳ reply to bob: parent/.test(txt) && /🔥×2 \(ann, Bob\)/.test(txt), 'export keeps replies and reaction users');
  const jobCalls = apiCalls.slice(apiBefore);
  ok(jobCalls.every((c) => /\/channels\/222222222222222222\/messages\?before=\d+&limit=50$/.test(c)), `job made only client-style page fetches (${jobCalls.length})`);

  // --- full history job reaches the start ---
  const dl2 = page.waitForEvent('download', { timeout: 300e3 });
  await sendJob('channel', 0);
  const d2 = await dl2;
  const all = (fs.readFileSync(await d2.path(), 'utf8').match(/^\[/gm) || []).length;
  ch = await sw.evaluate(() => SBDB.getChannel('222222222222222222'));
  ok(all === 600 && ch.count === 600 && ch.reachedStart === true, `full history: export ${all}/600, stored ${ch.count}, reachedStart=${ch.reachedStart}`);

  // --- server job ---
  await sw.evaluate(() => SBDB.kvSet('settings', { format: 'md', mediaWithJobs: true, time: 'iso', pace: 'normal' }));
  const dl3 = page.waitForEvent('download', { timeout: 300e3 });
  await sendJob('server', 90);
  const d3 = await dl3;
  const md = fs.readFileSync(await d3.path(), 'utf8');
  ok(d3.suggestedFilename().endsWith('.md') && /#general/.test(md) && /#random/.test(md), 'server job exported general + random as markdown: ' + d3.suggestedFilename());
  const random = await sw.evaluate(() => SBDB.getChannel('333333333333333333'));
  ok(random && random.count === 30, 'random channel fully captured: ' + (random && random.count));
  await sleep(3000);
  const saved = await sw.evaluate(() => SBDB.open().then((db) => new Promise((r) => { const q = db.transaction('saved').objectStore('saved').count(); q.onsuccess = () => r(q.result); })));
  ok(saved > 0, 'media saved with job: ' + saved);

  // --- library page ---
  await lib.reload(); await sleep(800);
  const rowsShown = await lib.locator('#chats tbody tr').count();
  ok(rowsShown >= 3, 'library lists chats: ' + rowsShown);
  await lib.locator('#chats tbody tr', { hasText: 'general' }).first().click();
  await lib.fill('#dSearch', 'msg 42 in');
  await sleep(200);
  ok((await lib.locator('#dList .msg').count()) === 1, 'library search finds one message');
  const backup = lib.waitForEvent('download');
  await lib.click('[data-tab=settings]'); await lib.click('#backup');
  const bk = JSON.parse(fs.readFileSync(await (await backup).path(), 'utf8'));
  ok(bk.backup === 'Scrollback' && bk.channels.length >= 3, 'backup has every chat');
  lib.once('dialog', (d) => d.accept());
  await lib.click('#wipe'); await sleep(500);
  ok((await sw.evaluate(() => SBDB.listChannels())).length === 0, 'delete everything empties the store');
  const tmp = path.join(downloads, 'restore.json'); fs.writeFileSync(tmp, JSON.stringify(bk));
  await lib.setInputFiles('#restore', tmp); await sleep(1500);
  const restored = await sw.evaluate(() => SBDB.getChannel('222222222222222222'));
  const inBackup = bk.channels.find((c) => c.channel.id === '222222222222222222').messages.length;
  ok(restored && restored.count === inBackup && restored.title === 'general', `restore brings chats back: ${restored && restored.count}/${inBackup}`);

  // --- popup renders against the Discord tab ---
  // the popup asks for the active tab; point it at the Discord tab instead
  await page.goto('https://discord.com/channels/111111111111111111/222222222222222222'); await sleep(1500);
  const pop = await ctx.newPage();
  await pop.addInitScript(() => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = () => q({ url: 'https://discord.com/*' });
  });
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(800);
  ok((await pop.textContent('#count')).replace(/\D/g, '') === String(restored.count), 'popup shows saved count: ' + await pop.textContent('#count'));
  ok(/#general/.test(await pop.textContent('#where')), 'popup shows chat name');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

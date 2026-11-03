// Render Chrome Web Store screenshots (1280x800) and promo tiles from the real
// extension pages, seeded with made-up demo chats.
// Run: npm run shots
const fs = require('fs');
const path = require('path');
const { launch, DATA } = require('../test/harness');

const OUT = path.resolve(__dirname, '../store');
const RAW = path.join(OUT, 'screenshots/raw');
const EPOCH = 1420070400000n;
const sf = (ms, n) => (((BigInt(Math.floor(ms)) - EPOCH) << 22n) + BigInt(n)).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PEOPLE = [['maya', 'Maya'], ['jules.dev', 'Jules'], ['okafor', 'Tobi'], ['rin', 'Rin'], ['pixelpat', 'Pat']];
const LINES = [
  'pushed the new lighting pass, can someone check it on a low-end GPU?',
  'looks great on my laptop, 58 fps steady',
  'the fog at the cliff edge is so good now',
  'are we still doing the playtest on saturday?',
  'yes, 7pm UTC. I will post the build link an hour before',
  'found a softlock when you pause during the boss intro',
  'nice catch, filing it now',
  'here is the new title screen mockup',
  'love the color palette. maybe a bit more contrast on the logo?',
  'patch notes draft is in the doc, please skim before friday',
  'the save system migration is done, old saves load fine',
  'who has the audio stems for track 3?',
  'uploading them now',
  'can we cut the tutorial popups down to three?',
  'agreed, the second one repeats the first anyway'
];
function demoChannel(cid, n, everyMs, base) {
  const now = Date.now(), out = [];
  for (let i = 0; i < n; i++) {
    const ms = now - i * everyMs - 120e3, p = PEOPLE[(i * 7 + base) % PEOPLE.length];
    out.push({
      id: sf(ms, base * 100 + (i % 100)), channel_id: cid, type: 0, content: LINES[(i + base) % LINES.length],
      timestamp: new Date(ms).toISOString(), edited_timestamp: i % 11 === 3 ? new Date(ms + 6e4).toISOString() : null,
      author: { id: '7000000000000000' + (10 + (i % 5)), username: p[0], global_name: p[1], bot: false },
      attachments: i % 9 === 7 ? [{ url: `https://cdn.discordapp.com/attachments/${cid}/${i}/screenshot_${i}.png` }] : [],
      embeds: [], reactions: i % 4 === 1 ? [{ emoji: { name: '🔥' }, count: 3 }, { emoji: { name: '👍' }, count: 2 }] : [],
      referenced_message: i % 6 === 1 ? { id: sf(ms - 9e5, 1), content: LINES[(i + base + 3) % LINES.length], author: { global_name: PEOPLE[(i + 2) % 5][1] } } : null
    });
  }
  return out;
}

async function frame(ctx, file, { title, sub, img, w = 1280, h = 800, imgW }) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  const data = img ? 'data:image/png;base64,' + fs.readFileSync(img).toString('base64') : null;
  await p.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
      background:radial-gradient(1200px 600px at 0% 0%,#7c6cf6 0%,#4c40c8 55%,#2d2580 100%);color:#fff;display:flex;align-items:center;gap:56px;padding:0 64px;box-sizing:border-box}
    .t{flex:0 0 ${img ? 380 : w - 128}px} h1{font-size:${img ? 46 : (h < 400 ? 36 : 54)}px;line-height:1.08;margin:0 0 18px;letter-spacing:-.02em} p{font-size:21px;line-height:1.45;margin:0;opacity:.88}
    .logo{display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;margin-bottom:${h < 400 ? 14 : 28}px;opacity:.95}
    .shot{flex:1;display:flex;justify-content:center} img.s{max-width:${imgW || 720}px;max-height:${h - 120}px;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.45)}
  </style></head><body><div class="t"><div class="logo"><img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, '../icons/128.png')).toString('base64')}" width="40" height="40">Scrollback</div>
  <h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${data ? `<div class="shot"><img class="s" src="${data}"></div>` : ''}</body></html>`);
  await sleep(200);
  await p.screenshot({ path: file });
  await p.close();
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const { ctx, sw, extId } = await launch();

  const chats = [
    ['222222222222222222', 'general', 900, 3 * 3600e3, 1],
    ['333333333333333333', 'playtest-feedback', 240, 9 * 3600e3, 2],
    ['444444444444444444', 'art-and-audio', 410, 6 * 3600e3, 3]
  ];
  for (const [cid, title, n, every, base] of chats) {
    await sw.evaluate(async ([cid, title, rows]) => {
      for (let i = 0; i < rows.length; i += 100) await ingest(null, rows.slice(i, i + 100));
      await SBDB.patchChannel(cid, { title, guildId: '111111111111111111', guildName: 'Lantern Studio' });
    }, [cid, title, demoChannel(cid, n, every, base)]);
  }
  await sw.evaluate(async (rows) => {
    await ingest(null, rows);
    await SBDB.patchChannel('555555555555555555', { title: 'maya' });
  }, demoChannel('555555555555555555', 120, 20 * 3600e3, 4));

  // popup against the fake Discord tab, which now serves the demo chat
  DATA['222222222222222222'] = demoChannel('222222222222222222', 900, 3 * 3600e3, 1);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('https://discord.com/channels/111111111111111111/222222222222222222');
  await page.evaluate(() => { document.title = '#general | Lantern Studio'; });
  await sleep(1500);
  await sw.evaluate(() => SBDB.patchChannel('222222222222222222', { title: 'general', guildName: 'Lantern Studio' }));
  const pop = await ctx.newPage();
  await pop.addInitScript(() => { const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = () => q({ url: 'https://discord.com/*' }); });
  await pop.setViewportSize({ width: 364, height: 600 });
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(900);
  await pop.emulateMedia({ colorScheme: 'dark' });
  const ph = await pop.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  await pop.setViewportSize({ width: 364, height: ph });
  await pop.screenshot({ path: path.join(RAW, 'popup.png') });

  // library with a chat open
  const lib = await ctx.newPage();
  await lib.setViewportSize({ width: 1100, height: 760 });
  await lib.emulateMedia({ colorScheme: 'light' });
  await lib.goto(`chrome-extension://${extId}/library/library.html`);
  await sleep(800);
  await lib.locator('#chats tbody tr', { hasText: 'playtest' }).first().click();
  await lib.fill('#dSearch', 'build');
  await sleep(400);
  await lib.evaluate(() => window.scrollTo(0, 0));
  await lib.screenshot({ path: path.join(RAW, 'library.png') });

  // HTML export as a reader sees it
  const html = await lib.evaluate(async () => SBFormat.html((await SBDB.getMessages('333333333333333333')).slice(-30), { title: 'playtest-feedback', days: 30, time: 'local' }));
  const ex = await ctx.newPage();
  await ex.setViewportSize({ width: 1000, height: 720 });
  await ex.emulateMedia({ colorScheme: 'dark' });
  await ex.setContent(html.replace(/<img loading="lazy" src="[^"]+"/g, '<img src="data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#3b3f8f"/><circle cx="250" cy="50" r="22" fill="#f5c46b"/><path d="M0 180 L90 90 L160 150 L220 110 L320 180Z" fill="#2a2d6b"/></svg>') + '"'));
  await sleep(300);
  await ex.screenshot({ path: path.join(RAW, 'export.png') });

  // on-page job panel
  const lib2 = await ctx.newPage();
  await lib2.goto(`chrome-extension://${extId}/library/library.html`);
  await page.bringToFront();
  await lib2.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'https://discord.com/*' }); chrome.tabs.sendMessage(t.id, { type: 'job', scope: 'channel', days: 90 }); });
  await sleep(4500);
  await page.screenshot({ path: path.join(RAW, 'job.png'), clip: { x: 220, y: 420, width: 1060, height: 380 } });

  const S = path.join(OUT, 'screenshots');
  await frame(ctx, path.join(S, '1-popup.png'), { title: 'Copy or download any Discord chat', sub: 'One click copies the whole chat. Download it as Text, Markdown, HTML, JSON or CSV.', img: path.join(RAW, 'popup.png'), imgW: 420 });
  await frame(ctx, path.join(S, '2-history.png'), { title: 'Load 7 days, 90 days or everything', sub: 'Scrollback scrolls the chat for you and shows progress right on the page.', img: path.join(RAW, 'job.png') });
  await frame(ctx, path.join(S, '3-library.png'), { title: 'Every saved chat in one place', sub: 'Search messages, export by date range, back up and restore.', img: path.join(RAW, 'library.png') });
  await frame(ctx, path.join(S, '4-export.png'), { title: 'Clean exports you can read', sub: 'Replies, reactions, images and day headers. Light and dark mode.', img: path.join(RAW, 'export.png') });
  await frame(ctx, path.join(S, '5-privacy.png'), { title: 'No token. No self-bot.', sub: 'Scrollback never asks for your token and never calls Discord\'s API. It saves what your tab already loads, and it all stays on your device.' });
  await frame(ctx, path.join(OUT, 'promo-440x280.png'), { title: 'Export Discord chats. No token.', w: 440, h: 280 });
  await frame(ctx, path.join(OUT, 'marquee-1400x560.png'), { title: 'Export your Discord chats without your token', sub: 'No token. No self-bot. It saves only what your Discord tab already loads.', w: 1400, h: 560 });
  fs.copyFileSync(path.join(OUT, '../icons/128.png'), path.join(OUT, 'icon-128.png'));
  await ctx.close();
  console.log(fs.readdirSync(S).filter((f) => f.endsWith('.png')).join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });

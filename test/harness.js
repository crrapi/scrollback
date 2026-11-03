// Shared test harness: launches Chromium with the unpacked extension and a
// fake Discord client (fake-discord.html) behind routed https://discord.com.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_DIR || process.cwd()] }));

const EXT = path.resolve(__dirname, '..');
const EPOCH = 1420070400000n;
const sf = (ms, n) => (((BigInt(ms) - EPOCH) << 22n) + BigInt(n)).toString();
const HOUR = 3600e3, DAY = 24 * HOUR, NOW = Date.now();

function makeChannel(cid, count, everyMs) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ms = NOW - i * everyMs - 60e3;
    out.push({
      // snowflakes are unique across channels, so vary the increment per channel
      id: sf(ms, Number(cid[0]) * 1000 + i), channel_id: cid, type: 0, content: `msg ${i} in ${cid.slice(0, 3)}`,
      timestamp: new Date(ms).toISOString(), edited_timestamp: null,
      author: { id: '555555555555555555', username: 'user' + (i % 3), global_name: i % 3 ? null : 'Ann' },
      attachments: i % 50 === 0 ? [{ url: `https://cdn.discordapp.com/attachments/${cid}/${i}/pic${i}.png?ex=1` }] : [],
      embeds: [], reactions: i === 0 ? [{ emoji: { name: '🔥' }, count: 2 }] : [],
      referenced_message: i === 1 ? { id: sf(ms - 1000, 999), content: 'parent', author: { username: 'bob' } } : null
    });
  }
  return out; // newest first, like the API
}
const DATA = {
  '222222222222222222': makeChannel('222222222222222222', 600, 5 * HOUR), // ~125 days
  '333333333333333333': makeChannel('333333333333333333', 30, 2 * DAY),   // ~60 days
  '444444444444444444': []
};

const apiCalls = [];

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dl-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    // CHROME_PATH runs a local Chrome instead of Playwright's Chromium; recent
    // branded Chrome needs the feature flag to honour --load-extension
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
    headless: true, acceptDownloads: true, downloadsPath: downloads,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`].concat(process.env.CHROME_PATH ? ['--disable-features=DisableLoadExtensionCommandLineSwitch'] : [])
  });
  const errors = [];
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(p.url() + ' ' + e.message)));

  await ctx.route('https://discord.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) {
      apiCalls.push(u.pathname + u.search);
      let m;
      if ((m = /\/reactions\//.exec(u.pathname))) return route.fulfill({ json: [{ id: '1', username: 'ann' }, { id: '2', global_name: 'Bob' }] });
      if ((m = /\/channels\/(\d+)\/messages$/.exec(u.pathname))) {
        const all = DATA[m[1]] || [];
        const before = u.searchParams.get('before'), limit = +u.searchParams.get('limit') || 50;
        const start = before ? all.findIndex((x) => BigInt(x.id) < BigInt(before)) : 0;
        return route.fulfill({ json: start < 0 ? [] : all.slice(start, start + limit) });
      }
      return route.fulfill({ status: 404, json: {} });
    }
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fake-discord.html')) });
  });
  // media downloads point at the CDN; answer with a tiny PNG
  await ctx.route('https://cdn.discordapp.com/**', (r) => r.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(EXT, 'icons/16.png')) }));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  return { ctx, sw, extId, errors, downloads };
}

module.exports = { launch, DATA, NOW, DAY, EXT, apiCalls };

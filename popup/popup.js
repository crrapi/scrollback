/* popup.js — current-chat status, quick exports and job launch. */

const $ = (id) => document.getElementById(id);
let tabId = null, here = { channelId: null, guildId: null, title: null }, channel = null, settings = {};

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }));
const sendTab = (msg) => new Promise((res) => chrome.tabs.sendMessage(tabId, msg, (r) => { void chrome.runtime.lastError; res(r || null); }));
const DISCORD = /^https:\/\/(ptb\.|canary\.)?discord\.com\//;

function status(text, ok = true) {
  const s = $('status'); s.textContent = text; s.className = 'status ' + (ok ? 'ok' : 'bad');
  if (text) setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 4000);
}
const title = () => (channel && channel.title) || here.title || here.channelId;
const meta = () => ({ title: title(), channelId: here.channelId, guildId: here.guildId, time: settings.time });

function downloadText(text, fmt, days) {
  const url = URL.createObjectURL(new Blob([text], { type: SBFormat.FORMATS[fmt].mime }));
  chrome.downloads.download({ url, filename: SBFormat.filename(title(), fmt, days), saveAs: false, conflictAction: 'uniquify' }, () => {
    void chrome.runtime.lastError;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); status(`Copied ${label}.`); }
  catch (e) { status('Clipboard blocked. Use Download.', false); }
}
async function savedRows() { const r = await send({ type: 'rows', channelId: here.channelId }); return (r && r.rows) || []; }

async function refresh() {
  const [c, all] = await Promise.all([send({ type: 'channel', channelId: here.channelId }), send({ type: 'channels' })]);
  channel = c && c.channel;
  const n = (channel && channel.count) || 0;
  $('count').textContent = n.toLocaleString();
  const where = [title() ? (here.guildId ? '#' : '@') + title() : null, channel && channel.guildName].filter(Boolean).join(' · ');
  $('where').textContent = where || `chat ${here.channelId}`;
  $('span').textContent = n && channel.oldestId
    ? `${SBFormat.day(SBFormat.msFromSnowflake(channel.oldestId))} → ${SBFormat.day(SBFormat.msFromSnowflake(channel.newestId))}${channel.reachedStart ? ' · start of chat reached' : ''}`
    : 'Scroll the chat, or use a button below to load history.';
  const list = (all && all.channels) || [];
  $('total').textContent = list.reduce((s, x) => s + (x.count || 0), 0).toLocaleString();
  $('chans').textContent = list.length.toLocaleString();
  const st = await sendTab({ type: 'jobStatus' });
  $('runningRow').hidden = !(st && st.running);
}

async function initLastResult() {
  const r = await send({ type: 'getResult' });
  const res = r && r.result;
  if (!res || !res.text) return;
  $('lastRow').hidden = false;
  $('copyLast').textContent = `Copy last job: ${res.title}`;
  $('copyLast').onclick = () => copy(res.text, res.title);
}

document.addEventListener('DOMContentLoaded', async () => {
  $('openLib').onclick = () => chrome.runtime.openOptionsPage();
  $('openDiscord').onclick = () => chrome.tabs.create({ url: 'https://discord.com/channels/@me' });

  settings = ((await send({ type: 'getSettings' })) || {}).settings || {};
  const sel = $('format');
  for (const [k, f] of Object.entries(SBFormat.FORMATS)) sel.add(new Option(f.label, k, false, k === settings.format));
  sel.onchange = async () => { settings = (await send({ type: 'setSettings', settings: { format: sel.value } })).settings; };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tab || !DISCORD.test(tab.url || '')) { $('where').textContent = ''; $('off').hidden = false; return; }
  here = SBFormat.parseLocation(new URL(tab.url).pathname);
  if (!here.channelId) { $('where').textContent = 'Open a channel or DM to start.'; $('off').hidden = false; $('openDiscord').hidden = true; return; }
  const live = await sendTab({ type: 'whereAmI' });
  if (!live) {
    $('where').textContent = 'Reload this Discord tab once so Scrollback can start capturing.';
    return;
  }
  here.title = live.title;
  $('main').hidden = false;
  $('serverBlock').hidden = !here.guildId;
  await refresh();
  await initLastResult();

  $('copy').onclick = async () => {
    const rows = await savedRows();
    if (!rows.length) return status('Nothing saved yet. Scroll the chat first.', false);
    copy(SBFormat.text(rows, meta()), `${rows.length.toLocaleString()} messages`);
  };
  $('download').onclick = async () => {
    const rows = await savedRows();
    if (!rows.length) return status('Nothing saved yet.', false);
    const fmt = sel.value;
    downloadText(SBFormat.render(fmt, rows, meta()), fmt, 0);
    status(`Downloading ${rows.length.toLocaleString()} messages as ${SBFormat.FORMATS[fmt].label}.`);
  };
  $('saveMedia').onclick = async () => {
    const r = await send({ type: 'saveMedia', channelId: here.channelId });
    if (!r || r.error) return status('Could not save media.', false);
    if (!r.count && !r.skipped) return status('No images or videos in saved messages.', false);
    status(`Saving ${r.count} files to Downloads/Scrollback/` + (r.skipped ? ` (${r.skipped} saved before)` : ''));
  };
  $('stop').onclick = async () => { await sendTab({ type: 'jobStop' }); status('Stopping…'); };

  document.querySelectorAll('.seg button').forEach((btn) => {
    btn.onclick = async () => {
      const scope = btn.dataset.scope, days = parseInt(btn.dataset.days, 10);
      const r = await sendTab({ type: 'job', scope, days });
      if (!r) return status('Reload the Discord tab, then try again.', false);
      if (r.busy) return status('A job is already running in this tab.', false);
      if (r.instant) {
        // the range was already saved gap-free, so the page rendered it right away
        const label = days > 0 ? `last ${days}d` : 'full history';
        if (!r.count) return status(`No messages in the ${label}.`, false);
        const res = ((await send({ type: 'getResult' })) || {}).result;
        if (res && res.text) await copy(res.text, `${label}: ${r.count.toLocaleString()} messages, already saved`);
        await initLastResult();
        return;
      }
      $('runningRow').hidden = false;
      status(scope === 'server'
        ? 'Server job started. Leave the tab open; the file downloads when it ends.'
        : 'Loading history. Watch the panel on the page; the file downloads when it ends.');
    };
  });
});

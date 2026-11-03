/* library.js — every saved chat: browse, search, export, back up, delete, settings. */

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }));
const F = SBFormat;
let settings = {}, chats = [], open = null, openRows = [];

function flash(el, text, ok = true) {
  el.textContent = text; el.className = 'status ' + (ok ? 'ok' : 'bad');
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
}
function saveFile(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};
const label = (c) => c.title ? (c.guildId ? '#' : '@') + c.title : 'Chat ' + c.id;
const covers = (c) => c.oldestId ? `${F.day(F.msFromSnowflake(c.oldestId))} → ${F.day(F.msFromSnowflake(c.newestId))}` : '—';

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  document.querySelectorAll('[data-pane]').forEach((p) => p.hidden = p.dataset.pane !== t.dataset.tab);
  if (t.dataset.tab === 'settings') usage();
});

// ---------- chat list ----------
async function loadChats() {
  chats = (await SBDB.listChannels()).filter((c) => c.count > 0).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  renderChats();
}
function renderChats() {
  const q = $('filter').value.trim().toLowerCase();
  const list = chats.filter((c) => !q || [c.title, c.guildName, c.id].some((v) => v && String(v).toLowerCase().includes(q)));
  const total = chats.reduce((s, c) => s + c.count, 0);
  $('summary').textContent = `${total.toLocaleString()} messages in ${chats.length.toLocaleString()} chats`;
  $('empty').hidden = chats.length > 0;
  $('chats').hidden = chats.length === 0;
  const tb = $('chats').tBodies[0];
  tb.replaceChildren(...list.map((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="cname"></div><div class="csub"></div></td><td class="num"></td><td></td><td class="mut"></td><td><button>Open</button></td>`;
    tr.cells[0].children[0].textContent = label(c);
    tr.cells[0].children[1].textContent = c.guildId ? (c.guildName || 'Server ' + c.guildId) : 'Direct message';
    tr.cells[1].textContent = c.count.toLocaleString();
    tr.cells[2].textContent = covers(c) + (c.reachedStart ? ' · from start' : '');
    tr.cells[3].textContent = c.updated ? ago(c.updated) : '';
    tr.onclick = () => openChat(c);
    return tr;
  }));
}
$('filter').oninput = renderChats;

// ---------- detail ----------
async function openChat(c) {
  open = c;
  openRows = await SBDB.getMessages(c.id);
  $('detail').hidden = false;
  $('dTitle').textContent = label(c);
  $('dSub').textContent = `${openRows.length.toLocaleString()} messages · ${covers(c)}${c.guildName ? ' · ' + c.guildName : ''}`;
  $('dSearch').value = '';
  renderMsgs();
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function highlight(el, text, q) {
  if (!q) { el.textContent = text; return; }
  const lower = text.toLowerCase(); let i = 0, j;
  while ((j = lower.indexOf(q, i)) !== -1) {
    el.append(text.slice(i, j));
    const m = document.createElement('mark'); m.textContent = text.slice(j, j + q.length); el.append(m);
    i = j + q.length;
  }
  el.append(text.slice(i));
}
function renderMsgs() {
  const q = $('dSearch').value.trim().toLowerCase();
  const hits = q ? openRows.filter((m) => (m.content || '').toLowerCase().includes(q) || (m.author || '').toLowerCase().includes(q)) : openRows;
  const shown = hits.slice(-300);
  $('dList').replaceChildren(...shown.map((m) => {
    const d = document.createElement('div'); d.className = 'msg';
    const a = document.createElement('span'); a.className = 'a'; a.textContent = m.author;
    const t = document.createElement('time'); t.textContent = new Date(F.rowMs(m)).toLocaleString();
    const c = document.createElement('div'); c.className = 'c';
    highlight(c, m.content || ((m.attachments || []).length ? '[attachment]' : ''), q);
    d.append(a, t, c); return d;
  }));
  flash($('dStatus'), q ? `${hits.length.toLocaleString()} matches${hits.length > 300 ? ', showing the newest 300' : ''}` : (openRows.length > 300 ? 'Showing the newest 300. Export for everything.' : ''));
  if (!q) $('dList').scrollTop = $('dList').scrollHeight;
}
$('dSearch').oninput = renderMsgs;
$('dClose').onclick = () => { $('detail').hidden = true; open = null; openRows = []; };
function exportRows() {
  const days = parseInt($('dRange').value, 10);
  return { days, rows: F.sliceDays(openRows, days), meta: { title: open.title || open.id, days, channelId: open.id, guildId: open.guildId, time: settings.time } };
}
$('dDownload').onclick = () => {
  const fmt = $('dFormat').value, x = exportRows();
  if (!x.rows.length) return flash($('dStatus'), 'Nothing in that range.', false);
  saveFile(F.render(fmt, x.rows, x.meta), F.filename(x.meta.title, fmt, x.days), F.FORMATS[fmt].mime);
  flash($('dStatus'), `Downloaded ${x.rows.length.toLocaleString()} messages.`);
};
$('dCopy').onclick = async () => {
  const fmt = $('dFormat').value, x = exportRows();
  if (!x.rows.length) return flash($('dStatus'), 'Nothing in that range.', false);
  try { await navigator.clipboard.writeText(F.render(fmt, x.rows, x.meta)); flash($('dStatus'), `Copied ${x.rows.length.toLocaleString()} messages.`); }
  catch (e) { flash($('dStatus'), 'Clipboard blocked. Use Download.', false); }
};
$('dMedia').onclick = async () => {
  const r = await send({ type: 'saveMedia', channelId: open.id, days: parseInt($('dRange').value, 10) });
  if (!r || r.error) return flash($('dStatus'), 'Could not save media.', false);
  flash($('dStatus'), r.count || r.skipped ? `Saving ${r.count} files to Downloads/Scrollback/${r.skipped ? ` (${r.skipped} saved before)` : ''}` : 'No images or videos in this chat.', !!(r.count || r.skipped));
};
$('dDelete').onclick = async () => {
  if (!confirm(`Delete ${openRows.length.toLocaleString()} saved messages from ${label(open)}? This cannot be undone.`)) return;
  await SBDB.deleteChannel(open.id);
  $('dClose').onclick();
  loadChats();
};

// ---------- settings ----------
async function initSettings() {
  settings = ((await send({ type: 'getSettings' })) || {}).settings || {};
  for (const sel of [$('sFormat'), $('dFormat')]) for (const [k, f] of Object.entries(F.FORMATS)) sel.add(new Option(f.label, k, false, k === settings.format));
  $('sTime').value = settings.time; $('sPace').value = settings.pace; $('sMedia').checked = !!settings.mediaWithJobs;
  const save = async (patch) => { settings = (await send({ type: 'setSettings', settings: patch })).settings; flash($('sStatus'), 'Saved.'); };
  $('sFormat').onchange = () => { $('dFormat').value = $('sFormat').value; save({ format: $('sFormat').value }); };
  $('sTime').onchange = () => save({ time: $('sTime').value });
  $('sPace').onchange = () => save({ pace: $('sPace').value });
  $('sMedia').onchange = () => save({ mediaWithJobs: $('sMedia').checked });
}
async function usage() {
  try {
    const e = await navigator.storage.estimate();
    $('usage').textContent = `Using about ${(e.usage / 1048576).toFixed(1)} MB on this device.`;
  } catch (e) { $('usage').textContent = ''; }
}

// ---------- backup / restore / wipe ----------
$('backup').onclick = async () => {
  const list = await SBDB.listChannels(), out = [];
  for (const c of list) out.push({ channel: c, messages: await SBDB.getMessages(c.id) });
  const n = out.reduce((s, x) => s + x.messages.length, 0);
  saveFile(JSON.stringify({ backup: 'Scrollback', version: F.VERSION, createdAt: new Date().toISOString(), channels: out }),
    `scrollback-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  flash($('dataStatus'), `Backed up ${n.toLocaleString()} messages from ${out.length} chats.`);
};

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function cleanRow(r, cid) {
  if (!r || !F.isId(r.id)) return null;
  const channel_id = F.isId(r.channel_id) ? r.channel_id : cid;
  if (!F.isId(channel_id)) return null;
  const urls = (a) => (Array.isArray(a) ? a : []).map((u) => F.safeUrl(u)).filter(Boolean);
  const rep = r.replyTo && typeof r.replyTo === 'object' && F.isId(r.replyTo.id)
    ? { id: r.replyTo.id, author: s(r.replyTo.author, 100) || undefined, content: s(r.replyTo.content, 4000), attachments: urls(r.replyTo.attachments), unavailable: !!r.replyTo.unavailable } : null;
  return {
    id: r.id, channel_id, type: Number(r.type) || 0, author: s(r.author, 100) || 'unknown', authorId: F.isId(r.authorId) ? r.authorId : null,
    bot: !!r.bot, ts: s(r.ts, 40) || null, editedTs: s(r.editedTs, 40) || null, content: s(r.content, 8000), attachments: urls(r.attachments),
    embeds: (Array.isArray(r.embeds) ? r.embeds : []).slice(0, 10).map((e) => ({ type: s(e && e.type, 20) || null, title: s(e && e.title, 500) || null, description: s(e && e.description, 4000) || null, url: F.safeUrl(e && e.url) })),
    stickers: (Array.isArray(r.stickers) ? r.stickers : []).map((x) => s(x, 100)),
    reactions: (Array.isArray(r.reactions) ? r.reactions : []).map((x) => ({ emoji: s(x && x.emoji, 100), count: Number(x && x.count) || 0 })),
    reactionUsers: r.reactionUsers && typeof r.reactionUsers === 'object' ? Object.fromEntries(Object.entries(r.reactionUsers).slice(0, 50).map(([k, v]) => [s(k, 100), (Array.isArray(v) ? v : []).slice(0, 100).map((x) => s(x, 100))])) : undefined,
    replyTo: rep
  };
}
$('restore').onchange = async (ev) => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return flash($('dataStatus'), 'That file is not valid JSON.', false); }
  // full backup, or a single-chat JSON export
  const groups = data && data.backup === 'Scrollback' && Array.isArray(data.channels) ? data.channels
    : data && data.exporter === 'Scrollback' && Array.isArray(data.messages) ? [{ channel: data.channel || {}, messages: data.messages }] : null;
  if (!groups) return flash($('dataStatus'), 'Not a Scrollback backup or JSON export.', false);
  let n = 0;
  for (const g of groups) {
    const ch = g.channel || {}, cid = F.isId(ch.id) ? ch.id : null;
    const rows = (g.messages || []).map((r) => cleanRow(r, cid)).filter(Boolean);
    for (let i = 0; i < rows.length; i += 1000) await SBDB.putMessages(rows.slice(i, i + 1000));
    const target = cid || (rows[0] && rows[0].channel_id);
    if (target) await SBDB.patchChannel(target, { title: s(ch.title, 120) || null, guildId: F.isId(ch.guildId) ? ch.guildId : null, guildName: s(ch.guildName, 120) || null, reachedStart: ch.reachedStart === true || undefined });
    // gap-free spans from the backup, so restored chats skip re-scrolling
    const idOrStart = (v) => v === '0' || F.isId(v);
    if (target) for (const sp of (Array.isArray(ch.spans) ? ch.spans : []).slice(0, 1000)) {
      if (sp && idOrStart(sp.lo) && idOrStart(sp.hi) && F.cmpId(sp.lo, sp.hi) <= 0) await SBDB.addSpan(target, { lo: sp.lo, hi: sp.hi });
    }
    n += rows.length;
  }
  flash($('dataStatus'), `Restored ${n.toLocaleString()} messages.`);
  loadChats(); usage();
};
$('wipe').onclick = async () => {
  if (!confirm('Delete every saved message, chat and media record? This cannot be undone.')) return;
  await SBDB.wipe();
  flash($('dataStatus'), 'All Scrollback data deleted.');
  $('dClose').onclick(); loadChats(); usage();
};

// ---------- boot ----------
(async () => {
  $('ver').textContent = 'Version ' + chrome.runtime.getManifest().version + '.';
  const p = new URLSearchParams(location.search);
  if (p.has('welcome')) $('welcome').hidden = false;
  $('dismissWelcome').onclick = () => { $('welcome').hidden = true; history.replaceState(null, '', location.pathname); };
  await initSettings(); // also waits for the service worker's v1 migration
  await loadChats();
})();

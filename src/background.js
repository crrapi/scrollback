/*
 * background.js — service worker. Owns persistence (IndexedDB via db.js),
 * rendering for page jobs, settings and on-demand media saving.
 *
 * Media is never saved on passive capture. It saves only when the user asks:
 * the "Save media" button, or a time-range job with "save media with jobs" on.
 */
importScripts('format.js', 'db.js');

var DEFAULT_SETTINGS = { mediaWithJobs: false, time: 'iso', format: 'txt', pace: 'normal' };

var chain = Promise.resolve();
function queue(fn) {
  var p = chain.then(fn);
  chain = p.catch(function (e) { console.warn('[Scrollback]', e); });
  return p;
}

async function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, await SBDB.kvGet('settings', {})); }

// ---------- trimming + validation of tapped payloads ----------
var isId = SBFormat.isId;
function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function name(u) { u = u || {}; return str(u.global_name || u.username || u.id || 'unknown', 100); }
function urls(list) { return (Array.isArray(list) ? list : []).map(function (x) { return x && SBFormat.safeUrl(x.url); }).filter(Boolean); }

function refMsg(m) {
  var r = m.referenced_message;
  if (r && isId(r.id)) return { id: r.id, author: name(r.author), authorId: r.author && r.author.id, content: str(r.content, 4000), attachments: urls(r.attachments) };
  if (m.message_reference && isId(m.message_reference.message_id)) return { id: m.message_reference.message_id, unavailable: true };
  return null;
}
function trim(m, fallbackCid) {
  var cid = isId(m.channel_id) ? m.channel_id : fallbackCid;
  if (!isId(m.id) || !isId(cid)) return null;
  var a = m.author || {};
  return {
    id: m.id,
    channel_id: cid,
    type: typeof m.type === 'number' ? m.type : 0,
    author: name(a),
    authorId: isId(a.id) ? a.id : null,
    bot: !!a.bot,
    ts: str(m.timestamp, 40) || null,
    editedTs: str(m.edited_timestamp, 40) || null,
    content: str(m.content, 8000),
    attachments: urls(m.attachments),
    embeds: (Array.isArray(m.embeds) ? m.embeds : []).slice(0, 10).map(function (e) {
      return { type: str(e.type, 20) || null, title: str(e.title, 500) || null, description: str(e.description, 4000) || null, url: SBFormat.safeUrl(e.url) };
    }),
    stickers: (Array.isArray(m.sticker_items) ? m.sticker_items : []).map(function (s) { return str(s.name, 100); }),
    reactions: (Array.isArray(m.reactions) ? m.reactions : []).map(function (r) {
      return { emoji: str(r.emoji && (r.emoji.name || r.emoji.id), 100), count: Number(r.count) || 0 };
    }),
    replyTo: refMsg(m)
  };
}

async function ingest(urlCid, messages) {
  var rows = [];
  for (var i = 0; i < messages.length && i < 500; i++) { var r = messages[i] && trim(messages[i], isId(urlCid) ? urlCid : null); if (r) rows.push(r); }
  await SBDB.putMessages(rows);
}

// ---------- migration from v1 (chrome.storage.local "ch:<id>" maps) ----------
async function migrateV1() {
  if (await SBDB.kvGet('migratedV1', false)) return;
  var all = await chrome.storage.local.get(null);
  var meta = all['dpe:meta'] || {}, moved = 0, oldKeys = [];
  for (var k in all) {
    if (k.indexOf('ch:') !== 0) continue;
    oldKeys.push(k);
    var cid = k.slice(3), map = (all[k] && all[k].map) || {};
    var rows = Object.values(map).filter(function (r) { return r && isId(r.id); }).map(function (r) {
      r.channel_id = isId(r.channel_id) ? r.channel_id : cid; return r;
    });
    for (var i = 0; i < rows.length; i += 1000) await SBDB.putMessages(rows.slice(i, i + 1000));
    if (meta[cid] && meta[cid].title) await SBDB.patchChannel(cid, { title: meta[cid].title });
    moved += rows.length;
  }
  var old = all['dpe:settings'];
  if (old && old.imagesWithCaptures) await SBDB.kvSet('settings', Object.assign(await getSettings(), { mediaWithJobs: true }));
  await SBDB.kvSet('migratedV1', true);
  oldKeys.push('dpe:meta', 'dpe:settings', 'dpe:clip', 'dpe:dl');
  await chrome.storage.local.remove(oldKeys);
  if (moved) console.info('[Scrollback] migrated', moved, 'messages from v1 storage');
}
var ready = queue(migrateV1);
chrome.runtime.onInstalled.addListener(function (d) {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html?welcome=1') });
});

// ---------- media saving ----------
var MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|mov|webm|mkv|mp3|ogg|wav|m4a)(\?|$)/i;
function sanitize(s) { return String(s || 'file').replace(/[\/\\?%*:|"<>\x00-\x1f~]/g, '_').replace(/^\.+/, '_').slice(0, 100); }
function basename(u) { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || 'file'); } catch (e) { return 'file'; } }
function attKey(u) { try { return new URL(u).pathname.split('/').slice(-3).join('/'); } catch (e) { return String(u).split('?')[0]; } }
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function saveMedia(cid, days) {
  var ch = await SBDB.getChannel(cid);
  var rows = SBFormat.sliceDays(await SBDB.getMessages(cid), days || 0);
  var items = [];
  rows.forEach(function (r) { (r.attachments || []).forEach(function (u) { if (MEDIA.test(u)) items.push({ u: u, r: r }); }); });
  var fresh = new Set(await SBDB.claimSaved(items.map(function (x) { return attKey(x.u); })));
  var todo = items.filter(function (x) { return fresh.has(attKey(x.u)); });
  var folder = 'Scrollback/' + sanitize(ch && ch.title ? SBFormat.slug(ch.title) + '-' + cid : cid);
  // paced in the background so a big channel does not open 1000 downloads at once
  (async function () {
    for (var i = 0; i < todo.length; i++) {
      var x = todo[i];
      chrome.downloads.download({ url: x.u, filename: folder + '/' + sanitize(x.r.id + '_' + basename(x.u)), conflictAction: 'uniquify', saveAs: false }, function () { void chrome.runtime.lastError; });
      await sleep(250);
    }
  })();
  return { count: todo.length, skipped: items.length - todo.length };
}

// ---------- render for page jobs ----------
async function render(cid, days, fmt, title) {
  var s = await getSettings();
  var ch = await SBDB.getChannel(cid);
  var rows = SBFormat.sliceDays(await SBDB.getMessages(cid), days);
  var meta = { title: title || (ch && ch.title) || cid, days: days, channelId: cid, guildId: ch && ch.guildId, time: s.time };
  return { count: rows.length, text: rows.length ? SBFormat.render(fmt || s.format, rows, meta) : '' };
}

// ---------- router ----------
var HANDLERS = {
  capture: function (m) { return ingest(m.urlChannelId, Array.isArray(m.messages) ? m.messages : []); },
  reactions: function (m) {
    if (!isId(m.cid) || !isId(m.mid)) return;
    return SBDB.setReactionUsers(m.cid, m.mid, str(m.emoji, 100), (m.users || []).slice(0, 100).map(function (u) { return str(u && u.name, 100); }));
  },
  start: function (m) { if (isId(m.cid)) return SBDB.patchChannel(m.cid, { reachedStart: true }); },
  where: function (m) {
    if (!isId(m.channelId)) return;
    return SBDB.patchChannel(m.channelId, { title: str(m.title, 120) || null, guildId: isId(m.guildId) ? m.guildId : null, guildName: str(m.guildName, 120) || null });
  },
  channel: async function (m) { return { channel: await SBDB.getChannel(m.channelId) }; },
  channels: async function () { return { channels: await SBDB.listChannels() }; },
  rows: async function (m) { return { rows: await SBDB.getMessages(m.channelId) }; },
  render: function (m) { return render(m.channelId, m.days || 0, m.format, m.title); },
  saveMedia: function (m) { return saveMedia(m.channelId, m.days || 0); },
  clear: async function (m) { await SBDB.deleteChannel(m.channelId); return { ok: true }; },
  getSettings: async function () { return { settings: await getSettings() }; },
  setSettings: async function (m) {
    var s = Object.assign(await getSettings(), m.settings || {});
    await SBDB.kvSet('settings', s); return { settings: s };
  },
  setResult: async function (m) { await SBDB.kvSet('lastResult', { text: str(m.text, 200e6), title: str(m.title, 200), format: m.format, ts: Date.now() }); return { ok: true }; },
  getResult: async function () { return { result: await SBDB.kvGet('lastResult', null) }; }
};
var FIRE_AND_FORGET = { capture: 1, reactions: 1, start: 1, where: 1 };

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || !HANDLERS[msg.type] || sender.id !== chrome.runtime.id) return;
  var p = ready.then(function () { return queue(function () { return HANDLERS[msg.type](msg); }); });
  if (FIRE_AND_FORGET[msg.type]) return;
  p.then(function (r) { reply(r || { ok: true }); }, function (e) { reply({ error: String(e && e.message || e) }); });
  return true;
});

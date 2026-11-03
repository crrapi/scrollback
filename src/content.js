/*
 * content.js — isolated-world content script on discord.com.
 *  - relays what tap.js (MAIN world) captured to the service worker
 *  - reports the current channel, its title and its server
 *  - runs "last N days" jobs for this channel or every channel in the server,
 *    with an on-page progress panel. Jobs drive the real client by scrolling
 *    and clicking the sidebar; they never call the API.
 * Loaded after format.js, so SBFormat is available.
 */
(function () {
  var TAG = 'scrollback:tap';
  var alive = true;

  function bg(msg) {
    return new Promise(function (res) {
      if (!alive) return res(null);
      try {
        chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; res(r || null); });
      } catch (e) { alive = false; res(null); }
    });
  }
  function fire(msg) { if (!alive) return; try { chrome.runtime.sendMessage(msg); } catch (e) { alive = false; } }

  // ---- relay from the MAIN-world tap ----
  var seen = {}; // cid -> { min, n } for job progress
  function note(cid, id) {
    if (!SBFormat.isId(cid) || !SBFormat.isId(id)) return;
    var s = seen[cid] || (seen[cid] = { min: null, n: 0 });
    s.n++;
    if (!s.min || SBFormat.cmpId(id, s.min) < 0) s.min = id;
  }
  var started = {}; // cid -> true once the channel start was reached this page load
  var latest = {};  // cid -> newest message id from this page load's newest-page fetch
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || ev.origin !== location.origin) return;
    var d = ev.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === 'messages' && Array.isArray(d.messages)) {
      d.messages.forEach(function (m) { note(m && m.channel_id || d.urlChannelId, m && m.id); });
      fire({ type: 'capture', urlChannelId: d.urlChannelId, messages: d.messages });
    } else if (d.kind === 'reactions') {
      fire({ type: 'reactions', cid: d.cid, mid: d.mid, emoji: d.emoji, users: d.users });
    } else if (d.kind === 'span' && d.span) {
      if (d.span.latest) latest[d.cid] = d.span.hi;
      if (d.span.lo === '0') started[d.cid] = true;
      fire({ type: 'span', cid: d.cid, span: d.span });
    }
  });

  // ---- where are we ----
  function here() { return SBFormat.parseLocation(location.pathname); }
  function titles() {
    // document.title looks like "Discord | #general | My Server" or "#general | My Server"
    var parts = (document.title || '').replace(/^\(\d+\)\s*/, '').split(' | ').map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s !== 'Discord'; });
    var h1 = document.querySelector('section[class*="title"] h1, [class*="titleWrapper"] h1, header h1');
    var chan = (h1 && h1.textContent.trim()) || parts[0] || null;
    var guild = here().guildId && parts.length > 1 ? parts[parts.length - 1] : null;
    return { title: chan ? chan.replace(/^#/, '') : null, guildName: guild };
  }
  function reportWhere() {
    var h = here(); if (!h.channelId) return;
    var t = titles();
    fire({ type: 'where', channelId: h.channelId, guildId: h.guildId, title: t.title, guildName: t.guildName });
  }
  var lastHref = '';
  setInterval(function () { if (location.href !== lastHref) { lastHref = location.href; setTimeout(reportWhere, 900); } }, 1000);

  // ---- helpers ----
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // nearest ancestor that scrolls; short chats that fit on screen still count
  // when anyHeight is set, since their list is styled to scroll
  function scrollableAncestor(el, stop, anyHeight) {
    while (el && el !== stop) {
      var o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && (anyHeight || el.scrollHeight > el.clientHeight + 20)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function findScroller() {
    var list = document.querySelector('[data-list-id="chat-messages"]');
    return list ? scrollableAncestor(list, document.body, true) : null;
  }
  function oldestSeen(cid) { return (seen[cid] && seen[cid].min) || null; }
  async function channelMeta(cid) { var r = await bg({ type: 'channel', channelId: cid }); return (r && r.channel) || null; }
  // Saved history counts only when one gap-free span runs from the newest
  // message this page load saw back past the cutoff. Old saves with holes in
  // them never end a job early.
  async function covered(cid, days) {
    if (latest[cid] == null) return false;
    var meta = await channelMeta(cid);
    return SBFormat.spanCovers(meta && meta.spans, latest[cid], SBFormat.cutoffId(days));
  }

  // ---- progress panel (closed shadow root, so page CSS cannot reach it) ----
  var panel = null, running = false, stopFlag = false;
  function show(text, busy) {
    if (!document.body) return;
    if (!panel) {
      var host = document.createElement('div');
      var root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>' +
        '.p{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;background:#1e1f22;color:#e6e6e9;' +
        'font:12px/1.45 system-ui,sans-serif;padding:10px 12px;border:1px solid #3a3c41;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45)}' +
        '.h{font-weight:700;color:#a5a6f6;margin-bottom:2px}button{margin-top:8px;background:#da373c;color:#fff;border:0;border-radius:6px;' +
        'padding:4px 10px;font:600 11px system-ui;cursor:pointer}</style><div class="p"><div class="h">Scrollback</div><div class="t"></div><button>Stop</button></div>';
      root.querySelector('button').onclick = function () { stopFlag = true; show('Stopping after this step…', true); };
      panel = { host: host, t: root.querySelector('.t'), b: root.querySelector('button') };
      document.body.appendChild(host);
    }
    panel.t.textContent = text;
    panel.b.style.display = busy ? 'inline-block' : 'none';
    if (!busy) setTimeout(function () { if (panel && !running) { panel.host.remove(); panel = null; } }, 10000);
  }

  // Chrome fires scroll events from its rendering loop, which barely runs in
  // a background tab. Dispatch one so the client's loader still sees the move.
  function scrollEl(el, top) {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  }

  // ---- scroll this channel back until the cutoff or the channel start ----
  async function scrollBack(days, cid, pace, onProgress) {
    var cutoff = days > 0 ? SBFormat.snowflakeForMs(SBFormat.cutoffMs(days)) : null;
    var idle = 0, lastMin = null, base = pace === 'gentle' ? 1800 : 900;
    for (var step = 0; step < 20000; step++) {
      if (stopFlag) return 'stopped';
      var scroller = findScroller(); if (!scroller) return 'no-scroller';
      // once this page load's scrolling meets saved history, the rest is known
      if (await covered(cid, days)) return 'covered';
      if (started[cid]) return 'start';
      var oldest = oldestSeen(cid);
      if (latest[cid] == null && cutoff && oldest && SBFormat.cmpId(oldest, cutoff) <= 0) return 'cutoff';
      if (scroller.scrollTop <= 1) {
        // already at the top: setting 0 again fires no scroll event, so the
        // client never asks for older messages. Step down and back up.
        scrollEl(scroller, Math.min(120, scroller.scrollHeight));
        await sleep(80);
        scrollEl(scroller, 0);
      } else {
        scrollEl(scroller, Math.max(0, scroller.scrollTop - Math.floor(scroller.clientHeight * 0.85)));
      }
      await sleep(base + Math.floor(Math.random() * base * 0.5));
      var nowMin = oldestSeen(cid);
      if (nowMin === lastMin) idle++; else { idle = 0; lastMin = nowMin; }
      if (onProgress) onProgress(((seen[cid] && seen[cid].n) || 0) + ' seen, back to ' + (nowMin ? SBFormat.day(SBFormat.msFromSnowflake(nowMin)) : '?'));
      var fits = scroller.scrollHeight <= scroller.clientHeight + 20;
      if (scroller.scrollTop <= 1 && idle >= (fits ? 2 : 5)) return 'top';
      if (idle >= 15) return 'stall';
    }
    return 'max-steps';
  }

  function download(text, filename, mime) {
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function range(days) { return days > 0 ? 'last ' + days + 'd' : 'full history'; }

  // ---- already saved: export straight away, nothing to scroll ----
  async function instant(cid, days) {
    var settings = ((await bg({ type: 'getSettings' })) || {}).settings || {};
    var title = titles().title || cid;
    var out = await bg({ type: 'render', channelId: cid, days: days, format: settings.format, title: title });
    if (!out) return null;
    if (out.count) await bg({ type: 'setResult', text: out.text, title: title + ' (' + range(days) + ')', format: settings.format || 'txt' });
    var media = null;
    if (settings.mediaWithJobs && out.count) media = await bg({ type: 'saveMedia', channelId: cid, days: days });
    return { count: out.count, media: media ? media.count : 0 };
  }

  // ---- channel job ----
  async function runChannel(days) {
    var h = here(); if (!h.channelId) return show('Open a channel or DM first.', false);
    var cid = h.channelId, title = titles().title || cid;
    var settings = ((await bg({ type: 'getSettings' })) || {}).settings || {};
    running = true; stopFlag = false;
    try {
      show('Checking what is already saved…', true);
      var why = await scrollBack(days, cid, settings.pace, function (info) { show('Loading ' + range(days) + ' of ' + title + ' — ' + info, true); });
      if (why === 'no-scroller') return show('Could not find the message list. Open a text channel.', false);
      var out = await bg({ type: 'render', channelId: cid, days: days, format: settings.format, title: title });
      if (!out) return show('The extension was updated. Reload this tab and try again.', false);
      if (!out.count) return show('No messages in the ' + range(days) + '.', false);
      var fmt = settings.format || 'txt';
      download(out.text, SBFormat.filename(title, fmt, days), SBFormat.FORMATS[fmt].mime);
      await bg({ type: 'setResult', text: out.text, title: title + ' (' + range(days) + ')', format: fmt });
      var media = '';
      if (settings.mediaWithJobs) { var r = await bg({ type: 'saveMedia', channelId: cid, days: days }); if (r) media = ', ' + r.count + ' media files'; }
      show((stopFlag ? 'Stopped. Saved what loaded: ' : 'Saved ') + out.count + ' messages from ' + title + media + '.', false);
    } finally { running = false; }
  }

  // ---- server channel enumeration ----
  function sidebarScroller(guild) {
    var any = document.querySelector('a[href^="/channels/' + guild + '/"]');
    return any ? scrollableAncestor(any, document.body) : null;
  }
  async function collectChannels(guild) {
    var found = new Map();
    function scan() {
      document.querySelectorAll('a[href^="/channels/' + guild + '/"]').forEach(function (a) {
        var m = (a.getAttribute('href') || '').match(/^\/channels\/\d+\/(\d+)$/);
        if (!m || found.has(m[1])) return;
        var label = (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ');
        found.set(m[1], { id: m[1], href: a.getAttribute('href'), name: label.replace(/\s*\(.*$/, '').slice(0, 80) || m[1] });
      });
    }
    scan();
    var sc = sidebarScroller(guild);
    if (sc) {
      scrollEl(sc, 0); await sleep(300); scan();
      var last = -1;
      for (var i = 0; i < 400 && !stopFlag; i++) {
        scrollEl(sc, Math.min(sc.scrollHeight, sc.scrollTop + Math.floor(sc.clientHeight * 0.8)));
        await sleep(220); scan();
        if (sc.scrollTop === last) break; last = sc.scrollTop;
      }
      scrollEl(sc, 0); await sleep(200);
    }
    return Array.from(found.values());
  }
  async function openChannel(ch, guild) {
    var sel = 'a[href="' + ch.href + '"]', a = document.querySelector(sel);
    if (!a) {
      var sc = sidebarScroller(guild);
      for (var i = 0; sc && i < 400 && !a; i++) {
        scrollEl(sc, sc.scrollTop + Math.floor(sc.clientHeight * 0.8)); await sleep(140);
        a = document.querySelector(sel);
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight) break;
      }
    }
    if (!a) return false;
    a.scrollIntoView({ block: 'center' }); await sleep(120);
    a.click();
    for (var j = 0; j < 40; j++) { await sleep(150); if (here().channelId === ch.id && findScroller()) break; }
    if (here().channelId !== ch.id || !findScroller()) return false;
    // wait for the newest page so saved history can be matched against it
    for (var k = 0; k < 20 && latest[ch.id] == null; k++) await sleep(150);
    return true;
  }

  // ---- server job ----
  async function runServer(days) {
    var h = here(); if (!h.guildId) return show('Open a server channel first (DMs have no server).', false);
    var guild = h.guildId, guildName = titles().guildName || guild;
    var settings = ((await bg({ type: 'getSettings' })) || {}).settings || {};
    var fmt = settings.format === 'json' || settings.format === 'csv' ? 'txt' : (settings.format || 'txt');
    running = true; stopFlag = false;
    try {
      show('Collecting the channel list…', true);
      var chans = await collectChannels(guild);
      if (!chans.length) return show('No channels found in the sidebar.', false);
      var parts = [], scanned = 0, total = 0, mediaTotal = 0;
      for (var i = 0; i < chans.length && !stopFlag; i++) {
        var ch = chans[i], tag = '[' + (i + 1) + '/' + chans.length + '] #' + ch.name;
        show(tag + ' — opening…', true);
        if (!(await openChannel(ch, guild))) continue; // voice, forum, locked: skip
        scanned++;
        if (await covered(ch.id, days)) show(tag + ' — already saved', true);
        else await scrollBack(days, ch.id, settings.pace, function (info) { show(tag + ' — ' + info, true); });
        var out = await bg({ type: 'render', channelId: ch.id, days: days, format: fmt, title: '#' + ch.name });
        if (out && out.count) { parts.push(out.text); total += out.count; }
        if (settings.mediaWithJobs && out && out.count && !stopFlag) {
          var r = await bg({ type: 'saveMedia', channelId: ch.id, days: days }); if (r) mediaTotal += r.count;
        }
      }
      var sepr = fmt === 'html' ? '\n<hr>\n' : '\n\n' + '='.repeat(60) + '\n\n';
      var head = fmt === 'html' ? '' : (fmt === 'md' ? '# ' : '# Server export: ') + guildName + ' — ' + range(days) + ', ' + scanned + ' channels, ' + total + ' messages, ' + new Date().toISOString() + '\n\n';
      var combined = head + parts.join(sepr);
      if (total) {
        download(combined, SBFormat.filename(guildName + '-server', fmt, days), SBFormat.FORMATS[fmt].mime);
        await bg({ type: 'setResult', text: combined, title: guildName + ' server (' + range(days) + ')', format: fmt });
      }
      show('Server ' + (stopFlag ? 'stopped' : 'done') + ': ' + scanned + ' channels, ' + total + ' messages' + (settings.mediaWithJobs ? ', ' + mediaTotal + ' media files' : '') + '.', false);
    } finally { running = false; }
  }

  // ---- popup -> page ----
  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'job') {
      if (running) return reply({ ok: false, busy: true });
      var days = Math.max(0, parseInt(msg.days, 10) || 0), cid = here().channelId;
      (async function () {
        // channel range already saved gap-free: hand the result straight back
        if (msg.scope !== 'server' && cid && await covered(cid, days)) {
          var r = await instant(cid, days);
          if (r) return reply({ ok: true, instant: true, count: r.count, media: r.media });
        }
        (msg.scope === 'server' ? runServer(days) : runChannel(days)).catch(function (e) { running = false; show('Job failed: ' + (e && e.message || e), false); });
        reply({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'jobStop') { stopFlag = true; return reply({ ok: true }); }
    if (msg.type === 'jobStatus') return reply({ running: running });
    if (msg.type === 'whereAmI') { var h = here(), t = titles(); return reply({ channelId: h.channelId, guildId: h.guildId, title: t.title, guildName: t.guildName }); }
  });
})();

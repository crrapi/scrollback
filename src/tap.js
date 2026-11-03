/*
 * tap.js — MAIN-world content script, document_start (declared in manifest).
 *
 * Read-only tap on responses the Discord client already requested. It wraps
 * fetch and XMLHttpRequest only to read JSON bodies of:
 *   - /channels/{id}/messages[...]                    -> message objects
 *   - /channels|guilds/{id}/messages/search           -> search hits
 *   - /channels/{id}/messages/{id}/reactions/{emoji}  -> who reacted (only when
 *     the user opens the reaction list, so the client fetches it)
 * It makes no requests of its own and never reads request headers or tokens.
 * Results go to the isolated-world content script via window.postMessage.
 */
(function () {
  var TAG = 'scrollback:tap';
  var RE_API = /^\/api\/(?:v\d+\/)?/;
  var RE_MESSAGES = /\/(?:channels|guilds)\/\d+\/messages(?:\/search)?\/?$/;
  var RE_REACTIONS = /\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/?$/;

  function path(u) {
    try {
      var p = new URL(u, location.href);
      return /(^|\.)discord\.com$/.test(p.hostname) && RE_API.test(p.pathname) ? p.pathname : null;
    } catch (e) { return null; }
  }
  function wanted(u) { var p = path(u); return !!p && (RE_MESSAGES.test(p) || RE_REACTIONS.test(p)); }

  function post(payload) {
    payload.source = TAG;
    try { window.postMessage(payload, location.origin); } catch (e) {}
  }

  // custom emoji URLs are "name:id"; unicode ones are percent-encoded. Key by
  // the name so it lines up with the reaction's emoji.name on the message.
  function emojiKey(raw) {
    var d = raw; try { d = decodeURIComponent(raw); } catch (e) {}
    var c = d.indexOf(':'); return c > 0 ? d.slice(0, c) : d;
  }

  function handle(u, body) {
    var p = path(u); if (!p || body == null) return;
    var r = RE_REACTIONS.exec(p);
    if (r) {
      if (Array.isArray(body)) post({ kind: 'reactions', cid: r[1], mid: r[2], emoji: emojiKey(r[3]), users: body.map(function (x) { return { id: x.id, name: x.global_name || x.username || x.id }; }) });
      return;
    }
    var cm = /\/channels\/(\d+)\/messages/.exec(p);
    var cid = cm ? cm[1] : null, list = [];
    if (Array.isArray(body)) list = body;
    else if (Array.isArray(body.messages)) body.messages.forEach(function (g) { if (Array.isArray(g)) list.push.apply(list, g); else if (g) list.push(g); });
    else if (body.id) list = [body];
    list = list.filter(function (m) { return m && typeof m.id === 'string'; });
    if (list.length) post({ kind: 'messages', urlChannelId: cid, messages: list });
  }

  // a page shorter than its limit, loaded from the newest end or going older,
  // means the channel start was reached
  function handleStart(u, body) {
    var p = path(u);
    if (!p || !Array.isArray(body)) return;
    var cm = /\/channels\/(\d+)\/messages\/?$/.exec(p);
    if (!cm) return;
    var q; try { q = new URL(u, location.href).searchParams; } catch (e) { return; }
    if (q.has('after') || q.has('around')) return;
    var limit = parseInt(q.get('limit') || '50', 10) || 50;
    if (body.length < limit) post({ kind: 'start', cid: cm[1] });
  }

  var origFetch = window.fetch;
  window.fetch = function (input) {
    var p = origFetch.apply(this, arguments);
    try {
      var u = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (wanted(u)) p.then(function (res) {
        if (!res.ok) return;
        res.clone().json().then(function (j) { handle(u, j); handleStart(u, j); }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
    return p;
  };

  var XP = XMLHttpRequest.prototype;
  var urls = new WeakMap();
  var origOpen = XP.open, origSend = XP.send;
  XP.open = function (method, url) {
    try { urls.set(this, String(url)); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XP.send = function () {
    var xhr = this, u = urls.get(xhr);
    try {
      if (wanted(u)) xhr.addEventListener('load', function () {
        if (xhr.status < 200 || xhr.status >= 300) return;
        var body = null;
        try {
          if (xhr.responseType === 'json') body = xhr.response;
          else if (xhr.responseType === '' || xhr.responseType === 'text') body = JSON.parse(xhr.responseText);
        } catch (e) { return; }
        handle(u, body); handleStart(u, body);
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();

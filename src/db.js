/*
 * db.js — IndexedDB store shared by the service worker and the library page
 * (same extension origin, same database). Exposes self.SBDB.
 *
 *   messages  key id, index byChannel [channel_id, sk]   (sk = zero-padded id)
 *   channels  key id  { id, guildId, title, count, oldestId, newestId, reachedStart, spans, updated }
 *   kv        key k   { k, v }   settings, last job result, schema flags
 *   saved     key k   attachment keys already downloaded (dedup)
 */
(function (root) {
  var NAME = 'scrollback', VER = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        var ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('byChannel', ['channel_id', 'sk']);
        db.createObjectStore('channels', { keyPath: 'id' });
        db.createObjectStore('kv', { keyPath: 'k' });
        db.createObjectStore('saved', { keyPath: 'k' });
      };
      rq.onsuccess = function () {
        var db = rq.result;
        db.onversionchange = function () { db.close(); dbp = null; };
        res(db);
      };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }
  function done(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = tx.onabort = function () { rej(tx.error); }; }); }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function chanRange(cid) { return IDBKeyRange.bound([cid, ''], [cid, '￿']); }

  async function kvGet(k, dflt) {
    var db = await open();
    var row = await req(db.transaction('kv').objectStore('kv').get(k));
    return row ? row.v : dflt;
  }
  async function kvSet(k, v) {
    var db = await open(); var tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ k: k, v: v }); return done(tx);
  }

  // rows: already-trimmed messages. Keeps reaction-user enrichment on rewrite.
  async function putMessages(rows) {
    if (!rows.length) return [];
    var db = await open();
    // read old rows first so reaction-user enrichment survives the rewrite
    var rs = db.transaction('messages').objectStore('messages');
    var olds = await Promise.all(rows.map(function (r) { return req(rs.get(r.id)); }));
    var tx = db.transaction(['messages', 'channels'], 'readwrite');
    var ms = tx.objectStore('messages'), cs = tx.objectStore('channels');
    var touched = {};
    rows.forEach(function (r, i) {
      r.sk = SBFormat.sortKey(r.id);
      touched[r.channel_id] = true;
      var old = olds[i];
      if (old && old.reactionUsers && !r.reactionUsers) r.reactionUsers = old.reactionUsers;
      ms.put(r);
    });
    var cids = Object.keys(touched);
    // queued after the puts, so these requests see them (IDB runs requests in order)
    cids.forEach(function (cid) {
      var range = chanRange(cid), idx = ms.index('byChannel');
      var stats = {};
      var n = idx.count(range);
      n.onsuccess = function () { stats.count = n.result; };
      var lo = idx.openKeyCursor(range, 'next'), hi = idx.openKeyCursor(range, 'prev');
      lo.onsuccess = function () { stats.oldestId = lo.result ? lo.result.primaryKey : null; };
      hi.onsuccess = function () {
        stats.newestId = hi.result ? hi.result.primaryKey : null;
        var g = cs.get(cid);
        g.onsuccess = function () {
          var c = g.result || { id: cid, guildId: null, title: null, reachedStart: false };
          c.count = stats.count; c.oldestId = stats.oldestId; c.newestId = stats.newestId; c.updated = Date.now();
          cs.put(c);
        };
      };
    });
    await done(tx);
    return cids;
  }

  async function setReactionUsers(cid, mid, emoji, names) {
    var db = await open(); var tx = db.transaction('messages', 'readwrite'); var ms = tx.objectStore('messages');
    var g = ms.get(mid);
    g.onsuccess = function () {
      var r = g.result; if (!r || r.channel_id !== cid) return;
      r.reactionUsers = r.reactionUsers || {}; r.reactionUsers[emoji] = names; ms.put(r);
    };
    return done(tx);
  }

  async function patchChannel(cid, patch) {
    var db = await open(); var tx = db.transaction('channels', 'readwrite'); var cs = tx.objectStore('channels');
    var g = cs.get(cid);
    g.onsuccess = function () {
      var c = g.result || { id: cid, guildId: null, title: null, count: 0, oldestId: null, newestId: null, reachedStart: false, updated: Date.now() };
      Object.keys(patch).forEach(function (k) { if (patch[k] !== undefined && patch[k] !== null) c[k] = patch[k]; });
      cs.put(c);
    };
    return done(tx);
  }

  // record a gap-free id range; reaching lo '0' also marks the channel start
  async function addSpan(cid, span) {
    var db = await open(); var tx = db.transaction('channels', 'readwrite'); var cs = tx.objectStore('channels');
    var g = cs.get(cid);
    g.onsuccess = function () {
      var c = g.result || { id: cid, guildId: null, title: null, count: 0, oldestId: null, newestId: null, reachedStart: false, updated: Date.now() };
      c.spans = SBFormat.mergeSpan(c.spans, span);
      if (span.lo === '0') c.reachedStart = true;
      cs.put(c);
    };
    return done(tx);
  }

  async function getChannel(cid) { var db = await open(); return (await req(db.transaction('channels').objectStore('channels').get(cid))) || null; }
  async function listChannels() { var db = await open(); return req(db.transaction('channels').objectStore('channels').getAll()); }

  // all rows for a channel in id order, optionally only newer than a snowflake
  async function getMessages(cid, afterId) {
    var db = await open();
    var lo = afterId ? [cid, SBFormat.sortKey(afterId)] : [cid, ''];
    var rows = await req(db.transaction('messages').objectStore('messages').index('byChannel').getAll(IDBKeyRange.bound(lo, [cid, '￿'])));
    rows.forEach(function (r) { delete r.sk; });
    return rows;
  }

  async function deleteChannel(cid) {
    var db = await open(); var tx = db.transaction(['messages', 'channels'], 'readwrite');
    var cur = tx.objectStore('messages').index('byChannel').openKeyCursor(chanRange(cid));
    var ms = tx.objectStore('messages');
    cur.onsuccess = function () { var c = cur.result; if (c) { ms.delete(c.primaryKey); c.continue(); } };
    tx.objectStore('channels').delete(cid);
    return done(tx);
  }

  async function wipe() {
    var db = await open(); var tx = db.transaction(['messages', 'channels', 'saved', 'kv'], 'readwrite');
    ['messages', 'channels', 'saved'].forEach(function (s) { tx.objectStore(s).clear(); });
    tx.objectStore('kv').delete('lastResult');
    return done(tx);
  }

  // returns the subset of keys not yet saved and marks them saved
  async function claimSaved(keys) {
    var db = await open(); var tx = db.transaction('saved', 'readwrite'); var st = tx.objectStore('saved');
    var fresh = [];
    keys.forEach(function (k) {
      var g = st.getKey(k);
      g.onsuccess = function () { if (g.result === undefined) { fresh.push(k); st.put({ k: k, t: Date.now() }); } };
    });
    await done(tx);
    return fresh;
  }

  root.SBDB = {
    open: open, kvGet: kvGet, kvSet: kvSet, putMessages: putMessages, setReactionUsers: setReactionUsers,
    patchChannel: patchChannel, addSpan: addSpan, getChannel: getChannel, listChannels: listChannels, getMessages: getMessages,
    deleteChannel: deleteChannel, wipe: wipe, claimSaved: claimSaved
  };
})(typeof self !== 'undefined' ? self : globalThis);

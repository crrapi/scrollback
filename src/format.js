/*
 * format.js — shared by the content script, the service worker, the popup and
 * the library page. Single source of truth for snowflake math, URL parsing,
 * time-window slicing and every exporter. Exposes self.SBFormat.
 */
(function (root) {
  var DISCORD_EPOCH = 1420070400000;
  var VERSION = '2.0.1';

  // ---------- snowflakes ----------
  var SNOWFLAKE = /^\d{15,21}$/;
  function isId(id) { return typeof id === 'string' && SNOWFLAKE.test(id); }
  // zero-padded so plain string order equals numeric order (IndexedDB keys)
  function sortKey(id) { return String(id).padStart(21, '0'); }
  function snowflakeForMs(ms) {
    return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH)) << 22n).toString();
  }
  function msFromSnowflake(id) {
    try { return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH)); } catch (e) { return NaN; }
  }
  function cmpId(a, b) { a = BigInt(a); b = BigInt(b); return a < b ? -1 : a > b ? 1 : 0; }
  // days <= 0 means "all time"
  function cutoffMs(days, now) { return days > 0 ? (now || Date.now()) - days * 86400000 : -Infinity; }

  // ---------- discord.com URLs ----------
  // /channels/@me/<dm>, /channels/<guild>/<channel>, /channels/<guild>/<channel>/<message>,
  // /channels/<guild>/<channel>/threads/<thread>
  function parseLocation(pathname) {
    var m = /^\/channels\/(@me|\d+)\/(\d+)(?:\/threads\/(\d+))?/.exec(pathname || '');
    if (!m) return { guildId: null, channelId: null };
    return { guildId: m[1] === '@me' ? null : m[1], channelId: m[3] || m[2] };
  }

  // ---------- windows ----------
  function rowMs(m) {
    if (m.ts) { var t = Date.parse(m.ts); if (!isNaN(t)) return t; }
    if (m.id) return msFromSnowflake(m.id);
    return NaN;
  }
  // keep rows newer than the cutoff; rows with no parseable time are kept
  function sliceDays(rows, days) {
    if (!(days > 0)) return rows.slice();
    var c = cutoffMs(days);
    return rows.filter(function (m) { var t = rowMs(m); return isNaN(t) ? true : t >= c; });
  }
  // true when the oldest stored row already reaches back past the cutoff, or
  // the channel start was reached earlier (meta.complete)
  function isCoveredBack(rows, days, meta) {
    if (meta && meta.reachedStart) return true;
    if (!(days > 0) || !rows || !rows.length) return false;
    var c = cutoffMs(days), min = Infinity;
    for (var i = 0; i < rows.length; i++) { var t = rowMs(rows[i]); if (!isNaN(t) && t < min) min = t; }
    return min <= c;
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  // only http(s) links survive into exported HTML
  function safeUrl(u) {
    try { var p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch (e) { return null; }
  }
  // legacy rows stored replyTo as a bare id string
  function normReply(r) { return typeof r === 'string' ? { id: r, unavailable: true } : r; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts, opts) {
    if (!ts) return '?';
    if (!opts || opts.time !== 'local') return ts;
    var d = new Date(ts); if (isNaN(d)) return ts;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function day(ms) { return isNaN(ms) ? '?' : new Date(ms).toISOString().slice(0, 10); }
  function oneLine(s, max) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }
  function reactionList(m) {
    return (m.reactions || []).map(function (x) {
      var who = m.reactionUsers && m.reactionUsers[x.emoji];
      return { emoji: x.emoji, count: x.count, who: who && who.length ? who : null };
    });
  }
  function header(rows, meta) {
    meta = meta || {};
    var range = meta.days > 0 ? 'last ' + meta.days + 'd' : 'all captured';
    return { title: meta.title || 'Discord channel', line: rows.length + ' messages, ' + range + ', exported ' + new Date().toISOString() };
  }

  // ---------- exporters ----------
  function text(rows, meta) {
    meta = meta || {};
    var h = header(rows, meta);
    return '# ' + h.title + '\n# ' + h.line + '\n\n' + rows.map(function (m) {
      var out = '', r = normReply(m.replyTo);
      if (r && (r.author || r.content)) {
        out += '  ↳ reply to ' + (r.author || '?') + ': ' + (oneLine(r.content, 160) || '[no text / attachment only]') + '\n';
      } else if (r && r.id) {
        out += '  ↳ reply to message ' + r.id + ' [not loaded]\n';
      }
      out += '[' + fmtTime(m.ts, meta) + '] ' + m.author + (m.bot ? ' (bot)' : '') + ': ' + (m.content || '');
      if (m.editedTs) out += ' (edited)';
      if (m.attachments && m.attachments.length) out += '\n  ' + m.attachments.join('\n  ');
      (m.embeds || []).forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var p = [e.title, e.description].filter(Boolean).join(' — ');
        if (p || e.url) out += '\n  [embed: ' + p + (e.url ? ' <' + e.url + '>' : '') + ']';
      });
      if (m.stickers && m.stickers.length) out += '\n  [sticker: ' + m.stickers.join(', ') + ']';
      var rx = reactionList(m);
      if (rx.length) out += '\n  [reactions: ' + rx.map(function (x) {
        return x.emoji + '×' + x.count + (x.who ? ' (' + x.who.join(', ') + ')' : '');
      }).join(', ') + ']';
      return out;
    }).join('\n') + '\n';
  }

  function markdown(rows, meta) {
    meta = meta || {};
    var h = header(rows, meta), lastDay = null, out = ['# ' + h.title, '', '_' + h.line + '_', ''];
    rows.forEach(function (m) {
      var d = day(rowMs(m));
      if (d !== lastDay) { out.push('', '## ' + d, ''); lastDay = d; }
      var r = normReply(m.replyTo);
      if (r && (r.author || r.content)) out.push('> ↳ **' + (r.author || '?') + '**: ' + (oneLine(r.content, 160) || '_attachment_'));
      var body = (m.content || '').replace(/\n/g, '  \n');
      out.push('**' + m.author + '**' + (m.bot ? ' `bot`' : '') + ' · ' + fmtTime(m.ts, meta) + (m.editedTs ? ' _(edited)_' : '') + '  ');
      if (body) out.push(body + '  ');
      (m.attachments || []).forEach(function (u) { out.push('[' + (u.split('/').pop().split('?')[0] || 'attachment') + '](' + u + ')  '); });
      (m.embeds || []).forEach(function (e) {
        if (!e) return; var p = [e.title, e.description].filter(Boolean).join(' — ');
        if (p || e.url) out.push('> ' + oneLine(p, 300) + (e.url ? ' <' + e.url + '>' : ''));
      });
      var rx = reactionList(m);
      if (rx.length) out.push(rx.map(function (x) { return x.emoji + ' ' + x.count; }).join(' · '));
      out.push('');
    });
    return out.join('\n');
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // leading = + - @ would run as a formula in Excel / Sheets
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(rows, meta) {
    var cols = ['id', 'timestamp', 'edited', 'author', 'author_id', 'bot', 'content', 'reply_to_id', 'reply_to_author', 'attachments', 'reactions'];
    var lines = [cols.join(',')];
    rows.forEach(function (m) {
      var r = normReply(m.replyTo) || {};
      lines.push([
        m.id, fmtTime(m.ts, meta), m.editedTs || '', m.author, m.authorId || '', m.bot ? 1 : 0, m.content || '',
        r.id || '', r.author || '', (m.attachments || []).join(' '),
        reactionList(m).map(function (x) { return x.emoji + ':' + x.count; }).join(' ')
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function json(rows, meta) {
    meta = meta || {};
    return JSON.stringify({
      exporter: 'Scrollback', version: VERSION, exportedAt: new Date().toISOString(),
      channel: { id: meta.channelId || null, guildId: meta.guildId || null, title: meta.title || null },
      range: meta.days > 0 ? { lastDays: meta.days } : 'all-captured',
      count: rows.length, messages: rows
    }, null, 2);
  }

  function html(rows, meta) {
    meta = meta || {};
    var h = header(rows, meta), lastDay = null;
    var body = rows.map(function (m) {
      var d = day(rowMs(m)), sep = '';
      if (d !== lastDay) { sep = '<h2>' + d + '</h2>'; lastDay = d; }
      var r = normReply(m.replyTo), rep = '';
      if (r && (r.author || r.content)) rep = '<div class="rep">↳ <b>' + esc(r.author || '?') + '</b> ' + (esc(oneLine(r.content, 200)) || '<i>attachment</i>') + '</div>';
      else if (r && r.id) rep = '<div class="rep">↳ reply to ' + esc(r.id) + ' <i>(not loaded)</i></div>';
      var atts = (m.attachments || []).map(function (u) {
        var s = safeUrl(u); if (!s) return '';
        var name = esc(s.split('/').pop().split('?')[0] || 'attachment');
        return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(s)
          ? '<a href="' + esc(s) + '"><img loading="lazy" src="' + esc(s) + '" alt="' + name + '"></a>'
          : '<a class="file" href="' + esc(s) + '">' + name + '</a>';
      }).join('');
      var emb = (m.embeds || []).map(function (e) {
        if (!e || typeof e !== 'object') return '';
        var p = [e.title, e.description].filter(Boolean).map(esc).join(' — '), u = safeUrl(e.url);
        return (p || u) ? '<div class="emb">' + p + (u ? ' <a href="' + esc(u) + '">link</a>' : '') + '</div>' : '';
      }).join('');
      var stk = (m.stickers && m.stickers.length) ? '<div class="stk">sticker: ' + esc(m.stickers.join(', ')) + '</div>' : '';
      var rx = reactionList(m);
      var rxh = rx.length ? '<div class="rx">' + rx.map(function (x) {
        return '<span' + (x.who ? ' title="' + esc(x.who.join(', ')) + '"' : '') + '>' + esc(x.emoji) + ' ' + esc(x.count) + '</span>';
      }).join('') + '</div>' : '';
      return sep + '<div class="m" id="m' + esc(m.id) + '">' + rep +
        '<div class="hd"><span class="a">' + esc(m.author) + '</span>' + (m.bot ? '<span class="bot">BOT</span>' : '') +
        '<time datetime="' + esc(m.ts) + '">' + esc(fmtTime(m.ts, meta)) + (m.editedTs ? ' (edited)' : '') + '</time></div>' +
        '<div class="c">' + esc(m.content) + '</div>' + (atts ? '<div class="at">' + atts + '</div>' : '') + emb + stk + rxh + '</div>';
    }).join('\n');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\'">' +
      '<title>' + esc(h.title) + '</title><style>\n' +
      ':root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mut:#6b7280;--line:#e5e7eb;--acc:#5b5bd6;--chip:#f1f1f6}\n' +
      '@media (prefers-color-scheme:dark){:root{--bg:#18191c;--fg:#e6e6e9;--mut:#9a9ba1;--line:#2c2e33;--chip:#26282d;--acc:#8d8df0}}\n' +
      'body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:2rem 1rem;max-width:860px;background:var(--bg);color:var(--fg)}\n' +
      'h1{font-size:1.3rem;margin:0}.sub{color:var(--mut);font-size:.85rem;margin:.25rem 0 1.5rem}\n' +
      'h2{position:sticky;top:0;background:var(--bg);font-size:.8rem;color:var(--mut);margin:1.25rem 0 .25rem;padding:.25rem 0;border-bottom:1px solid var(--line)}\n' +
      '.m{padding:.45rem 0}.hd{display:flex;gap:.5rem;align-items:baseline}.a{font-weight:600}\n' +
      '.bot{font-size:.65rem;background:var(--acc);color:#fff;border-radius:4px;padding:0 .3rem}\n' +
      'time{color:var(--mut);font-size:.75rem}.c{white-space:pre-wrap;overflow-wrap:anywhere}\n' +
      '.rep{color:var(--mut);font-size:.82rem;border-left:3px solid var(--line);padding-left:.5rem;margin-bottom:.15rem}\n' +
      '.at{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.3rem}.at img{max-width:320px;max-height:240px;border-radius:6px}\n' +
      '.file{font-size:.85rem;color:var(--acc)}.emb{font-size:.85rem;color:var(--mut);border-left:3px solid var(--acc);padding-left:.5rem;margin-top:.3rem}\n' +
      '.stk{font-size:.8rem;color:var(--mut)}.rx{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.3rem;font-size:.82rem}\n' +
      '.rx span{background:var(--chip);border-radius:8px;padding:0 .45rem}a{color:var(--acc)}</style></head><body>\n' +
      '<h1>' + esc(h.title) + '</h1><div class="sub">' + esc(h.line) + '</div>\n' + body + '\n</body></html>\n';
  }

  var FORMATS = {
    txt: { label: 'Text', mime: 'text/plain;charset=utf-8', fn: text },
    md: { label: 'Markdown', mime: 'text/markdown;charset=utf-8', fn: markdown },
    html: { label: 'HTML', mime: 'text/html;charset=utf-8', fn: html },
    json: { label: 'JSON', mime: 'application/json', fn: json },
    csv: { label: 'CSV', mime: 'text/csv;charset=utf-8', fn: csv }
  };
  function render(fmt, rows, meta) { return (FORMATS[fmt] || FORMATS.txt).fn(rows, meta); }
  function slug(s) { return String(s || 'channel').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'channel'; }
  function filename(title, fmt, days) {
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return 'discord-' + slug(title) + (days > 0 ? '-' + days + 'd' : '') + '-' + stamp + '.' + (FORMATS[fmt] ? fmt : 'txt');
  }

  root.SBFormat = {
    VERSION: VERSION, isId: isId, sortKey: sortKey, snowflakeForMs: snowflakeForMs, msFromSnowflake: msFromSnowflake,
    cmpId: cmpId, cutoffMs: cutoffMs, parseLocation: parseLocation, rowMs: rowMs, sliceDays: sliceDays,
    isCoveredBack: isCoveredBack, esc: esc, safeUrl: safeUrl, normReply: normReply, day: day,
    text: text, markdown: markdown, csv: csv, json: json, html: html,
    FORMATS: FORMATS, render: render, slug: slug, filename: filename
  };
})(typeof self !== 'undefined' ? self : globalThis);

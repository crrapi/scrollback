# Changelog

## 2.0.1 (2026-11-03)

- New: Scrollback remembers which stretches of a chat it saved with no gaps. A 7d / 30d / 90d / All run that is already covered copies to the clipboard instantly, with no scrolling. When new messages arrived since last time, it loads only that gap and stops. Server jobs skip channels that are already covered. Backups keep this information.
- Fixed: a history job that started with the chat already scrolled to the top could end early without loading older messages. Most visible on slower machines.
- Fixed: history and server jobs could stall when the Discord tab was in the background, because Chrome fires few scroll events there.
- Store name is now "Scrollback: Chat Exporter for Discord, No Token", and the listing and README explain why it needs no token.

## 2.0.0 (2026-10-30)

Renamed to Scrollback and rebuilt for the Chrome Web Store.

- Storage moved from one `chrome.storage` blob per channel to IndexedDB, so big chats no longer rewrite the whole channel on every page. v1 data migrates on first run.
- Tap runs as a MAIN-world content script from the manifest. No injected `<script>` tag, no page globals, no console logging.
- Fixed: message links (`/channels/g/c/m`) were read as the channel ID.
- Fixed: XHR responses with `responseType: "json"` were dropped.
- Fixed: jobs could stop early when saved history had gaps. Stop rules now use only what the current page load saw.
- Fixed: HTML export allowed `javascript:` links from embeds.
- Jobs detect the true start of a chat and support full history ("All") and 7 days.
- New exports: Markdown and CSV (formula-safe). HTML export now has day headers, inline images and dark mode.
- New library page: browse and search all chats, export by range, back up and restore, delete one or all.
- New settings: default format, local or UTC time, gentle scroll speed.
- Media saving is paced and goes to `Downloads/Scrollback/<chat>/`.
- Payloads from the page are validated and trimmed before storage.
- Dropped the `tabs` permission.
- Supports ptb and canary.

## 1.2.0

Last personal build (passive tap, 30/60/90d jobs, server job, reaction users, image saving).

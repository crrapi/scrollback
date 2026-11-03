# Security policy

Scrollback runs inside a logged-in Discord session, so security reports matter a lot here.

## Reporting a vulnerability

Email **scrollback@crrapi.xyz** with the details. Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and the version from `manifest.json`. You will get a reply within a few days.

## What counts

- Any path that reads or leaks the Discord token, cookies or request headers
- Any network request the extension makes on its own
- Script injection through exported files, the popup or the library page
- Data leaving the browser without a user action

## Supported versions

Only the latest release on the Chrome Web Store gets fixes.

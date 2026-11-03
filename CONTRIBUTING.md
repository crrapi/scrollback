# Contributing

Bug reports and pull requests are welcome.

## Ground rules

Scrollback has three promises. A change that breaks one will not be merged.

1. It never reads or sends the Discord token, cookies or request headers.
2. It never makes network requests of its own. It only reads responses the Discord client already fetched.
3. Data stays in the browser until the user exports it.

## Setup

```bash
npm install
npx playwright install chromium
```

Load the folder unpacked at `chrome://extensions` (Developer mode on). Reload the Discord tab after each extension reload.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the exporter unit tests. `npm run test:e2e` loads the extension in Chromium against a fake Discord client (`test/fake-discord.html`) and checks capture, history jobs, the server job, media saving, migration, the library and the popup. Both must pass.

## Style

Plain JavaScript, no build step, no runtime dependencies. Match the code around you.

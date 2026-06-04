# QWEN.md — Maven Dependency Search (uTools Plugin)

## Project Overview

This is a **uTools desktop plugin** that searches the Maven Central Repository and copies `<dependency>` XML snippets to the clipboard. It is a lightweight, single-page application with no build step, no npm dependencies, and no bundler.

**Tech stack:**
- **Frontend:** Vanilla HTML/CSS/JavaScript (single `index.html` file, no framework)
- **Backend (Preload):** Node.js (`https` module, CommonJS via `require`)
- **Platform:** uTools plugin runtime (Electron-based desktop app)
- **API:** Maven Central Solr Search API (`https://search.maven.org/solrsearch/select`)

## Architecture & Data Flow

```
uTools Desktop
  └── plugin.json          ← Plugin manifest (entry points, triggers, metadata)
  ├── src/frontend/
  │     └── index.html     ← Full UI: search bar, result list, copy feedback
  └── src/background/
        └── index.js       ← Preload script; runs in Node.js context,
                              exposes window.* functions consumed by the frontend
```

**How it works:**
1. uTools loads `plugin.json`, which points to `src/frontend/index.html` as `main` and `src/background/index.js` as `preload`.
2. The preload script runs first in a Node.js-enabled context and attaches helper functions to `window` (`searchMaven`, `getLatestVersion`, `searchSimilar`, `generateDependencyXML`).
3. The frontend HTML calls these `window.*` functions on user input (200ms debounce) and renders results with vanilla DOM manipulation.
4. Clicking a result generates a `<dependency>` XML string and copies it via `utools.copyText()`.

**Trigger commands** (defined in `plugin.json` → `features`):
- `mvn` — opens the plugin
- `mvn <keyword>` (regex match) — opens with a pre-filled search

## Building and Running

There is **no build step**. The plugin is loaded directly by uTools.

| Action | How |
|---|---|
| **Load for dev** | Open uTools → type `开发者工具` → "加载本地插件" → select project root |
| **Trigger plugin** | Type `mvn` or `mvn <keyword>` in uTools launcher |
| **npm scripts** | `npm run dev` only prints a message; actual dev happens inside uTools |

No tests, linter, or CI are configured.

## Key Files

| File | Purpose |
|---|---|
| `plugin.json` | uTools plugin manifest: name, version, triggers, entry points |
| `package.json` | npm metadata only (no dependencies, no real scripts) |
| `src/background/index.js` | Node.js preload script: HTTPS requests, caching, request cancellation |
| `src/frontend/index.html` | Self-contained UI with inline CSS and JS |
| `assets/logo.png` | Plugin icon shown in uTools |
| `assets/logo.svg` | Vector source of the icon |

## Development Conventions

- **No external dependencies.** Both `package.json` and the runtime code use zero third-party libraries. Everything is vanilla Node.js and browser APIs.
- **Single-file frontend.** All HTML, CSS, and JS live in one `index.html`. CSS uses custom properties (`--accent-color`, etc.) for theming. JS uses `var` declarations and `for` loops (no ES modules, no arrow functions in event handlers).
- **Preload exposes `window.*`.** The background script communicates with the frontend exclusively through global functions on `window`.
- **Chinese UI strings.** All user-facing text is in Simplified Chinese. Code comments are also in Chinese.
- **Performance patterns in `index.js`:**
  - `https.Agent` with `keepAlive: true` for TCP/TLS connection reuse
  - LRU cache (Map-based, max 100 entries, 5-min TTL)
  - Request cancellation via `req.destroy()` when a new search fires
  - Field selection (`fl` parameter) to minimize API response size

## Plugin Configuration (`plugin.json`)

```json
{
  "pluginName": "Maven 依赖搜索",
  "main": "src/frontend/index.html",
  "preload": "src/background/index.js",
  "pluginSetting": { "single": true },
  "features": [{
    "code": "mvn",
    "cmds": ["mvn", { "type": "regex", "match": "/mvn\\s+(.+)/i" }]
  }]
}
```

Key fields: `single: true` means only one instance of the plugin runs at a time. The regex command extracts the search keyword from `mvn <keyword>` input.

## External API

- **Endpoint:** `GET https://search.maven.org/solrsearch/select`
- **Params:** `q` (query), `rows` (result count), `wt=json`, `fl` (field list), `sort`
- **Response fields used:** `g` (groupId), `a` (artifactId), `v` (version), `latestVersion`, `versionCount`
- **Rate limiting:** None enforced client-side, but caching and request cancellation reduce load.

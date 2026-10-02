# Hot Update Simulator · Manual

A debugging tool for simulating a **real game hot-update server**. The point is not to "offer hot-update features", but to
**reproduce the ugly conditions a hot-update client will run into**, so the Unity side's download, verification, retry and resume
logic takes a beating long before it ever reaches a real device.

---

## Quick Start

```bash
npm install                 # Install backend dependencies
npm run sample              # Generate sample bundles (a few MB of fake AssetBundles)
npm start                   # Start; defaults to http://localhost:5500
```

Frontend:

```bash
# Dev mode (hot reload, port 5173, proxied to 5500)
cd frontend && npm run dev

# Or build static files and let the backend serve them directly
npm run build && npm start
```

Open:

| Address | Description |
|---|---|
| `/` | Frontend panel |
| `/docs` | Swagger API docs; you can make test calls right on the page |
| `/manual` | This manual (rendered in the panel, with a table of contents) |
| `/api/system` | Confirm which config is active and where the asset directory points |

Two entry points for this manual — don't mix them up:

- **`/manual`** — the rendered page, for humans to read.
- **`/manual.md`** — the Markdown source itself. Use it with `curl`, open it in an editor, or when you want to copy the original text.
  Opening `/manual.md` directly in the browser address bar redirects to `/manual` (browsers only
  ever display `text/markdown` as plain text); add `?raw=1` to force the source through.

The manual is split into one file per language, matching the layout of `frontend/src/locales/`; pick one with `?lang=`:

| File | Language |
|---|---|
| `backend/public/manual.zh-CN.md` | Chinese |
| `backend/public/manual.en.md` | English (this file) |

For example, `curl "http://localhost:5500/manual.md?lang=en"` gets you the English source file.
Without `?lang=` the default is Chinese. Edit a file and refresh the page — no restart needed.

The manual in the panel **switches automatically with the UI language**. If you add a new language,
remember to add the matching manual file and an entry in the `MANUAL_FILES` whitelist in `backend/app.js`
(that map is a whitelist, not path concatenation — concatenating with it would become an arbitrary file read).

---

## Using the Panel

Once `http://localhost:5500/` is open (run `npm run build` first), the left sidebar has 9 entries — 8 pages plus an API docs link that opens in a new tab:

| Page | When to use it |
|---|---|
| **Overview** | Start here. Beyond request counts and latency percentiles, the important part is the "Simulation impact" column — it tells you **how many requests the simulator tampered with**. Otherwise a 10-second P95 looks like a backend performance problem when you're the one who dialed the latency up |
| **Network Simulation** | Tune latency / jitter / bandwidth / packet loss / offline. Changes apply immediately; there is no Save to click |
| **Faults** | Add rules. The right-hand side spells out which client capability each of the 8 fault types tests, so you don't have to guess which one to pick |
| **Presets** | The most used page. 17 scenarios, one click each; most of the time you never tune parameters by hand |
| **Live Logs** | Every request is tagged with what was done to it: `abort`, `+300ms`, `100Kbps`, `Range`… Requests that were killed show "Dropped" in the status column |
| **API Console** | Verify on the spot: call `/api/version` once and see whether the timing really changed |
| **Favorites** | Save frequently used requests and replay them over and over. Replay is issued by the server, so it goes through the simulator in full |
| **Manual** | This file, rendered inside the panel with a table of contents |
| **API Docs** | Sidebar item that opens Swagger UI in a new tab |

### Top Bar

- The **status light** reflects the **client's point of view**. Turn offline on and it turns red with "Disconnected" — which is correct,
  because the simulation really is taking effect. The control panel itself stays usable, so you can always dial the parameters back.
- The **Panic** button: turns off all network simulation and fault injection in one click. Your lifeline when you set the wrong parameters.

### One Easy Trap

`/assets` is the hot-update asset download route, so frontend build output must not live in `dist/assets/`.
`frontend/vite.config.js` already sidesteps this with `build.assetsDir: 'web'`; don't change it back.

---

## Directory Layout

```
backend/
  app.js                  Assembly file; wiring only
  server.js               Process entry point
  config.json             Persisted configuration (all simulation parameters live here)
  core/configManager.js   Config read/write and validation
  modules/
    networkSimulator.js   Latency / jitter / bandwidth limit / packet loss / offline
    faultInjector.js      500 / timeout / abort / truncate / corrupt / empty response
    assetServer.js        Asset delivery (Range resume, ETag, md5 manifest)
    logger.js             In-memory ring-buffer logging
  middleware/
    requestPipeline.js    Chains the two simulators above onto the request
    loggerMiddleware.js   Records each request's final outcome
  routes/                 The individual endpoints
  public/manual.en.md     This file (English manual)
storage/                  Runtime data (gitignored)
  assets/{platform}/...   Hot-update bundles go here
  presets.json            Custom presets
  favorites.json          Saved requests
frontend/                 Vite + Bootstrap panel (vanilla JS, no framework)
  src/api.js              API wrappers
  src/store.js            App state and subscriptions
  src/locales/            Chinese and English locale files
  src/ui/                 DOM helpers, toasts, sidebar
  src/views/              8 pages, each with mount/unmount
dist/                     Frontend build output (gitignored)
scripts/                  Sample asset generation, backend and frontend tests
```

### Where Hot-Update Bundles Go

Create a directory per platform, drop the files in — **no hand-written manifest required**:

```
storage/assets/
  Android/
    manifest.json        ← optional
    bundles/
      role.ab
      scene_01.ab
  iOS/
    bundles/...
```

- Without `manifest.json`: the server scans the directory, computes the size and md5 of every file,
  and derives a stable version number from the content (same content, same version).
- With `manifest.json`: use it to declare the version and other metadata.

```jsonc
// storage/assets/Android/manifest.json
{
  "version": "1.2.0",        // The client uses this to decide whether an update is needed
  "minVersion": "1.0.0",     // Below this version, force an update
  "forceUpdate": false,
  "notice": "This update fixes a crash on the login screen",
  "channel": "default"
  // You can also provide "files": [...] and control the manifest yourself entirely,
  // in which case the directory is not scanned
}
```

---

## Two Kinds of "Bad": Who Handles What

This split matters — don't mix the two up while tuning:

| | What it simulates | How it shows up |
|---|---|---|
| **networkSimulator** | Poor link quality | Slow, jittery, dropping. The client sees a **network problem** |
| **faultInjector** | Something wrong with the server or the files | 500s, timeouts, corrupted content. The client sees a **server problem** |

The two stack. "Weak 3G + abort halfway through an asset download" is what the real internet looks like most of the time —
that is exactly the `Weak link + abort (combo)` preset.

### Fault Types at a Glance

| type | What the client sees | What it tests |
|---|---|---|
| `status` | HTTP 500 / 404 / 403 | Error messages, fallback logic |
| `timeout` | No response at all until the client times itself out | Whether the timeout value is sane |
| `slowHeader` | Response headers come back very late | Whether connect and read timeouts are configured separately |
| `abort` | The connection is reset halfway through the download | Resume (Range) |
| `truncate` | A full length is declared but the body ends early | Content length validation |
| `corrupt` | **The download succeeds but the content is bad** | Whether md5 is actually verified |
| `slowThenAbort` | Stalls for a long time, then dies halfway through the download | The full "timeout, retry, and the retry dies" chain |
| `empty` | 200 with an empty body | Empty files and empty manifests must not crash |

`corrupt` is the one people overlook most: a client that doesn't verify hashes "succeeds" the whole way,
then blows up at unpack or at runtime, which is extremely expensive to track down. Run it early.

`slowThenAbort` is the only **composite type**. A single rule can express one action, but the most
common production failure chain has two stages: the client waits too long → it times out and retries →
the retry dies partway through. This type uses both `delayMs` and `ratio`, reproducing both stages at once.
Other combinations (say "corrupt, then truncate") are not supported: that would mean splitting faults into
an orchestratable chain of atoms, which costs far more than it returns and invites configurations that
look valid but do nothing (see the design discussion in the repo).

### maxHits: Building "Fail the First N Times"

`maxHits` on a rule builds a failure sequence, which is exactly what retry logic needs:

```jsonc
{
  "name": "Version API fails twice",
  "maxHits": 2,              // Fail only twice; the third call succeeds
  "match": { "pathPrefix": "/api/version" },
  "action": { "type": "status", "status": 500 }
}
```

Combined with `POST /api/control/fault/reset-counters` you can zero the counters and run the sequence again.
The `Fails twice, then works` preset is exactly this scenario.

### Rule Match Fields

| Field | Description |
|---|---|
| `method` | Request method; empty means any |
| `pathPrefix` | Path prefix; empty means any |
| `pathGlob` | Path glob; empty means any |
| `platform` | Matched against the first segment of `/assets/{platform}/` |

`pathGlob` supports three wildcards: `*` matches any characters within one segment, `**` crosses directories,
and `?` matches a single character. For example `/assets/**/*.ab`, `/api/version`.

> **Why globs and not regex**: a regular expression would be applied to **every** request,
> and a catastrophic-backtracking pattern (say `(a|a)*$`) can wedge single-threaded Node for tens of seconds —
> every connection, the control panel included, freezes with it, and the only way out is restarting the process.
> In practice even a mature static checker like `safe-regex2` doesn't catch this class of pattern.
> Globs compile down to linear-time matching, so the cost stays bounded.

### Rule Action Fields

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | The fault type, from the table above |
| `status` | `status` | Status code to return, 100–599 |
| `body` | `status` | Custom response body; leave it empty for a default notice |
| `ratio` | `abort` `truncate` `corrupt` `slowThenAbort` | How much of the data to act on, 0.01–1 |
| `delayMs` | `slowHeader` `slowThenAbort` | How long to delay the headers; defaults to 3000 ms |

`ratio` is the least obvious one — it decides how deep the damage goes.
With `ratio: 0.5`:

| Type | What actually happens |
|---|---|
| `abort` | The connection is killed halfway through; the client must re-download or resume |
| `truncate` | Half is sent, then the response ends cleanly, while `Content-Length` still claims the full length |
| `corrupt` | Length is unchanged; the middle half of the bytes is flipped (only verification notices) |
| `slowThenAbort` | Stalls for `delayMs` first, then aborts at the halfway point like `abort` |

Fields that do not apply to the current `type` are **ignored**: the backend only reads
the relevant ones, and the panel's rule editor hides and disables the rest so you cannot
silently submit a value you cannot see.

### Which Rule Wins When Several Match

**The first eligible rule in the list decides.**

- Rules that are disabled, don't match, or have used up their `maxHits` are skipped and the next one is considered;
- the first eligible rule rolls its `probability` dice once: on a hit, it injects;
  **on a miss, nothing is injected this time** (it does not keep looking further down).

That second point is the important one: if a lost roll kept searching, N rules at 50% each would hit with an effective probability of
`1-(1-0.5)^N` (75% with just two rules), and `probability` would stop meaning what it says.

---

## Security Boundaries (Important)

This is a local development tool and **the control endpoints have no authentication whatsoever**,
yet they can read and write simulation parameters, inject fault rules, and read the entire request log. So:

- **By default it listens only on `127.0.0.1`.** When you really do need to test against a phone or a real device,
  change `server.host` in `backend/config.json` to `0.0.0.0`,
  and be clear that this means **any machine on the same LAN** can drive it.
- **Cross-site requests are rejected.** A state-changing request (POST/PATCH/…) carrying a non-local `Origin`
  gets a flat 403, and a cross-site page can't read the response body either. Otherwise any web page that happens to
  run in the user's browser could read your entire request log.
- **Replay can't target the control endpoints**, nor the replay endpoint itself — the latter would amplify itself
  to tens of thousands of inlined requests within seconds and exhaust the ephemeral ports.
- Error responses no longer pass back `err.message` (it would carry absolute disk paths);
  the details go to the log only.

---

## Client Integration (Unity C# Sample)

It comes down to three endpoints, exactly like a real hot-update server:

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

[Serializable]
public class VersionInfo
{
    public string platform;
    public string version;
    public string currentVersion;
    public bool needUpdate;
    public bool forceUpdate;
    public string notice;
    public int fileCount;
    public long totalSize;
    public string manifestUrl;
}

public class HotUpdateClient : MonoBehaviour
{
    // Note: the port must match server.port in backend/config.json
    const string BaseUrl = "http://127.0.0.1:5500";
    const string Platform = "Android";

    /// <summary>Step 1: ask the server whether an update is needed.</summary>
    public IEnumerator CheckVersion(string currentVersion, Action<VersionInfo> onDone)
    {
        string url = $"{BaseUrl}/api/version?platform={Platform}" +
                     $"&current={UnityWebRequest.EscapeURL(currentVersion)}" +
                     $"&deviceId={SystemInfo.deviceUniqueIdentifier}";

        using (var req = UnityWebRequest.Get(url))
        {
            // A timeout is mandatory, otherwise a timeout fault hangs this forever
            req.timeout = 10;
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                // This covers all of it at once: server 500, timeout, connection reset (offline / packet loss)
                Debug.LogError($"Version query failed: {req.error} / {req.responseCode}");
                onDone(null);
                yield break;
            }

            var info = JsonUtility.FromJson<VersionInfo>(req.downloadHandler.text);
            onDone(info);
        }
    }

    /// <summary>
    /// Step 2: download the file, with resume support.
    /// Resume is mandatory — the abort preset exists specifically to attack it.
    /// </summary>
    public IEnumerator DownloadAsset(string relativePath, string savePath, Action<bool> onDone)
    {
        string url = $"{BaseUrl}/assets/{Platform}/{relativePath}";

        long existing = 0;
        if (System.IO.File.Exists(savePath))
            existing = new System.IO.FileInfo(savePath).Length;

        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = 30;
            if (existing > 0)
            {
                // The Range header is the key: with it, a download can continue after an interruption
                req.SetRequestHeader("Range", $"bytes={existing}-");
            }

            yield return req.SendWebRequest();

            if (req.responseCode == 416)
            {
                // The server says the range isn't satisfiable, which usually means the local file is more complete than the server copy
                Debug.LogWarning("Local file is already complete or out of sync with the server; delete and download again");
                onDone(false);
                yield break;
            }

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"Download interrupted (at byte {existing}): {req.error}");
                onDone(false);   // The caller should retry rather than fail outright
                yield break;
            }

            byte[] data = req.downloadHandler.data;
            // 206 means a resumed response; append the new data after what's already there
            bool isPartial = req.responseCode == 206;
            using (var fs = new System.IO.FileStream(
                savePath, isPartial ? System.IO.FileMode.Append : System.IO.FileMode.Create))
            {
                fs.Write(data, 0, data.Length);
            }
            onDone(true);
        }
    }
}
```

### Three Things You Must Get Right

1. **Always set `timeout`.** When a `timeout` fault hits, a client with no timeout hangs forever.
2. **Always send the `Range` header for resume.** Verify with the `Abort mid-download` preset:
   after the connection is killed, calling again should continue from the break point, not start over.
3. **Always verify md5.** Verify with the `Corrupted asset` preset:
   the file `corrupt` returns has exactly the right length, so only verification reveals that the content was damaged.
   The manifest endpoint (`/api/manifest`) already provides a `hash` for every file.

---

## Common Endpoints

### For the Client (Affected by Network Simulation)

| Method | Path | Description |
|---|---|---|
| GET | `/api/version` | Check the version and decide whether an update is needed. Parameters `platform`, `current`, `channel`, `deviceId` |
| GET | `/api/manifest` | Fetch the full file manifest (path / size / md5 / download URL) |
| GET | `/api/check` | Both of the above in one call, saving a round trip |
| GET | `/api/platforms` | List every platform and its version |
| GET | `/api/health` | Health check |
| POST | `/api/manifest/refresh` | Clear the manifest cache so newly added bundles take effect immediately |
| GET | `/assets/{platform}/{path}` | Download an asset; supports Range resume and ETag conditional requests |

### For the Control Panel (Unaffected, Always Available)

| Method | Path | Description |
|---|---|---|
| GET | `/api/control` | Current simulation state |
| PATCH | `/api/control/network` | Change network parameters |
| POST | `/api/control/network/reset` | Reset network parameters to defaults |
| PATCH | `/api/control/fault` | Fault injection master switch |
| GET/POST | `/api/control/fault/rules` | List / add fault rules |
| PUT/DELETE | `/api/control/fault/rules/{id}` | Update / delete a rule |
| POST | `/api/control/fault/reset-counters` | Zero the hit counts on rules |
| POST | `/api/control/disable` | **Panic**: turn off all simulation |
| POST | `/api/control/reset` | Reset everything to defaults |
| GET/POST | `/api/presets` | List / create presets |
| POST | `/api/presets/{id}/apply` | Apply a preset |
| POST | `/api/presets/capture` | Save the current configuration as a preset |
| GET/POST/DELETE | `/api/favorites` | Saved requests |
| POST | `/api/favorites/{id}/replay` | Replay (goes through the simulator in full) |
| GET | `/api/logs` | Read logs |
| GET | `/api/logs/stream` | Live log stream (SSE) |
| DELETE | `/api/logs` | Clear logs |
| GET | `/api/stats` | Aggregate stats (latency percentiles, status code distribution, timeline) |
| GET | `/api/system` | Runtime and path information |

### A Few Handy Shortcuts

```bash
# Switch to "abort halfway through an asset download" in one call
curl -X POST http://localhost:5500/api/presets/abort-download/apply

# See what just happened (only requests the simulator touched)
curl "http://localhost:5500/api/logs?limit=20&onlySimulated=true"

# Panic (your lifeline when the UI is stuck)
curl -X POST http://localhost:5500/api/control/disable

# Confirm where the asset directory actually points
curl http://localhost:5500/api/system
```

---

## Configuration

`backend/config.json` is the only file you need to change, and edits **take effect immediately — no restart**.

```jsonc
{
  "server": {
    "port": 5500,              // Must match VITE_API_BASE_URL in .env
    "assetDir": "../storage/assets",   // Relative to the backend/ directory
    "enableBrowse": true,      // /browse directory listing
    "enableDocs": true         // /docs API docs
  },
  "network": {
    "enabled": false,          // Master switch
    "offline": false,          // Offline: kills the connection outright (not a 503)
    "latencyMs": 0,            // Base latency
    "jitterMs": 0,             // Latency jitter, ±N ms
    "bandwidthKbps": 0,        // Bandwidth limit in kilobits per second; 0 = unlimited
    "packetLossRate": 0        // Whole-packet loss probability, 0–1
  },
  "fault": {
    "enabled": false,
    "rules": []                // See the comment at the top of modules/faultInjector.js for the rule shape
  },
  "hotUpdate": {
    "defaultChannel": "default",
    "channels": ["default", "beta", "dev"],
    "gray": { "enabled": false, "percent": 0 }   // Gray release percentage
  },
  "logging": {
    "maxEntries": 2000         // Ring-buffer log capacity
  }
}
```

### About the Bandwidth Unit

`bandwidthKbps` is in **kilobits per second**, matching how carriers quote speeds:

| Value | Equivalent | Time to download 10MB |
|---|---|---|
| 20000 | 20 Mbps (WiFi) | ~4 s |
| 2000 | 2 Mbps (4G) | ~40 s |
| 400 | 400 Kbps (3G) | ~200 s |
| 100 | 100 Kbps (extremely weak link) | ~13 min |

---

## About Gray Release

With `hotUpdate.gray.enabled` on, only clients that fall inside the gray percentage see the new version.
Grouping is based on the `deviceId` the client sends (md5, then modulo), so **the same device gets the same answer every time** —
gray release has to be stable, otherwise a client sees the new version one moment and the old one the next.

When the client sends no `deviceId`, nothing is intercepted (doing so would shut out everyone).

---

## Self-Checks and Tests

The project ships with several checks. Running them after a change beats reading code by eye:

```bash
npm run lint         # ESLint, with complexity budgets (complexity / max-depth / max-lines)
npm run arch         # Structure: dependency cycles / layer direction / orphans / size spread
npm run smoke        # Backend end-to-end: 74 assertions, every fault type actually triggered
npm run regression   # Edges and regressions: 66 assertions covering chunked / 0-byte / Range / caching / version semantics
npm run ui-check     # Frontend: headless Chrome walks all 8 routes and scans each page for untranslated text
npm run soak         # Stability: 400 mixed requests, checks memory stays flat and the server still works afterwards
npm run docs-check   # Doc coverage: are every endpoint / config key / fault type still written up in this manual?
```

A few notes:

- `ui-check` needs Chrome or Edge and leaves one screenshot per page in `ui-check-shots/`.
- `smoke`, `regression` and `ui-check` all modify `backend/config.json` and restore it when done.
  Killing them mid-run can leave it dirty; `git diff backend/config.json` tells you.
- `docs-check` pulls the real endpoints, config keys, fault types, panel pages and npm scripts out of
  the code and compares them against this manual. Add a feature and forget the docs, and it says so.

---

## Troubleshooting

**No endpoints reachable at all?**
Start with `curl http://localhost:5500/api/control/disable`. Control endpoints aren't affected by simulation,
so this call always gets through. If it doesn't get through either, the server genuinely isn't running.

**Assets returning 404?**
`curl http://localhost:5500/api/system` and look at `paths.assetRoot` and `assetRootExists`.
Most of the time the bundles just aren't in the right place.

**Changed the config and nothing happened?**
Did you edit `backend/config.json`? The files under `storage/` are runtime data, not configuration.
The manifest is cached for 10 seconds; after uploading new bundles, `curl -X POST .../api/manifest/refresh` refreshes it right away.

**Port conflict?**
See the message printed at startup. Remember to also update `VITE_API_BASE_URL` in `.env`,
otherwise the frontend proxy keeps pointing at the old port.

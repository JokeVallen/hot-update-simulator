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

Once `http://localhost:5500/` is open (run `npm run build` first), the left sidebar has 11 entries — 10 pages plus an API docs link that opens in a new tab:

| Page | When to use it |
|---|---|
| **Overview** | Start here. Beyond request counts and latency percentiles, the important part is the "Simulation impact" column — it tells you **how many requests the simulator tampered with**. Otherwise a 10-second P95 looks like a backend performance problem when you're the one who dialed the latency up |
| **Network** | Tune latency / jitter / bandwidth / packet loss / offline. Changes apply immediately; there is no Save to click |
| **Faults** | Add rules. The right-hand side spells out which client capability each of the 8 fault types tests, so you don't have to guess which one to pick |
| **Presets** | The most used page. 17 scenarios, one click each; most of the time you never tune parameters by hand |
| **Live Logs** | Every request is tagged with what was done to it: `abort`, `+300ms`, `100Kbps`, `Range`… Requests that were killed show "Dropped" in the status column |
| **API Console** | Verify on the spot: call `/api/version` once and see whether the timing really changed |
| **Favorites** | Save frequently used requests and replay them over and over. Replay is issued by the server, so it goes through the simulator in full |
| **Assets** | Lays out how the bundles actually sit on disk: which platforms exist, which channels each has, and what the resource and code tracks contain. Start here when asking "did I put the files in the right place?" |
| **Release** | Edit channels (the name list plus the default channel) and gray release rules. Cross-checks the channels declared in config against the ones actually present on disk and flags mismatches |
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
    dll/                  Code hot update (optional, see "Code Hot Updates")
    bundles/              Resource hot update
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

## Code Hot Updates

A hot update is really **two independent tracks**. Mature pipelines (YooAsset,
Addressables, the HybridCLR DLL set) version and deliver them separately:

| | Resource track | Code track |
|---|---|---|
| Ships | AssetBundles, textures, config | Assemblies `.dll` (HybridCLR / ILRuntime), `.lua`, `.js` |
| Version field | `version` | `code.version` |
| How often it changes | Every content change | Maybe once a week |
| What if it fails | Can degrade; a missing texture is survivable | Usually must succeed, or the game may not start |
| Compatibility | Mostly just format | **Must match the base package's AOT metadata** |

The simulator supports both, with **separate version numbers**. Add a `code` block to
`manifest.json`:

```jsonc
// storage/assets/Android/manifest.json
{
  "version": "1.5.0",            // resource version
  "code": {
    "version": "2.1.0",          // code version, independent of the one above
    "minAppVersion": "1.2.0",    // below this base package version, code cannot be hot-updated
    "aotHash": "aot-abc123",     // the expected AOT metadata fingerprint
    "forceUpdate": false,
    "notice": "Fixed a skill damage miscalculation",
    "dir": "dll"                 // directory holding the code files; "dll" by default
  }
}
```

Lay the files out like this:

```
storage/assets/Android/
  manifest.json
  dll/
    Assembly-CSharp.dll.bytes    ← code track
    GameLogic.dll.bytes
  bundles/
    role.ab                      ← resource track
```

**Files under `dll/` never appear in the resource manifest.** The two tracks have separate
manifests; the client fetches the code manifest with `?track=code`. Mixing them would download
the same DLL twice, and the client could not tell "resource update" from "code update" — and
those two need completely different failure handling.

### About AOT compatibility

This is the most common and hardest-to-diagnose failure in the HybridCLR era: a hot-update DLL
references a type the base package **never generated AOT generic code for**. Nothing is wrong at
compile time; it blows up at runtime, and the error message sits far from the root cause.

So real pipelines declare "this code update requires base package >= X". The client submits the
installed base package version and its AOT fingerprint, and the server says whether it can be used:

```bash
curl "http://localhost:5500/api/version?platform=Android&current=1.5.0&codeCurrent=2.1.0&appVersion=1.0.0&aotHash=aot-abc123"
```

```jsonc
{
  "version": "1.5.0",
  "needUpdate": false,
  "code": {
    "version": "2.1.0",
    "needUpdate": true,
    "minAppVersion": "1.2.0",
    "compatible": false,        // base package 1.0.0 < 1.2.0
    "requiresAppUpdate": true,  // cannot be fixed by hot update alone; the app must be upgraded
    "aotHash": "aot-abc123",
    "aotMatch": true,
    "fileCount": 2,
    "manifestUrl": "/api/manifest?platform=Android&track=code"
  }
}
```

⚠️ `compatible` and `aotMatch` are `null` when there is **nothing to judge against** — **not `true`**.
"Not checked" and "checked and passed" are different things, and the client has to be able to tell
them apart. Otherwise an old client that never sends `appVersion` is told "compatible" and updates
into code that crashes.

These two fields exist precisely to test the client's gating logic: raise `minAppVersion`, or change
`aotHash`, and see whether the client actually blocks the update instead of blindly applying it.

### Injecting faults on the code download only

`pathGlob` scopes a fault to the code track:

```jsonc
{ "match": { "pathGlob": "/assets/**/dll/**" },
  "action": { "type": "abort", "ratio": 0.5 } }
```

That reproduces "resources all downloaded, then the code bundle died halfway". **Incomplete code can
stop the game from starting at all, while incomplete resources may only cost you a texture** — the two
need completely different handling, and each deserves its own test.

### What is not modelled here

To be clear, this is **protocol-level** support, not a complete code hot-update framework:

- **No differential patches**: whole files only. File-by-file incremental updates suit Lua projects
  fine; diffing a monolithic DLL is out of scope.
- **No inter-file dependency ordering**: the manifest is a flat list — no "download A before B".
- **No code-specific validation**: Lua bytecode versions, DLL architecture mismatches, and the like
  are not understood by the server.
- **No differential patches**: see above.

Channels **do** affect content now (since protocol 2) — see "Channels now affect content" above.

---

## Protocol Version and Capability Negotiation

The client is your own Unity code, while the server keeps evolving. Without negotiation, adding a
field or changing a meaning on the server **does not produce an error** in an old client — it just
makes it misjudge silently. And silent misjudgement is exactly what this simulator exists to expose.

So every hot-update response carries:

```jsonc
{
  "protocolVersion": 2,
  "capabilities": [
    "codeTrack",          // code hot-update track is available
    "rangeResume",        // assets support Range resume
    "conditionalCache",   // ETag conditional requests (304) are supported
    "hashMatchesEtag",    // the ETag is the manifest hash (see below)
    "manifestPinning",    // manifests can be pinned to eliminate races
    "multiAlgorithmHash", // entries carry the algorithm name and multiple digests
    "gzip",               // JSON responses may be gzipped
    "channelContent",     // channels actually affect content (since protocol 2)
    "grayRules"           // gray release supports a rule list (since protocol 2)
  ]
}
```

`GET /api/protocol` takes no parameters, so a client can ask before it even knows the platform.

### What a client should do

```csharp
// 1. Ask once at startup
var probe = await GetJson($"{BaseUrl}/api/protocol");
int proto = probe.protocolVersion;
bool hasCode = probe.capabilities.Contains("codeTrack");

// 2. Branch on **capabilities**, not on the version number
//    A version number only says "older or newer"; a capability says "this one thing is supported"
if (!hasCode) { /* take the path without code hot updates */ }
```

The server also accepts a client-declared version: `?protocol=2`. If the client is newer than the
server, the response carries `protocolCompatible: false` plus a `protocolNotice` — the server
**cannot** answer in a newer format (it only speaks its own), so the value of that field is telling
the client how much to trust what follows.

### The ETag is the content hash

The asset `ETag` header **is the hash from the manifest**:

```
in the manifest:  "hash": "58435bb4…"
in the response:  ETag: "58435bb4…"
```

That is deliberate, not a coincidence. **It lets a client skip a request entirely**:

```
The client already has file X, with local hash H
The new manifest says X still has hash H
→ skip the download; not a single request is sent
```

If the ETag were something else (say "size + mtime"), the client would be holding the hash and still
have to send a conditional request to ask "is the file on the server still the one I have?".

Conditional requests still work — send the manifest hash as `If-None-Match` and an unchanged file
returns `304`.

The digest algorithm is configurable via `hotUpdate.hashAlgorithms` (default `md5`):

```jsonc
{ "hotUpdate": { "hashAlgorithms": ["md5"] } }
```

With several algorithms (e.g. `["sha256","md5"]`), **the first is the primary one** — the manifest's
`hash` field and the ETag both use it, and `hashes` carries every algorithm's digest. Extra digests
cost no extra I/O: the file is read once. Each entry also names its algorithm in `hashAlgo`.

### Manifest identity: eliminating the race

The typical hot-update flow has **two steps**:

```
1. GET /api/version    → learn that you should update to 1.2.0
2. GET /api/manifest   → fetch the file list
```

If someone changes the configuration between those two steps (or you happen to be editing
`manifest.json`), the client receives the **1.3.0 file list** while believing it is performing the
1.2.0 update — it discovers the mismatch halfway through, and **nothing reports an error**.

In a real project that race is hard to hit; **here it is easy**, because you are changing settings
constantly. So the manifest carries a `manifestId` (it changes when the content changes, and stays
stable otherwise) and the client echoes it back on step 2:

```bash
# Preferred: exact match
curl "http://localhost:5500/api/manifest?platform=Android&expectId=8b030cd618bf7f9d"

# Or match the version only — simpler to implement in a client
curl "http://localhost:5500/api/manifest?platform=Android&expectVersion=1.2.0"
```

A mismatch returns **409** along with the current identity, so the client can simply start over.
Much cheaper than discovering it after a partial download.

> Simpler still: use `GET /api/check`, which returns the version decision and the manifest **in one
> response** — that flow has no race by construction.

### Channels now affect content

`channel` now **decides which directory the server reads**, instead of merely being echoed back.

A subdirectory of the platform directory named after a configured channel *is* that channel's content:

```
storage/assets/Android/
  default/                 ← channel names come from hotUpdate.channels
    manifest.json
    bundles/role.ab
  beta/
    manifest.json
    bundles/role.ab        ← may be entirely different from default
```

Pass the channel on the request, and it appears in the URLs too:

```bash
curl "http://localhost:5500/api/version?platform=Android&channel=beta"
# the manifest's url becomes /assets/Android/beta/bundles/role.ab
```

**The old layout needs no changes at all.** The rule is "does the platform directory contain
subdirectories named after configured channels?":

| Layout | Example | Behaviour |
|---|---|---|
| **Flat** (old) | `Android/bundles/role.ab` | the whole platform directory is the default channel; URLs carry no channel segment |
| **Per-channel** (new) | `Android/default/bundles/role.ab` | resolved per channel; URLs carry the channel segment |

Directories like `bundles/` and `dll/` are **never mistaken for channels** — only names listed in
`hotUpdate.channels` count. So to use several channels, create a `beta/` directory and declare it
in the config.

An unknown channel returns **404** listing the available channels, and **never falls back to the
default silently** — "beta users received production content" is impossible to diagnose when
nothing reports an error.

**The same holds under the flat layout**: the only channel that platform has is the default one, so
`?channel=something-else` is a 404 too (not "there is only one channel anyway, here you go").

If your client hardcodes a channel name while the server uses the flat layout (say the client sends
`channel=production`), two options:

- change the client to send `default` (or nothing at all)
- **or** rename it on the server — no directory needed:

  ```jsonc
  { "hotUpdate": { "channels": ["production"], "defaultChannel": "production" } }
  ```

  (`defaultChannel` must appear in `channels`, otherwise it is normalised to `channels[0]`.)

The 404 body states which layout you are on and both of those options, so you can act on it
directly. Also, the `channel` field in responses **always reports the channel actually in effect**
rather than echoing what you sent — otherwise a client keying its cache by that field would file
content under the wrong name.

`GET /api/platforms` lists the channels each platform actually has content for, plus the names
declared in the config.

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

#### `truncate` fails by *waiting for a timeout*

Measured on the same 4096-byte file on the same machine:

| Rule | Time | Received | How it ended |
|---|---|---|---|
| `abort` ratio 0.5 | **3 ms** | 2048 B | connection reset |
| `truncate` ratio 0.4 | **6010 ms** | 1638 B | connection closed |
| no fault | 2 ms | 4096 B | clean end |

**A factor of 2000**, and the reason is worth a client developer's attention:

- `abort` destroys the socket outright — the connection is gone, so the client knows
  **immediately**
- `truncate` only ends the body early and **leaves the connection open** (HTTP keep-alive,
  server sends `Keep-Alive: timeout=5`). The client sees `Content-Length: 4096` but has only
  1638 bytes, so it keeps waiting for the rest until the server's keep-alive timeout closes
  the connection (5 s) and it can finally call it "transfer interrupted"

Two consequences:

1. **Batch timings**: every truncated attempt in a `truncate` scenario burns about 6 seconds
2. **Client timeout policy has to account for it**: `truncate` and `abort` look identical in
   *symptom* (both are "transfer interrupted") but differ by three orders of magnitude in
   *cost*. Five retries is 30 seconds

**This is not specific to the simulator**: plenty of real gateways and CDNs truncate a response
without closing the connection either, and the client just appears to hang. So rather than a quirk
of this tool, it faithfully reproduces a failure mode that is common in the wild — **do not assume
a truncated transfer means the connection drops immediately**.

> If you want the "connection cut" symptom, use `abort`; if you want to cover *both* client paths
> (hanging vs. failing fast) in one scenario, add both rules.

### Time dimension: make a fault start late and heal itself

`afterMs` and `forMs` are two offsets relative to the **scenario clock**:

| Field | Meaning |
|---|---|
| `afterMs` | How long after applying this the rule starts to apply. `0` = immediately |
| `forMs` | How long it stays in effect before recovering on its own. `0` = forever |

```jsonc
{ "afterMs": 30000 }              // start dropping the connection 30 s after applying
{ "forMs": 10000 }                // start now, recover by itself after 10 s
{ "afterMs": 5000, "forMs": 20000 }  // starts at 5 s, lasts 20 s
```

**What the scenario clock is**: its origin is *the moment the fault config changed* — clicking
Apply in the panel, switching presets, or editing any fault rule means the scenario starts now.

Why not "since server start" or "since the first request":

- since server start — by the time you finish editing, `afterMs: 30000` is often already in the
  past, which is not what you meant at all
- since the first request — when it starts depends on client behaviour, so it is unpredictable

It is **only sensitive to fault-related changes**: editing network parameters (latency, bandwidth)
does **not** reset the clock. Otherwise your timeline would restart at random while you were
tuning a weak network.

To replay the timeline without touching the config, use the panel's "Restart timeline" button or
`POST /api/control/fault/restart-clock`.

The rule list shows a live countdown ("active in 12s" / "recovers in 8s"), and the failure reasons
distinguish `not-yet-active` from `window-expired`.

> One easy-to-miss consequence: **a rule that has not started yet does not shadow anything.**
> The match semantics are "the first *qualifying* rule decides", and a rule outside its time window
> does not qualify — so a catch-all with `afterMs: 60000` does not block the rules behind it during
> those 60 seconds. That makes "let A apply for 30 s, then switch to B" expressible with two rules.

### Quota scope: stop devices from stealing each other's quota

`maxHits` is a **global quota** by default, first come first served. That gets painful with several
devices under test:

```
Rule: maxHits = 2, testing "fail twice then succeed"
Device A runs once  →  A burns the whole quota
Device B runs       →  nothing fails; looks like "the fault was never configured"
```

Adding `maxHitsScope: "device"` gives **each device its own quota**:

```jsonc
{ "maxHits": 2, "maxHitsScope": "device" }
```

The device identifier comes from `?deviceId=` on the request. **There is an easy trap here**:

- hot-update endpoints like `/api/version` already carry it — **nothing extra to do**
- but **the asset URLs in the manifest do not carry `deviceId`** — and neither do real CDN URLs
  in practice. So **if you use device scope on `/assets`, the client must append `deviceId` to the
  asset URL itself**; otherwise every device shares one anonymous bucket, which reproduces exactly
  the symptom this feature exists to fix: the first device burns the quota and the rest never fire

**Requests without a `deviceId` share one bucket** — the behaviour stays deterministic instead of
turning into "everyone gets a quota".

| Scope | Meaning |
|---|---|
| `global` (default) | one shared quota |
| `device` | one quota per device |

The rule list spells out each device's usage (`dev-A:2✓ dev-B:1`, where ✓ means that device has
used up its quota).

> A deliberate design point: **`device` scope is never reported as "quota exhausted"**. The devices
> seen so far may be used up, but a new device can still fire — so "exhausted" is not a global fact
> here, and claiming it would only mislead. The panel instead reports *which* devices are used up.

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
| GET | `/api/protocol` | Protocol version and capabilities. No parameters — ask this first at startup |
| GET | `/api/version` | Check the version and decide whether an update is needed. Parameters `platform`, `current`, `channel`, `deviceId`; for code hot updates also `codeCurrent`, `appVersion`, `aotHash` |
| GET | `/api/manifest` | Fetch the full file manifest (path / size / md5 / download URL). `?track=code` for the code track; `?expectId=` / `?expectVersion=` pins the version and returns 409 on a mismatch |
| GET | `/api/check` | Both of the above in one call, saving a round trip |
| GET | `/api/platforms` | List every platform with its resource version and code version |
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
| POST | `/api/control/fault/restart-clock` | Restart the scenario clock used by `afterMs` / `forMs` |
| PATCH | `/api/control/hotupdate` | Edit channels and gray release (`channels` / `defaultChannel` / `gray`). Partial update; array fields are replaced wholesale, and anything normalised away is reported in `notes` |
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
    "assetDir": "assets",      // Relative to the storage root; see "Where Runtime Data Lives"
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
    "channels": ["default", "beta", "dev"],   // Channel names. Only names declared here count as channel directories
    "hashAlgorithms": ["md5"],   // Digest algorithms; the first is primary (manifest hash and ETag both use it)
    "gray": {
      "enabled": false,
      // Gray release rules. Semantics: **AND within one rule, OR across rules**
      "rules": [
        { "name": "internal whitelist", "devices": ["dev-001", "dev-002"] },
        { "name": "all of beta channel", "channels": ["beta"] },
        { "name": "new base packages only", "minAppVersion": "1.5.0" },
        { "name": "random 10%", "percent": 10 }
      ],
      "percent": 0                 // Legacy shorthand; ignored when rules is non-empty
    }
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

## Where Runtime Data Lives (Isolating From Your Project)

The simulator **never writes anything outside its own directory**. All of its runtime data sits in two places:

| What | Where | Committed? |
|---|---|---|
| Sample bundles, presets, favorites | The storage root (default `<project>/storage`) | No, gitignored |
| Simulation settings, fault rules | `backend/config.json` | **Yes** — that is a project file |

The asset directory is **read-only** to the server: no code path writes to or deletes from it.
`npm run sample --clean` only clears `assets/` under the storage root, so it
**cannot touch your Unity build output**.

### Moving the data outside the project

**Put it in `.env`** (at the project root) — no shell-specific syntax to remember, and `npm start`
just works:

```ini
# .env
HOT_UPDATE_STORAGE=D:\hus-data
```

> ⚠️ Backslashes or forward slashes are both fine, but **do not add quotes**. The directory is
> created for you.

You can also set it on the command line, but **every shell spells it differently** — this is the
easiest thing to get wrong:

```bash
# Git Bash / WSL / macOS / Linux
HOT_UPDATE_STORAGE=D:/hus-data npm start
```

```bat
:: Windows cmd — note it does NOT accept the VAR=value form
set HOT_UPDATE_STORAGE=D:\hus-data && npm start
```

```powershell
# Windows PowerShell
$env:HOT_UPDATE_STORAGE='D:\hus-data'; npm start
```

All three are equivalent. A command-line value **takes precedence over `.env`**, which is handy for
a quick experiment.

Sample bundles, presets and favorites then live in `D:\hus-data`, leaving the project directory
clean. Relative paths resolve against the **project root** (not the current working directory),
so launching from an IDE will not send them somewhere unexpected.

`npm run sample` and the server read the **same** storage root — they cannot drift apart.
To confirm where things landed:

```bash
curl http://localhost:5500/api/system
# paths.storageRoot / paths.assetRoot / paths.storageRootOverridden
```

### Serving a real Unity build directly

Point `assetDir` at your build output using an **absolute path**:

```jsonc
{ "server": { "assetDir": "D:\\MyUnityProject\\ServerData\\Android" } }
```

Unity builds and it is immediately testable — no copying. The server only reads, but note that
your real bundles become reachable at `http://127.0.0.1:5500/assets/...`; it listens on loopback
only by default, so that stays local.

---

## Deployment and Multiple Devices

### Letting other devices connect (phone / real hardware / another PC)

By default it listens on `127.0.0.1` only, so other devices cannot reach it. To open it up:

```bash
HOST=0.0.0.0 npm start
```

Then open `http://<your-LAN-IP>:5500` on the other device (`ipconfig` on Windows shows the IPv4 address).

> ⚠️ **The control API has no authentication.** Binding to `0.0.0.0` exposes the simulation
> settings, fault rules and the full request log to every machine on the same LAN. Turn it on
> only while testing on real hardware, and turn it back off afterwards. When the bound address
> is not loopback, the startup log prints a prominent warning.

Two notes:

- **Unity clients** use `/api` and `/assets` and send no `Origin` header — never an issue.
- **The panel itself** is fully usable from another device, write actions included (panic,
  parameter changes). The cross-site check is based on **same-origin** (Origin matching Host),
  not on "is this a loopback address" — otherwise opening the panel via a LAN address would
  silently turn it read-only through its own protection.

### Packaging a clean usage build (separate from the dev directory)

**The repository is the product; there is no separate release branch.** But you should not copy
the dev directory wholesale: it holds `node_modules`, sample bundles, build output, and a
`backend/config.json` that day-to-day use has rewritten.

Build a clean package with:

```bash
npm run release
# → release/hot-update-simulator-1.0.0.tgz
```

It contains the git-tracked sources plus a prebuilt `dist/`, and specifically:

- **No** `node_modules`, no `storage`, none of your development data
- `backend/config.json` **reset to defaults** — this is the important part: that file is both
  git-tracked and rewritten by the UI, so fault rules and simulation settings tuned during
  development would otherwise ship inside the release
- A `RELEASE.txt` recording which commit it came from and how to run it

Unpack and use it elsewhere:

```bash
mkdir D:\hus-runtime
tar -xzf hot-update-simulator-1.0.0.tgz -C D:\hus-runtime --strip-components=1
cd D:\hus-runtime
npm install          # backend dependencies only; the frontend is already built
npm start
```

A fresh release has no sample assets — run `npm run sample` once, or point
`HOT_UPDATE_STORAGE` at an existing data directory.

The script refuses to package from a dirty working tree, because a release must map to an exact
commit. Pass `--force` if you really need to, and it will be noted in `RELEASE.txt`.

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
npm run version-check # Version consistency: format, both package.json files, and a CHANGELOG entry
npm run bump minor   # Bump the version (patch|minor|major or an explicit version) and seed a CHANGELOG section
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

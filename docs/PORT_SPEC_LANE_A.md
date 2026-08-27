# LANE A — Wire protocol & session lifecycle

Owner (this file): reassigned writer. Source of truth is the files cited.
`HYPERIA_EVENT_STREAM_API.md` is the sidecar's *intent*; the live client
has already diverged. Where they disagree, the client + a live 0.17.x
sidecar win.

Lane C owns *when* a socket is opened. This lane owns *what* is on the
wire once it is. Lane D §5.5 (`hyp_pane_*` vs `hyp_agent_*`) is correct;
§5.4 (one reconnect policy) is a target this client does **not** meet.

---

## 1. CONTRACT

### 1.1 Transport

Four WebSocket endpoints on the Hyperia sidecar, default
`ws://{host}:9800` (`HYPERIA_PORT` overrides on the sidecar). This client
builds URLs as `{ws|wss}://{location.hostname}:9800{path}`
(`frontend/src/hyperia/stream.ts:17-21`). It does **not** go through
ops-room `:8080` and does **not** use the `/hyperia-api` HTTP rewrite.
Containers that can reach `:8080` but not `:9800` cannot stream.

JSON TEXT frames are UTF-8, field `t` is the discriminant, `v` is `1`
when present. Clients MUST ignore unknown `t` and unknown fields
(`HYPERIA_EVENT_STREAM_API.md:45`). BINARY frames are raw payload with
**no header** — interpretation depends on the socket kind.

`paneId` addressing: full UUID **or a 4+ character prefix**
(`HYPERIA_EVENT_STREAM_API.md:31`). Tab ids are full UUIDs in
`/ws/tab/{tabId}` (`tab-stream.ts:280-281`).

### 1.2 Auth

Sidecar accepts, optionally:

- `Authorization: Bearer <token>` (native clients)
- `?token=<token>` (browsers cannot set WS headers)
  (`HYPERIA_EVENT_STREAM_API.md:37-38`)

Reads are anonymous by default. `config.stream.requireToken = true`
rejects tokenless upgrades with 401 before the handshake.

**Token classes (this is a state machine, not a string):**

| Class | Shape | Lifetime | Use |
|---|---|---|---|
| pane | `hyp_pane_*` | dies with that pane **and** with sidecar restart | agent-in-pane identity (`HYPERIA_AGENT_TOKEN` in a Hyperia pane is this) |
| agent | `hyp_agent_*` | persists across pane death and sidecar restart | long-lived room / ops-host |
| system | (sidecar-defined) | process | sidecar-internal |

This client **never attaches a token** to any of the four sockets
(`stream.ts:37`, `tab-stream.ts:283`, `broker.ts:473`,
`video-wall.ts:986`). It relies on anonymous reads. Ops-host attaches
`HYPERIA_AGENT_TOKEN` only on the **HTTP** proxy
(`backend/src/main.rs:48-56`), not on browser WS.

**What breaks if you pick wrong:**

- Persist `hyp_pane_*` in the room process. Sidecar restart or the
  origin pane recycling → every subsequent WS/HTTP call 401s. The room
  looks "Hyperia offline" while `:9800` is up. This is the session
  Lane D §5.5 burned.
- Use `hyp_agent_*` as a pane's `HYPERIA_AGENT_TOKEN`. You impersonate
  a durable agent from a volatile seat. Audit logs lie; a closed pane
  keeps a live credential.
- Put the token only in `Authorization` from a browser. The browser
  cannot set WS headers; the upgrade is anonymous (or 401 if
  `requireToken`). Browser clients **must** use `?token=`.
- Forward a pane token from ops-host to the sidecar on behalf of every
  user. You have just made every client that user.

Port: `enum Credential { Anonymous, Pane(String), Agent(String) }`.
On `{t:"error", code:"unauthorized"}` (or 401 before upgrade), refresh
or fail closed — do not retry the dead secret.

### 1.3 Heartbeat

Server → `{t:"ping"}` every `heartbeatMs` (hello advertises it; we have
seen `15000`). Client → `{t:"pong"}` on the **same** socket.

Implemented in:

- `openContentSocket` (`stream.ts:45-46`) — pane + pixels
- `StreamBroker.ensureWallSocket` (`broker.ts:483-485`)
- `TabStream.handle` (`tab-stream.ts:324`)
- `HyperiaWallClient` (`wall-client.ts:16`) — **dead code**, see §3
- video-wall pixels (`video-wall.ts:993`)

Miss a heartbeat and the sidecar drops you. There is no client-initiated
ping.

### 1.4 Common TEXT frames

```
{ t:"hello", v:1, mode:"wall"|"focused"|"tab"|…, serverVersion, heartbeatMs }
{ t:"ping" } / { t:"pong" }
{ t:"error", code, message }   // then close
{ t:"bye", reason }            // server closing
```

`hello.mode` is `"wall"` on `/ws/wall`, `"focused"` on `/ws/pane`
(`HYPERIA_EVENT_STREAM_API.md:50`). `/ws/tab` hello uses `mode:"tab"`
(observed; `tab-stream.ts:326-328` logs it, does not branch on it).

The typed `WallMessage` union (`protocol.ts:136-148`) is **not** the
full wire. Live sidecars also send `t:"panes"` (flat roster, no `t` in
the type) and tab sockets send `t:"tab-layout"`, `t:"pixels"`. Unknown
`t` MUST be ignored, not a parse failure.

### 1.5 Cell / colour / attrs (wall and tab are identical)

```
Color = "default" | "idx:{0-255}" | "#{rrggbb}"
Cell  = [char, fg, bg, attrs]
```

`protocol.ts:1-3`. `char` is one grapheme or `""` (blank). Trailing
default-blank cells MAY be omitted; the client pads to `cols`
(`tab-stream.ts:457-459`, `broker.ts:94-99`).

`ATTR` bitfield (`protocol.ts:7-14`):

| bit | name | paint |
|---|---|---|
| 1 | BOLD | weight 700 |
| 2 | ITALIC | italic font |
| 4 | UNDERLINE | rule under glyph |
| 8 | INVERSE | swap fg/bg |
| 16 | DIM | alpha 0.55 |
| 32 | STRIKE | mid rule |

`idx:N` maps through a **client theme**, not the sidecar:

- 0–15: VS Code-ish ANSI16 (`protocol.ts:17-22`)
- 16–231: 6×6×6 cube, component `0` or `55+v*40` (`protocol.ts:28-31`)
- 232–255: grey `8+(n-232)*10` (`protocol.ts:33-34`)

`#rrggbb` / `#rrggbbaa` used as-is (alpha stripped, `protocol.ts:47`).
`#rgb` expanded (`protocol.ts:48-50`).

`cssColor` / `normalizeColor` also accept leaked Rust Debug
`Idx(4)` and bare integers (`protocol.ts:54-67`). That is defensive
against `ScreenBuffer::screen_dump` doing `format!("{:?}", color)`
(`HYPERIA_EVENT_STREAM_API.md:73`). The sidecar is *supposed* to
normalise; the client must not trust it.

### 1.6 Why `normalizeGridRows` has three shapes

`protocol.ts:85-100`. Keyframes have arrived as all three:

1. **`[{y, cells}, …]`** — documented wall row
  (`HYPERIA_EVENT_STREAM_API.md:64`).
2. **`[{cells}, …]`** — `y` omitted; implicit index
   (`protocol.ts:86-87, 98`).
3. **`[ [cell, cell, …], … ]`** — a row is a bare cell array; `y = index`
   (`protocol.ts:93`).
4. **`{row: N, cells}`** — `row` as the y alias (`protocol.ts:97`).

A fourth non-shape: the message field `rows` is the **height**, never
the grid. Do not pass `message.rows` into `normalizeGridRows`
(`protocol.ts:87-88`). The grid field is `rows_data`.

`wallRowPayload` only reads `frame`/`delta` (`protocol.ts:120-123`).

### 1.7 `name` vs OSC `title`

Sidecar ≥0.17.9 pane entries carry:

- `name` — stable creature codename (`"Brave Skink 🥐"`). Layout-stable.
  Never shadowed by a process title.
- `title` — volatile OSC title; equals `name` until a program sets it.
- `tabName` — tab-level, top of `tab-layout`.

`paneChrome` (`protocol.ts:103-118`):

```
namedFromLayout = typeof name === "string" && name.trim() ≠ ""
label           = name.trim() || title.trim() || paneId[0..8]
```

JSON `name: null` is **not** a string; it does not lock the label.
`TabStream` keeps `namedFromLayout` so a later `title` / topology
update cannot overwrite a real layout name (`tab-stream.ts:347-351,
389-403`). Until 0.17.9, fall back to `title` then `/status` `name`.

`state`: `"running" | "idle"` on tab-layout (plus wall `"busy"`).
Client treats anything but `"idle"` as running (`tab-stream.ts:79-81`).
Drive bezel glow/dim from this
(`HYPERIA_EVENT_STREAM_API.md:177`).

### 1.8 Socket: `/ws/wall`

Query: `?fps=N` (coalesce cap, sidecar clamps 1–60; this client sends
the broker's `overviewFps`, constructed as 10, `main.ts:34`,
`broker.ts:471-472`) and optional `?token=`.

**Server order (documented):** `hello` → `topology` → one `frame` per
pane → live `delta`/`resize`/`state`/`topo`/`resync`
(`HYPERIA_EVENT_STREAM_API.md:81-107`).

**Server order (live 0.17.x, observed):** `hello` → **`t:"panes"`**
(flat `{paneId,title,cols,rows,state,active}[]`, often `name:null`,
**no BSP**) → `frame`s. `t:"topology"` with `windows[].tabs[].panes[]`
is implemented in the type (`protocol.ts:138`) and in
`ingestWallTopology` (`main.ts:2536`) but is **not** what the sidecar
emitted when we dumped it. A port must accept **both**.

`frame`: full grid, carries `cols`,`rows`,`cursor`,`rows_data`. Client
reallocates the grid if size changed (`broker.ts:529-538`).
`delta`: changed rows only; `cols`/`rows` may be absent. Apply onto
the last keyframe (`broker.ts:539-543`).
`resize`: new `cols`/`rows`, wipe grid, `hasFrame=false`, expect a
following `frame` (`broker.ts:544-549`).
`resync` (server): "I dropped deltas; rebuild from the next
topology+frames." This client **keeps the last raster**
(`broker.ts:507-509`) and does **not** echo `resync`. The dead
`HyperiaWallClient` *does* echo it (`wall-client.ts:17`) — do not copy
that.
Client → `{t:"resync"}` to force a refresh (`broker.ts:419`); coalesced
to 1500 ms (`broker.ts:417`).
`topo{op:"remove"}` deletes the view (`broker.ts:511-513`).
`t:"panes"` is handled only in `main.ts:2550-2565`, not in the broker.

On sidecar restart: socket dies. Broker reconnects in 1500 ms **only if
`wallListeners.size > 0`** (`broker.ts:490-496`). Desk overview
re-opens via `ensureOverview` on the next tick. There is no backoff,
no jitter, no generation on the wall socket.

Lagged wall client: sidecar sends `resync` then keyframes
(`HYPERIA_EVENT_STREAM_API.md:141-142`).

### 1.9 Socket: `/ws/pane/{paneId}`

Query: `?scrollback=1` (default true; this client always sends it,
`broker.ts:368, 567`). Optional `?token=`.

**Read-only.** Input is MCP `terminal_keys`, not this socket
(`HYPERIA_EVENT_STREAM_API.md:135, 183`).

Order: `hello(mode:"focused")` → `meta{paneId,title,cols,rows,state,cwd}`
→ BINARY scrollback (oldest→newest, ring ~512 KB) → `{t:"replay-end"}`
→ live BINARY PTY + interleaved TEXT `resize`/`state`/`bye`.

This client:

- `binaryType = "arraybuffer"` (`stream.ts:39`)
- TEXT `ping` → pong; `meta`/`resize` → VT resize
  (`broker.ts:571-574`, `main.ts:2435-2446`)
- BINARY → `terminal.write` (`broker.ts:568-569`)
- also accepts undocumented `{t:"screen-snapshot", text}` as a
  pre-live fallback (`main.ts:2448-2450`)

On lag: sidecar `{t:"error", code:"slow-consumer"}` + close. Client
must reconnect and replay; it cannot patch. `ensureFocused` retries
after 350 ms (`broker.ts:324`) with no cap, no jitter.

`paneId` in the URL may be a prefix. Never put `"tab:"+uuid` here
(Lane C clobber 2).

### 1.10 Socket: `/ws/pixels/{paneId}`

Not in `HYPERIA_EVENT_STREAM_API.md` v1. The client invented / the
sidecar added it for **web panes**.

Query: `?w=&h=&fps=` (`broker.ts:367, 589`, `video-wall.ts:986`).
TEXT: `hello` / `ping` / `meta` (pixels meta uses `w`×`h`,
`main.ts:2431-2433`). BINARY: JPEG bytes, no header. Client
`createImageBitmap` and letterbox (`broker.ts:591-595`,
`main.ts:2455-2465`). Drop the frame if the lease changed mid-decode
(`broker.ts:594`).

`/ws/tab` web panes are **not** this socket. They arrive as TEXT
`{t:"pixels", paneId, jpeg: <base64>}` (`tab-stream.ts:359-360,
478-491`). Two encodings, one concept. Port: one `PixelsFrame` enum
`{ Binary(Bytes) | JsonJpeg { pane_id, b64 } }`.

### 1.11 Socket: `/ws/tab/{tabId}`

Query: `?fps=12&w={canvas}&h={canvas}` (`tab-stream.ts:280-281`).
`w`/`h` are compositor hints; they do not change PTY size.

**Server order is guaranteed:** `hello` → `tab-layout` → one terminal
`frame` keyframe per terminal pane, in that first burst
(`tab-stream.ts:7-9`). Do not invent a wait-for-layout, a seed grid,
or a wall-feed fallback. A keyframe of blank rows is a valid empty
mirror (idle / restart) — paint an empty terminal
(`tab-stream.ts:9-10`).

`tab-layout` (`tab-stream.ts:333-335, 364-367`):

```
{ t:"tab-layout", v, tabId, tabName, windowId, w, h,
  panes: [{ paneId, type, name?, title, state, focused?,
            x,y,w,h | bspX,bspY,bspW,bspH,
            cols, rows }] }
```

Top-level `w`/`h` are tab pixel size, **not** pane percents. Pane
`x,y,w,h` are percents 0–100 (also accepted as 0–1 fractions,
`tab-stream.ts:61-64`). Sidecar ≤0.17.9 omitted `name`. Sidecar
≤0.17.9 stuck late/re-registered panes at `0,0,100,100` (Claude,
0.17.10 fix). Identity is `paneId` (`tab-stream.ts:197, 386`).

Then, per pane, same cell packing as wall: `frame` / `delta` /
`resize` (`tab-stream.ts:338-340, 430-475`). Web: `{t:"pixels",
paneId, jpeg}`. `state` may update `title`/`name`/`focused`
(`tab-stream.ts:343-356`).

**Input (not wired in the 3D UI, but specified):**

```
client → { t:"input", paneId, keys }
```

`TabStream.sendKeys` (`tab-stream.ts:317-319`). `keys` is the same
string language as MCP `terminal_keys` (`\n`, `\r`, `\t`, `\x03`).
`/ws/pane` has no equivalent.

On close: `TabStream` logs and paints "CONNECTING" only after
`dispose`/`reconnect` — **`connect()` does not retry**
(`tab-stream.ts:300-305`). Caller (`attachTabStream`) must reopen.

On sidecar restart: tab socket dies; the stored `BaySource::Tab` (Lane
C) remains; restore/`attachTabStream` opens a new `/ws/tab`. Expect a
fresh `tab-layout` + blank-or-full keyframes. Do not keep stale grids
across generations (`tab-stream.ts:278, 308-314`).

### 1.12 Session lifecycle the port must implement

Per socket:

```
dial → hello (or 401/close)
     → kind-specific burst (topology|panes|tab-layout|meta+replay)
     → live
     → ping/pong
     → error|bye|peer-close → backoff reconnect if the lease still wants it
```

Generation / cancellation: increment **before** closing the old socket
(`stream.ts:34-35`, `tab-stream.ts:278-279`). Events from generation
N-1 are dropped. `session.powered === false` also drops
(`stream.ts:42`). Rust: `CancellationToken` on the task; do not port
the integer.

Sidecar restart checklist:

| socket | local action |
|---|---|
| wall | close; 1.5 s reconnect if anyone is subscribed; next `frame`s replace grids; do not wipe bays |
| pane | close; `ensureFocused` 350 ms retry + scrollback replay |
| pixels | same as pane |
| tab | close; caller reconnects; apply new `tab-layout`; blank keyframe ≠ missing pane |

HTTP `/api/status` (via `/hyperia-api/status`) is **not** a stream.
It is how names/BSP arrive when `tab-layout`/`topology` omit them
(`main.ts:2322-2346`). Poll, do not confuse it with `t:"topology"`.

---

## 2. WHAT WORKED

**One cell packing for wall and tab.** `[char,fg,bg,attrs]` plus
`normalizeGridRows` meant the tab compositor did not invent a second
grid codec. Keep it one type.

**Keyframe / delta split.** Full `frame` after connect/resize; `delta`
is changed rows only. Cheap enough that one `/ws/wall` feeds every
overview bay. Survived 7+ panes at 10 fps.

**Ignore-unknown `t`.** Let the sidecar add `panes`, `tab-layout`,
`pixels`, `screen-snapshot` without a coordinated bump. The typed
union lagging the wire is ugly; the runtime surviving it is why the
rule exists.

**`paneChrome` lock.** Distinguishing "layout sent `name`" from
"we fell back to `title`" stopped OSC titles from renaming creature
panes once 0.17.9 landed. Port the boolean, not a heuristic on the
string.

**Blank keyframe = empty terminal.** Treating it as "no data" made
idle panes look broken and invited a wall-feed fallback that the
implementer (correctly) forbade (`tab-stream.ts:7-10`).

**Anonymous wall reads + optional token.** The room works without
shipping a secret in the JS bundle. Token is an ops-host concern.

**`?token=` for browsers.** Correct given WS header limits. Native
Rust can use `Authorization`.

---

## 3. WHAT DIDN'T

### 3.1 This client never authenticates its sockets

`hyperiaWsUrl` has no token parameter (`stream.ts:17-21`). The moment
a sidecar sets `requireToken`, every wall/pane/pixels/tab upgrade
401s and the room is blind. Ops-host has the agent token and does not
give it to the browser. Port must decide: proxy Hyperia WS through
ops-host (attach `hyp_agent_*` server-side) **or** mint a short-lived
read token onto `?token=`. Do not paste `hyp_pane_*` into JS.

### 3.2 `hyp_pane_*` as a long-lived credential

A pane token dies with the pane and the sidecar. Using it for the
room (or stashing it in env as if it were `hyp_agent_*`) produces
"Hyperia is down" after an unrelated pane recycle. Model the lifetime
in the type. Lane D §5.5 is the same finding; this is the wire
statement of it.

### 3.3 Four reconnect policies, all bad

| path | policy |
|---|---|
| wall + listeners | 1500 ms, no backoff (`broker.ts:496`) |
| wall, no listeners | stay dead until a desk overview tick |
| focused pane/pixels | 350 ms floor, infinite (`broker.ts:324`) |
| tab | **none** (`tab-stream.ts:300-305`) |
| `/ws/v1/control` (not Hyperia) | 1 s / 3 s (`main.ts:612-614`) |

`HyperiaWallClient.connect` (`wall-client.ts:11-19`) has **zero**
reconnect and is unused on the live path. It also **echoes `resync`**,
which can loop with a confused sidecar. Delete it; do not port it.

Lane D asked for one policy in `hyperia-client`. Agree. Exponential
backoff + jitter + cap, identical for all four kinds, cancelled when
the lease drops.

### 3.4 Typed `WallMessage` is a lie

`protocol.ts:136-148` has no `panes`, no `tab-layout`, no `pixels`.
The live first wall burst is `t:"panes"`. `handleWall` ignores
anything without `paneId` except `resync`/`topo-remove`
(`broker.ts:506-516`) — so `hello`, `topology`, `state`, `panes` are
silently dropped at the broker and only `main.ts` sees `panes`. A Rust
`enum` with `#[serde(other)]` / `Unknown` is mandatory. Do not
`deny_unknown_fields`.

### 3.5 Default `0,0,100,100` on `/ws/tab`

Late panes arrived as full-tab rects (sidecar ≤0.17.9). Clients that
keyed by rect or hid 100% leftovers **dropped Husky Prawn / Koi /
Rabbit**. 0.17.10 sends true splits. Permanent rule (wire-level, not
a pretty layout): **never hide a paneId you received**; if 2+ share
an identical full-tab rect, auto-grid them. Key by `paneId`.

### 3.6 Two pixel encodings

Focused web: BINARY JPEG. Tab web: JSON base64. A compositor that
only listens for TEXT (`tab-stream.ts:292`) will never see a binary
tab pixel if the sidecar ever switches. Accept both.

### 3.7 Hardcoded `:9800` + hostname

`stream.ts:19-21`. Breaks: TLS termination on 443, sidecar on another
host, ops-room in a container, anything that is not "browser and
sidecar share a hostname and 9800 is open". The HTTP side already
learned this (`backend/src/main.rs:38-45`). The WS side did not.

### 3.8 `v` is never checked

`hello.v` is logged at best. A v2 sidecar can break us silently.
Read it. If `v` is missing, assume 1. If `v > 1` and you don't
implement it, fail the socket loudly.

### 3.9 Focused "full fidelity" still needs a VT

`/ws/pane` is raw bytes. Without `vte`/`alacritty_terminal` you get
mojibake. The wall/tab grids are the path that does **not** need a
VT. Do not "simplify" focused by stuffing wall cells into it — you
lose sixel, cursor shape, and truecolour the VT already parsed.

### 3.10 Input on the wrong socket

`/ws/tab` has `{t:input}` (`tab-stream.ts:317-319`). `/ws/pane` does
not. A port that injects keys on focused PTY over the stream will
fight the sidecar. Use MCP or the tab input frame; pick one and
document it.

---

## 4. RUST NOTES

**`hyperia-proto` (no IO):**

```
enum Color { Default, Idx(u8), Rgb(u8,u8,u8) }
struct Cell { ch: char /* or String grapheme */, fg: Color, bg: Color, attrs: u8 }
enum Attr { Bold=1, Italic=2, Underline=4, Inverse=8, Dim=16, Strike=32 }
fn normalize_grid_rows(v: &Value) -> Vec<GridRow>  // all three shapes
fn parse_color(&str) -> Color  // idx:N, Idx(N), #hex, default
fn pane_chrome(name, title, pane_id) -> Chrome
```

Serde: `#[serde(tag="t")]` + an `Unknown` variant. Never
`deny_unknown_fields`.

**`hyperia-client`:** one `struct Socket { kind, cred, backoff, token:
CancellationToken }`. Four constructors. `hello` is a oneshot the
caller awaits; after that a `mpsc`/`broadcast` of `Event`. Ping is
internal. `Drop` cancels.

Backoff: `min(1500 * 2^n, 30_000) + jitter`, reset on a successful
`hello`. Same for all four kinds.

**Credentials:** `Credential` as above. Browser-facing ops-host mints
a read-only agent-derived ticket and puts it on `?token=`. Never ship
`hyp_pane_*` to a renderer.

**Focused PTY:** feed BINARY into `vte::Parser` on the client task.
`resize` TEXT must apply **before** the next byte
(`HYPERIA_EVENT_STREAM_API.md:131`). Wall/tab skip `vte`.

**Tab input:** `Sink<TabInput { pane_id, keys: String }>`. Do not
invent a binary keymap.

**Pixels:** `enum PixelPayload { Jpeg(Bytes), JpegB64 { pane_id, s } }`.
Decode off the WS task; drop if the generation changed.

**Wall multiplex:** one socket, `HashMap<PaneId, Grid>` as in
`broker.ts:119`. `resync` keeps last pixels until the replacement
`frame` — do not flash black.

**Do not port** `HyperiaWallClient` (`wall-client.ts`). Do not port
`focusedGeneration`. Do not put `{hostname}:9800` in a const; take
`HyperiaEndpoint { host, port, tls, token }`.

**Sidecar restart** is indistinguishable from a dropped socket. The
lease layer (Lane C) decides whether to redial. This crate just
redials when asked and emits `Event::Hello` so callers wipe
generation-scoped grids.

---

## 5. Wire cheat-sheet (implement this, not the TS types)

```
GET /ws/wall?fps=&token=
  hello(mode=wall) → (topology | panes) → frame* → (delta|resize|state|topo|resync|ping)*

GET /ws/pane/{id}?scrollback=1&token=
  hello(mode=focused) → meta → BINARY* → replay-end → (BINARY | resize | state | bye | ping)*
  no input

GET /ws/pixels/{id}?w=&h=&fps=&token=
  hello → (BINARY jpeg | meta | ping)*

GET /ws/tab/{tabId}?fps=&w=&h=&token=
  hello(mode=tab) → tab-layout → frame* → (delta|resize|state|pixels|ping)*
  client: {t:input, paneId, keys}

cell = [char, "default"|"idx:N"|"#rrggbb", same, attrs_u32]
name = stable label; title = OSC; never let title overwrite name
key by paneId
```

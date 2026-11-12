# AgentHub state machines

AgentHub has no hidden status booleans left in the hot paths. Every status that a
user, a developer, or an agent can observe is declared once in
[`lib/machines.js`](lib/machines.js) and enforced where it changes.

There are three audiences, and each one gets the same rules:

| Audience | How it reads the rules | How it is protected |
| --- | --- | --- |
| User (UX) | buttons/labels are derived from the machine | illegal actions are not rendered, and stale runs heal instead of spinning forever |
| Developer (DX) | `lib/machines.js` + `public/machines.js` | server rejects illegal transitions with a structured `409`, tests assert invariants |
| Agent (AX) | `GET /api/machines`, `GET /api/status`, `window.__ahState()` | machine contract version, `allowed` lists in every rejection, idempotent endpoints |

Machine contract version: **3** (`MACHINE_VERSION`, surfaced by `GET /api/version`
and by the `version` field of `GET /api/machines`). Bump it whenever a state or
transition changes; the tests and the generated browser copy follow it.

## Inventory

| Machine | States | Owner (writes) | Persistence | Enforcement |
| --- | --- | --- | --- | --- |
| `task` | inbox → todo → running → review → done | `lib/tasks.js` | `data/tasks.json` | `POST /api/tasks/:id` → `409 ILLEGAL_TRANSITION` |
| `run` | idle → running → done/error/stopped → idle | `lib/runs.js` | thread fields `runState`, `runStartedAt`, `runEndedAt`, `runError` | `POST /api/threads/:id/send` → `409 RUN_IN_PROGRESS`; `/stop` is idempotent |
| `step` | working → done/error/stopped | `server.js` (delegate), `lib/threads.js#updateSubrun` | message `status` on subrun messages | written only through `updateSubrun` |
| `delegation` | idle → starting → running → done/error/stopped | `public/app.js` | none (client session) | button lock + `Hentikan`/`Batal` switch, server run outcome is the source of truth |
| `noteEditor` | closed → editing ⇄ dirty → saving | `public/app.js` | none (draft in DOM) | close is confirmed while `dirty` |
| `key` | unknown/valid/invalid/error ⇄ checking | `lib/keys.js` | `data/keys.json` | `canTransition` before persisting a probe result; one probe per key in flight |
| `agent` | unknown/online/error ⇄ checking, → triggering | `lib/agents.js` | `data/agents.json` | same pattern as `key` |
| `connection` | connecting ⇄ live/degraded/offline/unauthorized | `public/app.js` | none | banner text + retry behaviour |
| `promo` | idle → refreshing → ready/error → idle | `server.js` | `data/snapshot.json` (result, not state) | single-flight `refreshPromoOnce()` |
| `promoPass` | available → pending/active → expired | `lib/promoPass.js` | `data/promo-pass.json` | `passPhase()` derives the phase from the campaign window; actions validate model/toggle/upgrade before writing |
| `ui` (overlay) | null ⇄ one of `usage, env, qr, delegate, note, adopt, promoClaim, project, projectEdit, models, effort, engines, access, git, sbMenu, palette, search, mention` | `public/app.js#setLayer` | none | one layer at a time, `aria-hidden` mirrors it |
| `view` | any of 9 views | `public/app.js#go` | URL `?view=` | rail buttons come from `VIEWS` |

Two supporting tables live next to the machines because they are the same kind of
knowledge (facts that used to be scattered string literals):

- `SSE_SCOPES` maps every SSE event name to the state slices it invalidates.
- `KEY_POOL_CANDIDATE` / `KEY_POOL_ACTIVE` / `KEY_MODEL_VISIBLE` define which key
  statuses a gateway may try, which count as "ready", and which may list models.
- `CHANGE_STATUSES` / `RULE_FILES` define the vocabulary of the workspace drawer:
  which file changes exist (`modified`, `added`, `deleted`, `renamed`, `copied`,
  `untracked`, `conflict`) and which rule files may be written (`AGENTS.md`,
  `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`). Changes are not
  a state machine — a file can move between statuses at any time — so the contract
  exposes them as a closed set instead of invented transitions.

## Workspace per thread

A thread owns its folder (`thread.cwd`), not the browser tab. The server validates
it before the thread is created or a run starts (`WORKSPACE_INVALID`), persists it
on every send, and exposes three read/write surfaces:

| Route | Purpose |
| --- | --- |
| `GET /api/threads/:id/workspace` | repo?, branch, changed files, rule files |
| `GET /api/threads/:id/diff` | the same list plus `+/-` counts and a bounded patch |
| `POST /api/threads/:id/revert` | restore tracked files; delete untracked only with `deleteUntracked: true` |
| `POST /api/threads/:id/rules` | write one allow-listed rule file (max 64 KB) |

Revert is deliberately narrow: only paths that appear in `git status` are accepted,
paths are resolved inside the repo root, the index is never touched (`git restore
--worktree`), and a file that is not tracked is never deleted without the explicit
flag. A non-repo folder answers `409 NOT_A_REPO` instead of guessing.

A workspace may be a subfolder of a repo. `git status`, `git diff --numstat`, and
`git diff` all report paths relative to the **repo root**, so the module resolves
the root once (`git rev-parse --show-toplevel`) and uses it for every path. The
thread keeps its own `cwd` in responses, but file paths are always root-relative —
`server.txt` inside `packages/api` is `packages/api/server.txt` in the diff and in
a revert request.

## Promo pass

The promo pass is time-driven, so its phase is derived rather than mutated on a
timer:

```
available ──claim──> pending ──drop 22:00──> active ──plan end 22:59──> expired
             └─────────────────────────────> active   (claimed after 22:00)
```

`lib/promoPass.js` owns the campaign window (drop at 22:00, ticket valid 10 hours,
plan expires three days later at 22:59), the billing day (also 22:59, not
midnight), quota math (base quota × 100/150/…%), and usage matching against the
gateway's upstream model name. `publicPass()` is the only shape the UI and
`/api/state` see; internal fields (`toggles`, `aliases`, `extraModels`, raw usage)
are normalized on read so a hand-edited or legacy file cannot crash rendering.

Every action is a small validated write: unknown models answer
`400 MODEL_UNKNOWN`, models not in the plan cannot be toggled
(`409 MODEL_NOT_IN_PLAN`), only catalog models can be added
(`400 MODEL_NOT_ADDABLE`), and upgrades stop at four boosts (`409 QUOTA_MAX`).
`claim` is idempotent — claiming twice does not move the schedule.

## Attachments

Attachments are deliberately not a state machine; they are immutable blobs with a
strict input contract:

| Rule | Enforcement |
| --- | --- |
| 8 MB per file | `saveUpload` → `413 UPLOAD_TOO_LARGE` |
| 5 per message | `POST /send` → `400 ATTACHMENT_LIMIT` |
| Names are basenames only | `safeName` strips paths and control characters |
| Every id must exist | `POST /send` validates before writing the user message (`400 ATTACHMENT_INVALID`) |
| No path or token in URLs | UI fetches `/api/uploads/:id` with the authorization header and renders blob URLs |
| No HTML/SVG inline execution | only known image types are served `inline`; everything else is `attachment` + `nosniff` |

`augmentPrompt` gives CLI engines absolute paths and gives the pool engine inlined
text (bounded at 12k characters per file / 20k total), so the same attachment works
with or without disk access. A message containing only attachments still gets a
thread title from the file names.


## Run lifecycle (the one that used to break)

`running: true/false` on a thread was written from four places, so two problems
were structural rather than accidental:

1. two `POST /send` calls in the same thread could interleave and corrupt history;
2. a server crash mid-run left a thread "Working" forever, with the send button
   disabled and no way back.

Now `lib/runs.js` is the only writer. `begin()` checks the live registry *and* the
`run` machine, then writes the thread fields in one call. `finish()` clears the
registry before patching, is idempotent, and downgrades an illegal final state to
`error` with a warning instead of lying. `stop()` only aborts processes; the state
change goes through `finish()` so there is exactly one transition path.

On startup, `recoverInterrupted()` marks any thread that is still `running` without
a live process as `error` ("Terputus karena server berhenti saat run berjalan") and
reports the count as `recoveredRuns` in `GET /api/status`. The UI therefore opens on
honest state, and the next send is allowed immediately (`error → running` is legal).

`thread.running` is still written and still returned for older clients, but it is
derived from `runState`. Read `runState` if you are writing new code.

## Why these are not machines (yet)

Centralising everything costs more than it buys when the state is a single frame of
UI with no second observer. These stay local on purpose:

| Local boolean | Where | Why it is fine |
| --- | --- | --- |
| sidebar collapsed | `public/app.js` + `localStorage` | pure preference, no other component branches on it |
| promo tab (models vs providers) | `public/app.js` | same view, two render functions |
| task filters (project, query) | `public/app.js` | derived from `tasks`; the source of truth is the list |
| token gate (locked/unlocked) | `public/app.js` | one-way, guarded by 401 handling; there is nothing to transition between |
| desktop bootstrap (starting/ready) | `desktop/main.js` | process-local, single writer, exits on failure |

If any of these ever grows a second writer or needs to be reported to an agent,
promote it to `lib/machines.js` in the same change that adds the second writer.

## Agent contract (AX)

```js
// in the page (CDP, Playwright, devtools)
window.__ahState();       // { view, layer, connection, run, promo, delegation, noteEditor, dialog, changes, workspace, thread, threadRunState }
window.__ahMachines;      // the same transitions the server enforces
```

```http
GET  /api/machines        # every machine + keyPool sets + sseScopes + version
GET  /api/status          # runningThreads, recoveredRuns, checks in flight, promo state
GET  /api/version         # { machines: 2, views, taskStatuses }
POST /api/threads/:id/send   # 409 RUN_IN_PROGRESS while a run is active
POST /api/threads/:id/stop   # always 200, { stopped: n }, idempotent
GET  /api/threads/:id/workspace  # repo, branch, changed files, rule files
GET  /api/threads/:id/diff       # files with +/- and a bounded patch
POST /api/threads/:id/revert     # { paths, deleteUntracked? } — explicit, per file
POST /api/threads/:id/rules      # { file, content } — allow-listed names only
GET  /api/workspace/check?cwd=   # validate a free-folder path before storing it
```

Every rejection carries the information needed to self-correct:

```json
{ "error": "run: \"idle\" hanya bisa pindah ke: running (diminta: done)",
  "code": "ILLEGAL_TRANSITION", "machine": "run",
  "from": "idle", "to": "done", "allowed": ["running"] }
```

Never infer status from a button's disabled state or from `thread.running`. Query
`__ahState()` or `/api/status`, act, then read the state again.

## Developer checklist (DX)

1. Add or change the state in `lib/machines.js` only. Keep `states` labels and
   `transitions` exhaustive; a state with no outgoing edges must still be listed.
2. Bump `MACHINE_VERSION` for any change in states, transitions, or the shape of
   `/api/machines`.
3. Run `npm run machines` to regenerate `public/machines.js`.
4. Route the write through one function (like `runs.finish`) instead of assigning
   the field at call sites, so there is a single enforcement point.
5. Cover it in `test/machines.test.js` (invariants) and, if it has an HTTP
   surface, in the route's test file.
6. `npm run check` must pass: it verifies the generated file is in sync, then runs
   the suite.

## Test map

| File | What it pins down |
| --- | --- |
| `test/machines.test.js` | every machine: initial state exists, transitions point at known states, terminal states are sinks (or explicitly reopenable), labels are unique, key pool sets are subsets of `key` states |
| `test/api.test.js` | `/api/machines` and `/api/version` shape, contract version, SSE scopes, token gate, task 409 contract |
| `test/run.test.js` | real run → `done`, concurrent send → `409`, stop → `stopped` and idempotent afterwards |
| `test/recovery.test.js` | orphaned `running` thread is recovered as `error` at startup, history intact, and can run again |
| `test/workspace.test.js` | thread workspace validation/persistence, side-effect-free `/api/workspace/check` for the free-folder picker, git status/diff, per-file revert (tracked + untracked guard), rule files, non-repo 409, subfolder workspace with root-relative paths |
| `test/search.test.js` | global search across thread titles/messages, tasks, notes, projects; limits, short queries, regex characters, normalization |
| `test/history.test.js` | pool conversation history: role order, filtering of subruns/streaming/errors, message and character caps |
| `test/promoPass.test.js` | campaign window, billing day, quota/upgrade math, model matching, claim idempotence, toggles/add/rename/dismiss/share, unknown actions and bad JSON |
| `test/uploads.test.js` | basename sanitization, MIME guessing, size/base64 rejection, CLI paths vs pool inline text, upload/download/delete, `/send` invalid and over-limit attachments, attachment-only messages |
| `test/desktop.test.js` | UI shell contract: unique element IDs, separate textareas, composer slots, in-app dialog (no native confirm/prompt), packaged handshake version |
| `test/projects.test.js` | project/environment metadata routes that the UI's overlay and rail depend on |

## Wiring

```
lib/machines.js ──(tools/build-machines.mjs)──> public/machines.js
        │                                            │
        ├── server.js, lib/runs.js, lib/keys.js,      └── public/app.js
        │   lib/agents.js, lib/pool.js                   (labels, buttons, __ahState)
        └── tests
```

The generator is not optional: `npm run check` fails when `public/machines.js`
drifts from `lib/machines.js`, which is how server and UI stay honest when the app
is served from a packaged desktop build.

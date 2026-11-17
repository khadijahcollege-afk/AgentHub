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

## Approval lifecycle (a run that stops to ask)

`run: running → running` is not a transition the run machine can express, yet a
run can sit still for minutes waiting for a person. That waiting is its own
small machine, owned by `lib/approvals.js`:

```
(created) → pending → answered | denied | cancelled | timedOut
```

It is deliberately **not** in `lib/machines.js`: it is ephemeral, never
persisted, and it belongs to the server process rather than to a thread field.
It is documented here because the invariants matter more than the shape.

| Invariant | Why |
| --- | --- |
| Every request ends | Answer, timeout (3 min permission / 10 min question), `/stop`, or process shutdown. A promise that can outlive all four is a hung run. |
| `ask` is not `deny` | `decide()` is pure and returns `decision: 'ask'`. `executeTool` decides whether a human exists; with no client (delegate, CLI, direct API) it denies with a reason instead of waiting forever. |
| `AskUserQuestion` never auto-approves | Not even in `yolo`. Without a human it would wait ten minutes and then fail with a misleading message. |
| A waiting run survives a reload | `res.on('close')` skips `ctrl.abort()` when `approvals.list(threadId)` is non-empty; the new tab re-reads the card from `GET /api/threads/:id/approvals`. Timeouts still guarantee termination. |
| Answers are bound to their thread | `requestId` is random and checked against the thread id; a wrong-thread answer is `403 WRONG_THREAD`, not a silently ignored no-op. |
| "Always" is narrow | Only `write_file`/`edit_file`/`delete_file` may be remembered, per folder, never `run_command`. |

The UI mirrors it without owning it: `runAsks` in `public/app.js` is a render
cache of the server's pending list, cleared by `setRun` on every terminal state
and re-filled by `loadAsks()` when a thread opens. A tab that inherits
`running` from the server but does not own the SSE stream calls
`adoptRemoteRun()` on the `threads` broadcast, so the chip stops spinning and
the final message appears.

## Context summary lifecycle (compact)

A thread's `compact` field is not a state machine, but it has one invariant that
matters and one cursor that must never lie. Owner: `lib/compact.js`.

```
(absent) ──POST /compact──> summary(gen 1) ──POST /compact──> summary(gen 2)
    ^                            │                                   │
    └────────DELETE /compact─────┴─────────────DELETE /compact───────┘
```

| Invariant | Why |
| --- | --- |
| The newest `KEEP_RECENT = 6` messages are never folded | The work in progress must stay verbatim. A paraphrase of the current conclusion is worse than no summary at all. |
| `throughMessageId` only advances on success | If the pool dies halfway, nothing is written; the old conversation is still whole. A cursor written optimistically would make messages vanish. |
| A cursor pointing at a missing message restarts from the beginning | Threads get trimmed and forked. Guessing "everything before this is covered" would silently skip unsummarized conversation. |
| Summaries are nested, not stacked | The previous summary is folded into the next (`generations` + 1). Ten summaries in a row would otherwise cost the same tokens as the history they replaced. |
| Folded turns are not sent alongside their summary | The summary stands in for them; sending both pays twice for the same content. |
| The summary is a user turn, not a `system` turn | Providers reject a second `system` message mid-history. It is wrapped in explicit fences so model-written text is not read as a new instruction. |
| Automatic runs are one at a time and skip active threads | Two summaries in parallel compete with the run that is still producing the conversation being summarized. |
| `DELETE` removes the summary, never a message | "Drop summary" is a window change, not history destruction. |

`GET /api/threads/:id/compact` reports `canCompact` from the same
`selectFolded()` the write path uses, so the button and the endpoint cannot
disagree. `POST` returns `409 RUN_IN_PROGRESS`, `400 NOTHING_TO_COMPACT`, or
`502 COMPACT_FAILED`; the failure path writes nothing.

## Terminal tab lifecycle (server-owned)

A terminal tab is not a state machine, but it owns two invariants that a page
reload used to break. Owner: `lib/terminal.js`.

```
(absent) ──POST /api/terminal (no tabId)──> tab 1
(absent) ──POST /api/terminal/tabs────────> tab N  (empty, idle)
tab ──POST /api/terminal {tabId}──> running ──exit──> done | error | stopped
tab ──DELETE /api/terminal/tabs/:id──> (gone)
```

| Invariant | Why |
| --- | --- |
| Tabs live in the server, not in page memory | The command keeps running while the page is closed or reloaded. A client-side list would lose `npm test` mid-run and show an empty terminal. |
| Numbers are stable and reuse the smallest free one | `folder`, `folder 2`, `folder 3`; closing `folder 2` hands number 2 to the next tab. Renumbering open tabs would make users lose track of which tab they were watching. |
| Tab 1 never shows a number | The first tab reads as "this project's terminal", not "terminal number one". |
| A tab is one session; a command is one process | Two tabs never share output. Within a tab, runs are append-only history (`MAX_RUNS_PER_TAB = 40`, transcript capped), so an earlier result is still readable. |
| One command at a time per tab | A second command in a busy tab is `409` rather than silently overwriting the transcript of the command that is still running. |
| Closing the panel ≠ closing a tab | The panel button only hides. Only `DELETE /api/terminal/tabs/:id` ends the session — that is what makes the terminal useful beside the editor. |
| Stop ≠ close | `DELETE /api/terminal/:id` stops the process and keeps the tab and its output. Closing the tab drops the session. |
| The real exit code survives the shell | `powershell.exe -Command` reports 1 for every failure. The wrapper ends with `exit $LASTEXITCODE`, falling back to `$?` for cmdlets, so CI output is readable. |
| Max 4 concurrent processes across all tabs | Same ceiling as before; tabs raise history, not parallelism. Unbounded tabs would let a reload-spamming client fork processes forever. |

The UI reads the list from `GET /api/terminal?workspace=` on every panel open, so
the panel and the server cannot disagree about which tabs exist.

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
POST /api/threads/:id/stop   # always 200, { stopped: n, released: n }, idempotent
GET  /api/threads/:id/approvals        # prompts still waiting for a human
POST /api/threads/:id/approvals/:rid   # { decision: allow|deny|answered|reject, ... }
GET  /api/permissions                  # per-folder "always allow" rules
DELETE /api/permissions                # { cwd } — forget one folder's rules
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
| `test/history.test.js` | pool conversation history: role order, filtering of subruns/streaming/errors, message and character caps, and that a summary is sent first while the turns it replaced are not |
| `test/promoPass.test.js` | campaign window, billing day, quota/upgrade math, model matching, claim idempotence, toggles/add/rename/dismiss/share, unknown actions and bad JSON |
| `test/uploads.test.js` | basename sanitization, MIME guessing, size/base64 rejection, CLI paths vs pool inline text, upload/download/delete, `/send` invalid and over-limit attachments, attachment-only messages |
| `test/desktop.test.js` | UI shell contract: unique element IDs, separate textareas, composer slots, in-app dialog (no native confirm/prompt), packaged handshake version |
| `test/projects.test.js` | project/environment metadata routes that the UI's overlay and rail depend on |
| `test/approval.test.js` | approval broker: allow/deny, timeout releases the run, abort and `cancelThread` release the registry, wrong-thread and bad-decision rejections, per-folder "always" rules limited to write tools, question answered/rejected, subagent tagging, no nested branching |
| `test/approvals-api.test.js` | the same promises over the real server: `build` stops at a write until answered, deny writes nothing, `AskUserQuestion` reaches the model as an answer, questions still asked in `yolo`, wrong-thread 403, always-rule persisted and reused, `/stop` releases a waiting prompt |
| `test/ask-question.test.js` | `AskUserQuestion` contract: 1–4 questions, 2–4 options, unique text/labels, header length, `Other` rejection, preview safety, answer normalization, and the text the model finally sees |
| `test/agent-loop.test.js` | the tool loop end-to-end against a local OpenAI-compatible provider: tool call → execute → result → answer, round limit, cancellation, tools offered per mode |
| `test/hook-wiring.test.js` | hook events actually wired into the loop: `ask` becomes `allow` only through `PermissionRequest`, denial writes nothing, a missing approval client denies instead of waiting |
| `test/subagents-api.test.js` | subagent runs through the real server: `subagent` SSE events, child tool tagging, mode never looser than the parent |
| `test/port-helper.test.js` | `pickFreePort` skips ports that are already answering (including the Windows case where a neighbour listens on `::` only, so an IPv4 bind still "succeeds") |
| `test/compact.test.js` | summary selection: nothing folded below the thresholds, the newest messages stay verbatim, an empty/short/refusal reply is rejected, a dead pool does not advance the cursor, the summary is length-capped at a sentence boundary, and the second pass folds the previous summary (`generations`) |
| `test/compact-api.test.js` | the same promises over the real server: saved to the thread, `compacted` flag only in the list, the next run really receives the summary and not the folded turns, `DELETE` restores history without deleting messages, `409` during a run, `502` writes nothing, automatic mode via settings |
| `test/terminal.test.js` | tab contract: numbering (`folder`, `folder 2`, `folder 3`), smallest-free reuse without renaming open tabs, separate transcripts per tab, empty tabs from `+`, per-workspace numbering, close stops and releases the session, second command in a busy tab is `409`, the 4-process ceiling spans tabs, invalid folders rejected, closing line and real exit code in the transcript |

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

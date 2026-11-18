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

Machine contract version: **5** (`MACHINE_VERSION`, surfaced by `GET /api/version`
and by the `version` field of `GET /api/machines`). Bump it whenever a state or
transition changes; the tests and the generated browser copy follow it.

## Inventory

| Machine | States | Owner (writes) | Persistence | Enforcement |
| --- | --- | --- | --- | --- |
| `task` | inbox → todo → running → review → done | `lib/tasks.js` | `data/tasks.json` | `POST /api/tasks/:id` → `409 ILLEGAL_TRANSITION` |
| `run` | idle → running → done/error/stopped → idle | `lib/runs.js` | thread fields `runState`, `runStartedAt`, `runEndedAt`, `runError` | `POST /api/threads/:id/send` → `409 RUN_IN_PROGRESS`; `/stop` is idempotent |
| `queueItem` | waiting ⇄ reserved → (gone) | `lib/queue.js` | `data/queue.json` | `POST …/queue/reserve` → `409 QUEUE_RESERVED`; item removed only after its run starts |
| `planMode` | outside ⇄ plan → (approved, back to the pre-plan mode) | `lib/tools.js#executeTool` (writes `planRuntime`) | none per run; the durable trace is `<cwd>/.agenthub/plans/plan-<id>.md` | `ExitPlanMode` denies with `NOT_IN_PLAN_MODE` outside plan; approval requires a human, even in `yolo` |
| `backgroundTask` | running → done/error/stopped | `lib/bg-runner.js` | thread fields in `data/background-tasks.json`, output in `<cwd>/.agenthub/tasks/<id>.log` | `start` refuses past the active limits; terminal states are sinks (no re-run, one id = one process) |
| `install` | checking → eligible → downloading → verifying → ready → installing, ⇄ blocked | `server.js` (`startDownload`, `/api/update/install`) | `updateDl`/`updateVerify` in memory; the installer file in `dist/` | verification `mismatch` and preflight `error` refuse the install (`409 CHECKSUM_MISMATCH` / `409 PREFLIGHT_FAILED`) |
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

## Git branch checkout (read-only graph, refusing checkout)

Owner: `lib/gitgraph.js`. Two operations, deliberately asymmetric: reading history
and moving HEAD. Only the second writes anything, and it never forces.

```
GET  …/git/graph     → { repo, commits[], edges[], rails[], lanes, truncated }
GET  …/git/branches  → { repo, branches[], current }
POST …/git/checkout  → 200 { ok, branch } | 400 BRANCH_{REQUIRED,INVALID,UNKNOWN}
                     | 409 WORKTREE_DIRTY | 409 CHECKOUT_FAILED
```

| Invariant | Why |
| --- | --- |
| The graph never mutates anything | It answers "where did this code come from". A graph that can rewrite history is a graph you stop trusting. |
| Layout is a pure function, computed on the server | Lane geometry is the part that is easy to get subtly wrong and hard to see wrong on screen. Pure means it is testable without a repo, and the client never invents coordinates. |
| A parent that already owns a rail is reused, never given a second one | Otherwise every merge adds a permanent lane and the graph widens with no content. |
| Parents outside the loaded page are dashed, not dropped | A hidden parent makes a commit look like a repository root. |
| Lanes are computed per page, not spliced across pages | Splicing needs parent context that is not in the new page; a wrong connecting line is worse than a graph that restarts its rails. |
| `checkout` never forces and never stashes | Forcing or stashing discards work the user did not agree to lose. git's own refusal is the correct answer, surfaced verbatim. |
| Only `checkout` writes; there is no commit/push/reset route at all | A UI bug, or a hostile page, cannot rewrite history if the endpoint does not exist. |
| Checkout broadcasts `workspace` + `threads` | Every other client is looking at the same folder; a branch switch changes files on disk. |

The UI adds no state of its own: the branch chip renders `workspaceInfo.branch`, the
popover re-reads `/git/branches` on open, and the graph modal re-reads page 0 on
open. Closing the modal or reloading loses nothing.

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

## Input queue lifecycle (the message that used to be lost)

A second send to a busy thread used to be a `409`, which is right for an API caller
and wrong for a person: the text they just typed vanished. Owner: `lib/queue.js`.

```
(empty) ──POST …/queue──────────> waiting
waiting ──POST …/queue/reserve──> reserved   (RESERVE_TTL_MS = 20000, then back to waiting)
reserved ──run starts───────────> (gone)     (commit removes the item)
reserved ──start fails──────────> waiting    (release, contents intact)
waiting ──DELETE …/queue/:id────> (gone)
```

| Invariant | Why |
| --- | --- |
| Queued items live in the server (`queue.json`) | The typed message survives a reload and reads the same from every tab. A tab-local queue means closing the tab loses work already written. |
| Strict FIFO; only the head may be reserved | A queue that can be skipped is a list. Order is the promise the user made to themselves. |
| `reserve → start → commit`, never remove first | If the start fails (validation, hook refusal, `runs.begin` rejected) the item returns to its exact position with all its content. Removing first loses a message that never ran. |
| One winner per item | Two tabs reserving the same head must not run it twice. `reserve` reads and writes in one synchronous block. |
| Every reservation expires | A tab that dies mid-reserve must not freeze the queue forever. |
| Drain runs from `runs.onIdle`, not from each caller | `finish()` is reached on done, error, stopped, and post-crash recovery. Adding the drain at four call sites means one missed site hangs the queue silently. |
| A run waiting for a human blocks the drain | `approvals.list(threadId).length` is checked before reserving: pushing the next item on top of an unanswered question is how a queue turns into a pile. |
| `409 RUN_IN_PROGRESS` becomes "queued", not an error | A tab that did not start the run (reloaded page, another device) has no local running state. The server is the authority, so the client enqueues on that code instead of reporting failure. |
| `clientCommandId` claims before the run starts (`lib/inputs.js`) | A retry after a dropped connection answers from the ledger (`duplicate: true`) instead of calling the model twice. The claim is dropped with `forget()` when the run never started, so a corrected resend still works. |

## Thread payload budget (small screens only)

`GET /api/threads/:id` takes optional `?messageLimit=` and `?byteBudget=`. Without
them the response is byte-for-byte what it always was — the desktop payload does
not change, and nothing is trimmed by default.

| Invariant | Why |
| --- | --- |
| Trimming happens only on the response | `lib/snapshot.js` clones messages before shortening them; the stored thread is never rewritten, so there is no such thing as a permanently truncated preview. |
| User and subrun messages are never trimmed | The user's own typing must be readable without asking, and subrun content is already bounded when written. |
| Trim starts from the largest assistant message | The cost is one giant reply, not "a large thread". Shrinking it first fixes the stall with the fewest edits. |
| Preview floor is `MIN_PREVIEW_CHARS = 2000` | A preview cut to a few characters hides the message instead of summarising it. |
| `refId` is the ORIGINAL index | `GET …/message-body?refId=` must never return the wrong message, even after `messageLimit` already dropped earlier ones. |
| A trimmed response says so | `truncatedMessages`, `bodyRefs`, and `byteBudgetApplied` are what make the UI able to offer "show full message" and "load N earlier messages" instead of silently showing less. |

## Plan mode lifecycle (the agent that stops to plan)

Mode `plan` existed before this stage, but only as something the *user* picked
from the access chip. The agent could not decide a task needed planning, and
"approval" meant nothing because there was no document to approve. Owner:
`lib/plan.js` (pure rules, plan file) plus the plan branch of
`lib/tools.js#executeTool`.

```
outside ──EnterPlanMode──> plan(active) ──ExitPlanMode──> askPlan ──approve──> previous mode
   ^                            ^                              │
   └────────ExitPlanMode denied (NOT_IN_PLAN_MODE)─────────────┴──reject───> plan(active)
```

Two tools, deliberately asymmetric: `EnterPlanMode` only *removes* capability
(no writes, no commands), so asking would be a click for nothing.
`ExitPlanMode` restores write access, so it always asks — including in `yolo`.

| Invariant | Why |
| --- | --- |
| `EnterPlanMode` never prompts | It reduces what the agent can do. Prompting for a reduction teaches users to click through the prompts that matter. |
| `ExitPlanMode` always asks, even in `yolo` | Approving a plan is the only thing that re-opens writing for the rest of the run. A mode with no prompts is exactly where an unattended agent would otherwise promote itself. |
| `ExitPlanMode` outside plan is `deny` + `NOT_IN_PLAN_MODE` | Not a schema error: the call is well-formed but illegal. A silent `allow` would leave the model believing it had approval it never received. |
| An empty plan is a schema error | Whitespace is not a plan. Accepting it means "approve anything I do next", which is the exact thing the card exists to prevent. |
| `MAX_PLAN_CHARS = 20000` | A plan longer than this is a document nobody reads before clicking approve. Matches ZCode. |
| The pre-plan mode is remembered | Leaving plan from `yolo` returns to `yolo`, not to `build`. Falling back to the default would silently tighten every later run. |
| The plan file is written **before** the mode changes | If the write fails the run stays in plan mode. Otherwise a run would be allowed to write files while its plan — the agreed record — does not exist. |
| `allowedPrompts` are display-only | One lax category ("install dependencies") would cover any command. Real permissions stay one card per call. |
| `askPlan` is not inherited by subagents | Approving a plan raises the write permission for the rest of the run. A child must not be able to raise its own ceiling through a card meant for the parent; a child calling `ExitPlanMode` takes the no-client path and stays in plan. |
| Plan decisions are `approve`/`reject`, not `allow`/`deny` | Approving a plan is not approving one tool call. Sharing the vocabulary would let an old `allow` payload quietly approve a plan. |
| `reject` keeps the run in plan mode | "No" must not behave like "yes" for the gate. The model gets a reason and is told to ask what should change. |
| The plan file is re-injected after compact | A folded summary can drop the message that carried the plan. Without the reminder the model re-plans from scratch — or, worse, diverges from what was agreed. |
| The tool list is rebuilt when the mode changes | `ExitPlanMode` must make write tools *reappear*. A model that only sees read tools concludes the work is impossible. |
| Plan transitions run before the normal permission gate | The card must show the plan text, not "Permission needed: ExitPlanMode". A prompt that cannot be evaluated is worse than no prompt. |
| The effective mode lives in one shared object | `planRuntime.mode` is what the next tool reads. Passing the run's starting mode to every call would deny the write that was just approved. |

Approved plans go to `<cwd>/.agenthub/plans/plan-<sanitized threadId>.md`
(atomic `.tmp` + rename), deliberately outside the tracked tree so a plan can
never be committed by accident. `STATE-MACHINES` treats this as a lifecycle, not
a machine: it is per-run, never persisted as a thread field, and the only durable
trace is the plan file.

## Background command lifecycle (the task that outlives the run)

A run answers one prompt and then ends. `npm install`, a dev server, or a full
test suite do not fit that shape: they take minutes or never finish, and forcing
them into `run_command` means either a timeout that kills real work or a run that
hangs. Owner: `lib/background.js` (pure rules — limits, wording, when a task is
finished) plus `lib/bg-runner.js` (processes, output files, the persisted
registry). The split is what makes the rules testable without spawning anything.

```
        ┌──────────── done        (exit 0)
running ├──────────── error       (non-zero exit, spawn failure, or recovered after restart)
        └──────────── stopped     (user, thread delete, lifetime cap, or shutdown)
```

Terminal states are sinks. There is deliberately no `idle`: a finished task stays
around as data, and "run it again" means a **new task with a new id**, never a
reopened one.

Three tools, one shape: `start_background_command`, `check_background_command`,
`stop_background_command`. There is no fourth "wait" tool — waiting is a parameter
of `start`, because a separate wait tool is exactly what a model would use to sit
still longer than it needs to.

| Invariant | Why |
| --- | --- |
| Output goes to a **file**, never memory | `npm install` prints tens of thousands of lines. Holding them in memory until the task ends spends the server's memory for one command, and the output must survive the run ending, the tab closing, and a restart. |
| What the model reads is the **tail**, with `truncated` reported | Errors and summaries live at the end. Returning the head would show progress bars and hide the failure. Reporting `truncated` stops the model from believing it read everything. |
| A task is **not a run** | The run may finish while the command keeps living. Tying task lifetime to run lifetime would kill exactly the commands the feature exists for. |
| One id = one process; restart = new id | Reusing an id after stop would let an old transcript be read as the new command's output. A new id keeps every record honest. |
| `MAX_ACTIVE_PER_THREAD = 3`, `MAX_ACTIVE_TOTAL = 8` | Every active task is a real process. The per-thread cap stops one conversation from starving the rest; the total cap protects the machine. Both numbers are reported to the UI so the panel never promises more than the server allows. |
| `MAX_LIFETIME_MS` = 1 hour | A command that never ends still has to end. Without a cap, `npm run dev` left behind holds its port forever. |
| `RETENTION_MS` = 24 hours, `MAX_TASKS_PER_THREAD` = 20 | Records are cheap but not free, and the log files sit in the user's repo. Pruning keeps the newest, and a running task is **never** pruned — dropping the record of a live process makes it impossible to stop. |
| The registry is written at birth and at stop, not per output chunk | The output already lives in its own file. Rewriting JSON on every printed line makes the disk busier than the command. |
| A task recorded `running` is recovered as `error`, with the file kept | After a restart there is no process to wait for. Leaving it `running` makes the agent wait forever. The log file is the only trace of where the command stopped, so it is never deleted. |
| `waitMs` missing/empty → default, negative → 0 | A garbled value from the model must not extend a run; "wait zero" must still be expressible. |
| `start_` is `exec`, `check_` is `read`, `stop_` is `bgctl` | Starting runs a command, so it is gated exactly like `run_command` (`ask` in build/edit, dangerous-check in guarded, denied in plan). Reading output is reading a file. Stopping only *revokes* capability, so it is allowed everywhere — including plan mode, where a task started earlier must still be stoppable. |
| Subagents inherit `threadId` | A task started by a child belongs to the parent conversation: that is where it will be read, and where its id must be stoppable. Recording it under the child's own id would lose it when the child ends. |
| Deleting a thread prunes its records but does not kill its processes | Deleting a conversation is not an instruction to kill work. Killing a live process only because its thread was removed would be a surprise nobody asked for. |

Output lives at `<cwd>/.agenthub/tasks/<id>.log`, inside the user's workspace but
outside the tracked tree (same reasoning as plan files). The UI panel
(`#bg-panel`) reads the same routes the model uses, so what the agent sees and
what the user sees cannot diverge.

## Install lifecycle (the file that has to prove itself)

A download finishing is not evidence that the file is the one the release
published. Every release has carried `SHA256SUMS.txt` and nothing read it, so a
truncated download or an HTML captive-portal page could be saved as
`AgentHub-Setup.exe` and offered with an "Install now" button. Owner: `lib/install.js`
(pure rules — checksums, interception, preflight, retry, lifecycle decisions) plus
`server.js` (`downloadAndVerify`, `/api/update/install`). The split is what lets the
rules be tested without downloading 100 MB or touching a real machine.

```
checking ──→ eligible ──→ downloading ──→ verifying ──→ ready ──→ installing
    │            │             │              │           │
    └────────────┴─────────────┴──→ blocked ←─┘           └──→ ready (spawn failed)
                                       └──→ checking | downloading | eligible
```

`ready` is deliberately not terminal: the user may cancel before installing, and
`installing` returns to `ready` when the installer cannot be spawned — a state the
UI cannot leave is a dead end.

| Invariant | Why |
| --- | --- |
| `unverified` is never rendered as verified | When a release has no `SHA256SUMS.txt`, the pane shows a warning badge, never a green check. A checkmark for a file nobody compared teaches the user to trust the checkmark, which is worse than having no checkmark at all. |
| `mismatch` refuses the install but **keeps the file** | `POST /api/update/install` answers `409 CHECKSUM_MISMATCH` and both hashes are printed. Deleting the file would destroy the only evidence available for a bug report. |
| Interception is diagnosed **before** the checksum | An HTML page will never match any hash, so "checksum mismatch" would send the user hunting a corrupt release when the real cause is an office proxy or a Wi-Fi login page. `text/html`, `application/json`, a short body, and a `.exe` without `MZ` are each named. |
| A non-network failure is **not retried** | Re-fetching the same bytes from the same proxy costs time and quota and returns the same bad file. `retry` is given a `shouldRetry` that rejects `CHECKSUM_MISMATCH` and `NOT_INSTALLER`. |
| Unknown free space is `warn`, not `error` | `statfs` is unavailable on some platforms. Blocking an install because the disk size could not be read would refuse a machine that is perfectly fine. |
| Preflight gates the API, not just the button | `/api/update/install` can be called by an agent or `curl`, with no UI. Checking only in the client would make the rule optional. |
| Retry uses jitter | Without it, every AgentHub instance alive at that moment hits the same host in the same millisecond after an outage. |
| `installing` may fall back to `ready` | If the spawn throws, leaving the state at `installing` shows a spinner forever with no way to retry. |
| Diagnostics redact, never omit | Tokens and keys become `[disembunyikan]`. Omitting the field would hide whether a key is even configured; printing it would leak it. |

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
| `test/approvals-api.test.js` | the same promises over the real server: `build` stops at a write until answered, deny writes nothing, `AskUserQuestion` reaches the model as an answer, questions still asked in `yolo`, wrong-thread 403, always-rule persisted and reused, `/stop` releases a waiting prompt, and plan mode end-to-end (`kind: 'plan'` carrying the plan text, approve writing plan file + planned file in the same run, `mode` events reporting `plan` then the restored mode, `lastMode` persisted, reject writing nothing, `allow`/`deny` refused with `BAD_DECISION`) |
| `test/ask-question.test.js` | `AskUserQuestion` contract: 1–4 questions, 2–4 options, unique text/labels, header length, `Other` rejection, preview safety, answer normalization, and the text the model finally sees |
| `test/agent-loop.test.js` | the tool loop end-to-end against a local OpenAI-compatible provider: tool call → execute → result → answer, round limit, cancellation, tools offered per mode, a plan approved mid-run (`mode` event emitted, write tool allowed for the rest of that run, plan file on disk) with the reject path still denied, and `SessionStart` hook context surviving the second turn (the system prompt is rebuilt when the mode changes) |
| `test/hook-wiring.test.js` | hook events actually wired into the loop: `ask` becomes `allow` only through `PermissionRequest`, denial writes nothing, a missing approval client denies instead of waiting |
| `test/subagents-api.test.js` | subagent runs through the real server: `subagent` SSE events, child tool tagging, mode never looser than the parent |
| `test/port-helper.test.js` | `pickFreePort` skips ports that are already answering (including the Windows case where a neighbour listens on `::` only, so an IPv4 bind still "succeeds") |
| `test/compact.test.js` | summary selection: nothing folded below the thresholds, the newest messages stay verbatim, an empty/short/refusal reply is rejected, a dead pool does not advance the cursor, the summary is length-capped at a sentence boundary, and the second pass folds the previous summary (`generations`) |
| `test/compact-api.test.js` | the same promises over the real server: saved to the thread, `compacted` flag only in the list, the next run really receives the summary and not the folded turns, `DELETE` restores history without deleting messages, `409` during a run, `502` writes nothing, automatic mode via settings |
| `test/terminal.test.js` | tab contract: numbering (`folder`, `folder 2`, `folder 3`), smallest-free reuse without renaming open tabs, separate transcripts per tab, empty tabs from `+`, per-workspace numbering, close stops and releases the session, second command in a busy tab is `409`, the 4-process ceiling spans tabs, invalid folders rejected, closing line and real exit code in the transcript |
| `test/gitgraph.test.js` | pure layout without a repo: straight line, input not mutated, parallel branches, a shared parent getting exactly one rail, out-of-page parents dashed, root has no downward edge, lane width bounded by commit count, empty/non-array input, rails continuing across rows, every edge pointing downwards, one edge per parent |
| `test/gitgraph-repo.test.js` | against real git: plain folder vs empty repo, ref decoration cleaned, merge commit with two parents ordered below them, paging without repeats, `maxCount` clamp, branch list marking the current branch, successful checkout, invalid/unknown names rejected before git runs, and a dirty worktree refused with the user's edits intact |
| `test/gitgraph-api.test.js` | route contract: response shape with server-computed lanes, `repo:false` for a plain folder, `400 WORKSPACE_MISSING`, `maxCount` clamped, branches, checkout reflected in the workspace summary, `400 BRANCH_UNKNOWN`, `409 WORKTREE_DIRTY` leaving files untouched, and a `workspace` SSE broadcast on checkout |
| `test/queue.test.js` | pure queue contract: strict FIFO, one winner per `reserve`, `release` restoring position and attachments intact, `commit` rejecting an unknown reservation, expired reservations swept on read, a running item not removable, `MAX_QUEUE_PER_THREAD`, empty-prompt refused while attachment-only is allowed, and a repeated `clientCommandId` not creating a second item |
| `test/inputs.test.js` | idempotency ledger: command-id shape enforced, first claim empty and second returning the record, `settle` completing status and `userMessageId`, `forget` releasing a claim so a corrected resend works, per-thread separation, TTL expiry, and the entry cap keeping the newest records |
| `test/snapshot.test.js` | payload budget: no parameters returns the same object untouched, `messageLimit` trims from the front and reports the count, the largest assistant message is trimmed first, user and subrun messages never trimmed, the caller's data not mutated, `bodyFor` returning full content with a matching hash and rejecting unknown or path-like `refId`, budget clamping, and the 2000-character preview floor |
| `test/queue-api.test.js` | the same promises over the real server: a send during a run lands in the queue instead of `409`, the queued item really executes after the previous run ends (including from the `stopped` path), two items run in FIFO order, `reserve` refused with `RUN_IN_PROGRESS`, delete and clear, unknown attachments refused before queueing, and a repeated `clientCommandId` not stacking items |
| `test/send-replay.test.js` | `/send` idempotency and the snapshot routes over HTTP: the same `clientCommandId` answering `duplicate: true` without a second user message or a second model call, the same id in another thread treated as new, a malformed id ignored rather than rejected, a large thread requested small and its full body fetched back with a matching hash, and `messageLimit` reporting `truncatedMessages` |
| `test/plan.test.js` | plan mode contract: `sanitizeName` cannot escape the plan folder, empty/oversize plans rejected, `EnterPlanMode` never asks while `ExitPlanMode` always does (and is `NOT_IN_PLAN_MODE` outside plan), the pre-plan mode is remembered, the plan file is atomic and its header names thread and folder, the reminder only appears when a file exists, approval writes the file and *then* allows `write_file` in the same run, rejection keeps plan mode and still denies writes, no client is `NO_CLIENT` rather than a hang, and the tool list swaps between plan and out-of-plan |
| `test/background.test.js` | pure background rules: tool names, `sanitizeTaskId` unable to escape the folder, output path inside `.agenthub/tasks`, empty/oversize commands refused, `waitMs` odd values falling back to the default while negatives become 0, label trimming, tail selection reporting `truncated`, the two active limits, exit code → status mapping, the notices the model reads, and pruning (expired, per-thread cap, running never dropped) |
| `test/bg-runner.test.js` | the same promises against **real processes**: output really lands in the file with a real byte count, non-zero exit becomes `error`, a large output read as a tail, `stop` killing the process and being idempotent, `stopThread` scoped to one thread, active counts split per thread, recovery turning a `running` record into `error` with its log kept, and prune never touching a live task |
| `test/background-api.test.js` | routes over a real server: list needs `thread`, a task from the *previous* process still listed as `error` with `recovered: true` and its output readable, `output=1` required for the body, another thread seeing nothing, unknown ids 404 on read and delete, and stopping an already-finished task answering `already: true` instead of failing |
| `test/install.test.js` | verified install: `SHA256SUMS.txt` parsing (binary `*` marker, malformed lines skipped), streamed hashing, the three verification states with `unverified` never reporting `ok`, proxy interception for HTML/JSON/short body/non-`MZ`, preflight levels including unknown disk as `warn`, `retry` honouring `shouldRetry` so permanent errors are not repeated, `firstSuccess` recording every source and notifying the fallback, `installDecision` per download status, `uninstallPlan` per platform, redaction keeping the key but not the value, and over a real server: a matching checksum reaching `ready` with `decision.action === 'install'`, a wrong checksum reaching `mismatch` with the install refused, an HTML body refused as "not an installer", preflight and uninstall-plan readable by the UI, and diagnostics never containing the access token |
| `test/update.test.js` | release check and download progress against a local fixture server: the fixture is a real `MZ`-prefixed file, because the MZ check rejects anything that is not a Windows executable |

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

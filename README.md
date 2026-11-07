# delta-pi

A [Pi](https://pi.dev) extension that connects a Pi coding-agent session to a
[Delta](https://delta.dev) thread: Pi records its conversation into Delta, shares
its checkout, and receives teammates' activity back.

It is a producer plugin, built the way Delta's
[Build a Coding Agent Plugin](https://delta.dev/docs/cli/build-a-plugin) guide
describes, with [delta-claude](https://github.com/zed-industries/delta-claude) as
the reference implementation. Every Delta operation goes through the `delta` CLI;
the plugin never touches Delta's database.

## What it does

- **Records the session.** User messages, agent messages, thinking, tool calls and
  their results, turn state, and the session name become a Delta transcript. Each
  Pi run is one Delta turn, so the thread never shows a turn per model response.
- **Shares the files.** The checkout Pi runs in is attached as a Delta worktree and
  kept syncing while Pi runs (`worktree mount --existing-checkout`).
- **Brings activity back.** Teammates' messages and comments arrive in Pi as
  messages, without starting a turn on their own.
- **Stops when someone takes over.** If a teammate takes the turn, Delta reports
  the supersession and Pi's run is aborted.

The producer identity is `--source pi` plus Pi's own session id as
`--external-id`, so re-running with the same session resumes the same thread and
sequence numbers instead of creating a second one.

## Install

Requires Delta (with the `delta` CLI signed in) and Pi.

```sh
pi install git:github.com/ajmwagar/delta-pi   # from the repository
pi install npm:delta-pi                       # from npm, once published
pi install /path/to/delta-pi                  # from a local checkout
```

Or load it for a single run without installing anything:

```sh
pi -e /path/to/delta-pi/delta.ts
```

If you keep extensions as local files, copy `delta.ts` into `~/.pi/agent/extensions/`
and add `"delta.ts"` to the `extensions` array in `~/.pi/agent/settings.json`.

## Use

```
/delta share          # create this session's thread, or widen it to your organization
/delta join <link>    # work in a thread someone shared with you
/delta status         # thread, audience, pending records, mount state
/delta sync           # send anything still queued
/delta unshare        # make the thread private again; invited people keep access
/delta link           # the link that opens this thread on another computer
/delta auto on|off    # whether activity from Delta starts a Pi turn or waits for a prompt
/delta leave          # stop recording, release the mounts
```

Activity from Delta reaches Pi as a message. By default it does not start a turn: the footer counts what is waiting (`2 from Delta waiting`), and your next prompt answers it. `/delta auto on` makes a delivered message start a turn instead, arriving as a follow-up so it never interrupts a running tool call.

On another computer, open that link: it pulls the thread into that machine's
local store, where the Delta app lists it. Delta keeps no account-wide thread
index — signing in elsewhere does not fill the sidebar — so the link (or `delta
thread show <link>`, or `/delta join <link>` in Pi) is how a thread moves between
your own machines. `/delta link` prints it again at any time.

`/delta share` asks who should be able to open the thread (just you, or your
organization) before anything is uploaded, and prints the link when it is done.
Audience is not one-way: `/delta share` on a private thread widens it, and
`/delta unshare` narrows it back. Moves between devices continue either way, and
people already invited keep their access.

## How recording works

Records are appended with `delta --json thread append` as schema-1 JSONL: one
`schemaVersion`/`sequence` envelope per ACP update. They are written to
`~/.pi/agent/state/delta/sessions/<session>.json` **before** they are sent and
stay there until Delta acknowledges them, so a failed or interrupted send is
retried with the same bytes. Receipts are `recorded`, `duplicate`, or `fenced`;
a fenced record belongs to a turn someone else took over, and stops Pi's run.

Turn shape, per Delta's contract: a run opens with a `running` state update whose
`turnSequence` is its own sequence, its messages carry that same `turnSequence`,
and it closes with an `idle` update. History (the session so far, recorded when
you share) carries no turn.

Sharing returns as soon as the thread exists and is watching, so Pi's input is
never held while the backfill uploads. The backfill itself is capped at roughly
100k tokens: the newest messages are sent, and one notice in the transcript names
the ones left out and the command that reads them back.

## Known limits

- Messages are recorded when complete; streaming partial updates are not sent.
- An edit or write is recorded as a unified patch, so Delta draws it as a diff.
  Every other tool keeps its text output, clipped at 8k characters with a
  marker naming what was left out, so one huge command cannot stall recording.
- Remote activity is delivered from the moment the watch goes live. The snapshot
  before it is history and is not replayed into Pi's context.
- Delivered activity starts no turn unless `/delta auto on`; nothing reaches Pi
  while the session is closed.
- Subagents are not recorded as child threads yet.
- `/delta join` mounts the thread's files and reports the directory, but Pi gives
  extensions no way to change the working directory of a running session, so the
  join does not move you into the checkout. Start a session there with
  `cd <directory> && pi`.
- Delta's `integration register` currently only knows `claude-code`, so the CLI
  cannot advertise this plugin to Delta clients yet.

## Fleet sync

A Delta thread list is per computer. The thread id is local to the machine that
recorded it, and only the share id (`thread_…`) resolves anywhere, so moving a
thread between your own machines means opening its link there. `scripts/fleet.sh`
closes that loop over ssh:

```sh
./scripts/fleet.sh                    # which active threads each machine has
./scripts/fleet.sh --apply            # pull what each machine is missing
./scripts/fleet.sh --apply --limit 3  # bound the pulls per machine
./scripts/fleet.sh --hosts studio,neo # ignore the configured list
```

Hosts come from `--hosts` or from `~/.pi/agent/delta-fleet`, one name per line:

```
averys-mac-studio
averys-macbook-neo
```

Pulls are deliberate, not automatic: a machine that clones every thread pays
disk for conversations it never opens, and archived threads are skipped unless
you pass `--include-archived`. Counts in the report are active threads, with the
archived total beside them.

This is a stopgap. Delta has no account-wide thread index — `thread sync` only
takes local ids, and signing in elsewhere does not populate the sidebar list — so
discovery has to happen somewhere, and today that is your own host list.

## Development

```sh
bun test                      # record translation, outbox, receipts, watch parsing
bun run scripts/smoke.ts      # real thread: share, record a turn, read it back, delete it
bun run scripts/watch-smoke.ts # `thread watch` output parses as expected
bun run scripts/delivery-smoke.ts # activity from Delta reaches Pi, with and without auto-turn
```

The smoke scripts create a private thread for a throwaway Git repository and
delete it at the end.

`npm pack --dry-run` shows exactly what a published package contains: `delta.ts`,
this README, the license, and `package.json` (whose `pi.extensions` field is what
Pi reads). Publishing a release is `npm login && npm publish` — the version is
permanent once published, so bump `version` first.

## Known limits

- **Thread tags don't sync.** Tags are a desktop-sidebar adornment keyed to a
  local thread entry: there is no tag table, column, or row in the replicated
  graph (`app_threads` columns are name, archived, join_id, status, pinned
  position, last prompted… — no tag), and the CLI doesn't expose them either.
  `fleet.sh` cannot move them. Either Delta syncs them natively (product
  change) or we keep our own sidecar mapping `thread_… → tag set` under
  `delta-fleet`; deferred until there's time.
- **Same problem for the thread list itself.** Signing in on a second
  machine does not populate its desktop list; `fleet.sh` is the interim.
- **Settings sync is already correct.** The `boot` block (appearance, fonts,
  layout, proxy) is byte-identical on Studio and Neo; only the device-bound
  `secure` keychain blob differs, which is by design.

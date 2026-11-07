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
/delta leave          # stop recording, release the mounts
```

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
- Subagents are not recorded as child threads yet.
- `/delta join` mounts the thread's files and reports the directory, but Pi gives
  extensions no way to change the working directory of a running session, so the
  join does not move you into the checkout. Start a session there with
  `cd <directory> && pi`.
- Delta's `integration register` currently only knows `claude-code`, so the CLI
  cannot advertise this plugin to Delta clients yet.

## Development

```sh
bun test                      # record translation, outbox, receipts, watch parsing
bun run scripts/smoke.ts      # real thread: share, record a turn, read it back, delete it
bun run scripts/watch-smoke.ts # `thread watch` output parses as expected
```

The smoke scripts create a private thread for a throwaway Git repository and
delete it at the end.

`npm pack --dry-run` shows exactly what a published package contains: `delta.ts`,
this README, the license, and `package.json` (whose `pi.extensions` field is what
Pi reads). Publishing a release is `npm login && npm publish` — the version is
permanent once published, so bump `version` first.

# interop-tests

How the experiments in [PLAN.md](PLAN.md) are run and recorded. Read PLAN.md first, and the root
[AGENTS.md](../AGENTS.md) for the conventions all code here follows.

## Layout

| | |
| --- | --- |
| `compose.<peer>.yaml` | Overlay on the root `compose.yaml`: the peer's services, a `capture` sidecar in the peer's network namespace, and `node` given `depends_on` the peer |
| `<peer>.test.ts` | `node:test` file driving our library against the peer, in the style of `test/`. Reads `PEER_HOST`/`PEER_PORT` from env, defaulting to the compose service name and 2775 |
| `peers/<peer>/` | Dockerfile and config for a peer without a published image, or one that needs config files |
| `captures/` | pcapng and tshark JSON from a run. Gitignored |
| `findings/<NN>-<peer>.md` | What a phase found. Committed after every phase |
| `run.py` | Brings a peer up, runs its tests, stops the capture, tears down, analyses the capture |

## Running

```bash
./interop-tests/run.py <peer>            # one peer, all its tests
./interop-tests/run.py <peer> --keep     # leave the peer up for a manual look
```

`run.py` is the one spelling; it wraps

```bash
docker compose -f compose.yaml -f interop-tests/compose.<peer>.yaml run --rm --use-aliases node node --test interop-tests/<peer>.test.ts
docker compose -f compose.yaml -f interop-tests/compose.<peer>.yaml stop capture
docker compose -f compose.yaml -f interop-tests/compose.<peer>.yaml down -v
```

and then decodes `captures/<peer>.pcapng` with tshark (`-d tcp.port==<port>,smpp -Y smpp -T json`),
printing the command histogram and the counts of `_ws.malformed` and error-severity `_ws.expert`.
Both counts must be zero for a phase to pass.

## Rules for an experiment

1. Peers run in Docker with full patch-version pins. Nothing is installed on the host. Node runs
   only through the `node` service. Every peer service caps its logs (`logging: json-file`,
   `max-size`/`max-file`) and healthchecks something the peer does not log a stack trace for —
   SMPPSim once filled the whole host disk in twenty minutes from a TCP-probe healthcheck.
2. `src/` and `test/` are read-only during an experiment. A defect is recorded with a reproducer,
   never fixed here — a fix is a separate change with a regression test in `test/`.
3. No git command that changes state: no add, commit, push, checkout, stash, reset. The
   orchestrator commits after each phase.
4. A peer that will not come up is time-boxed: after about an hour of trying, record `blocked` with
   everything tried, and stop.
5. `down -v` at the end of every run. Locally built images are kept, and their tag goes in the
   findings.
   `run.py` runs in the foreground with a long timeout; an agent that backgrounds it is never woken
   when it ends.
6. Scratch files live outside the repo, in the directory the orchestrator names.
7. A finding says what happened, what the spec or the peer's docs say, and how to reproduce it.
   Wording is neutral: a mismatch is a mismatch until a reader decides whose it is.

## Findings file

```markdown
# <NN> <peer>

Date, images and tags, the commit of this repo, host Docker version.

## Setup
Commands that worked, and what did not, so the next run starts where this one ended.

## Scenarios
| Id (from PLAN.md) | Result (pass / fail / blocked / not run) | Evidence (test name, log line, tshark frame) |

## Defects in @larvit/smpp
One subsection each: what happened, what the spec or the peer's docs say, reproducer (PDU hex or
test), severity.

## Peer quirks
Behaviour of the peer worth knowing that is not our defect.

## Open questions
```

Then set the phase's row in PLAN.md's Status table to `done` or `blocked`, linking the file.

## Fixing what a phase found

Every defect a phase records is fixed before the next phase runs — a fix can change behaviour in
ways the next experiment must see. One fix per defect class, as its own change:

1. A worktree on a branch off `origin/typescript` (never `origin/master`, the 0.4.0 code), named
   for the defect.
2. Regression tests in `test/` first, naming the behaviour with the reproducer from the findings;
   then the implementation; then the decision record in the root `AGENTS.md` where the fix settles
   a question of the wire or the session's life.
3. `/larv-review` on the branch, with the pull request based on `typescript`. When it marks the PR
   ready, squash-merge it.
4. Back in the experiments worktree: fast-forward `typescript`, rerun the experiment that found the
   defect, delete the workaround its test carried, and note the fix in the findings file.

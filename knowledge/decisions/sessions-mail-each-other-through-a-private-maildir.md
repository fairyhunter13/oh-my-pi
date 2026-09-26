---
type: Decision
resource: packages/coding-agent/src/mailbox/index.ts
title: Two omp sessions mail each other through a private maildir, and a mail is never a user prompt
description: hub is per-process and collab is a human room, so two top-level sessions on one machine talk through ~/.omp/agent/mailbox, which the fork's built-in mailbox extension reads as agent-attributed custom messages that start at most one turn and never steer.
tags: [omp, extensions, messaging, security, trust, cost]
status: stable
generated: { by: claude/opus-5-5, at: 2026-09-23T12:00:00Z }
sources:
  - resource: internal/policy/omp_mailbox.go
  - resource: internal/policy/omp_mailbox_test.go
  - resource: internal/install/omp.go
  - resource: internal/install/omp_test.go
  - resource: knowledge/decisions/an-agent-never-forges-a-human-stamp.md
---

# Why a maildir

Two omp sessions in two terminals had no channel. hub resolves peers through
`AgentRegistry.global()`, which is one process. collab is a room for a human. The interim fix typed
into a tmux pane after an `inotifywait`, and a typed line is a user prompt: the receiver could not
tell the other agent from Hafiz. `ccw-mailbox.js` replaces it.

Each top-level session owns `~/.omp/agent/mailbox/<session id>/`, with `tmp/`, `new/`,
`delivered/` and `rejected/`, all mode 0700, plus a 0600 `.presence.json`. A sender stages a 0600
file in the recipient's `tmp/` and renames it into `new/`. A reader acts on `new/` only, so a
partial file is never read. The session id is the key, so `/new`, `/resume`, `/fork` and a branch
move the presence to the new id, and shutdown removes the presence and keeps the mail.

A subagent opens no mailbox, and `mail_send` and `/mail` refuse in one. The test is the same
`session_init` entry `ccw-agent-profile` reads. A one-shot run (`print`, `json`) opens none either,
because nobody is there to answer. `CCW_MAILBOX=off` registers nothing.

# What a reader accepts

The checks run in this order, and a file that fails one moves to `rejected/` with a notice:

1. The mailbox and `new/` are this uid's and 0700. If not, nothing is read, and nothing moves.
2. `lstat` shows a regular file, and not a symlink.
3. The file is this uid's, mode 0600, and 64 KB at most.
4. The bytes come from one `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` fd, whose inode must match the
   `lstat`. The path is never looked up a second time.
5. A `---` header carries `from`, `to`, `id`, `in-reply-to`, an integer `hop` and `sentAt`.
   `to` is this session's full id, and every id is a plain token that cannot name `..`.

A duplicate id, one already in this session's `ccw-mailbox` audit entries, moves to `delivered/`
and is not delivered again.

# Delivery, and what a mail costs

A mail arrives through `pi.sendMessage` as `customType: "ccw-mail"` with `attribution: "agent"`.
`pi.sendUserMessage` is never called, because it writes `role: "user"`. One option set,
`{ triggerTurn: true, deliverAs: "followUp" }`, is right in both states. While a turn runs it
queues as a follow-up, which waits until no tool call is left. At idle it starts one turn. A steer
was refused, because a steer skips the rest of a running tool batch. The file moves to `delivered/`
only after the send and the audit entry, so a crash before the move leaves it in `new/`, and the
next scan files it without a second delivery.

Every delivery starts a turn on the receiver's model, so two bounds hold. A reply carries
`in-reply-to` and the parent's hop plus one, and hop 4 is refused at the sender and at the reader.
More than 10 mails from one sender in 60 minutes stay in `new/`, with no turn and one notice per
sender per hour, until the window allows them.

`fs.watch` on `new/` does the work. A rescan at session start picks up mail that arrived while the
session was down, and a rescan every 30 seconds covers an event the watcher missed.

The body carries the mail's id, `[mail from <id> <cwd>, id <mail id>]`, because the model sees the
content and not `details`, and it needs the id to pass as `inReplyTo`.

# What the checks do not stop

A process that runs as Hafiz can still write a file whose `from` names another session. The
checks stop another user, a symlink trick and a partial file. They do not stop a hostile process
under the same uid, and nothing short of signing would. The line that holds regardless is the
label: a mail is marked as coming from an agent and is never `role: "user"`. That keeps the rule
in [an agent never forges a human stamp](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/an-agent-never-forges-a-human-stamp.md). A human's word
stays the one input an agent cannot manufacture.

A pid that dies and is reused makes a stale presence look live. The cost is one mail to a dead
mailbox, which waits in `new/` and is read if that session resumes.

# The mailbox is built into the fork (2026-09-26)

`ccw-mailbox.js` and its Go harness are deleted. The same code is
`packages/coding-agent/src/mailbox/index.ts` in the fork, bound in `sdk.ts` beside the
agent-profile extension, and `test/mailbox-extension.test.ts` ports every harness case. Every
constant, directory name, refusal and header string is unchanged, so stored sessions and older
peers read the same mail. The root is `join(getAgentDir(), "mailbox")`, so `PI_CODING_AGENT_DIR`
isolates a sandbox. `ccw install` prunes a stale `extensions/ccw-mailbox.js`. The concept's
`resource` moved to the fork file, because the old Go file is gone.

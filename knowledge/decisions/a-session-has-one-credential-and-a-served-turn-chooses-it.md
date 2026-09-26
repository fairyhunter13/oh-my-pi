---
type: Decision
resource: packages/ai/test/ccw-credentials.test.ts
title: A session has one credential, a served turn chooses it, and every OAuth row is kept fresh
description: With several subscriptions or API keys per provider, a session uses exactly one. The strict pin wins, then the default, then the sole row. With none of those, the row that serves the first successful turn is adopted as the session's pin, so a 429 or 401 never moves the session to another account. Every stored OAuth row of every provider is refreshed near expiry by one sweep, which runs from a systemd timer, in each interactive session, and on demand.
tags: [omp, credentials, oauth, refresh, subagents, fork]
status: stable
generated: { by: claude/opus-5, at: 2026-09-23T18:00:00Z }
sources:
  - resource: omp-src/selftest.ts
  - resource: config/claude/omp-credential-refresh.sh
  - resource: config/claude/omp-credential-refresh.timer
  - resource: knowledge/decisions/every-credential-surface-reads-one-catalog.md
---

# Decision

On 2026-09-23 the user asked for one active credential per session. They also asked that
every refreshable credential stay ready, bound subagents included, and that a login name its
credential. Their direction was to widen omp's own single-credential machinery rather than
build a second one. The user chose three behaviors:

- A session picks once and records the pick. There is no rotation between accounts.
- A systemd timer, a sweep in every interactive session and a manual command all refresh.
- A login asks a name prefilled with an automatic one, then asks the scope.

**Where the choice is made.** The first build recorded the pick inside
`AuthStorage.getApiKey`. The full `packages/ai` suite then failed 35 upstream tests: account
rotation, Codex and Claude ranking, Fable fallback, and "an explicit env var outranks a stored
api key". Every caller of the auth store had changed, not only sessions. The pick moved to the
session layer. After an assistant message that is not an error,
`AgentSession` calls `authStorage.adoptSessionCredential(provider, sessionId)`. That call pins
the row the session's sticky names. The auth store keeps its upstream semantics, and the
upstream suite stays green. A failed turn adopts nothing, because a live test showed that the
first build adopted a rate-limited key.

**The sole row.** A provider with one usable row marks that row active before any request.
The rule feeds `listCredentials` marks and the OAuth identity only. Key precedence is
unchanged, so an exported env var still outranks a stored key.

**One exception: a model that only other accounts serve.** Upstream `73a11421f`, after
v18.2.11, passes `accountIds` from `model.accountAccess` for a Codex model that only some
accounts may use (Daybreak). On `ccw-next` the strict pin filtered rows before those passes,
so a pinned session kept an account that cannot serve the model, and upstream's own test failed.
The user chose on 2026-09-23 to let eligibility move the request. `#pinAdmitted` in
`auth/select.ts` then serves such a request from the eligible accounts, and the pin itself
stays. A pinned row that is eligible, or no eligible row at all, keeps the pin.

Plain eligibility would have moved bound subagents too. The `/agent-profile` child guard reads
the `active` mark, which follows the pin and not the row that served, so it would not have
caught the move. So a pin can be exclusive: `pinSessionCredential(provider, sessionId, id,
{ exclusive: true })`, stored as `{"credentialId":N,"exclusive":true}` and kept by `inherit`.
The extension pins every bound child that way, and nothing moves an exclusive pin. A user's
`/session pin`, a login choice and the first-turn adoption stay plain. The flag exists on
`ccw` (v18.2.11) too, where nothing reads it yet, so the extension and the commit subjects are
the same on both branches. Tests: upstream's Codex test passes unchanged on `ccw-next`, a new
test fails when `#pinAdmitted` ignores the flag, the Go harness fails when the extension drops
it, and a selftest check covers `inherit` on both branches.

**Refresh.** Upstream already had a sweep that works for every provider:
`AuthBrokerRefresher`, used only by `auth-broker serve`. Its body became
`AuthStorage.refreshCredentials({ provider, force, skewMs })`. That method reloads the store
first. Without the reload, a CLI saw no rows. It refreshes each row through
`refreshCredentialById`, so single-flight, the SQLite lease and the compare-and-set disable
apply. A row whose provider has no refresh function, such as an MCP grant, is skipped and never
disabled. Three callers use it:

- `omp-credential-refresh.timer` runs every 15 minutes with a 1-hour window, in cgroup novpn.
- Each interactive omp runs `startCredentialRefreshSweep` on the same window.
- `omp auth-broker refresh [--force]` and the Credentials tab refresh on demand.

The CLI exits 2 when a row failed definitively and needs a new login. Only that exit code
alerts. Anthropic rotates the refresh token on every use, so the timer does not force: forcing
every 15 minutes would spend rotations for nothing.

**A re-login keeps the row.** During this work the real store lost row 1 (the work account),
and a new row 5 held the same account. The logs show the order. A refresh of row 1 failed with
`invalid_grant`, so omp disabled it, and the re-login inserted row 5 because the upsert matched
only active rows. Then `#purgeSupersededDisabledRows` hard-deleted row 1, because an active row
now held its identity. 18 session pins still named #1, so each such session, and each subagent
that inherited it, failed with "the row no longer exists". Now `#reviveSupersededRow` revives
the newest disabled row that the purge would delete, whatever disabled it. The row keeps its id,
label and default. The first fix revived only a `deleted by user` row, so it missed this exact
case. The selftest check covers both causes and fails on the tree without the fix. Which process
spent the refresh token first is not confirmed. The broker writes no log.

The real store was repaired on 2026-09-23 after a full `.backup`
(`~/.omp/backups/agent.db.bak-20260923T183426Z`). The 18 pins on #1 moved to #5, the same
account. The 3 pins on #2, the gmail account the user removed on purpose, were deleted. A
running omp caches a pin after its first read, so only a new or resumed process sees the repair.

# Where the checks run (2026-09-26)

The selftest checks this concept names are fork tests now, in
`packages/ai/test/ccw-credentials.test.ts`, under the same titles. The selftest runs that file
against every tree it applies.

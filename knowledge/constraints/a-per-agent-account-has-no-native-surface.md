---
type: Constraint
resource: packages/coding-agent/src/agent-profile/index.ts
title: A per-agent account has no native surface in omp, so every path to one is an extension
description: task.agentModelOverrides selects a provider and a model and never a credential, a child inherits the parent's affinity, and the only built-in that names a credential is the security scan. So binding an account to an agent has to be written, not configured.
tags: [authentication, oauth, omp, subagents, extensions, quota, enforcement]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-09-23T06:40:00Z }
sources:
  - resource: internal/policy/omp.go
  - resource: knowledge/decisions/a-subagent-pins-its-own-account-from-inside-the-child.md
  - resource: knowledge/decisions/a-subagent-model-resolves-in-four-tiers.md
  - resource: internal/policy/omp_test.go
---

# The three places a reader expects to find it, and what is actually there

**`task.agentModelOverrides`.** The value is a model pattern. `parseModelPatternWithContext`
reads a provider, a model id, an optional `:level` suffix and an optional `@upstream` routing
target. There is no credential field and no place to put one, because the value must stay a string:
`normalizeModelPatternList` calls `value.split(",")` on it.

**The `/agents` hub.** It writes that same setting, plus `task.agentPrewalk`, `task.agentAdvisor`
and `task.disabledAgents`. Four keys, no account among them. `/agent-profile` now binds all four
beside the model, which leaves the account as the one axis with no setting at all.

**`/session pin`.** This is the closest native mechanism, and it is one account for the whole
session. A child inherits the parent's affinity through `inheritSessionCredentials`
(`sdk.ts:1478-1481`, seeded at `structured-subagent.ts:417-418`), so pinning in the parent moves
every agent together.

# The one built-in that does name a credential

`createExactSecurityOAuthResolver` (`security/auth.ts:137-158`) resolves one exact credential id
for the security scan, reachable only from `/security … --credential <id>`. It is a single-purpose
resolver for one command, not a general seam, and nothing routes a subagent through it.

# What follows

Splitting quota per agent is an extension or it is nothing. `ccw-agent-profile.js` pins
`(provider, childSessionId) -> credentialId` from inside the child, because the session id a pin is
keyed by is private to that child. The reasoning is in
[a subagent pins its own account](../decisions/a-subagent-pins-its-own-account-from-inside-the-child.md).

The corollary that keeps costing time: because the account axis is not a setting, no `omp` command
prints it. `/agent-profile status` exists for that reason alone — it names the applied profile, the
credential bound to each agent, and the pins the session actually wrote.

# omp 18.2.11 added a spawn hook, and it is still not a credential surface

`before_subagent_spawn` (`task/structured-subagent.ts:364-392`) lets an extension replace a
child's model patterns or refuse the spawn. Its result is `model`, `note`, `block` and `reason`
(`extensibility/extensions/types.ts:1151-1160`): there is no credential field. So the account is
still pinned from inside the child, and the hook's part is to refuse a spawn whose selector
matches no account or two, before the child exists.

The strict half needed one more fact, because a pin is an affinity. At the provider-request hook
the credential is already chosen: `agent-loop.ts:1816` resolves the key before the stream, and
`auth-storage.ts:5966` records it as the session's sticky account, which `listOAuthAccounts`
reports as `active` (`:6257-6276`). So the child can compare the account omp chose with the one
it pinned, and refuse the request. That comparison is a read of a list the auth store already
exposes, not a new surface, and it is the only way a child learns which account served it before
the spend.

# 2026-09-26: the extension is built into the fork

Upstream omp still has no per-agent credential surface, so everything above holds for a stock
omp. On the machine that runs the fork, the `/agent-profile` mechanism moved from the generated
`ccw-agent-profile.js` into the fork's `packages/coding-agent/src/agent-profile`, bound in every
session, a task child included. ccw generates only the data, `agent-profiles.builtin.yml`. The
pin is still written from inside the child, for the same reason: the session id it is keyed by is
private to that child.

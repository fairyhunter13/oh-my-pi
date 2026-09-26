---
type: Constraint
resource: packages/coding-agent/src/config/model-resolver.ts
title: A mis-mapped subagent falls back to the parent's model at two sites, and the second logs nothing
description: model-resolver.ts fires when the provider has a credential row but no usable key, and logs one warn. sdk.ts fires when the provider has no row at all, and logs nothing, emits no event and writes no entry. Both share one cause, so one pre-flight catches both.
tags: [subagents, models, omp, failure-modes, extensions, cost]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-09-23T01:10:00Z }
sources:
  - resource: internal/policy/omp.go
  - resource: internal/policy/omp_test.go
  - resource: knowledge/decisions/a-subagent-pins-its-own-account-from-inside-the-child.md
  - resource: knowledge/constraints/an-unset-env-var-in-models-yml-ships-its-own-name.md
---

# Two sites, not one

The earlier reading of this runtime recorded one silent fallback. There are two, and they are
reached by different conditions.

**Site A — `resolveModelOverrideWithAuthFallback`** (`config/model-resolver.ts:1610-1652`). The
provider HAS a credential row, but `getApiKey` yields nothing usable. The subagent runs on the
parent's model. One `logger.warn` is emitted from `task/executor.ts:3548-3554`, and the
retry-fallback chain is suppressed for that run (`executor.ts:262`).

**Site B — `createAgentSession`** (`sdk.ts:2618-2637`). The provider has NO credential at all, so
the mapped model is absent from `modelRegistry.getAvailable()` — availability is gated on
`authStorage.hasAuth(provider)` (`model-registry.ts:2504-2516`). The executor resolves no model,
`resolutionModels` widens to `getAll()` (`sdk.ts:2523-2527`), and the parent's model is swapped in.
**Nothing is logged.** No hook fires, no event is emitted, no session entry records it.

Site B is the common case for a profile that names a provider the machine never logged into, which
is exactly the shape a fleet default takes when it travels to a machine with fewer subscriptions.

# The one artefact either leaves

`SessionInitEntry` carries `agent`, `modelRole` and `resolvedModel`
(`session/session-entries.ts:232-263`), and `resolvedModel` is the POST-fallback value. So the
child's own session file records what actually ran — but nothing compares it to what was asked for,
and the parent never reads a child's session file.

`retry_fallback_applied` (`session/agent-session.ts:4415-4419`) is a different thing: runtime
recovery after a request failed, not selection-time reroute.

# One cause, so one check

Both sites reduce to the same predicate: the mapped model is not in `getAvailable()`.
`ctx.models.resolve()` runs `resolveModelRoleValue` over exactly that set
(`extensibility/extensions/model-api.ts:19-38`), so a pattern that resolves in the parent is one
the executor can resolve too.

`/agent-profile` therefore checks in two places:

- **Pre-flight, in the parent, at `apply()`.** Every mapped pattern goes through
  `ctx.models.resolve()`. A pattern that resolves to nothing, or resolves to a different
  *provider*, is named in an error notice before any child spawns. A different *id* is not
  reported, because a fuzzy pattern legitimately resolves to another id.
- **Post-mortem, in the child, at `before_agent_start`.** `ctx.model` is the model the request
  will use. When it differs from the profile's, the child appends a `ccw-agent-model-mismatch`
  entry, and the `ccw-agent-account` entry carries the model it actually ran. That is the only
  record that survives site B.

`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount` pins the pre-flight: a profile
naming `nosuch/nosuch-model` must be reported by name. Removing the check reds it.

# What stays undetectable

An `apiKey` in `models.yml` naming an **unset** environment variable. `resolveConfigValue` returns
the variable NAME (`config/resolve-config-value.ts:99-107`), and that non-empty string reads as
authenticated all the way down, so the model is in `getAvailable()`, resolves cleanly, and fails
only at the provider with a 401. See
[an unset env var ships its own name](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/constraints/an-unset-env-var-in-models-yml-ships-its-own-name.md). The
only check is the request itself:

```sh
omp -p --model <provider>/<id> "Reply with exactly: OK"
```

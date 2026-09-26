---
type: Decision
resource: packages/coding-agent/src/agent-profile/index.ts
title: A subagent pins its own account, because every sibling shares the parent's session id
description: An account is keyed by (provider, sessionId) alone, so a parent-side pin races across concurrent siblings and the child pins itself from session_init. A thinking level needs none of that, because a model pattern already carries a :level suffix the parent resolves before the child exists.
tags: [authentication, oauth, omp, quota, subagents, extensions, thinking, enforcement, defaults]
status: stable
generated: { by: claude/opus-5, at: 2026-09-23T06:40:00Z }
sources:
  - resource: internal/policy/omp.go
  - resource: internal/policy/omp_test.go
  - resource: knowledge/runbooks/hold-two-claude-subscriptions-in-omp.md
  - resource: knowledge/decisions/an-account-picker-is-provider-generic-but-its-deadlines-are-not.md
  - resource: internal/install/omp.go
  - resource: internal/install/omp_test.go
---

See [the rule set](credentials-subagents-and-mappings-follow-one-rule-set.md) for every rule this
decision's addenda established, in one place.

# The gap a model map leaves open

`/agent-profile` mapped an agent to a `provider/model` string. A provider is not an account. One
anthropic provider holds two subscriptions here, so the map named which *model* a reviewer runs and
left both reviewers drawing on whichever pool omp balanced onto. Splitting quota per agent needs the
account as a second axis.

# Why the parent cannot do the pinning

An account choice is keyed by `(provider, sessionId)` and nothing else
(`pi-ai/src/auth-storage.ts:1363`). Every subagent runs under its own provider session id
(`pi-coding-agent/src/sdk.ts:1478`), and `buildSubagentSessionOptions` never sets one, so siblings
never collide.

The parent has exactly one session id, and `task.maxConcurrency` is 32. A handler that flipped the
parent's pin per spawn would be 32 writers on one map entry, and the last write would decide what
every sibling used. So the pin is written from inside the child, where the session id is private.

# The three constraints that shaped the mechanism

**The model setting must stay string-valued.** `task.agentModelOverrides` is a record of
`string | string[]`, and each value reaches `normalizeModelPatternList`, which calls
`value.split(",")`. An object there throws a `TypeError` and fails the spawn. So the account rides
beside that setting and never inside it.

**Module scope is the only channel.** A subagent session re-binds an extension module's factory to
its own `ExtensionAPI` without re-evaluating the module graph (`sdk.ts:2190-2214`). A module-level
`Map` is therefore one object in the parent and in every child; factory-level state is not. Nothing
on the spawn wire could carry it instead: `ExecutorOptions` holds `getApiKey` and
`credentialSourceSessionId`, both per-parent scalars, and the `task` tool input has no account
field.

**The child has to recognize itself.** `ExtensionContext` carries no agent name. A subagent session
holds a `session_init` entry whose `agent` is the agent name, appended before the first prompt
(`task/executor.ts:3946-3950`), and a main session holds none. That entry is the discriminator, and
a miss is never cached, because an early call can legitimately run before the append.

The pin lands on `before_agent_start`, with `before_provider_request` as the guard. Those two are
the only awaited hooks that run before a child's first request. The guard must return `undefined`,
because a returned value replaces the request payload.

That discriminator carries a second load. A subagent receives `session_start` as well
(`task/executor.ts:4036`, after the `session_init` append at `:3946`), which the first reading of
the runtime had wrong. So `OMP_AGENT_PROFILE` is read behind the same agent-name test. Without it, a
child would re-apply the environment's profile over whatever the operator chose mid-session, for
every sibling at once, and it would call `ctx.ui` on a session that runs `hasUI: false`. Removing
that one test turns the process-wide model map from three agents into one, which is what
`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount` measures by naming a rival profile
in the environment.

# What a failed selector does

Nothing. An agent whose selector matches no account, or matches two, is reported and left unbound,
and it inherits the parent's pin (`sdk.ts:1479-1481`). Silently serving "some account" would defeat
the reason the mapping exists. The resolver runs in the parent, where a `ui` exists, and prints the
`credentialId` it chose beside the email, so a drift in the row ids is visible at apply time rather
than at spend time.

That was the first version. Under the strict model below, an unbound selector no longer falls
back to the parent's pin: the spawn hook refuses the spawn on omp 18.2.11 and later, and on
every version the child's request guard refuses the first request, both with the reason
worded as the fix.

# The same affinity, not a lock

`pinSessionOAuthAccount` is an affinity: usage-limit handling still routes around an unavailable
account. A 5-hour limit on one subscription falls over to the other instead of stopping the agent.
See [the account picker](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/an-account-picker-is-provider-generic-but-its-deadlines-are-not.md) for the
provider-generic half of that, and
[the runbook](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/runbooks/hold-two-claude-subscriptions-in-omp.md) for the commands.

Superseded on 2026-09-23 for a bound agent. The operator chose "run on exactly what the
profile names, or do not run" over "fall over to the other subscription". The affinity is
unchanged in omp, so the child's request guard compares the account omp chose with the pinned
one and refuses the request when they differ. A bound agent now stops at its account's 5-hour
limit. An agent the profile names no account for is still balanced by omp.

# Startup applies silently, because a conversation message at startup ends a print session

`OMP_AGENT_PROFILE` is applied from `session_start`, and it applies without the report the
`/agent-profile` command prints. The report goes through `pi.sendMessage`, which injects into the
**conversation** rather than the UI. `omp -p` has already started processing the prompt by the time
`session_start` runs, so that call rejects with `AgentBusyError`, nothing awaits the promise, and the
session dies before the first token. `ctx.ui.setStatus` and `ctx.ui.notify` are UI and stay safe,
which is why the status chip still reports the profile and the pin count.

A measurement, not a theory: `omp -p "Reply with exactly: PONG"` answered `PONG` with the variable
unset and exited 1 with `AgentBusyError` with it set, on the same binary.

# The observable is credential_pin, not the sticky row

A sticky cache row records what a session asked for. A `credential_pin` entry in the session file
records the credential that **served** the request, so it is what proves a split happened. One
measured batch: two children, one `task` call, `credentialId 1` for the reviewer carrying the
parent's credential hash, and `credentialId 2` for the scout carrying a different one. A control run
with no profile produced no audit entry and the parent's hash.

There is a trap beside it. A child writes **two** sticky rows. Core's own inheritance writes one
keyed by the subagent's label a few milliseconds before the child runs, and it carries the parent's
account. The pin here writes the other, keyed by the child's session id. Reading the label-keyed row
as the verdict reports every child on the parent's account and is wrong.

# The third axis needed no mechanism at all

A thinking level is mapped per agent by the same setting, because a value in
`task.agentModelOverrides` is a model **pattern** and a pattern accepts a trailing `:level`.
`parseModelPatternWithContext` reads it (`config/model-resolver.ts:881-907`) and
`task/executor.ts:3733` places the result on the child session at creation. So the profile writes
`anthropic/claude-opus-5:xhigh`, the value stays a string, and no second setting, no spawn option
and no child-side call exists.

That is the opposite of the account axis, and the asymmetry is the point. A level is resolved by
the parent **before** the child session exists. An account is keyed by a session id only the child
knows, so it has to be pinned from inside. One feature, two mechanisms, each forced by where the
identifier lives.

The accepted levels are the six efforts (`pi-catalog/src/effort.ts:2-9`) plus `off` and `auto`.
`inherit` is absent on purpose, because omitting the key already means inherit. A misspelled level
does **not** fail the spawn: `model-resolver.ts:936-940` warns, drops the suffix and runs the agent
at its own default. So the profile validates the level itself, and that complaint is the only place
a reader learns of a typo.

Measured in one batch: `sonic` at `:off` wrote 0 thinking blocks on account #2, `reviewer` at
`:xhigh` wrote 2 on account #1, and each child's `session_init.resolvedModel` carried its own
suffix.

# Two defects the first version shipped with

**A typo unbound every account.** `apply()` cleared the binding table before it looked the profile
name up, then returned on the unknown name. The mix was left half-dismantled — every account
unbound, the previous model override still live, the status chip still naming the old profile — and
the only signal was a spelling complaint. The lookup runs first now, and nothing is mutated until it
succeeds.

**A child never recovered from a credential wipe.** `#resetProviderAssignments` deletes the
provider's whole pin map and the persisted sticky cache prefix
(`pi-ai/src/auth-storage.ts:2454-2462`), and `/login`, a credential removal and a credential disable
all reach it. The first version pinned once per session behind a latch, so a long-running child
finished on the balancer's account with nothing said. The pin is re-asserted on `turn_start` now,
the same boundary the retired `/account` used, and the latch became a record of the last id written so the audit
entry stays one line.

# Three silent failures the mechanism then had to close

**An exported `OMP_ACCOUNT` fought the profile, every turn.** `ccw-account` and
`ccw-agent-profile` were separate generated modules that wrote to the same pin store. A subagent
receives `session_start`, so `ccw-account` would take its own hold in the child and re-assert it
from `turn_start`, overwriting the per-agent pin with the parent's account and saying nothing.
`ccw-account` then carried the same `session_init` test the profile extension uses and returned
before the hold and before its 15-minute timer. One account for the parent, one account per agent
for the children. Since 2026-09-23 `ccw-account` and `OMP_ACCOUNT` are deleted, so this failure
has no source left. `ccw install` prunes an installed `ccw-account.js`.

**A `/new` or a `/resume` lost the mix.** The applied profile now lands as a
`ccw-agent-profile-state` custom entry on every `apply()` that came from a command or the
environment, and `session_start`, `session_switch`, `session_branch` and `session_tree` — the four
events `autoresearch` treats as one session change — re-read it from `getBranch()` and re-apply.
A branch therefore inherits the profile its parent held at the fork point. Precedence is decided:
the entry beats `OMP_AGENT_PROFILE`, because the entry is the operator's last explicit choice on
this branch and the variable is a machine default. A session with neither changes nothing, so
`/new` inside a live process keeps what is applied.

**A cold-revived child pinned nothing at all.** `task/persisted-revive.ts:148-211` passes no
`credentialSourceSessionId`, so a revived child inherits no affinity, and in a fresh process the
module-scope binding table is empty because no parent applied a profile in it. The child's own
`ccw-agent-account` entries are the only surviving record, so `pinAccount` falls back to the newest
one matching its agent and provider, and `session_start` calls `pinAccount` in a child instead of
returning.

Each of the three was a mutation test in
`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount`. Removing the guard redded with
`ccw-account wrote … inside a subagent`; removing the rehydrate reds on the override map; removing
the revive fallback reds with `a revived child wrote 0 pins`. All three were run against a mutated
tree and confirmed red before the tree was restored. The first case left with `ccw-account`: its
replacement is `TestTheRetiredAccountExtensionIsPruned` in `internal/install/omp_test.go`.

# The configuration surface, and why it is not /agents

omp's own `/agents` hub edits the same setting and persists it to `config.yml`. Until 2026-09-25
`ccw install --apply` replaced that file wholesale, so those edits died at the next install.
`/agent-profile` gained two verbs then: `status` names what `/agents` holds, and `import` lifts
it into `~/.omp/agent/ccw-agent-profiles.yml`. Since 2026-09-25 ccw only seeds `config.yml`, and a
persisted `/agents` entry wins over the profile for that agent. See
[the agents hub writes into a generated file](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/constraints/the-agents-hub-writes-into-a-generated-file.md).

`new` and `edit` walk one picker per agent — model from `ctx.models.list()`, which is the same set
`--model` offers, then account only when the provider has more than one row, then thinking level —
and show the exact lines in `ctx.ui.editor` before they land. Two details are load-bearing:

- The roster comes from `pi.getAllTools()`, parsing `^### (\S+)` out of the `task` tool's
  description, which is rendered from `src/prompts/tools/task.md:90-94`. So a project, user or
  plugin agent is offered, not only the five bundled ones. An `m<N>` heading is a tagged model
  rather than an agent and is dropped. When the parse yields nothing the wizard falls back to the
  names already in use and warns about nothing, because a false "unknown agent" is worse than no
  check.
- The wizard writes an **email** as the account selector where that email is unique among the
  provider's rows, and `#<credentialId>` where it is not. Anthropic and `openai-codex` are keyed
  `email|org` (`sqlite-credential-store.ts:169-197`), so one email holding two subscriptions is two
  rows and only the id tells them apart. An email survives a re-login that mints a new id; an id
  survives a duplicate email. Neither survives both, so the choice is made per row.

The profiles file keeps its comments. `Bun.YAML.stringify` emits flow style and carries no
comments, so a read-modify-write would delete the header and every note beside a profile on the
first wizard run. The writer splices one named block between line boundaries and copies the old
bytes to `<file>.bak-<YYYYmmdd-HHMMSS>` first, with a numeric suffix when two writes land inside
one second.

**Superseded on 2026-09-24 (addendum 3, Part L).** `new` and `edit` open one table instead of
walking every agent in sequence: every known agent (built-in, fleet, user, repo) is a row with
its live credential, provider, model and level beside it, plus `Save` and `Cancel`. Picking a
row still walks credential, then model, then thinking level, exactly as the paragraph above
describes, but the whole table is one screen and nothing is written before `Save`. The first
question picks a target: a profile, or (when the session sits in a repo) that repo's own local
file, which is how a repo agent gets an account without leaving the table screen. Every row goes
through `normalizeEntry` (shape), then `enforceOneBinding` (the one-binding rule) at `Save`, so a
refused row never reaches disk.
The roster rule and the email-vs-`#id` selector rule above are unchanged.

The same addendum fixed two bugs in `BOUND`, the module-scope pin table `/agent-profile status`
and the spawn hook both write through. `BOUND.set` used to spread the agent's OLD row into the
new one (`{...BOUND.get(agent), [provider]: id}`), so an agent moved from one provider to another
kept the dead provider's key too. `dropDeadBindings` then read that stale key on the next
`credential_disabled` or `credential_removed` and warned about an agent that no longer used the
dying credential. The fix writes the whole row (`{[provider]: id}`, or `{...binding.credentials}`
in the spawn hook), so a rebind clears the old provider outright. `status` also gained a table at
the top -- one line per bound row, then which agents share each credential, then the rows left on
the pool -- so the whole mapping reads at a glance instead of one agent at a time. Proven by the
G1/G2/G4 scenarios in `TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount`: rebinding
`scout` from an anthropic subscription to a deepseek key and then disabling the anthropic row
produces no notice at all, and removing a credential drops only the agents actually bound to it.

# Strict enforcement: a bound agent runs on its binding or not at all

A binding is the applied profile's entry for one agent: model, thinking level, and the stored
credential where one is named. Before 2026-09-23 it also held the API-key alias where the model
named one. It is enforced in two places, and only for a subagent. The parent's own model,
account and settings are never touched.

**At spawn, on omp 18.2.11 and later.** `before_subagent_spawn` fires in the spawning session
before the child's model resolves (`task/structured-subagent.ts:364-392`, called at `:658`
after the preflight). The event carries `agent`, `invocationKind`, `modelRole`, `patterns` and
`spawnKey` (`extensibility/extensions/types.ts:752-763`). A handler returns `model`, `note`,
`block` and `reason` (`:1151-1160`). The runner stops at the first `block` and keeps the last
`model` (`extensions/runner.ts:1816-1846`). A block becomes a preflight error with the reason
(`structured-subagent.ts:385-386`), and a model replaces the patterns (`:388-391`). The hook
returns the bound pattern with a note such as `profile split: anthropic/claude-opus-5:xhigh as
b@example.com #2`. It blocks when the model is not in `ctx.models.list()`, when `account:` does
not match exactly one usable row of `authStorage.listCredentials`, and when the running omp has
no `listCredentials` at all: `omp lacks ccw's commits: run ccw omp-src apply`. It also refreshes the
binding table from the selector, so a re-login that minted a new credential id is followed.

**At every request, on every version.** A handler cannot refuse by throwing: the runner catches
the throw, reports it, and sends the original payload (`extensions/runner.ts:1315-1361`,
`:1728`). Measured: a probe that threw got `PONG` back with an "Extension error" line. So the
guard returns a payload whose every read throws. The provider reads it inside its own `try`
before it serializes the body (`pi-ai anthropic.ts:2243-2258` into the catch at
`:3297-3313`, `openai-completions.ts:842-869`), so nothing is sent and the message becomes the
turn's error. The payload answers `undefined` for `then`. Without that, the runner's own
`await` trips it and falls back to the original payload, which the first probe run showed.

The guard compares the request's model (`ctx.model` is the request's, `runner.ts:1708-1709`)
with the bound model, the session level (`pi.getThinkingLevel()`) with the bound level after
the catalog clamp, and the session's active account with the pinned credential. The account is
already chosen when the payload hook runs: `agent-loop.ts:1816` resolves the key before the
stream, and `auth-storage.ts:5966` records it as the sticky account. The patched
`listCredentials(provider, sessionId)` marks that row `active`, which is what the guard reads. Before
the patch it was `listOAuthAccounts` (`:6257-6276`), which knew OAuth rows only. The refusal text
avoids every word omp's retry classifier reads as transient or as an auth failure
(`pi-ai/src/error/flags.ts:155-297`), so the turn ends
rather than being replayed on another model.

Measured end to end on 18.2.11, with a probe that moved a `sonic` child's level to `high`: the
child failed in 311 ms with zero input tokens billed, and the parent received `ccw-agent-profile
refused a request from sonic: expected thinking off on anthropic/claude-haiku-4-5, got high`.
A probe block on `scout` reached the parent as `Task execution failed: <reason>`.

The child fixes its binding the first time it needs it and appends it as a `ccw-agent-binding`
entry. A profile switched mid-run therefore does not re-judge a child spawned under the old
one, and a child revived in a fresh process is judged against that entry. Each refusal also
lands as a `ccw-agent-refused` entry.

On 18.2.10 the spawn event does not exist, and `pi.on` takes any name
(`extensions/loader.ts:210-214` in both versions), so the handler never runs there. The
settings override still sets the model, and the request guard still refuses.

`task.enableEffort` is pinned `false` in `config.yml`. A task `effort` argument beats a bound
level at spawn (`task/executor.ts:3601-3619`), and the spawn event does not carry it, so the
only defence would be a refusal. With effort off the conflict cannot arise, and the refusal
text names the setting when a level differs.

# The default profile, and the knobs beside the model

`tiered` applies to every session with no state entry and no `OMP_AGENT_PROFILE`. Precedence is
state entry, then the variable, then the built-in. The default is never written as a state
entry, so a resumed session follows the current default, and `/agent-profile off` records "off"
and wins on its branch. `tiered` names no account. Haiku scouts and does mechanical work, Sonnet
writes and plans, and Opus 5.5 at `xhigh` judges: `reviewer` and `security-reviewer` were the only
Opus rows, and prewalk and advisor are off by name. Hafiz moved the judges back to Opus on
2026-09-23, because no later gate re-checks a review, so a miss is silent. Writing and planning
stay on Sonnet, because a judge catches their mistakes. An account is enforced only where a
profile names one, so one subscription or several both work.

Hafiz's rule, restated on 2026-09-23: security, review, and anything critical or related to a
critical task run Opus at `xhigh`. The main session runs Opus 5.5 at `medium`. A normal task
prefers Sonnet. Any non-critical agent on Opus runs `medium`. The judges only review, so a
critical **implementation** task had no Opus `xhigh` writer: `task` is Sonnet at `medium`. So ccw
generated a ninth fleet agent, `critical-task`, as the `xhigh` writer, from 2026-09-23 to
2026-09-25:

| agent | `tiered` | `opus` | `frugal` |
|---|---|---|---|
| scout, web-researcher | Haiku `low` | Opus `medium` | Haiku `low` |
| sonic, test-runner | Haiku `off` | Opus `medium` | Haiku `off` |
| task | Sonnet `medium` | Opus `medium` | Haiku `medium` |
| planner | Sonnet `high` | Opus `medium` | Sonnet `medium` |
| reviewer, security-reviewer | Opus `xhigh` | Opus `xhigh` | Sonnet `high` |
| critical-task | Opus `medium` | Opus `medium` | Sonnet `high` |

Revised later on 2026-09-23: `medium` is the ceiling for a writer. `critical-task` stayed the one
writer on Opus, at `medium`. `xhigh` is for the two judges only (review, bugs, security and
vulnerabilities), because a missed defect reads as green. Fixing a bug was writing, so it went to
`task` or `critical-task`.

`critical-task` took every tool `task` takes: its file had no `tools` key, which omp reads as all
tools, as it does for the bundled `task` (`task/agents.ts:48-62`, `discovery/helpers.ts:327-329`),
and `spawns: "*"`. Its description named the work that belonged to it: security, auth and
credentials, secrets, payments and ledgers, data migrations and deletions, concurrency and
production configuration.

**Removed on 2026-09-25.** `planner`, `critical-task`, `test-runner` and `web-researcher` are
gone, and `OMPAgentFiles` with them: ccw generates no agent files anymore. Every built-in now
binds omp's own five bundled agents instead:

| agent | `tiered` | `opus` | `frugal` |
|---|---|---|---|
| scout | Haiku `low` | Opus `medium` | Haiku `low` |
| sonic | Haiku `off` | Opus `medium` | Haiku `off` |
| task | Sonnet `medium` | Opus `medium` | Haiku `medium` |
| reviewer, security-reviewer | Opus `xhigh` | Opus `xhigh` | Sonnet `high` |

The reasoning above still holds for the agents left: `task` is the one writer, capped at `medium`
because a missed defect in a judge is silent where a missed defect in a writer is not, and
`reviewer` and `security-reviewer` stay the two `xhigh` judges. See
[ccw changes no subagent behavior but the mapping](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/ccw-changes-no-subagent-behavior-but-the-mapping.md).
Every built-in binds every one of the five, because an applied profile still refuses an agent it
leaves out. A hand profile that extends `tiered` inherits the row. `opus` used to name bare
models, so under it every agent ran its own frontmatter level. It now names the levels in the
table.

A profile entry also takes `prewalk`, `advisor` and `serviceTier`, and a profile takes
`disabled: [agent, ...]`. They go onto `task.agentPrewalk`, `task.agentAdvisor`,
`task.agentServiceTierOverrides` and `task.disabledAgents` through the same runtime override as
the model, laid over what `config.yml` holds, and `off` clears all five. The legal values come
from `resolveAgentPrewalkPattern` and `resolveAgentAdvisorSelection`
(`config/model-resolver.ts:1300-1348`) and `SERVICE_TIER_INHERIT_SETTING_VALUES`
(`config/service-tier.ts:59-67`), and each is checked at load.

Until 2026-09-25 ccw generated four agents beside omp's five: `test-runner`, `web-researcher`,
`planner` and `critical-task`, in `~/.omp/agent/agents/`, each with a frontmatter `model:` set to
the model `tiered` bound, so the tier held with the extension off. All four are gone now, with
`OMPAgentFiles` itself
([ccw changes no subagent behavior but the mapping](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/ccw-changes-no-subagent-behavior-but-the-mapping.md)),
and the built-in profiles bind only omp's own five bundled agents. `modelRoles.slow` is
`anthropic/claude-opus-5-5:xhigh` for the same reason as before: the bundled reviewer is `@slow`.
Before the judges moved, it was Sonnet at `high`. `modelRoles.default` is
`anthropic/claude-opus-5-5:medium`
and `defaultThinkingLevel` is `medium`, which is what the machine runs. The constant said `high`
before, and until 2026-09-25 `config.yml` was replaced whole on install, so every install
reverted the machine. Since then the constant is a seeded default only.
`task.maxEffort: high` does not clamp the judges' `xhigh`, because it applies only to a task
`effort` argument (`task/executor.ts:3601`), and `task.enableEffort: false` turns that off.

# A repo maps its own agents, and an unbound agent does not run

A repo can define its own omp agents in `.omp/agents/*.md`. omp loads them from the nearest
`.omp/agents` above the session directory (`findAllNearestProjectConfigDirs` at
`config.ts:218-247`, filtered to `.omp` and first-only at `task/discovery.ts:98-107`). The repo
maps them in `agent-profiles.yml` in that same `.omp` directory. The extension finds the file by
the same walk from `ctx.cwd` (`extensibility/extensions/types.ts:442`), and re-reads it when its
mtime moves, as it does the hand file.

```yaml
default:
  okf-writer: { model: anthropic/claude-sonnet-5, thinking: medium, like: task }
profiles:
  frugal:
    okf-writer: { model: anthropic/claude-haiku-4-5 }
```

The effective profile is the applied fleet profile, then `default`, then
`profiles.<applied name>`, merged per agent and per field. It is built once at apply time and
becomes `APPLIED_PROFILE`, the one module-scope object that the spawn hook and the child guard
both read. So a repo row reaches the child through the same binding entry and the same guard as
a fleet row. A `profiles:` key that names no fleet profile gets a complaint and is ignored.

**Scope.** A repo row may bind only an agent that a file in that repo's `.omp/agents` defines,
matched by its frontmatter name. A row for a bundled agent (`task/agents.ts:44-73`), for a file
in `~/.omp/agent/agents`, or for an agent a built-in binds is refused. A repo that ships its own
`reviewer.md` still cannot rebind `reviewer`. The judges are tiered by what a miss costs, and a
repo that could move a judge to a cheaper model would change a fleet guarantee in a commit that
no fleet review sees.

**Accounts, and like.** A row takes `model`, `thinking`, `account`, `prewalk`, `advisor`,
`serviceTier` and `like`. `account` takes the grammar a hand row takes, a selector or
`{ provider: selector }`, and passes the same `normalizeEntry` check. The first version refused
`account` in a repo row. Hafiz reversed that on 2026-09-23: every mapping, a repo agent's
included, must be able to name its exact account. An account in a tracked file is still a fact
about one machine's login. On a machine without that login, the spawn is refused with the fix,
and the agent does not run on another account.

`like: <fleet agent>` is the portable form. It names an agent the applied profile binds. Each
field the row omits comes from that agent's row, and so does its account, but only while the
row stays on that agent's provider. An account on one provider cannot serve another, so a
mismatch is refused rather than dropped in silence. An API-key alias was treated the same way,
because its binding was the provider id. Since 2026-09-23 a key is a stored row like an OAuth one,
so it follows the same provider check. A named `account` beats the borrowed one, and a row
that names one may move to another provider.

**A machine-local account for a repo agent.** A machine can name a repo agent's account without
putting an email in git, under `assign.repos` in the hand file. That block is described in the
next section. The first version of it was a top-level `repos:` block with its own
`default:`/`profiles:` layers and a `repo-hand` status source. It was replaced whole on
2026-09-23, with no alias: a leftover `repos:` block binds nothing and gets a complaint that
names `assign.repos`. `repos` stays reserved, so a leftover one is never read as a profile.

**Strict refusal.** While any profile is applied, `before_subagent_spawn` refuses an agent that
the effective profile has no row for. The reason names where the row goes: for an agent the repo
owns, the repo overlay for the row and the hand file's `assign.repos` block for a machine-local
account, and for every other agent `~/.omp/agent/ccw-agent-profiles.yml`. Before
this, an unbound agent ran on its own frontmatter model, so a new agent could run on a model
nobody chose. A disabled agent is not refused by this rule, and omp refuses it earlier anyway
(`task/structured-subagent.ts:282-291`). An `m<N>` agent is covered below. Under `off` nothing
changes. `opus` and `frugal` gained rows for `test-runner`, `web-researcher` and `planner` on
2026-09-23, and `critical-task` became the ninth agent all three built-ins bound the same day.
`tiered` did not change. All four were removed on 2026-09-25
([ccw changes no subagent behavior but the mapping](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/ccw-changes-no-subagent-behavior-but-the-mapping.md)):
every built-in now binds the same 5 fleet agents, `scout`, `sonic`, `task`, `reviewer` and
`security-reviewer`, and none of them refuses one.

**extends.** A hand profile may say `extends: <profile>`. The name resolves to a hand profile
first, then to a built-in, and a profile that extends its own name gets the built-in of that
name. Rows merge per agent and per field, child over parent, and the merged row is validated as
one row. So `task: { account: me@work.example }` under `extends: tiered` takes tiered's model,
and the bare selector finds its provider there. `disabled` in the child replaces the parent's
list when present, and an agent the child disables loses the parent's row. A cycle or an
unknown name gets a complaint, and that profile is unusable: applying it changes nothing.

**Status.** `/agent-profile status` shows the source of each row: `builtin`, `hand`, `repo`,
`assign`, `assign-repo` or `assign-profile`. A row that an extending profile
changed shows `hand`, even when its model came from the parent.
Then it lists every agent with no row, each with the file to add the row to. The roster is the
5 bundled agents, the files in `~/.omp/agent/agents` and the files in the repo's `.omp/agents`.

Limits:

- **Plugin agents are not in the status roster.** omp finds them through extension and
  marketplace roots (`task/discovery.ts:111-153`), which this extension does not walk. The spawn
  hook still refuses one with no row, and it names the hand file.
- **The name reader is a copy, not omp's parser.** It copies the frontmatter cut in
  `pi-utils/src/frontmatter.ts:144-160`, and falls back to one key per line when the YAML fails,
  as omp does at `:161-202`. omp also repairs ambiguous scalars first, so a file that only the
  repair can read is read by the fallback here.
- **An overlay edit takes effect at the next apply**, as a hand-file edit does. The spawn hook
  and the guard never re-read either file.
- **`new` and `edit` write every row out**, so a profile edited with the wizard no longer extends.
- **The overlay comes from the parent's directory.** It is laid on at apply time, so a child that
  runs in another directory still runs under the parent's effective profile.

## Every path a child could leave its binding

Audited on omp 18.2.11 on 2026-09-23. Every mid-run model change inside one agent goes through
one funnel, `#setModelWithProviderSessionReset` (`session/agent-session.ts:9037-9063`): an
explicit `/model`, a prewalk hand-off, a retry fallback and model cycling. None of them fires an
extension event, so the child's `before_provider_request` sees the new model on the next request
(`extensions/runner.ts:1707-1737`) and judges it there.

| Path | What can move | Enforced here | Evidence |
|---|---|---|---|
| Retry fallback | model, level | The guard refuses a model outside the binding on the next request. The session and its pin stay the same. | `session/turn-recovery.ts:1878-1896`, `task/executor.ts:3577-3588` |
| Prewalk hand-off | model, level | The target must be the one the settings arm. The account is now checked on it too, because it shares the child's provider session. | `task/prewalk.ts:1-6`, `agent-session.ts:9046-9048` |
| Advisor | model, level, account | Its model is checked. Its account cannot be pinned, so an advisor on a provider the binding pins an account for refuses the spawn. | `session/session-advisors.ts:782-791`, `advisor/config.ts:119-136`, `sdk.ts:4010-4013` |
| `m<N>` tagged agent | model, account | Bound to the applied profile's `task` row with the tagged model in place of task's: task's level and account. A tag with no `model_mention` entry on the branch is refused. | `session/model-mentions.ts:21-41`, `:92-114` |
| eval `agent()` and `workpool()` | none beyond `task` | The same spawn hook and the same `session_init`, with `invocationKind: "eval"`. | `task/structured-subagent.ts:265-330`, `:364-392` |
| A caller's `model` argument | model | The spawn hook's model replaces every pattern upstream of it, the caller's included. | `task/structured-subagent.ts:388-391` |
| Side request, compaction fallback | model | A hand-off and a side turn pass the payload hook through `prepareSimpleStreamOptions`, so another model is refused. The compaction call path was not traced to that hook in this audit, so its enforcement is not confirmed. | `session/session-provider-boundary.ts:152-195`, `session/session-handoff.ts:158`, `session/agent-session.ts:9395` |
| Grandchild | all | The child's own spawn hook runs, over the module-scope profile it shares with the parent. | `sdk.ts:2190-2214`, `sdk.ts:2892-2908`, `sdk.ts:1478-1481` |
| Row with no `thinking` | level | Not a divergence: the row binds no level, and the child runs its frontmatter level. | `config/model-resolver.ts:1224-1274`, `task/executor.ts:3600-3620` |

The `m<N>` row takes task's level and account because omp builds each tagged agent as a clone of
the bundled `task` with only the model and the description changed. The selector comes from the
`model_mention` entry on the spawning branch, never from the spawn patterns, because a model the
caller names would replace those.

# Split files: the tracked overlay never holds an account, since 2026-09-24

Hafiz's added ask, 2026-09-24: every repo omp opens from can define its own subagents, and can
map any subagent to a chosen credential from inside that repo. The section above still describes
`<repo>/.omp/agent-profiles.yml`, the tracked overlay, correctly for `model`, `thinking`,
`prewalk`, `advisor`, `serviceTier` and `like`. What changed is `account`.

**The split.** A second file, `<repo>/.omp/agent-profiles.local.yml`, sits beside the tracked
one, in the same `.omp`. It is gitignored (`ensureLocalGitignored` appends its relative path to
the repo's `.gitignore` the first time `/agent-profile set ... scope=repo` creates it, backing up
`.gitignore` first, and never duplicating the line on a later set; it refuses to write anything
when `git check-ignore` reports the root is not a repo at all -- F12, 2026-09-24 addendum 2).
`account:` in the tracked
file is refused outright: `loadOverlay`'s `allowAccount` flag is `false` for it, so a row that
carries one is dropped from the applied profile with a complaint naming the local file, rather
than silently kept or silently failing the whole file. The reason is the one the first version
of the tracked overlay already accepted and Hafiz then reversed here: an account is an identity,
an email or an org, tied to one login on one machine, and `agent-profiles.yml` is committed. A
machine-local id in a tracked file is exactly the leak `assign.repos` existed to avoid, just
moved from the hand file into the repo. The local file removes the need for `assign.repos` as
that escape hatch: `/agent-profile set <agent> scope=repo` now writes `default.<agent>` in the
local file directly, any agent, account included, while `assign.repos` rows written before this
addendum keep reading exactly as they did (no migration).

**Local binds any agent.** The tracked overlay still binds only an agent the repo defines
(`repoOwns`, unchanged). The local file does not: `repoOwns` is never checked for it, so a
machine can pin a bundled or fleet agent — `scout`, `reviewer` — to a specific login from inside
one repo, with no profile and no hand-file `assign` row. A new scope, `repo-shared`, writes
`default.<agent>` into the *tracked* file instead, and keeps the old restriction: a repo-defined
agent only, and `account:` refused there too, with the same message `scope=repo` would need to
resolve it.

**Layering.** `composeProfile`'s layers grow by two, between the tracked file and `assign`:
tracked `default`, tracked `profiles.<name>`, local `default`, local `profiles.<name>`, then
`assign`, `assign.repos.<path>`, `assign.profiles.<name>` as before. Each field merges on its
own, so the local file's account can win a field the tracked file lost (thinking, model), while
`assign` and `assign.repos` still win over both, because the hand file is the operator's
machine-wide word.

**`.claude/agents` is a repo scope too.** `repoScope` walks up from the session directory
checking, at each directory, for either `.omp/agents` or `.claude/agents` (Part G teaches omp
itself to load the latter as a Claude-dialect task agent). Either one is enough to make that
directory's `.omp` hold the tracked and the local file, so a repo that ships only
`.claude/agents/*.md`, with no `.omp/agents` at all, is still a repo scope, and `scope=repo`
creates its `.omp` directory on first write.

**Selectors grow a form.** `matchCredentials` already matched a label, an identity or `#<id>`.
It now also matches `<provider>/<id>`, checked against the row's own `provider` field, so a
selector naming the wrong provider matches nothing even when the row set carries only one
provider's rows (the common case, since a bare `account:` value is resolved against the model's
own provider already). This makes a local-file row like `account: anthropic/3` self-describing,
where `#3` alone does not say which provider owns id 3.

See `internal/policy/omp_test.go`, the harness cases prefixed `H1`-`H5`, for the split
behaviour measured end to end: a tracked-file account dropped with a complaint, a fleet agent
bound from the local file, the local file's field beating the tracked file's, `assign.repos`
still beating a competing local row, a `.claude/agents`-only repo taking `scope=repo`, and
`repo-shared` refusing an account.

# Any agent takes any stored credential, with no profile

Hafiz's rule on 2026-09-23: any agent may take any stored credential, for any provider, model
and thinking level, from the TUI or the file, with no named profile in the way. Before this, an
account lived only inside a profile row, so `work`, `personal`, `split` and `audit` were
copies of `tiered` that differed only in `account:`. Those profiles still work unchanged. They
are now optional.

**Names.** A name is a stored row's `label`, set in omp's own `/providers` → Credentials, which
ccw's commits add (schema V8 to V9 adds `label`, unique per provider, case-insensitive).
`account: work` resolves through the row model's provider: the label first, case-insensitive,
then the email or identity, then `#<id>`. There is no substring tier and no position. Zero
matches or two refuse the spawn with the fix. The same label on two providers is two rows, so
`account: work` on an anthropic row and on an openai-codex row each find their own.

The first cut kept names in ccw, as an `accounts:` block in the hand file, and a name could span
providers:

```yaml
accounts:
  work: { anthropic: "hafiz.p@sentineltech.com" }
  personal: { anthropic: "hafizputraludyanto@gmail.com" }
```

omp stored several OAuth rows per provider, one per identity, and gave none of them a name. A
row id is an autoincrement key, and a logout plus a new login inserts a new row with a new id
(`auth/sqlite-credential-store.ts:713`, `:169-193`). So a name pointed at an email or an account
id, never at a bare row number. An API-key alias name was a credential name too: `account:
<alias>` moved the row's model from `base/model` onto `alias/model`, because omp kept one key per
provider id (`sqlite-credential-store.ts:1922-1925`) and the alias WAS the second key. Both
layers were deleted on 2026-09-23, when omp's store gained a label and several key rows per
provider. A leftover `accounts:` or `credentials:` block binds nothing and gets one complaint:
name it in `/providers` → Credentials, then use the name in `account:`.

**The assign layer.** `assign:` binds one agent, any agent, beside the profiles:

```yaml
assign:
  okf-writer: { account: work }
  repos:
    ~/git/github.com/fairyhunter13/sentineltech-project:
      investigation-agent: { account: personal }
  profiles:
    tiered:
      scout: { account: pool }
```

The layers run, lowest first: the profile's row, the repo overlay, `assign`,
`assign.repos.<path>`, `assign.profiles.<name>`. Each field merges on its own, so an
account-only row keeps the model and level below it. A layer that moves an agent to another
provider and names no account puts it on that provider's pool: an account never follows an agent
onto a provider it does not belong to. `account: pool` says so outright. `like:` is resolved
once, after every layer, so an account from any layer satisfies its provider check. Every
`assign` layer binds any agent, bundled, fleet, user, plugin or repo, `assign.repos` included:
Hafiz's rule is "without any limitation", so `scout` can run one way in one repo and another
way elsewhere. The first cut limited `assign.repos` to repo agents and was reversed the same day.
The scope rule still holds for the repo's own tracked file, so a commit cannot move a fleet
judge. The hand file is one machine's own choice. A `repos` or `profiles` key inside `assign:`
is never an agent.

All of it lands in the one composed profile at apply time, so the spawn hook and the child's
request guard enforce an assign row exactly as they enforce a profile row. A selector that
matches no stored row, or matches two, refuses the spawn, and the reason names the row's label,
its email or `#<id>`, and `/providers` → Credentials. `/agent-profile off` is still the kill
switch: it drops every layer,
`assign` included, and status says so.

**The one credential list.** One function, `storedCredentials`, returns a provider's usable
stored rows from the patched `authStorage.listCredentials(provider, sessionId)`. Each row is a
`CredentialSummary`: `id`, `kind` (`oauth` or `api_key`), `label`, `identity` (an email),
`hint` (a key's last four characters), `disabled`, `isDefault` and `active`. The list includes
disabled rows, and ccw drops them, so no picker offers a torn-down row. A definitive refresh
failure is such a tombstone, with the cause `oauth refresh failed: ...`
(`pi-ai/src/auth-storage.ts:2810-2829`). A transient failure records nothing on the row, so no
mark exists for one. The `set` picker, status and the spawn hook all read this list. When the
running omp has no `listCredentials`, the function says so, and every bound spawn is refused with
`omp lacks ccw's commits: run ccw omp-src apply`. ccw never falls back to picking a row itself.

The first cut read the store through `listStoredCredentials` and `listDisabledCredentials`
(`:7329`), added each alias key by name, and lived in `ompCredentialJS`, which both generated
extensions concatenated: omp loads every `.js` file directly in `extensions/` as an extension
(`discovery/helpers.ts:856-860`), so a shared runtime file there would load as a broken one. With
`/account` gone, the list lives in `ccw-agent-profile.js` alone.

**The commands.**

- `/agent-profile set [agent]` walks agent, model, level, credential and scope. The scopes are
  every profile, this profile only, and this repo only. The last is offered for every agent in
  every directory, and it writes `assign.repos.<path>`. `set <agent> model=... thinking=...
  account=... scope=all|profile|repo` does the same with no pickers. Each write keeps a backup
  and re-applies the current profile at once. `unset <agent> [scope]` removes the row, which
  restores the layers below.
- `/agent-profile account add|name|list|remove` and `key add` are deleted. omp's `/providers` →
  Credentials adds a subscription with omp's own login, adds an API key in a masked field, and
  names, removes and disables a row. ccw never removes a credential and never sees a key.
  Before the patch, `account add` drove `AuthStorage.login` (`pi-ai auth-storage.ts:3230-3307`),
  because `showOAuthSelector` lives on the interactive host (`modes/types.ts:486`), not on an
  extension ctx (`extensions/types.ts:428-558`). `key add` wrote an alias, and the key went into
  `/login <name>`, because `ctx.ui.input` has no masked mode (`extensions/types.ts:248`,
  `:167-170`).
- `new` and `edit` never write a repo's own agent into a named profile, where the row would bind
  every repo that defines an agent of that name. A row already there is kept, because a named
  profile is never rewritten without Hafiz.

**Status** prints every agent with its pattern, its credential (`[anthropic: work
a@example.com #1]`, `[deepseek: spare …c3d4 #12]`, `[pool]` or `[refused: ...]`) and its
source. The set picker lists each row as `label (email or key hint) #id`, then `any (pool)`.

Limits:

- **An omp without ccw's commits binds no credential.** Every spawn that names an `account:` is refused with
  the fix, and an agent with no `account:` still runs on its model and level.
- **One OAuth row per identity.** omp keys anthropic and openai-codex rows `email|org`
  (`sqlite-credential-store.ts:169-197`), so one email with two subscriptions is two rows. Only
  a label or `#<id>` tells them apart.
- **Solved by the patch.** `account add` refused a provider whose login asked for a secret, an
  alias could not stand for one OAuth row, and omp's own UI showed no name. The Credentials tab
  and the stored `label` retired all three.
- **A row with only an account and no model binds the account for whatever model the agent runs.**
  The agent keeps its own frontmatter model, and the account is enforced only on its provider.
- **The repo for `assign.repos` is the git toplevel, else the session directory.** It is `git
  rev-parse --show-toplevel` from the session directory, as a real path, and it needs no `.omp`
  directory, so a plain repo takes these rows too. Outside git the directory itself is the key,
  so a row set there applies in that directory only, not in its subdirectories. The tracked
  overlay still comes from the nearest `.omp/agents`, which is the walk omp uses for project
  agents.

# What cannot be enforced

- **The spawn hook's note is not persisted.** It rides on the resolved-model badge, and no
  session file carries it. The binding entry in the child is the durable record.
- **A prewalk or advisor target set by an agent's frontmatter is invisible.** The guard allows
  the targets it reads from the settings layer, and `task.prewalk` for the bundled `task`. A
  child armed only by frontmatter is refused at its hand-off until the profile binds prewalk
  or advisor itself.
- **An advisor's account cannot be pinned.** It runs as a second agent under a random UUIDv7
  provider session id (`advisor/config.ts:119-136`), which exists only in an in-process map. So
  an advisor on a provider the binding pins an account for refuses the spawn. An advisor on
  another provider runs, and its request is checked for its model only, not for its level.
- **A prewalk request is checked for model and account, not level.** It runs on the child's own
  provider session, so the pin reaches it. Its level rides on the prewalk target.
- **A row with no `thinking` binds no level.** The child runs its frontmatter level
  (`task/executor.ts:3600-3620`), and the guard does not check it. The `opus` built-in named
  bare models until 2026-09-23, so under it every agent ran its own level. It now names a level
  on every row. Name `thinking` to bind one.
- **A child revived in a fresh process spawns grandchildren unbound.** It is judged against its
  own `ccw-agent-binding` entry, but no profile is applied in that process, so its spawn hook
  has nothing to bind a grandchild to.
- **A tagged model inherits task's level even where the user named none.** The tag is a model
  choice. The level is the fleet's choice for the agent the tag clones.
- **One provider id with two stored API keys was balanced by omp.** An API-key binding was the
  provider id, so each key needed its own alias. The patched store keeps several key rows per
  provider, and `pinSessionCredential` pins one of them, so `account:` binds a key like an OAuth
  row. An explicit pin is strict: it never rotates to another row on a rate-limit block or a 401.
- **A side request on another model is refused.** Side requests reach the guard through
  `prepareSimpleStreamOptions` (`session/session-provider-boundary.ts:152-195`). Compaction,
  branch summaries and ephemeral turns run on the session's own model, so they pass. Only a
  compaction fallback onto another model fails, which is the strict choice. The judge that
  `find` uses (`judgment/index.ts`) does not pass through `onPayload`, so it is never refused.
  The 2026-09-23 audit traced hand-offs and side turns to that hook, but found no `onPayload`
  in the compaction path of `session/session-maintenance.ts`. So a compaction on another model
  may reach the provider unchecked. That is not confirmed.
- **The parent cannot be enforced, by design.** Nothing here pins or refuses the parent.

# Measured live on 2026-09-23, omp 18.2.11

On a scratch session with the parent on Haiku 4.5, and with no command and no environment
variable, the status line read `agents: tiered`. One batch spawned all 8 agents. Every child
file names its bound model and level, 0 ran Opus, and 0 were refused: scout, sonic,
test-runner and web-researcher on Haiku 4.5, and task, reviewer, security-reviewer and planner
on Sonnet 5.
That run was before the judges moved to Opus, and before `critical-task`, `test-runner`,
`web-researcher` and `planner` were removed on 2026-09-25
([ccw changes no subagent behavior but the mapping](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/decisions/ccw-changes-no-subagent-behavior-but-the-mapping.md)).
The harness test now pins reviewer and security-reviewer at `anthropic/claude-opus-5-5:xhigh`,
scout and task at `anthropic/claude-opus-5-5:medium`, and it fails if any other default agent
resolves to an Opus model.

A test profile then bound scout to the personal account (credential 2), sonic to Sentinel Tech
(credential 1), task to `deepseek/deepseek-flash`, and test-runner to a second DeepSeek credential,
`deepseek-alt`. The alias was added with `/agent-profile credential add`, and `/login deepseek-alt`
stored the environment variable name, so no key was typed. Each child ran on its binding with 0
refusals. The guard compares the active credential with the pinned id on every request, so 0
refusals is the proof. A profile naming `nobody@example.com`, and a model with no credential,
were blocked at spawn in 2.4 s, before any child existed, each reason naming its fix. Under
`/agent-profile off`, sonic ran on the parent's model at the bundled `medium`, unbound.

That run used the alias machinery deleted on 2026-09-23. The same binding is now a second key
row under `deepseek` itself, named in `/providers` → Credentials.

**Measured again on 2026-09-23 on the live build (`ccw` 5059aa31b), in a sandbox.** It used
`omp -p` with a temp `PI_CODING_AGENT_DIR` and a local server that logged each `Authorization`
header. An extension registered `fakekey` with 4 stored key rows and `fakeoauth` with 2 stored
OAuth rows, whose `getApiKey` returns the access token. One `task` call spawned 5 siblings:

- Run 1: scout was bound to `key-a` and sonic to `key-b`. task and reviewer were bound to the two
  OAuth rows, and security-reviewer to no account. All 5 completed. Their first requests started
  within 32 ms of each other, and each held the same 2.5 s window, so they ran at once. Every
  request carried only its own row, and the store held a pin per child.
- Run 2: `key-a` and the second OAuth row answered 429. Those two children sent 132 requests
  each, all on their own row, then failed. The other three completed.
- Run 3: the parent was pinned to `key-c`, which is not the default. The unbound child sent
  `key-c`, so it inherits the parent's row and does not fall back to the default.

Two traps for the next run. With `async.enabled` (the default), `omp -p` exits before background
children run, so the sandbox turns it off. An agent with an output schema refuses a string
`yield`. Two real Anthropic subscriptions were not measured, because only one row is live.

**Measured a third time on 2026-09-24, after exclusive pins (ccw 845eddd77).** The same 5
siblings started within 15 ms. Each bound child's pin read `{"credentialId":N,"exclusive":true}`,
and the parent's and the unbound child's pins were plain. Under 429 the two limited children sent
128 and 132 requests on their own rows and failed, and the other three completed. The
interactive `/agent-profile set scout` picker, driven in a sandbox TUI on its own tmux server,
listed `key-a #3` to `key-d #6`, `default` and `any (pool)`. Choosing `key-c` for "this profile
only" wrote `assign.profiles.multi.scout` with a backup, and the next scout sent `key-c`.

**Measured live on two real subscriptions on 2026-09-24, omp 18.3.0.** Profile `split` put a
Haiku scout on #6 (gmail) and an Opus reviewer on #5 (work) in one `task` call. Each assistant
message in the child sessions carried its own `credentialId`, 2 of 2 on #6 and 3 of 3 on #5, and
both pins were `exclusive: true`. One call escapes the binding by design: the parent labels each
child with the tiny title model (`task/label.ts`, via `executor.ts:1465`) under the child's handle,
on the parent's pool. So a gmail child's one-line label bills the work account.

Two facts for token cost came out of it. **A report used to spend a parent turn**: `/agent-profile`
sent every report as `deliverAs: "aside"`, which starts a turn when the session is idle
(`extensions/types.ts:1425-1427`), so an Opus parent answered each one. A report now goes as
`nextTurn` when idle, which only displays, and as `aside` mid-turn, where `nextTurn` would hide
it. A harness assertion failed on the old delivery with `an idle report was delivered as
"aside"`. **The first prompt is most of a small spawn's cost**: each child's first request wrote
11k-37k tokens of cache for a one-word answer. That is the next lever.

# Addendum 4 (2026-09-24, Part N): the one-binding rule closes its own escape hatch

A second-pass audit found the one-binding rule (`enforceOneBinding`, Decision 1, addendum 2 Part
K) ran only where `composeProfile` layered a row on top of a fleet one, never on the fleet row
itself. A hand `profiles.<name>` row -- `split`'s own `scout`, before this fix -- could carry an
account on two providers, no thinking level, or a `prewalk`/`advisor` value other than `off`, and
it spawned exactly as `binder`'s dedicated layered-row tests already proved refused. The fix
moves `enforceOneBinding` earlier in the file (`BUILTIN_NORMALIZED` calls `normalizeProfile`
eagerly at module load, before `composeProfile` is even defined, so the forward reference had to
move) and runs it inside `normalizeProfile` itself, on every fleet row, built-in and hand alike.

**The cost, found by running the existing suite.** `split`'s `scout` (account, no level),
`rival` and `ambiguous`'s `reviewer` (account, no level) needed a `thinking:` added. `walked` and
`advised` had relied on the very gap this fix closes: a fleet row combining an account with a
same-provider `prewalk`/`advisor` used to reach the spawn hook and the request guard, which have
their own, more specific checks (`its advisor runs on ... under its own provider session`, and
the request guard's account-vs-model check on the bound model). At the time, `apply()` rewrote
`task.agentPrewalk`/`task.agentAdvisor` wholesale from `entry.prewalk`/`entry.advisor`, with no
config.yml-level fallback while a profile was applied. So once `enforceOneBinding` refused the
row at parse time, no profile could carry a prewalk or advisor alongside its account. Since
2026-09-25 a persisted `/agents` value wins per agent, so that pairing can come back from
`config.yml`. `bindingOf` reads the merged advisor setting, so the spawn hook's
advisor-provider-overlap check (`its advisor runs on ... under its own provider session`)
refuses that pairing too. `walked`'s and `advised`'s fixtures dropped their `prewalk`/`advisor` fields; `walked`'s
request-guard test now exercises the account pin on the bound model directly instead of a
prewalk hand-off, since that is the only thing left to test once the combination is refused.

**A refused row now disables the agent, and says why.** Before this fix, a layered row
`composeProfile` refused left `profile[agent]` however `{...fleet}` had set it: the agent kept
running on its OLD fleet binding, or on the pool if the fleet held nothing, with only a complaint
notice as the trace. `composeProfile` now deletes `profile[agent]` on any refusal in its
per-agent loop (a bad shape, a `like:` mismatch, or `enforceOneBinding`) and returns the agent
list in a new `refused: [{agent, reason}]` field. `apply()` folds those agent names into
`APPLIED_DISABLED` (union with the profile's own `disabled:` list) and keeps the reason in a new
`APPLIED_REFUSED_REASONS` map, so `task.disabledAgents` -- the same setting a profile's own
`disabled:` list writes -- refuses the spawn at the real preflight
(`task/structured-subagent.ts:282-291`), before any model resolves, rather than this extension's
own hook returning a `{block, reason}` object for a "no row" case that is no longer accurate (the
row existed; it was refused). Both `report()` and `/agent-profile status` print `disabled: agent
(reason)` for a refusal-caused entry, and a plain agent name for one the profile's own list named.

# Addendum 4 (2026-09-24, Part N): the table editor's own bugs

**L-1: an edit erased every credential.** The table editor's picker built `chosen[agent] = {
model, thinking, accounts: {...} }` -- the OUTPUT shape `normalizeEntry` produces, plural
`accounts`, an id map -- then fed that same object back INTO `normalizeEntry` at Save, which
reads `account` (singular, the INPUT shape) and treats `accounts` as an unknown key. The row kept
its model and level and silently lost its account on every edit, `new wiz`'s own test included --
the test only asserted `wizProfile.scout != nil`, which stayed true because the entry survived
with just its account missing. The fix keeps the editor's own working state in the RAW, singular
`account` shape throughout, and converts a profile-target prefill (`allProfiles()`, already
normalized to `accounts`) back to `account` once when the table opens; a repo-local prefill needs
no conversion, because `loadOverlay` never normalizes a repo's rows at all. A round-trip test
(`edit tabletest` with every row untouched, straight to `Save`) now asserts the written YAML
still carries the account.

**L-2: a repo-local Save could not write at all.** For every agent the table lists, Save called
`spliceKeys(targetFile, ["default", agent], null)` when that agent had no result, to delete
whatever the local file held for it. `spliceKeys` returns `{ok: false}` when `value === null` and
the key path is not in the file at all -- deleting a key that was never written is an error, not
a no-op -- so Save failed outright on the first agent nobody had touched, before it reached an
agent that DID have a change. The fix skips an agent with no result AND no prior row, calls
`ensureLocalGitignored` the first time it creates the file (matching what `/agent-profile set
scope=repo` already does), and reapplies the currently-applied profile afterward, because the
local file layers onto whichever profile is applied at every session and an edit that does not
take effect until a manual `reload` defeats the point of an inline editor.

**L-3: "no credential (pool)" deleted the row.** Picking it used to `delete chosen[agent];
continue;`, skipping the model and level questions entirely, so Save wrote NOTHING for that
agent -- under a strict profile (every agent needs a row, addendum 2's "an unbound agent does not
run"), the agent was refused outright rather than running unbound on the pool, which is what
"pool" is supposed to mean. The fix makes "no credential (pool)" a normal path through the same
model and level questions (from every authenticated pattern rather than one provider's), and
writes `{model, thinking}` with no `account` key.

**L-5: the level step silently dropped `off` and `auto`.** It offered only
`effortsOf(model)`, falling back to `["off"]` when the model reported none, so a model with
efforts could never be bound at `off` or `auto` from the table. The fix offers `off` and `auto`
unconditionally, alongside whatever efforts the model supports, in `THINKING_LEVELS` order.

**L-6: a stale comment credited `normalizeEntry` with the one-binding rule.** `normalizeEntry`
only checks shape (a valid model pattern, a valid thinking level, a valid account grammar).
`enforceOneBinding` is the separate function that reads a normalized entry and refuses one that
combines an account with two providers, no level, or a live `prewalk`/`advisor`. The comment
above `tableEditor`, and this file's own description of `new`/`edit`, now name both.

# Addendum 4 (2026-09-24, Part N): a nested repo's own agents, never an unrelated outer directory

**G-1.** `repoScope` used to walk up from the session directory ONCE, stopping at the first
directory holding either `.omp/agents` or `.claude/agents`. omp's own `discoverAgents`
(`task/discovery.ts`) runs two INDEPENDENT walks, one per directory name, each unaware of the
other's depth, and keeps a `.claude/agents` candidate only when its own repo root
(`repoRootOfAgentsDir`, two `dirname` calls above the `agents` directory) equals the `.omp/agents`
candidate's root; with no `.omp/agents` candidate at all, whatever `.claude/agents` the walk
found stands with no root check. `repoScope`'s single, combined walk could stop at a directory
holding only `.claude/agents` that is CLOSER to cwd than an unrelated `.omp/agents` further up,
returning the wrong repo's agents entirely and never even looking for the `.omp/agents` one. The
fix splits the walk into `findNearestAgentsDir(start, ".omp")` and
`findNearestAgentsDir(start, ".claude")`, run independently, with the same root-equality gate
`discoverAgents` uses. The tracked overlay, the local file and every agent's frontmatter file are
unchanged; only which directories they are read from moves.

# Addendum 4 (2026-09-24, Part N): every tag on a bound task is refused, not only a cross-provider one

**K-3.** The `m<N>` tag guard (`before_subagent_spawn`) refused a tag only when its provider
differed from task's own bound provider, on the theory that a same-provider tag was safe because
it shared task's own account. It is not: the tag names a DIFFERENT model, which the account was
never checked against, so a same-provider tag could run task's credential on a model nobody
validated. The fix refuses every tag once `task.accounts` names one, regardless of the tag's own
provider, with the reason `task is bound to <model> as <credential>. A tagged model cannot run
on that binding.` An unbound task (no account named) still lets a tag through unchanged: model,
level and (when the tag's own row names one) a pin.

**L-4, proven live in the harness.** One profile mapping three credentials at once -- two
anthropic subscriptions (`scout`, `reviewer`) and one deepseek API key (`sonic`) -- spawned
together in one batch. Each child pinned its own row (`exclusive: true`) and wrote its own
`ccw-agent-account` entry, matching the live proof from addendum 3.

# Addendum 5 (2026-09-25, Part P): the main session's credential is never mapped

Hafiz's rule: the main session's provider and active credential are separate from subagent
credential mapping. Several main sessions may run at once on different credentials of one
provider and model, and each stays active; nothing in one session moves another session's
credential, an `/agent-profile` apply, a default change, a login or a usage-limit switch
included.

This was already true, and Part P proves it rather than changes it: `pinAccount` calls
`ctx.sessionManager.getSessionId()`, which is the CHILD's own id inside `before_agent_start`,
`before_provider_request` and `session_start` alike -- never a parent id it holds onto from
outer scope. The extension calls `setDefaultCredential`/touches `is_default` nowhere at all.
`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount`'s harness now pins the parent
session directly (simulating the operator's own `/session pin`) before any bound child spawns,
then reads the parent's sticky credential back after every child in the harness has spawned and
pinned itself: the value is unchanged, and exactly one `pins` entry ever names the parent's
session id.

omp's own per-session facts, from
[a session has one credential](a-session-has-one-credential-and-a-served-turn-chooses-it.md)
and the omp-side research behind this addendum: selection is keyed per session id (a strict
pin, else a 30-day sticky choice, else a hash-ranked pick), a usage-limit switch clears only the
switching session's sticky choice, and `is_default` changes affect new sessions only. Two
concurrent main sessions on one provider therefore resolve independently, whether or not either
one spawns a bound child.

# Addendum 6 (2026-09-25): the table shows the row and the applied binding, never "(inherit)"

`/agent-profile edit` → "this repo (local file)" printed `(inherit)` on every row of a repo
with no `.omp` directory. The prefill is the local file's `default:` block alone, and a missing
row printed the literal `(inherit)`. The agent did not inherit anything unknown:
`APPLIED_PROFILE` binds it from every layer `composeProfile` stacks. A row that held an account
and no model also lost the account from the display, because the old formatter needed a model
to find the provider.

Each row now reads `row: <fields> | applied: <binding>`, or `no row in this file`. The row part
names only the fields the edited file sets. The applied part is `bindingLine`'s text, and it
shows only for this repo's file or the applied profile. A profile that is not applied shows the
row part only, because an applied profile refuses an agent it has no row for.
`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount` captures both tables and
refuses any `(inherit)`.

# Addendum 7 (2026-09-25): /agents edits the applied mapping

`/agents` edits the CURRENT mapping: the profile applied in this session. An edit writes one row
at the first matching layer below:

| Top layer of the agent | Written to |
|---|---|
| `local-default`, `default` or `profiles.<P>` (tracked files are shared) | repo local `default.<agent>` |
| `local-profiles.<P>` | repo local `profiles.<P>.<agent>` |
| `assign.repos.<key>` | hand file `assign.repos.<key>.<agent>` |
| `assign` or `assign.profiles.<P>` | hand file `assign.profiles.<P>.<agent>` |
| none, and the repo has a mapping file or owns the agent | repo local `default.<agent>` |
| none, and `<P>` is a hand profile | hand file `profiles.<P>.<agent>` |
| none, and `<P>` is a built-in | hand file `assign.profiles.<P>.<agent>` |

The detail pane line reads `<P> · <provider>: <label> #<id> · <layer>`, or `<P> · pool · <layer>`,
`<P> · refused: <reason>`, `<P> · no row, refused at spawn` and `off: no mapping`. A fuzzy pattern
resolves to one model, and the notice names both. A refused row is put back byte for byte.

2026-09-25: the `assign.repos` layer is removed. It held 0 rows, `set` never wrote it, and a repo's
local file covers it (jev admit, 0.82). A leftover `assign.repos` block binds nothing, and ccw
names it with "assign.repos is removed; move each row to `<repo>/.omp/agent-profiles.local.yml`
under default:". The table above loses its `assign.repos.<key>` row. Restore is `git revert`.

# Addendum 8 (2026-09-26): the mechanism is built into the fork

Hafiz chose to move the mechanism and keep the data. `ccw-agent-profile.js` is no longer generated.
The same code, in TypeScript, is the fork's built-in extension `packages/coding-agent/src/agent-profile`,
and `sdk.ts` binds it in every session, a task child included. Every name a session or a file
carries stays the same: `/agent-profile`, `OMP_AGENT_PROFILE`, `ccw-agent-profiles.yml`, the repo
files and the four `ccw-agent-*` entry types. The built-in profiles and the default name come from
`~/.omp/agent/agent-profiles.builtin.yml`, which ccw generates. With no such file, no default applies.

The module-scope binding table still carries a binding from the parent to its child. It is now core
state rather than an extension's, and the reason in the section above still holds. Two fallbacks
for a stock omp are deleted: the refusal "omp lacks ccw's commits" and the string-path settings API.
The code ships inside the fork, so neither case can occur. The fork also drops its
`lookupSetting` export, because nothing outside the package imports it.

# Cited by

- [Hold two Claude subscriptions in omp](https://github.com/fairyhunter13/claude-code-workflows/blob/main/knowledge/runbooks/hold-two-claude-subscriptions-in-omp.md) — the
  split-agents section is this decision's operating procedure.

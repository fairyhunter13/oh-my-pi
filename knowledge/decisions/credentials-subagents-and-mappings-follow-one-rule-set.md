---
type: Decision
resource: packages/coding-agent/src/agent-profile/index.ts
title: Credentials, subagents and mappings follow one rule set
description: One spec for how omp credentials, subagents and ccw agent-profile mappings interact, as EARS rules, decision tables, a binding state table, examples and simulations. Every later change to /agent-profile, /agents or a single-credential command keeps these rules true or edits them in the same commit.
tags: [omp, credentials, subagents, extensions, fork, spec]
status: stable
generated: { by: anthropic/claude-opus-5-5, at: 2026-09-25T09:00:00Z }
sources:
  - resource: internal/policy/omp.go
  - resource: internal/policy/omp_test.go
  - resource: internal/hostcli/authrefresh_omp.go
  - resource: knowledge/decisions/a-subagent-pins-its-own-account-from-inside-the-child.md
  - resource: knowledge/decisions/every-credential-surface-reads-one-catalog.md
  - resource: knowledge/decisions/ccw-seeds-omp-defaults-and-never-overrides-a-user-choice.md
  - resource: knowledge/runbooks/carry-ccw-commits-across-omp-releases.md
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/coding-agent/src/auth/credential-selector.ts
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/coding-agent/src/auth/credential-settings.ts
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/coding-agent/src/modes/controllers/selector-controller.ts
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/coding-agent/src/cli/usage-cli.ts
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/tui/src/overlays/agents-hub.ts
  - resource: https://github.com/fairyhunter13/oh-my-pi/blob/ccw/packages/tui/src/setup/scenes/credentials.ts
---

# How to read this

- §2 holds the rules as EARS sentences. *WHEN* is an event, *WHILE* a state, *IF … THEN* an
  unwanted condition, *WHERE* an option. A sentence with no keyword is always true.
- §3 holds the decision tables, §4 the state table of one agent's binding, §5 the examples, §6 the
  simulations and §7 the questions Hafiz settled on 2026-09-25.
- Every rule is **[now]**: the code on `main` and on the fork's `ccw` branch behaves this way.
  Fork paths live in `fairyhunter13/oh-my-pi`, branch `ccw`, on v18.3.1.

# 1. Terms

|Term|Meaning|
|---|---|
|Credential|One row in omp's store (`agent.db`, `auth_credentials`): a durable `#id`, a provider, a kind (`oauth` or `api_key`), a label, an identity, an org and a disabled cause.|
|Subscription|A credential of kind `oauth`.|
|API key|A credential of kind `api_key`, added in `/providers` → Credentials.|
|Agent|A definition: name, description, prompt, tools and an optional default model.|
|Mapping (profile)|One row per agent: `model`, `thinking`, `account` (one credential or `pool`), `prewalk`, `advisor`, `serviceTier`.|
|Applied mapping `P`|The one mapping a session applies (`APPLIED_NAME`). `off` means none.|
|Layer|A file block that lays rows over `P` (DT-1).|
|Binding|What one agent gets after every layer is composed.|
|Pool|No credential is pinned, so omp picks among the provider's rows and rotates.|
|Repo-owned agent|An agent defined in `<repo>/.omp/agents` or `<repo>/.claude/agents`.|

# 2. Rules

## Credentials (C)

- **C-1** omp SHALL store any number of credentials per provider, of either kind. Every surface
  SHALL list them from `authStorage.listCredentials`.
- **C-2** WHEN a selector names a credential, omp and ccw SHALL match `<provider>/<id>`, `#<id>`,
  the label (any case) or the exact identity. IF it matches zero rows or more than one, THEN the
  selector SHALL be refused, and the rows SHALL be named.
- **C-3** IF a key exists only as `apiKey` in `models.yml` or only in the environment, THEN no
  picker SHALL offer it.
- **C-4** The main session SHALL use one credential per provider: its pin, else the default. ccw
  SHALL NOT map the main session.
- **C-5** WHILE a session is unpinned, WHEN a request fails with 401 or a usage limit, omp SHALL
  rotate to a sibling credential.
- **C-6** WHEN a credential is disabled or removed, ccw SHALL name that credential and every agent
  bound to it, and SHALL refuse those agents until a mapping names a live credential.

## Agent definitions (D)

- **D-1** A named global mapping SHALL NOT list a repo-owned agent.
- **D-2** WHEN `/agents` creates or copies an agent, it SHALL open `/agent-profile set <name>`.
- **D-3** WHILE an agent file carries `generated-by: ccw`, `/agents` SHALL offer copy, not edit.

## Mappings (M)

- **M-1** WHEN a session starts, ccw SHALL apply the remembered mapping, else `OMP_AGENT_PROFILE`,
  else `tiered`.
- **M-2** WHERE a hand mapping names `extends: <base>`, ccw SHALL lay its rows over `<base>`.
- **M-3** ccw SHALL compose the layers in DT-1 order, one field at a time.
- **M-4** WHEN a layer moves an agent to another provider and names no account, ccw SHALL drop the
  old credential and bind that provider's pool.
- **M-5** IF a tracked file names `account:`, THEN ccw SHALL ignore the field and complain.
- **M-6** IF the hand file holds `assign.repos`, THEN ccw SHALL ignore it and tell the user to move
  each row to `<repo>/.omp/agent-profiles.local.yml`.

## Bindings (B)

- **B-1** Each agent row SHALL bind at most one credential, of one provider, with one model and one
  level. DT-3 lists the refusals.
- **B-2** One mapping MAY bind different credentials to different agents, and their children MAY
  run at the same time.
- **B-3** IF a row is refused, THEN ccw SHALL disable that agent with the reason. The agent SHALL
  NOT fall back to an older row or to the pool.
- **B-4** WHILE a mapping is applied, WHEN an agent with no row spawns, ccw SHALL refuse the spawn
  and say where to add the row.
- **B-5** WHILE an agent is bound to a credential, the child SHALL pin it exclusively. A request on
  another model, level or credential SHALL be refused. At the credential's limit the agent SHALL
  stop and SHALL NOT move to another credential.
- **B-6** WHILE `off` is applied, a child SHALL run its own model on the parent's credential.
- **B-7** WHILE `task` holds an account, WHEN a tagged model (`m1`…) spawns, ccw SHALL refuse it.
- **B-8** A child's short task-label request SHALL run on the parent's credential (Q-2).

## /agent-profile (P)

- **P-1** WHEN `set` runs, ccw SHALL write one row at the chosen scope (DT-4), keep a `.bak`,
  reapply `P` and print the binding. IF the row makes the agent refused, THEN ccw SHALL restore
  the file byte for byte and show the reason.
- **P-2** WHEN `unset <agent> [scope]` runs, ccw SHALL delete that row.
- **P-3** WHEN `new` or `edit` runs, ccw SHALL show one table with `row: …` and `applied: …`.
  Cancel SHALL write nothing.
- **P-4** WHEN `status` runs, ccw SHALL show each bound agent's credential, the agents that share
  it, and the pool, refused and unbound agents.

## /agents (H)

- **H-1** WHILE `P` is applied, `/agents` SHALL show each agent's model and level as `P` binds them,
  and a credential line (DT-5).
- **H-2** WHILE a mapping is applied, WHEN a model, prewalk or advisor value is edited in
  `/agents`, ccw SHALL write it as one row in `P` at the layer DT-2 picks, never in `config.yml`.
- **H-3** WHEN the value is a comma list, a fuzzy pattern or a `provider/model` that names no
  available model, ccw SHALL store the one available model it resolves to and name both in the
  notice. IF nothing resolves, THEN ccw SHALL write nothing.
- **H-4** WHEN "clear override" is pressed, ccw SHALL clear the field from the target row. IF that
  row does not set it, THEN ccw SHALL say which layer does.
- **H-5** IF an edit makes the agent refused, THEN ccw SHALL restore the file byte for byte and
  show the reason.
- **H-6** WHEN an edit changes the provider, the notice SHALL say that the old credential does not
  follow.
- **H-7** `/agents` SHALL NOT edit a credential. Ctrl+K and the `credential: … · map…` chip SHALL
  open `/agent-profile set <agent>`.
- **H-8** WHEN an agent is enabled or disabled in `/agents`, `task.disabledAgents` in `config.yml`
  SHALL change, machine-wide.
- **H-9** WHILE `off` is applied, `/agents` SHALL write `config.yml` natively, and ccw SHALL write
  nothing.
- **H-10** WHEN a mapping is applied, ccw SHALL move each per-agent entry of `config.yml` into `P`
  (DT-2). It SHALL back up `config.yml` first, drop an entry that repeats the binding, keep and
  name an entry that cannot move, and show one notice.

## Single-credential features (F)

- **F-0** WHEN a feature acts on one credential, it SHALL ask which one first and act on that one
  only. No feature SHALL merge credentials into one view.
- **F-1** Every text selector SHALL accept `<provider>/<active|pool|id|#id|label|email>`. A bare
  number SHALL mean the credential id. `omp token` and `omp auth-broker logout` take
  `--credential`.
- **F-2** WHEN a saved reset becomes eligible, WHILE its credential has no answer, omp SHALL ask
  per credential (`Yes for <label>` / `No for <label>` / `Not now`) and store the answer in
  `claudeResets.autoRedeemByCredential` or `codexResets.autoRedeemByCredential`.
- **F-3** WHERE a routing policy (priority, reserve %) is set in `/providers` → Credentials, it
  SHALL apply to subscriptions only, and SHALL take effect live through
  `AuthStorage.setAccountPolicies` before `auth.accountPolicies` is saved.

## Standing principles (S)

- **S-1** ccw SHALL supply defaults and the first setup only, and SHALL NOT override a choice made
  in the omp TUI or by hand. H-10 is the one exception Hafiz chose, and it drops no choice.
- **S-2** A tracked file SHALL NOT hold a credential.
- **S-3** Every ccw write SHALL keep an undo: a `.bak` for a user file, `git revert` for code.
- **S-4** WHILE a mapping is applied, its composed row SHALL be the only ccw source of an agent's
  model, level and credential.
- **S-5** WHEN omp changes its settings API, ccw SHALL keep working through its adapter
  (`lookupSetting` handles on 18.3.1). IF neither API exists, THEN ccw SHALL show one error and
  apply nothing.

# 3. Decision tables

## DT-1: which layer's field wins (lowest first)

|#|Layer|File and key|May bind|`account:`|
|---|---|---|---|---|
|0|mapping `P`|built-in, or `ccw-agent-profiles.yml` `profiles.P`|any agent|yes|
|1|repo tracked default|`<repo>/.omp/agent-profiles.yml` `default`|repo-owned only|no|
|2|repo tracked for `P`|same file, `profiles.P`|repo-owned only|no|
|3|repo local default|`<repo>/.omp/agent-profiles.local.yml` `default`|any|yes|
|4|repo local for `P`|same file, `profiles.P`|any|yes|
|5|global, every mapping|`ccw-agent-profiles.yml` `assign`|any|yes|
|6|global, for `P` only|`ccw-agent-profiles.yml` `assign.profiles.P`|any|yes|

Each row is one file and key, so no two overlap. An agent with no row in any layer has no binding
(B-4). Order decides per field (M-3).

## DT-2: where an /agents edit or a migrated config.yml entry lands (first match)

|#|`P`|Agent's top layer|Repo has a mapping file|Repo-owned|Written to|
|---|---|---|---|---|---|
|1|`off`|—|—|—|nothing: omp writes `config.yml` (H-9)|
|2|any|1, 2 or 3|—|—|repo local `default.<agent>`|
|3|any|4|—|—|repo local `profiles.P.<agent>`|
|4|any|5 or 6|—|—|`assign.profiles.P.<agent>`|
|5|any|0 or none|yes|—|repo local `default.<agent>`|
|6|any|0 or none|no|yes|repo local `default.<agent>` (created and gitignored)|
|7|hand mapping|0 or none|no|no|`profiles.P.<agent>`|
|8|built-in|0 or none|no|no|`assign.profiles.P.<agent>`|

Rows 2-4 write at or above the layer that wins now, so no higher layer hides the write.

## DT-3: is a row valid (`enforceOneBinding`)

|#|Accounts of >1 provider|Credential provider ≠ model provider|Credential, no level|Credential and prewalk/advisor ≠ off|Result|
|---|---|---|---|---|---|
|1|Y|—|—|—|refused: one credential of one provider|
|2|N|Y|—|—|refused: one model of its account's provider|
|3|N|N|Y|—|refused: needs a thinking level|
|4|N|N|N|Y|refused: prewalk/advisor must be off|
|5|N|N|N|N|valid|

A pool row is checked for its shape only. A refusal disables the agent (B-3).

## DT-4: /agent-profile set scope → file

|Scope|Written to|Credential allowed|Restriction|
|---|---|---|---|
|`all`|`assign.<agent>`|yes|none|
|`profile`|`assign.profiles.<P>.<agent>`|yes|a mapping is applied|
|`repo`|repo local `default.<agent>`|yes|a repo is needed|
|`repo-shared`|repo tracked `default.<agent>`|no|repo-owned only|

## DT-5: the /agents credential line

|Situation|Line|
|---|---|
|`off`|`off: no mapping`|
|refused or disabled|`P · refused: <reason>`|
|no row|`P · no row, refused at spawn`|
|bound|`P · <provider>: <label> #<id> · <layer>`|
|pool|`P · pool · <layer>`|

## DT-6: spawn outcome

|Mapping applied|Row composed|Refused / disabled|Result|
|---|---|---|---|
|no (`off`)|—|—|own model on the parent's credential (B-6)|
|yes|no|—|refused: no row (B-4)|
|yes|yes|yes|refused, reason in status|
|yes|yes, credential problem|—|refused, the problem named|
|yes|yes, valid|no|the row's model:level; a bound row pins its credential exclusively|

# 4. One agent's binding in one session

States: `UNMAPPED` (`off`), `NO_ROW`, `REFUSED`, `POOL`, `BOUND(c)`, `DEAD(c)`.

|From|Event|To|Rule|
|---|---|---|---|
|any|`/agent-profile off`|UNMAPPED|B-6|
|UNMAPPED|apply `P`|NO_ROW / REFUSED / POOL / BOUND|M-1, M-3|
|NO_ROW|a row is added (set, `/agents`, migration)|POOL / BOUND / REFUSED|P-1, H-2, H-10|
|POOL|the row gains an account|BOUND(c) / REFUSED|P-1, H-7|
|BOUND(c)|the account changes to `d`|BOUND(d)|P-1|
|BOUND(c)|model moves provider, no account|POOL|M-4, H-6|
|BOUND(c)|model changes on the same provider|BOUND(c)|M-3|
|BOUND(c)|`c` is disabled or removed|DEAD(c)|C-6|
|DEAD(c)|a re-login revives `c`, or the row names a live `d`|BOUND(c) / BOUND(d)|C-6|
|BOUND(c)|`c` hits its limit|BOUND(c), requests refused|B-5|
|POOL|a pooled credential hits its limit|POOL, omp rotates|C-5|
|any valid|an edit would make the row invalid|unchanged: the write is restored|P-1, H-5|
|REFUSED|the row is fixed or unset|POOL / BOUND / NO_ROW|P-1, P-2|
|any|disabled in `/agents`|REFUSED (disabled)|H-8|
|BOUND(c)|**refused:** a request on another credential, model or level|BOUND(c)|B-5|
|BOUND(c)|**refused:** a tagged model while `task` holds an account|BOUND(c)|B-7|

# 5. Examples

Background: `anthropic #5` is the work subscription, `#6` the gmail subscription, `#7` an API key.
Built-ins `opus`, `tiered` (default), `frugal`; hand mappings `split` and `work` extend `tiered`.

## C-2: one selector, one credential

|Selector|Result|
|---|---|
|`anthropic/6`, `anthropic/#6`, `anthropic/<gmail address>`|`#6`|
|`anthropic/active`|the session's active row|
|`anthropic/9`|refused, the choices listed|
|a label two rows share|refused: "matches 2 … Use the id"|
|`6` with no provider (outside `/session pin`)|refused: "Name a credential as <provider>/…"|

## M-3: the highest layer wins, per field

Given `tiered` binds `scout: haiku :low`, and the repo local file has
`default: scout: { account: <work email> }`, when scout spawns, then it runs Haiku `:low` on `#5`.

|Layers setting `scout.model`|Model|
|---|---|
|mapping (haiku)|haiku|
|mapping, repo local default (sonnet)|sonnet|
|repo local default (sonnet), `assign.profiles.tiered` (opus)|opus|
|`assign` (sonnet), `assign.profiles.tiered` (opus)|opus|

## B-1: one agent, one credential

|Row|Result|
|---|---|
|`{ model: anthropic/claude-haiku-4-5, thinking: low, account: "#6" }`|`BOUND(#6)`|
|`{ model: anthropic/claude-sonnet-5, account: { anthropic: "#5", openai-codex: "#9" } }`|refused (DT-3 row 1)|
|`{ model: openai-codex/gpt-5, thinking: low, account: { anthropic: "#5" } }`|refused (DT-3 row 2)|
|`{ model: anthropic/claude-haiku-4-5, account: "#6" }`, no level below|refused (DT-3 row 3)|
|`{ …, account: "#6", prewalk: on }`|refused (DT-3 row 4)|
|`{ model: anthropic/claude-haiku-4-5, thinking: low }`|`POOL`|

## H-2 … H-10: /agents

|`P`|Repo mapping|scout's top layer|An /agents model edit writes|`config.yml`|
|---|---|---|---|---|
|tiered|none|mapping|`assign.profiles.tiered.scout`|untouched|
|tiered|local file exists|mapping|local `default.scout`|untouched|
|split|none|mapping (`split`)|`profiles.split.scout`|untouched|
|tiered|none|`assign`|`assign.profiles.tiered.scout`|untouched|
|off|—|—|nothing from ccw|written by omp|

- Given a fuzzy `sonnet`, then the resolved model is stored and the notice says
  `resolved from "sonnet"`. Given `nope`, nothing is written.
- Given the prefilled value with text typed after it (`anthropic/claude-haiku-4-5:lowsonnet`),
  then the value resolves to an available model and the notice names both. It is never written
  as typed.
- Given scout bound to `#6`, when prewalk is set `on`, then the file stays byte-identical and the
  notice says "must be off".
- Given `config.yml` holds `scout: anthropic/claude-sonnet-5:high` and tiered's own reviewer
  value, when `tiered` applies, then `config.yml` is backed up, scout moves to
  `assign.profiles.tiered.scout`, the reviewer entry is dropped, and one notice says "moved 2".

## C-6: a credential disappears

Given `split`, when `#6` is removed, then one warning reads
`The anthropic credential <label> #6 for <agents> was removed.` and their spawns are refused.

## F-0 … F-3: choose the credential first

|Command|First step|
|---|---|
|`/usage`|provider → credential picker|
|`/usage reset`|picker over every Claude and Codex row, 0 resets included, then `Spend one` / `Cancel`|
|`/session pin`|picker over every provider, plus "Use the pool"|
|`/logout`|picker, then a confirm|
|`/login`|"Add a new account" or "Log in again as …"|
|`/providers` → Credentials → a row|Usage…, Saved resets… (Claude and Codex), Priority and reserve… (subscriptions only)|

# 6. Simulations

|#|Setup|Action|Expected|Rules|
|---|---|---|---|---|
|1|this repo, `tiered`|spawn `scout`|Haiku `:low`, pool|M-1, DT-6|
|2|`split`|spawn `task` + `reviewer`|each on its own credential, exclusive pins|B-2, B-5|
|3|`split`, one credential at its limit|its agent sends|refused, no move|B-5|
|4|repo agent, tracked model, local account|spawn it|tracked model on the local account|M-3, M-5|
|5|a mapping without `sonic`|spawn `sonic`|refused, no row|B-4|
|6|row with two providers' accounts|apply|refused and disabled|B-1, DT-3|
|7|scout `BOUND(#6)`|`set scout model=openai-codex/gpt-5`|codex pool|M-4|
|8|`tiered`, no repo file|`/agents` scout → `sonnet`|`assign.profiles.tiered.scout`, "resolved from", `config.yml` untouched|H-2, H-3|
|9|repo local file exists|the same|local `default.scout`|DT-2|
|10|scout `BOUND(#6)`|`/agents` prewalk on|restored, "must be off"|H-5|
|11|`off`|`/agents` edit, then apply `tiered`|omp writes `config.yml`, then the entry moves, backup kept|H-9, H-10|
|12|`/agents` Ctrl+K on `reviewer`|pick `#6`|account written, the line shows `#6`|H-7|
|13|`#6` removed|—|credential and agents named|C-6|
|14|auto-redeem unset, a reset on `#6`|the sweep runs|one prompt for `#6`, stored for `#6` only|F-2|
|15|API key `#7`|`set sonic account=#7 …`|sonic on `#7`|B-1, C-1|

`TestTheAgentProfileExtensionPinsEachSubagentToItsMappedAccount` runs rows 1, 2, 5, 6, 8-11 and 13
as the M1, H1-H6 and G4 cases. The fork's `claude-auto-reset-integration.test.ts` runs row 14.
The same Go test runs row 4 as the `modelonly` case, and rows 7 and 15 as named `set` cases. Row 7
moves scout to `openai-codex/gpt-5` with no account, and row 15 binds sonic to API key `#12`.
Row 3 is the `omp-src/selftest.ts` check "a blocked pinned row does not fall over to another row".
Row 12 is split across two repos. The fork's `agents-hub.test.ts` shows that Ctrl+K hands off to
`/agent-profile set <agent>` and that the line shows the bound `#id`. The Go test's L6 picker case
writes the chosen account.

Since 2026-09-26 the extension is built into the fork, and the Go harness went with it. The cases
keep their ids in the fork's `packages/coding-agent/test/agent-profile-*.test.ts`: M1 and H1-H6 in
`agent-profile-hub`, G1 and G4 in `agent-profile-lifecycle`, the `set` and L cases in
`agent-profile-assign`, and L7 in `agent-profile-wizard`. `ccw omp-src apply` runs those files
through the selftest check "the built-in agent-profile extension passes its own tests in this
tree", so a rebase that breaks a row holds the release.

# 7. Settled questions (Hafiz, 2026-09-25)

Hafiz confirmed each shipped choice. To reopen one, add a plan step first, then edit its rule and
this row in the same commit.

|Id|Question|Decision|Rejected alternative, and why|
|---|---|---|---|
|Q-1|Should one row hold an ordered fallback list of credentials?|no (B-1, B-5)|a list tried in order: it moves a bound agent to another account, which B-5 exists to stop|
|Q-2|Who pays for the parent's short task-label request?|the parent's credential (B-8)|the child's: a fork change in the label path, for a request of a few tokens|
|Q-3|Keep `like:` with 0 uses?|keep|remove: jev returned uncertain (0.65), and 0 uses alone does not prove the feature is dead|
|Q-4|Where does an `/agents` edit go when its top layer is the shared `assign`?|`assign.profiles.P` (DT-2 row 4)|the shared `assign` row: one edit would change every mapping|
|Q-5|What does `/agents` do under `off`?|writes `config.yml` natively, and the next apply moves the entry (H-9, H-10)|apply `tiered` and write there: it overrides the `off` choice (S-1)|
|Q-6|What scope does enable/disable have?|machine-wide (H-8)|per mapping: `task.disabledAgents` binds no credential|
|Q-7|Can a tagged model spawn while `task` holds an account?|no, refused (B-7)|run it on `task`'s account: that breaks B-1 whenever the model's provider differs|
|Q-8|How are two subscriptions under one email told apart?|by `#id` (C-2)|auto-suffixed labels: #5 and #6 have different emails today|
|Q-9|What does a bare number mean in a selector?|the credential id (F-1)|the list position: it shifts when a row is removed|

# 8. Where the checks run, and one agent per credential (2026-09-26)

Row 3's check "a blocked pinned row does not fall over to another row" is a fork test now, in
`packages/ai/test/ccw-credentials.test.ts`. The selftest runs that file on every apply.

Every mapping layer (the profile row, the tracked repo file, the local repo file, `assign` and
`assign.profiles.<name>`) accepts every level of omp's `Effort` enum plus `off` and `auto`, and
`THINKING_LEVELS` now derives from core instead of a copy. `agent-profile-thinking.test.ts` binds
each level in each layer, a user-level custom agent included. Each agent binds one credential, and
agents in one mapping may bind different ones. A per-repo credential goes in the gitignored
`<repo>/.omp/agent-profiles.local.yml`, for example `default: { okf-writer: { account: work } }`,
and a `like: task` row borrows task's account only while it stays on task's provider. Claude Code
has one account per profile, so there a subagent varies only by model and effort.

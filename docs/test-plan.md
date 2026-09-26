# Test plan: ccw's commits on omp

```
IDs      T-nn test case. S-nn scenario. J-nn user journey. All append-only.
Status   planned | in-progress | done | blocked | dropped
         blocked carries the observed behaviour. dropped carries one line of reason.
Tiers    E1 unit assertion | E2 request through the real route | E3 run against the
         real engine | E4 run against the deployed target
Risk     likelihood x impact, 1 to 5 each. 1 to 25. Bands: 1-6 low, 7-14 medium,
         15-25 high. A high band earns a journey as well as a case.
Columns  | ID | Title | S-nn | D-nn covered | Status | Test node ID | Risk | Tier |
```

D-nn names the rule or concept the case defends; the D table lists them.

## Scope

Under test: the commits on branch `ccw` over the upstream release tag. They cover the credential
catalog and pins, the selector grammar and pickers, the agents hub, MCP 2026-07-28, the shell
snapshot and the stats credential filter, plus two stats fixes: the sync order and the disk-roots
memo. Since 2026-09-26 they also carry the spawn grant, the mailbox and the credential deadlines
that ccw used to generate.

Named exclusion: upstream behavior that these commits do not touch. Upstream's own suite covers it.

## D table

`D-<rule>` names a rule ID in `claude-code-workflows/knowledge/decisions/credentials-subagents-and-mappings-follow-one-rule-set.md`.

|D|Source|
|---|---|
|D-B5|rule B-5: an exclusive binding never falls through to another account|
|D-C1|rule C-1: any number of credentials per provider, listed from one store|
|D-C2|rule C-2: a selector matches exactly one row or is refused|
|D-C3|rule C-3: a key only in `models.yml` or the environment is never offered|
|D-C4|rule C-4: the main session uses its pin, else the default|
|D-C5|rule C-5: an unpinned session rotates on 401 or a usage limit|
|D-C6|rule C-6: a disabled or removed credential is named and refused|
|D-D1, D-D2, D-D3|rules D-1 to D-3: agent definitions and `/agents`|
|D-H|rules H-1 to H-10: `/agents` edits and the agents hub|
|D-F0, D-F1, D-F2, D-F3|rules F-0 to F-3: credential-first flows, the bare-number selector, auto-redeem, live policy|
|D-MCP|omp speaks MCP 2026-07-28 and answers roots inline: `claude-code-workflows/knowledge/defects/omp-reached-coderag-with-no-roots.md`|
|D-SHELL|the shell snapshot keeps the private helpers an rc calls|
|D-STATS|stats count each provider request once, per credential|
|D-B|rules B-1 to B-8: a bound subagent runs its row's model, level and account, or is refused|
|D-G|rules G-1 to G-4 and the repo layers: which file binds an agent, and in what order|
|D-GRANT|`claude-code-workflows/knowledge/decisions/a-subagent-spawns-only-on-a-user-confirmed-count.md`: 3 cheap spawns per user prompt are free, the rest spend a user-confirmed grant|
|D-MAIL|`claude-code-workflows/knowledge/decisions/sessions-mail-each-other-through-a-private-maildir.md`|
|D-DEADLINE|`claude-code-workflows/knowledge/decisions/an-account-picker-is-provider-generic-but-its-deadlines-are-not.md`: the three deadline tiers|
|D-JEV|`claude-code-workflows/knowledge/decisions/jev-is-spent-only-where-the-evidence-leaves-a-decision-open.md`|

S-07 and S-16 cite D-C1, because the rule set names no separate rule for an identity check or a
schema version.

## Scenarios

### S-01: a pinned session keeps its own row

```gherkin
Scenario: S-01 a pinned session keeps its own row
  Given two pinned sessions and a default
  When both resolve under interleaved calls
  Then each gets its own row, and a default change moves neither
  And the system holds that a cleared pin returns to the default
```

### S-02: a selector resolves exactly one row

```gherkin
Scenario: S-02 a selector resolves exactly one row
  Given rows #5 #6 #7
  When a selector names `<provider>/<id|#id|label|email|active>` or a bare number
  Then exactly one row resolves, else the refusal names the choices
  And the system holds that nothing changes on refusal
```

### S-03: a config-only key is never offered

```gherkin
Scenario: S-03 a config-only key is never offered
  Given a key only in models.yml or env
  When a picker lists credentials
  Then it is not offered, and a stored key still serves under `authHeader`
  And the system holds that no row is created
```

### S-04: an unpinned session rotates on a limit

```gherkin
Scenario: S-04 an unpinned session rotates on a limit
  Given an unpinned session
  When a request hits 401 or a usage limit
  Then omp rotates to a sibling
  And the system holds that the block persists per credential
```

### S-05: removing a credential clears only its pins

```gherkin
Scenario: S-05 removing a credential clears only its pins
  Given a session pins #6
  When #6 is removed
  Then only that session's pin clears and `onCredentialRemoved` fires once
  And the system holds that a re-login revives the row
```

### S-06: an exclusive pin never falls through

```gherkin
Scenario: S-06 an exclusive pin never falls through
  Given a binding's exclusive pin
  When a model only another account serves is requested
  Then the pin holds and the request is refused
  And the system holds that a subagent's inherit keeps the pin exclusive
```

### S-07: a re-login to another identity is refused

```gherkin
Scenario: S-07 a re-login to another identity is refused
  Given row #5 for identity A
  When a login returns identity B
  Then the login is refused and nothing is stored
  And the system holds that the same identity updates #5
```

### S-08: a credential command picks first

```gherkin
Scenario: S-08 a credential command picks first
  Given several rows
  When `/usage`, `/usage reset`, `/session pin`, `/logout` or `/login` runs
  Then a credential picker comes first, and Esc acts on none
  And the system holds that only the picked row changes
```

### S-09: auto-redeem is asked per credential

```gherkin
Scenario: S-09 auto-redeem is asked per credential
  Given auto-redeem unset and a reset eligible on #6
  When the sweep runs
  Then one prompt asks for #6
  And the system holds that the answer is stored for #6 only
```

### S-10: a routing policy edit applies live

```gherkin
Scenario: S-10 a routing policy edit applies live
  Given a routing policy edit
  When it validates
  Then it applies live to subscriptions, and an invalid one keeps the previous policy
  And the system holds that config is saved after the live update
```

### S-11: repo agents and hub edits land in their scope

```gherkin
Scenario: S-11 repo agents and hub edits land in their scope
  Given repo `.claude/agents` and the agents hub
  When agents are discovered and edited
  Then repo agents load in the Claude dialect, and hub edits land at user or repo scope
  And the system holds that no other scope's file changes
```

### S-12: MCP 2026-07-28 roots and fallback

```gherkin
Scenario: S-12 MCP 2026-07-28 roots and fallback
  Given a server that speaks 2026-07-28
  When it asks roots mid tools/call, or lacks server/discover
  Then roots are answered inline, or the legacy handshake runs
  And the system holds that `MCP-Protocol-Version` is set only after negotiation
```

### S-13: the shell snapshot keeps called helpers

```gherkin
Scenario: S-13 the shell snapshot keeps called helpers
  Given a shell rc with private helpers and a slow snapshot
  When the snapshot is taken
  Then called private helpers are kept and a slow snapshot finishes in the background
  And the system holds that the cached result is reused
```

### S-14: stats filter by credential

```gherkin
Scenario: S-14 stats filter by credential
  Given rows of two credentials
  When a stats view asks for one
  Then only that credential's rows count, and no credential answers 400
  And the system holds that the db is unchanged
```

### S-15: a fork's copied request counts once

```gherkin
Scenario: S-15 a fork's copied request counts once
  Given a parent session file and a fork that copied its entries
  When stats sync runs
  Then the request counts once, owned by the parent file
  And the system holds that re-sync keeps one row
```

### S-16: the auth schema moves to 9 and never down

```gherkin
Scenario: S-16 the auth schema moves to 9 and never down
  Given an auth db at schema 8
  When the fork opens it
  Then `label` and `is_default` exist and the version reads 9
  And the system holds that a newer version is never downgraded
```

### S-17: the session list reads the current sessions directory

```gherkin
Scenario: S-17 the session list reads the current sessions directory
  Given a session list read from one sessions directory less than 5 s ago
  When the agent directory changes and the list is read again
  Then the rows come from the new directory, and an unsynced session there is listed
  And the system holds that no row from the old directory is returned
```

### S-18: the built-in agent profile binds every subagent

```gherkin
Scenario: S-18 the built-in agent profile binds every subagent
  Given agent-profiles.builtin.yml with a default profile, and a session with no other choice
  When a subagent spawns, in the parent or in a task child
  Then the child runs its row's model and level on the row's account, or the spawn is refused with the reason
  And the system holds that with no builtin file no default applies and nothing is refused
```

### S-19: every mapping layer takes every thinking level

```gherkin
Scenario: S-19 every mapping layer takes every thinking level
  Given a row at off, an effort from core, or auto, in a hand profile, a tracked repo file, a local repo file or assign
  When the profile applies
  Then the agent binds at that level with no complaint, a user-level custom agent included
  And the system holds that an auto row warns while the judge role resolves to typesafe
```

### S-20: a spawn spends the grant by its tier

```gherkin
Scenario: S-20 a spawn spends the grant by its tier
  Given a user prompt, a grant or none, and each task's own binding
  When the session spawns subagents
  Then 3 cheap spawns run free, and a fourth or an expensive one spends the grant or is refused before it starts
  And the system holds that a new user prompt refills the free 3 and a subagent never spawns
```

### S-21: the built-in mailbox delivers only safe mail

```gherkin
Scenario: S-21 the built-in mailbox delivers only safe mail
  Given two top-level sessions on one machine
  When one sends mail to the other
  Then the mail arrives as an agent message, and a forged, oversized, symlinked or too-deep mail is rejected
  And the system holds that a subagent opens no mailbox
```

### S-22: deadlines come from omp and never refresh

```gherkin
Scenario: S-22 deadlines come from omp and never refresh
  Given OAuth rows of an anthropic, a no-refresh and a rotating provider
  When `omp auth-broker deadlines --json` runs
  Then anthropic rows carry authorizedAt plus the grant TTL, no-refresh rows their expiry, rotating rows null
  And the system holds that no token is resolved and an empty store prints []
```

### S-23: ccw's credential checks run as fork tests

```gherkin
Scenario: S-23 ccw's credential checks run as fork tests
  Given the 21 checks that ccw's selftest held
  When the fork's own test runner runs them
  Then each passes under its old title
  And the system holds that ccw's selftest runs this file on every apply
```

## Cases

| ID | Title | S-nn | D-nn covered | Status | Test node ID | Risk | Tier |
|---|---|---|---|---|---|---|---|
| T-01 | auth storage per session credential | S-01 | D-C1, D-C4 | done | `packages/ai/test/auth-storage-per-session-credential.test.ts` | 12 | E1 |
| T-02 | session credential | S-01 | D-C1, D-C4 | done | `packages/coding-agent/test/session-credential.test.ts` | 12 | E1 |
| T-03 | session credential fork branch | S-01 | D-C1, D-C4 | done | `packages/coding-agent/test/session-credential-fork-branch.test.ts` | 12 | E1 |
| T-04 | auth storage one active | S-01 | D-C1, D-C4 | done | `packages/ai/test/auth-storage-one-active.test.ts` | 12 | E1 |
| T-05 | credential selector | S-02 | D-C2, D-F1 | done | `packages/coding-agent/test/credential-selector.test.ts` | 12 | E1 |
| T-06 | usage cli | S-02 | D-C2, D-F1 | done | `packages/coding-agent/test/usage-cli.test.ts` | 12 | E1 |
| T-07 | token list credentials | S-02 | D-C2, D-F1 | done | `packages/coding-agent/test/token-list-credentials.test.ts` | 12 | E1 |
| T-08 | auth broker logout selector | S-02 | D-C2, D-F1 | done | `packages/coding-agent/test/auth-broker-logout-selector.test.ts` | 12 | E1 |
| T-09 | model registry auth header stored keys | S-03 | D-C3 | done | `packages/coding-agent/test/model-registry-auth-header-stored-keys.test.ts` | 12 | E1 |
| T-10 | auth storage credential precedence | S-03 | D-C3 | done | `packages/ai/test/auth-storage-credential-precedence.test.ts` | 12 | E1 |
| T-11 | auth storage codex selection | S-04 | D-C5 | done | `packages/ai/test/auth-storage-codex-selection.test.ts` | 12 | E1 |
| T-12 | auth storage block persistence | S-04 | D-C5 | done | `packages/ai/test/auth-storage-block-persistence.test.ts` | 12 | E1 |
| T-13 | auth storage credential removal | S-05 | D-C6 | done | `packages/ai/test/auth-storage-credential-removal.test.ts` | 20 | E1 |
| T-14 | sdk credential disabled bridge | S-05 | D-C6 | done | `packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts` | 20 | E1 |
| T-15 | auth storage codex selection | S-06 | D-B5 | done | `packages/ai/test/auth-storage-codex-selection.test.ts` | 20 | E1 |
| T-16 | sdk subagent auth inheritance | S-06 | D-B5 | done | `packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts` | 20 | E1 |
| T-17 | auth storage oauth relogin check | S-07 | D-C1 | done | `packages/ai/test/auth-storage-oauth-relogin-check.test.ts` | 12 | E1 |
| T-18 | auth storage email dedupe | S-07 | D-C1 | done | `packages/ai/test/auth-storage-email-dedupe.test.ts` | 12 | E1 |
| T-19 | selector controller pick credential | S-08 | D-F0 | done | `packages/coding-agent/test/modes/controllers/selector-controller-pick-credential.test.ts` | 12 | E1 |
| T-20 | selector controller credential flows | S-08 | D-F0 | done | `packages/coding-agent/test/modes/controllers/selector-controller-credential-flows.test.ts` | 12 | E1 |
| T-21 | credential after login | S-08 | D-F0 | done | `packages/coding-agent/test/slash-commands/credential-after-login.test.ts` | 12 | E1 |
| T-22 | credential picker | S-08 | D-F0 | done | `packages/tui/test/credential-picker.test.ts` | 12 | E1 |
| T-23 | credentials tab actions | S-08 | D-F0 | done | `packages/tui/test/credentials-tab-actions.test.ts` | 12 | E1 |
| T-24 | claude auto reset integration | S-09 | D-F2 | done | `packages/coding-agent/test/claude-auto-reset-integration.test.ts` | 12 | E1 |
| T-25 | codex auto reset | S-09 | D-F2 | done | `packages/coding-agent/test/codex-auto-reset.test.ts` | 12 | E1 |
| T-26 | account policies live update | S-10 | D-F3 | done | `packages/ai/test/account-policies-live-update.test.ts` | 12 | E1 |
| T-27 | discovery | S-11 | D-D1, D-D2, D-D3, D-H | done | `packages/coding-agent/test/task/discovery.test.ts` | 12 | E1 |
| T-28 | agents hub deps | S-11 | D-D1, D-D2, D-D3, D-H | done | `packages/coding-agent/test/agents-hub-deps.test.ts` | 12 | E1 |
| T-29 | agents hub | S-11 | D-D1, D-D2, D-D3, D-H | done | `packages/tui/test/agents-hub.test.ts` | 12 | E1 |
| T-30 | mcp modern roots | S-12 | D-MCP | done | `packages/coding-agent/test/mcp-modern-roots.test.ts` | 12 | E1 |
| T-31 | mcp http transport | S-12 | D-MCP | done | `packages/coding-agent/test/mcp-http-transport.test.ts` | 12 | E1 |
| T-32 | mcp reconnect | S-12 | D-MCP | done | `packages/coding-agent/test/mcp-reconnect.test.ts` | 12 | E1 |
| T-33 | shell snapshot | S-13 | D-SHELL | done | `packages/coding-agent/test/shell-snapshot.test.ts` | 12 | E1 |
| T-34 | credential filter | S-14 | D-STATS | done | `packages/stats/test/credential-filter.test.ts` | 12 | E1 |
| T-35 | provider stats | S-14 | D-STATS | done | `packages/stats/test/provider-stats.test.ts` | 12 | E1 |
| T-36 | fork dedup | S-15 | D-STATS | done | `packages/stats/test/fork-dedup.test.ts` | 12 | E1 |
| T-37 | a newer schema version is never downgraded | S-16 | D-C1 | done | `packages/ai/test/auth-storage-email-dedupe.test.ts` | 12 | E1 |
| T-38 | a v8 auth db migrates to v9 | S-16 | D-C1 | done | `packages/ai/test/auth-storage-schema-v9.test.ts` | 12 | E1 |
| T-39 | an unsynced on-disk session is listed from the current sessions directory | S-17 | D-STATS | done | `packages/stats/test/trace-builder.test.ts` | 12 | E1 |
| T-40 | ctrl+k hands the mapping to /agent-profile set (rule set §6 row 12) | S-11 | D-H | done | `packages/tui/test/agents-hub.test.ts` | 12 | E1 |
| T-41 | defaults, a missing builtin file, and a custom profile over a built-in | S-18 | D-B | done | `packages/coding-agent/test/agent-profile-defaults.test.ts` | 20 | E1 |
| T-42 | spawn preflight, child pin and request guard (B1-B8, E1, A1, A2) | S-18 | D-B | done | `packages/coding-agent/test/agent-profile-binding.test.ts` | 20 | E1 |
| T-43 | the /agents hub edits the applied mapping (H1-H6, K1, M1) | S-18 | D-H | done | `packages/coding-agent/test/agent-profile-hub.test.ts` | 12 | E1 |
| T-44 | resume, branch and credential events (C2-C6, G1, G4) | S-18 | D-B, D-C6 | done | `packages/coding-agent/test/agent-profile-lifecycle.test.ts` | 12 | E1 |
| T-45 | repo overlay, model mentions and a three-credential batch (R1-R8, A3, m1-m4) | S-18 | D-G | done | `packages/coding-agent/test/agent-profile-repo.test.ts` | 12 | E1 |
| T-46 | the assign layers and the one-binding rule (L1-L6, K5) | S-18 | D-G | done | `packages/coding-agent/test/agent-profile-assign.test.ts` | 12 | E1 |
| T-47 | the table editor (L7) | S-18 | D-H | done | `packages/coding-agent/test/agent-profile-wizard.test.ts` | 12 | E1 |
| T-48 | repo scope discovery (H2-H5, G-1, K5f, L4b-d) | S-18 | D-G | done | `packages/coding-agent/test/agent-profile-scope.test.ts` | 12 | E1 |
| T-49 | a task child binds the built-in extension too | S-18 | D-B | done | `packages/coding-agent/test/agent-profile-child-propagation.test.ts` | 20 | E1 |
| T-50 | every thinking level binds in every layer, and an auto row warns on a typesafe judge | S-19 | D-G, D-JEV | done | `packages/coding-agent/test/agent-profile-thinking.test.ts` | 12 | E1 |
| T-51 | 3 cheap spawns are free, an expensive one or a fourth spends the grant | S-20 | D-GRANT | done | `packages/coding-agent/test/agent-profile-spawn-grant.test.ts` | 20 | E1 |
| T-52 | the built-in mailbox delivers only safe mail as agent messages | S-21 | D-MAIL | done | `packages/coding-agent/test/mailbox-extension.test.ts` | 20 | E1 |
| T-53 | deadlines per basis, a disabled cause, a rotating provider and an empty store | S-22 | D-DEADLINE | done | `packages/coding-agent/test/auth-broker-deadlines.test.ts` | 12 | E1 |
| T-54 | ccw's 21 credential checks, under their selftest titles | S-23 | D-C1, D-B5, D-C6 | done | `packages/ai/test/ccw-credentials.test.ts` | 20 | E1 |

The node ID is the test file path, because bun has no collect-only listing.

## Fixtures

Every case builds its own store, session directory or MCP server in a temp directory. No case
reads the live `~/.omp/agent`.

- F-5 note, 2026-09-25: `ccw omp-src sync` printed `fork main: ea8b54247afb -> ba344f5e69f2` and
  `in sync: main ba344f5e69f2 here, on the fork and upstream`. The fork's `main` had stopped one
  upstream step behind.

## Traceability

The collected-test check. Silence is the pass.

```sh
# A plain pathspec `*` crosses `/`, so this lists nested test files too. `**/` would skip
# every file directly under test/.
git ls-files 'packages/*/test/*.test.ts' | sort > /tmp/collected
awk -F'|' '/^\| T-[0-9]/ {print $7}' docs/test-plan.md | tr -d ' `' | grep -v '^$' | sort -u | comm -23 - /tmp/collected
```

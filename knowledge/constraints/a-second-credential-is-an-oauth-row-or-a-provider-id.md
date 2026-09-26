---
type: Constraint
resource: packages/ai/src/auth-storage.ts
title: A second credential is a second OAuth row or a second provider id, and which one is decided by the login kind
description: listOAuthAccounts and pinSessionOAuthAccount carry no provider-name literals, so per-agent accounts work for every oauth-shaped login and for none of the api-key ones. An API key gets a second credential only by taking a second provider id, which is the credential namespace. ccw builds that id at runtime as a credentials alias, never in models.yml.
tags: [authentication, oauth, omp, subagents, models, quota]
status: stable
generated: { by: anthropic/claude-opus-5-5, at: 2026-09-23T01:55:59Z }
sources:
  - resource: internal/policy/omp.go
  - resource: knowledge/constraints/a-per-agent-account-has-no-native-surface.md
  - resource: knowledge/decisions/a-subagent-pins-its-own-account-from-inside-the-child.md
---

# The API surface is provider-generic; the behaviour is not

`listOAuthAccounts` (`pi-ai/src/auth-storage.ts:6257`) and `pinSessionOAuthAccount` (`:6291`)
contain **zero** provider-name literals. They refuse only on an api-key override. So the ccw
mechanism needs no per-provider code.

What varies sits three layers down:

1. **Row identity.** `resolveProviderCredentialIdentityKey`
   (`auth/sqlite-credential-store.ts:169`) forks exactly twice: `anthropic` and `openai-codex` get
   `<base>|org:<id>`; every other provider takes the first of `account:`, `email:`, `project:`. A
   null key means no dedupe, so each re-login inserts a new row.
2. **Row type.** `#getStoredOAuthSelections` (`:6181`) filters to `type === "oauth"`. Only oauth
   rows are listable and pinnable.
3. **Ranking.** `#resolveOAuthSelection` honours a session sticky unless `shouldRank` (`:5319`) is
   true, which needs a `DEFAULT_RANKING_STRATEGIES` entry (`:1154-1162`) — 7 providers have one.
   Time decay of a pin exists at `:5312` for **anthropic alone**, after one hour idle. That is why
   ccw's `ccw-account` ran a 15-minute re-pin timer for anthropic and for nothing else. Both are
   gone since 2026-09-23: ccw's commits make an explicit pin strict, with no decay, and
   `ccw-account` is deleted.

# Where a per-agent account works, and where it cannot

| login kind | second credential? | account-selectable per agent? |
|---|---|---|
| `oauth-code` (10 providers) | yes, a second row | **yes** |
| `device-code` (3 providers) | yes, a second row | **yes** |
| `custom` hook returning OAuthCredentials (3 of 9) | yes | **yes** |
| `custom` hook returning a string (5 of 9) | no, overwrite | no |
| api key | no, overwrite | by alias id |
| anything under a `models.yml` `apiKey` or `--api-key` | — | **no**, the account API is blanked |

`registry/hooks/custom.ts` is what splits the nine `login "custom"` providers: three return
`OAuthCredentials`, the other five live in `registry/hooks/api-key.ts` and return a string.

# The API-key answer: the provider NAME is the credential namespace

`getApiKey(model.provider, sessionId, …)` (`config/model-registry.ts:2718`) is the only credential
lookup, and it keys on the provider id. So **two provider ids are two independent credentials**,
and a profile selects between them by naming the id, never by an `account:` selector.

ccw builds the second id at runtime. A `credentials:` entry in `~/.omp/agent/ccw-agent-profiles.yml`
names an alias and the provider it copies:

```yaml
credentials:
  deepseek-work: { from: deepseek }
```

`ccw-agent-profile` copies every chat model of `from` and registers them under the alias with
`pi.registerProvider`, with an `oauth.login` hook and no `apiKey`. `/login deepseek-work` then
stores the pasted value as an `api_key` credential under the alias id
(`pi-ai/src/auth-storage.ts:3268-3286`). The value is resolved through `resolveConfigValue`, so
it may be a literal key, an environment variable NAME, or a `!command`. The profiles file never
holds a key. A profile then maps `sonic: { model: deepseek-work/deepseek-flash }`.

A second `models.yml` provider entry is the same idea and is not used. Until 2026-09-25
`models.yml` was `ManageGeneratedFile` (`internal/install/omp.go`), so every
`ccw install --apply` deleted a hand-added alias with no diff. Since then `models.yml` is seeded,
and a provider the user adds stays.

Session creation clears every provider an extension source registered and replays only what
that source's factory queued (`sdk.ts:2294-2305`). A child shares the parent's ModelRegistry and
re-binds the factory, so each bind re-queues the aliases the parent built. Without that, the
first spawn deletes them.

Two costs that are not obvious:

- **Catalog inheritance is per model ID, not per provider.** `finalizeCustomModel`
  (`config/custom-models.ts:113-156`) fills a row from the bundled reference index by id
  (`:116`), and `inheritReferenceThinking` (`pi-catalog/src/identity/reference.ts:177-187`)
  **refuses** to carry thinking levels across a renamed provider. That is why the alias copy
  carries `thinking`, `reasoning` and `compat` explicitly: without `thinking.efforts`, every
  level would clamp to nothing on the alias.
- **Discovery zeroes cost.** The no-`models:` path `discoverOpenAIModelsList`
  (`config/model-discovery.ts:839-911`) fills from the catalog by id but forces cost to zero
  (`:895`), so usage accounting silently reads zero for that provider.

# Do not do this to reach a second Anthropic subscription

The provider-rename trick can be pointed at Anthropic only through a command-backed key,
`apiKey: "!omp token anthropic --account N"`. That command prints a **raw access token**, so the
key would sit in a config file and in a process argument list, and the account API would be blanked
for that provider id on top of it. Two Anthropic subscriptions are two OAuth rows and are selected
with an `account:` selector. That is the whole reason the account axis exists.

# An environment variable is not a second channel

`getEnvApiKey` (`pi-ai/src/stream.ts:855-859`) reads `serviceProviderMap`, built from catalog
entries plus `PROVIDER_REGISTRY` (`:839-843`). A non-catalog provider name has no entry, so a
renamed provider cannot be fed from the environment at all — its key must come from `apiKey:`.

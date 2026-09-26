---
type: Defect
resource: packages/ai/test/ccw-credentials.test.ts
title: A config apiKey hid every stored key of its provider, and a removed key stayed listed
description: On omp 18.2.11 with ccw's commits, a models.yml apiKey made every stored API key of that provider inert and refused a session pin, even when the env var it names was unset. Remove on a disabled row did nothing, a removed row stayed listed with an Enable action, and omp token --list failed for API keys. Fixed on ccw and ccw-next with the same two commit subjects.
tags: [omp, credentials, api-key, auth, providers]
status: stable
generated: { by: claude/opus-5, at: 2026-09-23T13:50:00Z }
sources:
  - resource: internal/policy/omp.go
  - resource: knowledge/decisions/a-large-upstream-change-gets-a-prepared-port.md
---

# Defect

Found on 2026-09-23 by a sandbox run (`PI_CODING_AGENT_DIR` on a temp dir, fake keys, and a
local OpenAI-compatible server that logged the `Authorization` header). The real `agent.db`
was only read.

1. `ModelRegistry` calls `setConfigApiKey` for every models.yml provider with an `apiKey:`,
   and the validator requires one for a custom provider. `AuthStorage` treated the presence of
   that override as final: `getApiKey` and `peekApiKey` returned it (even `undefined`), and
   `pinSessionCredential` refused. So `deepseek`, `moonshot` and any custom endpoint could use
   one env-var key and nothing from `/providers → Credentials`, and a subagent bound to a
   second key of such a provider could never get it.
   A second path hid the keys even after `AuthStorage` was right: with `authHeader: true`,
   `createConfigHeaderResolver` (`coding-agent/src/config/resolve-config-value.ts`) adds
   `Authorization: Bearer <resolveConfigValue(apiKey)>`, which is the variable's name when it
   is unset, and the transports prefer an incoming `Authorization` header to the key
   `getApiKey` chose. The wire carried `Bearer FAKEC_K`. The bearer is now derived only while
   `configKeyIsSoleSource(provider)` holds: a config key, no runtime key, no stored row.
2. `disableCredentialById` drops the row from the in-memory cache, and `removeCredential`
   looked only there, so Remove on a disabled row returned false ("already gone").
3. Remove is a tombstone (`disabled_cause = "deleted by user"`), and `listCredentials` listed
   tombstones, so a removed key stayed in the tab with an Enable action.
4. `omp token <provider> --list` listed OAuth accounts only and failed on a provider with
   only API keys.

The fix fixes one order for a provider's key: a runtime `--api-key`, then the session's strict
pin, then a config key that resolves to a value, then the stored default, then the pool. A
config key naming an unset env var counts nowhere. It still resolves last, so a provider with
no stored row sends what it sent before. `removeCredential` reads the store, tombstones leave
the list and refuse enable, rename and default, and `token --list` prints each row by position,
`#id` and label or key hint, never the key.

The commits are `pi-ai: a session pin beats an unset or config key; remove deletes a disabled
row` and `coding-agent: omp token --list shows stored API keys`, on `ccw` and on `ccw-next`.
`omp-src/selftest.ts` (16 checks) checks the pin order, the removal and the request path with
`authHeader`, on both branches.

Proved on the live build after the fix, through the fake server: an unset env var sends the
stored key (`Bearer sk-fake-C1`) and a set one sends its value; a parent on key A spawns a
scout bound by an `assign:` row to key B, and the child's requests carry key B while the
parent's carry key A; with key B answering 429 the child sent 17 requests, all with key B.
`/logout` with two rows shows a picker and removes one row.

Passed in the same run, before the fix: add, rename, default, pin, clear pin, disable and
enable in the tab; default-first key choice; a pinned key sent after `/model` changes the
model; a strict pin that keeps its key through six 429 retries rather than moving to another.

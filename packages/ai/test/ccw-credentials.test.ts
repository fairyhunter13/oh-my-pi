/**
 * Ported from ccw's omp-src/selftest.ts (credential-storage checks). Fixture, resolution,
 * pinning, removal, revival and the models.yml request path: everything the fork's own
 * AuthStorage does that upstream selftest cannot see, since it lives in this tree now.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredential, OAuthCredential } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { CredentialRankingStrategy, UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { removeWithRetries } from "../../utils/src/temp";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-credentials-"));
// Nothing may reach the real agent directory, even through a default path.
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
delete process.env.PI_PROFILE;
const dbPath = path.join(tmp, "agent.db");

const realNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const PROVIDER = "ccw-selftest";

/** Upstream schema V8 as omp 18.2.11 creates it, with the rows the checks start from. */
function writeV8Fixture(file: string): void {
	const db = new Database(file);
	const now = Math.floor(realNow() / 1000);
	const expires = realNow() + 30 * DAY;
	db.run(`
		CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
		INSERT INTO auth_schema_version (id, version) VALUES (1, 8);
		CREATE TABLE auth_credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL,
			credential_type TEXT NOT NULL,
			data TEXT NOT NULL,
			disabled_cause TEXT DEFAULT NULL,
			identity_key TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL DEFAULT (${now}),
			updated_at INTEGER NOT NULL DEFAULT (${now})
		);
	`);
	const insert = db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?)",
	);
	const oauth = (email: string) =>
		JSON.stringify({
			access: `access-${email}`,
			refresh: `refresh-${email}`,
			expires,
			email,
			accountId: `acct-${email}`,
		});
	insert.run("anthropic", "oauth", oauth("work@example.com"), null, "email:work@example.com");
	insert.run("anthropic", "oauth", oauth("home@example.com"), null, "email:home@example.com");
	insert.run(PROVIDER, "api_key", JSON.stringify({ key: "sk-fixture-k0-0000", source: "login" }), null, null);
	insert.run(PROVIDER, "api_key", JSON.stringify({ key: "sk-old-dead-9999" }), "disabled by user", null);
	insert.run(PROVIDER, "api_key", JSON.stringify({ key: "sk-old-gone-8888" }), "deleted by user", null);
	db.close();
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

writeV8Fixture(dbPath);

/** Usage per access token: the work account is hot, the home account is cool, so ranking prefers home. */
const usedFraction: Record<string, number> = {
	"access-work@example.com": 0.95,
	"access-home@example.com": 0.1,
};
const usageProvider: UsageProvider = {
	id: "anthropic",
	async fetchUsage(params) {
		const used = usedFraction[params.credential.accessToken ?? ""] ?? 0.5;
		const limit = (id: string, durationMs: number) => ({
			id,
			label: id,
			scope: { provider: "anthropic", windowId: id },
			window: { id, label: id, durationMs, resetsAt: Date.now() + durationMs / 2 },
			amount: { usedFraction: used, unit: "percent" as const },
		});
		return { provider: "anthropic", fetchedAt: Date.now(), limits: [limit("5h", 5 * HOUR), limit("7d", 7 * DAY)] };
	},
};
const rankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({
		primary: report.limits.find(limit => limit.id === "5h"),
		secondary: report.limits.find(limit => limit.id === "7d"),
	}),
	windowDefaults: { primaryMs: 5 * HOUR, secondaryMs: 7 * DAY },
	// Production's anthropic strategy (pi-ai usage/claude.ts) declares a 1h warm window, so the
	// fixture must carry it too.
	stickyWarmMs: HOUR,
};

const store = await SqliteAuthCredentialStore.open(dbPath);
const auth = new AuthStorage(store, {
	usageProviderResolver: (provider: string) => (provider === "anthropic" ? usageProvider : undefined),
	rankingStrategyResolver: (provider: string) => (provider === "anthropic" ? rankingStrategy : undefined),
	refreshOAuthCredential: async (_provider: string, _id: number, credential: Record<string, unknown>) => {
		const { type: _type, ...rest } = credential;
		return rest as OAuthCredential;
	},
	usageFetch: Object.assign(() => Promise.reject(new Error("selftest: network is off")), {
		preconnect: fetch.preconnect,
	}),
});

// A thin adapter over the namespaced API (auth.credentials, auth.keys, auth.sessions,
// auth.limits, auth.oauth), matching the shorter names the ported checks below call.
const api = {
	reload: (): Promise<void> => auth.credentials.reload(),
	getApiKey: (provider: string, sessionId: string): Promise<string | undefined> => auth.keys.get(provider, sessionId),
	pinOAuth: (provider: string, sessionId: string, id: number, lastUsedAtMs?: number): boolean =>
		auth.sessions.pin(
			provider,
			sessionId,
			id,
			lastUsedAtMs === undefined ? undefined : { restoredAtMs: lastUsedAtMs },
		),
	markReached: (provider: string, sessionId: string, options: Parameters<typeof auth.limits.markReached>[2]) =>
		auth.limits.markReached(provider, sessionId, options),
	rotate: (provider: string, sessionId: string, options: Parameters<typeof auth.limits.rotate>[2]): Promise<boolean> =>
		auth.limits.rotate(provider, sessionId, options),
	setConfigKey: (provider: string, config: string): void => auth.keys.setConfig(provider, config),
	removeConfigKey: (provider: string): void => auth.keys.removeConfig(provider),
	adopt: (provider: string, sessionId: string): number | undefined => auth.sessions.adopt(provider, sessionId),
	refresh: (options: Parameters<typeof auth.oauth.refreshCredentials>[0]) => auth.oauth.refreshCredentials(options),
	inherit: (source: string, target: string): number => auth.sessions.inherit(source, target),
};
await api.reload();

const rows = () => auth.listCredentials(PROVIDER) as Array<Record<string, any>>;
const idOf = (provider: string, predicate: (row: Record<string, any>) => boolean): number => {
	const row = (auth.listCredentials(provider) as Array<Record<string, any>>).find(predicate);
	assert(row, `no ${provider} row matches`);
	return row.id;
};
let k0 = 0;
let k1 = 0;
let k2 = 0;
let work = 0;
let home = 0;

afterAll(async () => {
	try {
		auth.close();
	} catch {
		// Closing is best-effort on a failing tree.
	}
	Date.now = realNow;
	await removeWithRetries(tmp);
});

describe("ccw credential storage", () => {
	it("migration V8->V9 adds label and is_default and records version 9", () => {
		const db = new Database(dbPath, { readonly: true });
		try {
			const columns = (db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name: string }>).map(
				column => column.name,
			);
			assert(columns.includes("label"), "label column missing");
			assert(columns.includes("is_default"), "is_default column missing");
			const version = (
				db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as { version: number }
			).version;
			assert(version === 9, `schema version is ${version}, want 9`);
			const count = (db.prepare("SELECT COUNT(*) AS n FROM auth_credentials").get() as { n: number }).n;
			assert(count === 5, `fixture rows after migration: ${count}, want 5`);
		} finally {
			db.close();
		}
	});

	it("listCredentials lists every row, disabled included, removed left out, with identity and hint", () => {
		const anthropic = auth.listCredentials("anthropic") as Array<Record<string, any>>;
		assert(anthropic.length === 2, `anthropic rows: ${anthropic.length}`);
		assert(
			anthropic.every(row => row.kind === "oauth" && row.hint === null),
			"oauth rows carry kind oauth, no hint",
		);
		assert(
			anthropic.some(row => row.identity === "work@example.com"),
			"oauth identity is the email",
		);
		const keys = rows();
		assert(keys.length === 2, `api_key rows: ${keys.length}`);
		const dead = keys.find(row => row.disabled !== null);
		assert(dead?.disabled === "disabled by user" && dead.hint === "…9999", "disabled row listed with cause and hint");
		assert(!keys.some(row => row.hint === "…8888"), "a removed row (deleted by user) is left out");
		assert(
			keys.every(row => !row.isDefault && row.active === false && row.pinned === false && row.label === null),
			"clean flags",
		);
		work = idOf("anthropic", row => row.identity === "work@example.com");
		home = idOf("anthropic", row => row.identity === "home@example.com");
		k0 = idOf(PROVIDER, row => row.hint === "…0000");
	});

	it("addApiKey x2 on one provider keeps every row", () => {
		k1 = auth.addApiKey(PROVIDER, "sk-second-k1-1111", "work");
		k2 = auth.addApiKey(PROVIDER, "sk-third-k2-2222");
		assert(k1 !== k2 && k1 > k0 && k2 > k1, "distinct ascending ids");
		const enabled = rows().filter(row => row.disabled === null);
		assert(enabled.length === 3, `enabled api keys: ${enabled.length}, want 3`);
		assert(auth.addApiKey(PROVIDER, "sk-second-k1-1111") === k1, "an identical key returns its existing row");
	});

	it("renameCredential names a row and refuses a clash within the provider", () => {
		auth.renameCredential(k2, "personal");
		assert(rows().find(row => row.id === k2)?.label === "personal", "label stored");
		let refused = false;
		try {
			auth.renameCredential(k0, "WORK");
		} catch {
			refused = true;
		}
		assert(refused, "a case-insensitive clash must throw");
		auth.renameCredential(work, "work");
		assert(
			(auth.listCredentials("anthropic") as Array<Record<string, any>>).find(row => row.id === work)?.label ===
				"work",
			"the same name is free on another provider",
		);
		auth.renameCredential(k0, null);
		assert(rows().find(row => row.id === k0)?.label === null, "null clears the name");
	});

	it("setDefaultCredential marks one default per provider; null clears", () => {
		auth.setDefaultCredential(PROVIDER, k1);
		auth.setDefaultCredential(PROVIDER, k2);
		const defaults = rows().filter(row => row.isDefault);
		assert(defaults.length === 1 && defaults[0].id === k2, "exactly the last default");
		auth.setDefaultCredential(PROVIDER, null);
		assert(
			rows().every(row => !row.isDefault),
			"null clears",
		);
	});

	it("resolution: lowest id, then default, then pin", async () => {
		assert((await api.getApiKey(PROVIDER, "s-order-1")) === "sk-fixture-k0-0000", "no pin, no default: lowest id");
		auth.setDefaultCredential(PROVIDER, k2);
		assert((await api.getApiKey(PROVIDER, "s-order-2")) === "sk-third-k2-2222", "default beats lowest id");
		assert(auth.pinSessionCredential(PROVIDER, "s-order-3", k1), "api_key pin accepted");
		assert((await api.getApiKey(PROVIDER, "s-order-3")) === "sk-second-k1-1111", "pin beats default");
		assert((await api.getApiKey(PROVIDER, "s-order-4")) === "sk-third-k2-2222", "the pin stays in its session");
		const marks = rows();
		assert(!marks.some(row => row.active), "no session id: nothing active");
		const active = (auth.listCredentials(PROVIDER, "s-order-3") as Array<Record<string, any>>).filter(
			row => row.active,
		);
		assert(active.length === 1 && active[0].id === k1 && active[0].pinned === true, "active marks the pinned row");
		auth.clearSessionCredential(PROVIDER, "s-order-3");
		assert((await api.getApiKey(PROVIDER, "s-order-3")) === "sk-third-k2-2222", "cleared pin falls to the default");
		const afterClear = auth.listCredentials(PROVIDER, "s-order-3") as Array<Record<string, any>>;
		assert(!afterClear.some(row => row.pinned), "no row pinned after clearing");
		assert(afterClear.find(row => row.active)?.id === k2, "with a default, the default is active");
		auth.setDefaultCredential(PROVIDER, null);
	});

	it("a served turn adopts its row as the session's one choice; a cleared choice picks again", async () => {
		assert((await api.getApiKey(PROVIDER, "s-pick")) === "sk-fixture-k0-0000", "no pin, no default: lowest id");
		assert(api.adopt(PROVIDER, "s-pick") === k0, "the turn's row is adopted");
		const marks = (auth.listCredentials(PROVIDER, "s-pick") as Array<Record<string, any>>).filter(row => row.active);
		assert(
			marks.length === 1 && marks[0].id === k0 && marks[0].pinned === true,
			"the adopted row is the session's pin",
		);
		assert(api.adopt(PROVIDER, "s-pick") === undefined, "an existing pin is never replaced");
		auth.setDefaultCredential(PROVIDER, k2);
		assert((await api.getApiKey(PROVIDER, "s-pick")) === "sk-fixture-k0-0000", "a later default does not move it");
		auth.clearSessionCredential(PROVIDER, "s-pick");
		assert((await api.getApiKey(PROVIDER, "s-pick")) === "sk-third-k2-2222", "cleared: picks again, the default now");
		auth.setDefaultCredential(PROVIDER, null);
		await api.getApiKey("anthropic", "s-pick");
		assert(api.adopt("anthropic", "s-pick") !== undefined, "a ranked oauth row is adopted too");
		const oauthMarks = (auth.listCredentials("anthropic", "s-pick") as Array<Record<string, any>>).filter(
			row => row.active,
		);
		assert(oauthMarks.length === 1 && oauthMarks[0].pinned === true, "one active oauth row");
		assert(api.adopt("anthropic", "s-never-served") === undefined, "no served row, nothing adopted");
	});

	it("a provider with one usable row makes it active with no setup", () => {
		const provider = "ccw-selftest-solo";
		const id = auth.addApiKey(provider, "sk-solo-1234");
		const marks = auth.listCredentials(provider, "s-solo") as Array<Record<string, any>>;
		assert(
			marks.length === 1 && marks[0].id === id && marks[0].active === true,
			"the sole row is active before a request",
		);
	});

	it("pin oauth: pinSessionCredential and pinSessionOAuthAccount select the account", async () => {
		assert(auth.pinSessionCredential("anthropic", "s-oauth-1", home), "oauth pin accepted");
		assert((await api.getApiKey("anthropic", "s-oauth-1")) === "access-home@example.com", "pinned oauth resolves");
		assert(api.pinOAuth("anthropic", "s-oauth-2", work), "upstream pin accepted");
		assert((await api.getApiKey("anthropic", "s-oauth-2")) === "access-work@example.com", "upstream pin resolves");
		assert(!auth.pinSessionCredential("anthropic", "s-oauth-3", 999_999), "a missing row is refused");
	});

	it("idle warmth cannot override an explicit pin (fake clock, anthropic)", async () => {
		// Control: a resume-seeded sticky (lastUsedAtMs given) is not explicit, so after 2h idle ranking moves it.
		api.pinOAuth("anthropic", "s-warm-control", work, Date.now() - 2 * HOUR);
		const control = await api.getApiKey("anthropic", "s-warm-control");
		assert(control === "access-home@example.com", `control must re-rank to the cool account, got ${control}`);
		auth.pinSessionCredential("anthropic", "s-warm-1", work);
		api.pinOAuth("anthropic", "s-warm-2", work);
		assert((await api.getApiKey("anthropic", "s-warm-1")) === "access-work@example.com", "pinned before idle");
		clockOffsetMs += 2 * HOUR;
		try {
			assert(
				(await api.getApiKey("anthropic", "s-warm-1")) === "access-work@example.com",
				"pinSessionCredential holds",
			);
			assert(
				(await api.getApiKey("anthropic", "s-warm-2")) === "access-work@example.com",
				"pinSessionOAuthAccount holds",
			);
		} finally {
			clockOffsetMs -= 2 * HOUR;
		}
	});

	it("a blocked pinned row does not fall over to another row", async () => {
		auth.pinSessionCredential("anthropic", "s-block-1", work);
		const usage = await api.markReached("anthropic", "s-block-1", { retryAfterMs: HOUR });
		assert(usage.switched === false, "usage limit on a pinned row reports no switch");
		assert(
			(await api.getApiKey("anthropic", "s-block-1")) === "access-work@example.com",
			"still the pinned oauth row",
		);
		const rotated = await api.rotate("anthropic", "s-block-1", { error: new Error("401 unauthorized") });
		assert(rotated === false, "401 rotation on a pinned row reports no sibling");
		assert((await api.getApiKey("anthropic", "s-block-1")) === "access-work@example.com", "no fall-over after 401");
		auth.pinSessionCredential(PROVIDER, "s-block-2", k1);
		const keyUsage = await api.markReached(PROVIDER, "s-block-2", { retryAfterMs: HOUR });
		assert(keyUsage.switched === false, "usage limit on a pinned key reports no switch");
		assert((await api.getApiKey(PROVIDER, "s-block-2")) === "sk-second-k1-1111", "still the pinned key");
		// Before a turn is adopted the pool still moves off a blocked key; after it, nothing moves.
		await api.getApiKey(PROVIDER, "s-block-3");
		const poolUsage = await api.markReached(PROVIDER, "s-block-3", { retryAfterMs: HOUR });
		assert(poolUsage.switched === true, "control: an unadopted session switches");
		await api.getApiKey(PROVIDER, "s-block-4");
		api.adopt(PROVIDER, "s-block-4");
		const adoptedUsage = await api.markReached(PROVIDER, "s-block-4", { retryAfterMs: HOUR });
		assert(adoptedUsage.switched === false, "an adopted row reports no switch");
	});

	it("a pin on a disabled row fails with a message naming the row and the fix", async () => {
		auth.pinSessionCredential(PROVIDER, "s-dead", k2);
		assert(await auth.disableCredentialById(k2, "disabled by user"), "disable");
		let message = "";
		try {
			await api.getApiKey(PROVIDER, "s-dead");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert(message.includes(`#${k2}`) && message.includes("/providers"), `error names row and fix: ${message}`);
		assert(auth.enableCredential(k2), "enableCredential re-enables");
		assert(rows().find(row => row.id === k2)?.disabled === null, "row enabled again");
		assert((await api.getApiKey(PROVIDER, "s-dead")) === "sk-third-k2-2222", "pin serves again once enabled");
	});

	it("removeCredential(provider, id) removes one row and keeps the rest", async () => {
		assert(await auth.removeCredential(PROVIDER, k0), "removed");
		assert(!rows().some(row => row.id === k0), "a removed row leaves listCredentials");
		assert(rows().filter(row => row.disabled === null).length === 2, "other keys stay");
	});

	it("a session pin beats a config key; a config key naming an unset env var is ignored", async () => {
		const unsetEnv = "CCW_SELFTEST_UNSET_CONFIG_KEY";
		const setEnv = "CCW_SELFTEST_SET_CONFIG_KEY";
		const stored = ["sk-second-k1-1111", "sk-third-k2-2222"];
		delete process.env[unsetEnv];
		process.env[setEnv] = "sk-config-env-9999";
		try {
			api.setConfigKey(PROVIDER, unsetEnv);
			const pooled = await api.getApiKey(PROVIDER, "s-cfg-unset");
			assert(stored.includes(pooled ?? ""), `an unset config key yields to the stored rows, got ${pooled}`);
			assert(auth.pinSessionCredential(PROVIDER, "s-cfg-pin", k2), "pin accepted beside an unset config key");
			assert((await api.getApiKey(PROVIDER, "s-cfg-pin")) === "sk-third-k2-2222", "pin beats an unset config key");

			api.setConfigKey(PROVIDER, setEnv);
			assert(
				(await api.getApiKey(PROVIDER, "s-cfg-set")) === "sk-config-env-9999",
				"a set config key beats the pool",
			);
			assert((await api.getApiKey(PROVIDER, "s-cfg-pin")) === "sk-third-k2-2222", "pin beats a set config key");
			assert(auth.pinSessionCredential(PROVIDER, "s-cfg-pin-2", k1), "pin accepted beside a set config key");
			assert((await api.getApiKey(PROVIDER, "s-cfg-pin-2")) === "sk-second-k1-1111", "the new pin serves");
			const configMarks = auth.listCredentials(PROVIDER, "s-cfg-set") as Array<Record<string, any>>;
			assert(!configMarks.some(row => row.active || row.pinned), "a config key marks no row");
			const pinMarks = (auth.listCredentials(PROVIDER, "s-cfg-pin") as Array<Record<string, any>>).filter(
				row => row.active,
			);
			assert(pinMarks.length === 1 && pinMarks[0].id === k2 && pinMarks[0].pinned === true, "the pin stays marked");
		} finally {
			api.removeConfigKey(PROVIDER);
			auth.clearSessionCredential(PROVIDER, "s-cfg-pin");
			auth.clearSessionCredential(PROVIDER, "s-cfg-pin-2");
			delete process.env[setEnv];
		}
	});

	it("removeCredential(provider, id) removes a disabled row too, and a removed row stays gone", async () => {
		const id = auth.addApiKey(PROVIDER, "sk-disabled-then-removed-5555");
		assert(await auth.disableCredentialById(id, "disabled by user"), "disable");
		assert(await auth.removeCredential(PROVIDER, id), "a disabled row is removed");
		assert(!rows().some(row => row.id === id), "a removed disabled row leaves listCredentials");
		assert(!(await auth.removeCredential(PROVIDER, id)), "a removed row is already gone");
		assert(!auth.enableCredential(id), "enableCredential refuses a removed row");
		let renameError = "";
		try {
			auth.renameCredential(id, "again");
		} catch (error) {
			renameError = error instanceof Error ? error.message : String(error);
		}
		assert(renameError.includes(`${id}`), `renameCredential refuses a removed row: ${renameError}`);
		let defaultError = "";
		try {
			auth.setDefaultCredential(PROVIDER, id);
		} catch (error) {
			defaultError = error instanceof Error ? error.message : String(error);
		}
		assert(defaultError.includes(`${id}`), `setDefaultCredential refuses a removed row: ${defaultError}`);
	});

	it("request path: models.yml authHeader with an env-var apiKey sends the stored key, the env value or the pin", async () => {
		const provider = "ccw-selftest-hdr";
		const envName = "CCW_SELFTEST_HDR_KEY";
		const modelsPath = path.join(tmp, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				`  ${provider}:`,
				"    baseUrl: https://ccw-selftest-hdr.invalid/v1",
				"    api: openai-completions",
				`    apiKey: ${envName}`,
				"    authHeader: true",
				"    models:",
				"      - id: m1",
				"        name: M1",
				"",
			].join("\n"),
		);
		const registry = new ModelRegistry(auth, modelsPath);
		const model = registry.find(provider, "m1");
		assert(model, "the models.yml model loads");
		const sent = async (sessionId: string): Promise<string | null> => {
			let authorization: string | null = null;
			const fetch: FetchImpl = async (_url, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				const done = {
					id: "c",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				};
				return new Response(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			};
			const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
			for await (const _event of streamSimple(model, context, {
				apiKey: registry.resolver(model, sessionId),
				fetch,
				maxTokens: 16,
			})) {
				// Drain so the request is sent.
			}
			return authorization;
		};
		delete process.env[envName];
		try {
			const first = auth.addApiKey(provider, "sk-hdr-first-1111");
			const second = auth.addApiKey(provider, "sk-hdr-second-2222");
			assert((await sent("s-hdr-pool")) === "Bearer sk-hdr-first-1111", "an unset env key sends the stored key");
			assert(auth.pinSessionCredential(provider, "s-hdr-pin", second), "pin accepted");
			assert((await sent("s-hdr-pin")) === "Bearer sk-hdr-second-2222", "the pin is sent beside an unset env key");
			process.env[envName] = "sk-hdr-env-3333";
			assert((await sent("s-hdr-env")) === "Bearer sk-hdr-env-3333", "a set env key beats the pool");
			assert((await sent("s-hdr-pin")) === "Bearer sk-hdr-second-2222", "the pin beats a set env key");
			assert(first < second, "ids ascend");
		} finally {
			delete process.env[envName];
			api.removeConfigKey(provider);
			auth.clearSessionCredential(provider, "s-hdr-pin");
		}
	}, 20000);

	it("a removal clears only the remover's pin and fires onCredentialRemoved; a disabled key outlives a login", async () => {
		const provider = "ccw-selftest-rm";
		const a = auth.addApiKey(provider, "sk-rm-a-6666");
		auth.addApiKey(provider, "sk-rm-b-7777");
		assert(auth.pinSessionCredential(provider, "s-rm-1", a), "pin s-rm-1");
		assert(auth.pinSessionCredential(provider, "s-rm-2", a), "pin s-rm-2");
		const events: Array<{ provider: string; credentials: Array<{ id: number }> }> = [];
		const onRemoved = auth.credentials.onRemoved.bind(auth.credentials);
		const unsubscribe = onRemoved((event: (typeof events)[number]) => {
			// Events fired before the first listener are replayed to it; only this provider counts here.
			if (event.provider === provider) events.push(event);
		});
		try {
			assert(await auth.removeCredential(provider, a, { sessionId: "s-rm-1" }), "removed");
			assert(
				events.length === 1 && events[0].credentials[0]?.id === a,
				`one event naming #${a}: ${JSON.stringify(events)}`,
			);
			assert((await api.getApiKey(provider, "s-rm-1")) === "sk-rm-b-7777", "the remover's pin is cleared");
			let stale = "";
			try {
				await api.getApiKey(provider, "s-rm-2");
			} catch (error) {
				stale = error instanceof Error ? error.message : String(error);
			}
			assert(stale.includes(`${a}`), `another session keeps its strict error: ${stale}`);
		} finally {
			unsubscribe();
			auth.clearSessionCredential(provider, "s-rm-2");
		}
		const kept = auth.addApiKey(provider, "sk-kept-disabled-4444");
		await auth.disableCredentialById(kept, "disabled by user");
		const loginKey: AuthCredential = { type: "api_key", key: "sk-login-3333", source: "login" };
		await store.upsertAuthCredential(provider, loginKey);
		const keptRow = (auth.listCredentials(provider) as Array<Record<string, any>>).find(row => row.id === kept);
		assert(keptRow?.disabled === "disabled by user", "a user-disabled key survives another key's login");
	});

	it("a login of a removed or refresh-failed account revives its row, so a pin on the old id serves", async () => {
		const provider = "ccw-selftest-revive";
		const credential: OAuthCredential = {
			type: "oauth",
			access: "access-revive",
			refresh: "refresh-revive",
			expires: Date.now() + DAY,
			email: "revive@example.com",
			accountId: "acc-revive",
		};
		const upsert = async (item: AuthCredential) => store.upsertAuthCredential(provider, item);
		await upsert(credential);
		await api.reload();
		const id = idOf(provider, row => row.identity === "revive@example.com");
		auth.renameCredential(id, "revive");
		assert(auth.pinSessionCredential(provider, "s-revive", id), "pin");
		assert(await auth.removeCredential(provider, id), "removed");
		await upsert({ ...credential, access: "access-revive-2" });
		await api.reload();
		const row = (auth.listCredentials(provider) as Array<Record<string, any>>).find(candidate => candidate.id === id);
		assert(row?.label === "revive" && row.disabled === null, `the same row is back: ${JSON.stringify(row)}`);
		assert((await api.getApiKey(provider, "s-revive")) === "access-revive-2", "the old pin serves the revived row");
		auth.disableCredentialById(id, "oauth refresh failed: 400 invalid_grant");
		await upsert({ ...credential, access: "access-revive-3" });
		await api.reload();
		const ids = (auth.listCredentials(provider) as Array<Record<string, any>>).map(candidate => candidate.id);
		assert(
			ids.length === 1 && ids[0] === id,
			`a refresh-failed row is revived, not replaced: ${JSON.stringify(ids)}`,
		);
		assert(
			(await api.getApiKey(provider, "s-revive")) === "access-revive-3",
			"the old pin serves after a failed refresh",
		);
	});

	it("a binding's exclusive pin survives a subagent's inherit; a plain pin stays plain", async () => {
		const [bound, plain] = rows()
			.filter(row => row.disabled === null)
			.map(row => row.id);
		assert(bound !== undefined && plain !== undefined, "two usable rows");
		assert(auth.pinSessionCredential(PROVIDER, "s-excl", bound, { exclusive: true }), "exclusive pin");
		assert(auth.pinSessionCredential(PROVIDER, "s-plain", plain), "plain pin");
		api.inherit("s-excl", "s-excl-child");
		api.inherit("s-plain", "s-plain-child");
		assert(
			auth.sessionPinIsExclusive(PROVIDER, "s-excl-child") === true,
			"the child keeps the binding's exclusive pin",
		);
		assert(auth.sessionPinIsExclusive(PROVIDER, "s-plain-child") === false, "a plain pin stays plain in the child");
	});

	it("refreshCredentials: forced refreshes every OAuth row; unforced skips rows far from expiry", async () => {
		const idle = await api.refresh({ provider: "anthropic", skewMs: 0 });
		assert(idle.refreshed.length === 0 && idle.failed.length === 0, `nothing expiring: ${JSON.stringify(idle)}`);
		const forced = await api.refresh({ provider: "anthropic", force: true });
		const ids = [...forced.refreshed].sort((a: number, b: number) => a - b);
		assert(
			ids.length === 2 && ids.includes(work) && ids.includes(home),
			`forced refreshes both: ${JSON.stringify(forced)}`,
		);
		const live = (auth.listCredentials("anthropic") as Array<Record<string, any>>).filter(
			row => row.disabled === null,
		);
		assert(live.length === 2, "a refresh disables nothing");
	});

	it("saveApiKey still replaces every key of the provider", () => {
		store.saveApiKey(PROVIDER, "sk-replacement-7777");
		const enabled = rows().filter(row => row.disabled === null);
		assert(enabled.length === 1 && enabled[0].hint === "…7777", `enabled after saveApiKey: ${enabled.length}`);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredentials, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ANTHROPIC_OAUTH_GRANT_TTL_MS } from "@oh-my-pi/pi-ai/oauth/anthropic-constants";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

function mintOAuth(overrides: Partial<OAuthCredentials> & { email: string }): OAuthCredentials {
	return {
		access: `access-${overrides.email}`,
		refresh: `refresh-${overrides.email}`,
		expires: Date.now() + 60_000,
		...overrides,
	};
}

// `omp auth-broker deadlines --json` replaces the raw SQL ccw's 6-hourly renewal sweep used to
// run against agent.db (internal/hostcli/authrefresh_omp.go), so a schema drift or a constant
// rename breaks a fork test here first, not a silent 6-hourly sweep.
async function runDeadlinesCapturingStdout(): Promise<unknown[]> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({ action: "deadlines", flags: { json: true } });
	} finally {
		process.stdout.write = originalWrite;
	}
	return JSON.parse(captured.trim() || "[]") as unknown[];
}

describe("auth-broker deadlines", () => {
	let agentDir = "";
	let store: SqliteAuthCredentialStore | undefined;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deadlines-"));
		setAgentDir(agentDir);
		store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	});

	afterEach(async () => {
		store?.close();
		await removeWithRetries(agentDir);
	});

	test("an empty store prints an empty array", async () => {
		store!.close();
		store = undefined;
		expect(await runDeadlinesCapturingStdout()).toEqual([]);
	});

	test("an anthropic row 25 days after authorization gets a grant-ttl deadline", async () => {
		const authorizedAt = Date.now() - 25 * DAY_MS;
		await store!.saveOAuth(
			"anthropic",
			mintOAuth({ email: "due@example.test", orgName: "Sentinel Tech", authorizedAt }),
		);
		store!.close();
		store = undefined;

		const rows = await runDeadlinesCapturingStdout();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "anthropic",
			email: "due@example.test",
			orgName: "Sentinel Tech",
			basis: "grant-ttl",
			reloginBy: authorizedAt + ANTHROPIC_OAUTH_GRANT_TTL_MS,
		});
		expect(rows[0]).not.toHaveProperty("disabledCause");
	});

	test("a disabled row names its cause and carries no deadline", async () => {
		await store!.saveOAuth("anthropic", mintOAuth({ email: "dead@example.test", authorizedAt: Date.now() - DAY_MS }));
		const row = store!.listAuthCredentials("anthropic")[0]!;
		await store!.deleteAuthCredential(row.id, "invalid_grant");
		store!.close();
		store = undefined;

		const rows = await runDeadlinesCapturingStdout();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "anthropic",
			email: "dead@example.test",
			disabledCause: "invalid_grant",
			reloginBy: null,
			basis: null,
		});
	});

	test("a rotating provider with a real refresher gets no invented deadline", async () => {
		await store!.saveOAuth("openai-codex", mintOAuth({ email: "codex@example.test" }));
		store!.close();
		store = undefined;

		const rows = await runDeadlinesCapturingStdout();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "openai-codex",
			email: "codex@example.test",
			reloginBy: null,
			basis: null,
		});
	});

	test("a provider whose auth rule declares no refresh counts down its access-token expiry", async () => {
		const expires = Date.now() + 4 * DAY_MS;
		await store!.saveOAuth("perplexity", mintOAuth({ email: "nore@example.test", expires }));
		store!.close();
		store = undefined;

		const rows = await runDeadlinesCapturingStdout();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "perplexity",
			email: "nore@example.test",
			basis: "no-refresh",
			reloginBy: expires,
		});
	});
});

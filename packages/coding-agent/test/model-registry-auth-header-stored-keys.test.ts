import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const PROVIDER = "authheader-proxy";
const ENV_NAME = "PI_TEST_AUTHHEADER_PROXY_KEY";

let tempDir = "";
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-authheader-stored-"));
	fs.writeFileSync(
		path.join(tempDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: "https://authheader-proxy.example.com/v1",
					api: "openai-completions",
					apiKey: ENV_NAME,
					authHeader: true,
					models: [{ id: "m1", name: "M1" }],
				},
			},
		}),
	);
	authStorage = await AuthStorage.create(":memory:");
	delete process.env[ENV_NAME];
});

afterEach(() => {
	authStorage.close();
	delete process.env[ENV_NAME];
	fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Send one request the way the agent loop does and return the Authorization header that reached the wire. */
async function sentAuthorization(registry: ModelRegistry, sessionId: string): Promise<string | undefined> {
	const model = registry.find(PROVIDER, "m1");
	if (!model) throw new Error("expected the custom model");
	let authorization: string | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		authorization = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("authorization") ?? undefined;
		const chunks = [
			{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
			{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	};
	const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	for await (const _event of streamSimple(model, context, {
		apiKey: registry.resolver(model, sessionId),
		fetch,
		maxTokens: 16,
	})) {
		// Drain the stream so the request is sent.
	}
	return authorization;
}

test("authHeader with an unset env-var apiKey sends the stored key, and a session pin", async () => {
	const first = authStorage.addApiKey(PROVIDER, "sk-stored-first");
	const second = authStorage.addApiKey(PROVIDER, "sk-stored-second");
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));

	expect(await sentAuthorization(registry, "s-pool")).toBe("Bearer sk-stored-first");
	expect(authStorage.pinSessionCredential(PROVIDER, "s-pin", second)).toBe(true);
	expect(await sentAuthorization(registry, "s-pin")).toBe("Bearer sk-stored-second");
	expect(first).toBeLessThan(second);
});

test("authHeader with a set env-var apiKey: the env value serves, and a session pin beats it", async () => {
	process.env[ENV_NAME] = "sk-from-env";
	const pinned = authStorage.addApiKey(PROVIDER, "sk-stored-pinned");
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));

	expect(await sentAuthorization(registry, "s-env")).toBe("Bearer sk-from-env");
	expect(authStorage.pinSessionCredential(PROVIDER, "s-pin", pinned)).toBe(true);
	expect(await sentAuthorization(registry, "s-pin")).toBe("Bearer sk-stored-pinned");
});

test("authHeader with no stored row still sends the config key as before", async () => {
	process.env[ENV_NAME] = "sk-from-env";
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
	expect(await sentAuthorization(registry, "s-only")).toBe("Bearer sk-from-env");
	const model = registry.find(PROVIDER, "m1");
	expect(model && (await registry.resolveModelHeaders(model))?.Authorization).toBe("Bearer sk-from-env");
});

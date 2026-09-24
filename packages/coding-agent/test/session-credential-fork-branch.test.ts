import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// fork()/branch()/newSession() never dispatch a model call, so the agent
// here only needs to satisfy AgentSession's constructor shape.
function idleAgent(model: Model): Agent {
	const mock = createMockModel();
	return new Agent({
		getApiKey: () => "unused",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
	});
}

function makeSession(modelRegistry: ModelRegistry, model: Model, tempDir: TempDir): AgentSession {
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const session = new AgentSession({ agent: idleAgent(model), sessionManager, settings, modelRegistry });
	// A user message entry gives branch() something to branch from; appended
	// directly so this test never runs the model-dispatch/API-key path.
	session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Hello" }],
		attribution: "user",
		timestamp: Date.now(),
	});
	return session;
}

describe("Addendum 5 S-2: fork/branch carry the session credential pin", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let credentialA: number;
	let credentialB: number;

	beforeAll(async () => {
		authStorage = createInMemoryAuthStorage();
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
		modelRegistry = new ModelRegistry(authStorage);
		await authStorage.credentials.upsert("anthropic", {
			type: "oauth",
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + 60_000,
			email: "a@example.test",
		});
		await authStorage.credentials.upsert("anthropic", {
			type: "oauth",
			access: "access-b",
			refresh: "refresh-b",
			expires: Date.now() + 60_000,
			email: "b@example.test",
		});
		await authStorage.credentials.reload();
		const rows = authStorage.listCredentials("anthropic");
		credentialA = rows.find(row => row.identity === "a@example.test")!.id;
		credentialB = rows.find(row => row.identity === "b@example.test")!.id;
	});

	let session: AgentSession | undefined;
	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("keeps the pin across a fork, under the new session id", async () => {
		using tempDir = TempDir.createSync("@omp-credential-fork-");
		session = makeSession(modelRegistry, model, tempDir);
		const parentId = session.sessionManager.getSessionId();
		expect(authStorage.pinSessionCredential("anthropic", parentId, credentialA)).toBe(true);

		expect(await session.fork()).toBe(true);
		const childId = session.sessionManager.getSessionId();
		expect(childId).not.toBe(parentId);

		const childRows = authStorage.listCredentials("anthropic", childId);
		expect(childRows.find(row => row.id === credentialA)?.pinned).toBe(true);
	});

	it("keeps the pin across a branch, under the new session id", async () => {
		using tempDir = TempDir.createSync("@omp-credential-branch-");
		session = makeSession(modelRegistry, model, tempDir);
		const parentId = session.sessionManager.getSessionId();
		expect(authStorage.pinSessionCredential("anthropic", parentId, credentialB)).toBe(true);

		const userEntry = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected a user entry to branch from");
		const result = await session.branch(userEntry.id);
		expect(result.cancelled).toBe(false);
		const childId = session.sessionManager.getSessionId();
		expect(childId).not.toBe(parentId);

		const childRows = authStorage.listCredentials("anthropic", childId);
		expect(childRows.find(row => row.id === credentialB)?.pinned).toBe(true);
	});

	it("does not carry the pin across /new: a new session starts fresh", async () => {
		using tempDir = TempDir.createSync("@omp-credential-new-");
		session = makeSession(modelRegistry, model, tempDir);
		const parentId = session.sessionManager.getSessionId();
		expect(authStorage.pinSessionCredential("anthropic", parentId, credentialA)).toBe(true);

		expect(await session.newSession()).toBe(true);
		const nextId = session.sessionManager.getSessionId();
		expect(nextId).not.toBe(parentId);

		const nextRows = authStorage.listCredentials("anthropic", nextId);
		expect(nextRows.find(row => row.id === credentialA)?.pinned).toBe(false);
	});
});

// sdk.ts pushes createAgentProfileExtension into the rebindable/prepared slice of
// inlineExtensions (agent-profile/index.ts is registered before options.extensions, and
// rebindableInlineExtensionCount counts it), so a restricted task child -- which binds only
// `preloadedPreparedExtensions`, never new inline factories -- still gets a fresh instance of
// the extension, with its own before_agent_start/before_provider_request hooks.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { createAgentProfileExtension } from "../src/agent-profile";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession, type CreateAgentSessionOptions } from "../src/sdk";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profile-child-propagation-"));
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	resetSettingsForTest();
});

afterEach(() => {
	resetSettingsForTest();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function baseOptions(authStorage: AuthStorage, settings: Settings): CreateAgentSessionOptions {
	return {
		cwd: tempDir,
		agentDir: path.join(tempDir, "agent"),
		sessionManager: SessionManager.inMemory(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
	};
}

test("a restricted task child receives the agent-profile extension's hooks and command via preparedExtensions", async () => {
	const authStorage = createInMemoryAuthStorage();
	const settings = await Settings.init({ inMemory: true, agentDir: path.join(tempDir, "agent") });
	try {
		const { session: parent } = await createAgentSession(baseOptions(authStorage, settings));
		try {
			// The parent itself is unrestricted, so it built the extension inline and carries it
			// forward as a prepared (rebindable) factory.
			expect(parent.preparedExtensions?.some(p => p.factory === createAgentProfileExtension)).toBe(true);
			expect(parent.hasExtensionHandlers("before_agent_start")).toBe(true);
			expect(parent.hasExtensionHandlers("before_provider_request")).toBe(true);
			expect(parent.extensionRunner?.getCommand("agent-profile")).toBeDefined();

			const { session: child } = await createAgentSession({
				...baseOptions(authStorage, settings),
				model: parent.model,
				restrictToolNames: true,
				preloadedPreparedExtensions: parent.preparedExtensions,
			});
			try {
				await initializeExtensions(child, { reportSendError: () => {}, reportRuntimeError: () => {} });
				// The two hooks the child half of the mechanism depends on: the anchor and the
				// guard, both registered by a FRESH run of the factory bound to the child's own
				// ExtensionAPI (bindPreparedExtensions never reuses the parent's).
				expect(child.hasExtensionHandlers("before_agent_start")).toBe(true);
				expect(child.hasExtensionHandlers("before_provider_request")).toBe(true);
				expect(child.extensionRunner?.getCommand("agent-profile")).toBeDefined();
			} finally {
				await child.dispose();
			}
		} finally {
			await parent.dispose();
		}
	} finally {
		authStorage.close();
	}
});

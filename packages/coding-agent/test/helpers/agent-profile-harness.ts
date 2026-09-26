// Shared fakes for the agent-profile extension tests, ported from ccw's Go-embedded JS harness
// (claude-code-workflows internal/policy/omp_test.go). Real settings and real credential
// shapes; only the model catalog and the auth store are fakes, matching the original.
import type { ExtensionAPI, ExtensionContext } from "../../src/extensibility/extensions";

// The mapping tests grade routing, not the spend grant, so the grant is off unless a test turns
// it on. agent-profile-spawn-grant.test.ts does, and restores this default after each case.
process.env.CCW_SPAWN_GRANT = "off";

// One agent file, in the frontmatter shape this fork parses.
export const agentFile = (name: string, description: string): string =>
	"---\nname: " + name + "\ndescription: " + description + "\n---\nBody.\n";

export const oauth = (id: number, provider: string, identity: string, extra: Record<string, unknown> = {}) => ({
	id,
	provider,
	kind: "oauth",
	label: null,
	identity,
	hint: null,
	disabled: null,
	isDefault: false,
	...extra,
});

export const apiKey = (id: number, provider: string, hint: string, extra: Record<string, unknown> = {}) => ({
	id,
	provider,
	kind: "api_key",
	label: null,
	identity: null,
	hint,
	disabled: null,
	isDefault: false,
	...extra,
});

// c@example.org (#3) is a third subscription for the precedence case. #4 and #5 are disabled, so
// no picker offers them. twin@example.com is one email on two rows (#10, #11), so it selects
// neither. deepseek holds two API keys: its default (#6) and one labelled spare (#12).
export const CREDENTIALS = [
	oauth(1, "anthropic", "a@example.com"),
	oauth(2, "anthropic", "b@example.com"),
	oauth(3, "anthropic", "c@example.org"),
	oauth(4, "anthropic", "d@example.net", { disabled: "oauth refresh failed: invalid_grant" }),
	apiKey(5, "anthropic", "…9z9z", { disabled: "deleted by user" }),
	apiKey(6, "deepseek", "…a1b2", { isDefault: true }),
	oauth(7, "openai-codex", "o@example.com"),
	oauth(10, "anthropic", "twin@example.com"),
	oauth(11, "anthropic", "twin@example.com"),
	apiKey(12, "deepseek", "…c3d4", { label: "spare" }),
];

// cost is $/1M tokens, the shape spawn-grant.ts's rule 3 reads (agent-profile-spawn-grant.test.ts).
export const DEEPSEEK = {
	provider: "deepseek",
	id: "deepseek-flash",
	name: "DeepSeek Flash",
	reasoning: true,
	thinking: { mode: "effort", efforts: ["high", "xhigh"] },
	cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
};
export const OPUS = {
	provider: "anthropic",
	id: "claude-opus-5",
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
};
// The cheapest current Opus (Findings): $4/$20. spawn-grant.ts's rule 3 reference model.
export const OPUS55 = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	cost: { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 },
};
export const HAIKU = {
	provider: "anthropic",
	id: "claude-haiku-4-5",
	reasoning: true,
	thinking: { mode: "budget", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
	cost: { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 },
};
export const SONNET = {
	provider: "anthropic",
	id: "claude-sonnet-5",
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
	cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
};
export const CODEX = {
	provider: "openai-codex",
	id: "gpt-5",
	reasoning: true,
	thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
	cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
};
export const MODELS = [DEEPSEEK, OPUS, OPUS55, HAIKU, SONNET, CODEX];

// provider:sessionId -> credential id, the session-sticky row. listCredentials marks it active,
// matching what the request guard reads.
export interface FakeAuthStorage {
	sticky: Record<string, number>;
	pins: { provider: string; sessionId: string; credentialId: number; exclusive: boolean }[];
	credentials: typeof CREDENTIALS;
	listCredentials: (provider?: string, sessionId?: string) => (typeof CREDENTIALS)[number][];
	pinSessionCredential: (
		provider: string,
		sessionId: string,
		id: number,
		options?: { exclusive?: boolean },
	) => boolean;
	keys: { describe: (provider: string, sessionId?: string) => string | undefined };
}

// A fresh copy every call: CREDENTIALS is one module-level array shared by every test file in
// the same bun test process, and a test that labels, disables or splices a row (G4, K5, L1-L6)
// must never leak that mutation into a sibling file's run.
export const makeAuthStorage = (
	credentials: typeof CREDENTIALS = CREDENTIALS.map(row => ({ ...row })),
): FakeAuthStorage => {
	const sticky: Record<string, number> = {};
	const pins: FakeAuthStorage["pins"] = [];
	return {
		sticky,
		pins,
		credentials,
		listCredentials: (provider?: string, sessionId?: string) =>
			credentials
				.filter(row => provider === undefined || row.provider === provider)
				.map(
					row =>
						({
							...row,
							active: sticky[row.provider + ":" + sessionId] === row.id,
						}) as unknown as (typeof CREDENTIALS)[number],
				),
		pinSessionCredential: (provider, sessionId, id, options) => {
			if (!credentials.some(row => row.id === id && row.provider === provider && !row.disabled)) {
				return false;
			}
			pins.push({ provider, sessionId, credentialId: id, exclusive: options?.exclusive === true });
			sticky[provider + ":" + sessionId] = id;
			return true;
		},
		keys: { describe: () => undefined },
	};
};

export interface FakeApi {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	command?: {
		description?: string;
		getArgumentCompletions?: (prefix: string) => unknown;
		handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	};
	bindings?: {
		describe: (agent: string, ctx: ExtensionContext) => string | undefined;
		save: (change: unknown, ctx: ExtensionContext) => Promise<unknown>;
	};
	thinking: string | undefined;
	roster?: string;
	entries: { customType: string; [key: string]: unknown }[];
	notices: string[];
	sent: string[];
	deliveries: string[];
	reports: unknown[];
}

// One fake ExtensionAPI per session (parent or child), matching how bindPreparedExtensions
// re-runs the factory against a fresh ExtensionAPI per session while the extension module stays
// the one imported instance -- so module-scope state (BOUND, APPLIED_PROFILE, …) is shared
// across every `makePi` call in one test, exactly as sdk.ts shares it across a parent and its
// children.
export const makePi = (
	factory: (pi: ExtensionAPI) => void,
	thinking: string | undefined = "off",
): FakeApi & ExtensionAPI => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = {
		handlers,
		thinking,
		entries: [] as FakeApi["entries"],
		notices: [] as string[],
		sent: [] as string[],
		deliveries: [] as string[],
		reports: [] as unknown[],
		getThinkingLevel: () => api.thinking,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, spec: FakeApi["command"]) => {
			api.command = spec;
		},
		registerAgentBindings: (provider: FakeApi["bindings"]) => {
			api.bindings = provider;
		},
		sendMessage: (message: { customType: string; content: unknown }, options?: { deliverAs?: string }) => {
			api.sent.push(message.customType);
			api.deliveries.push(options?.deliverAs ?? "");
			api.reports.push(message.content);
		},
		appendEntry: (customType: string, data?: Record<string, unknown>) => {
			api.entries.push({ customType, ...data });
		},
		// The task tool's text is where the roster comes from (task.md).
		getAllTools: () => [{ name: "task", description: api.roster ?? "" }],
	} as unknown as FakeApi & ExtensionAPI;
	factory(api);
	return api;
};

export interface FakeCtxOptions {
	cwd?: string;
	mode?: string;
	idle?: boolean;
	select?: (title: string, choices: { label: string; description?: string }[]) => Promise<unknown>;
	model?: (typeof MODELS)[number];
	entries?: unknown[];
	branch?: unknown[];
	authStorage?: FakeAuthStorage;
	// Overrides ctx.models.resolve entirely; needed for a role alias ("@judge"), which the
	// default lookup below (a plain id/provider match) does not understand.
	resolve?: (pattern: string) => unknown;
}

// The shape before_subagent_spawn hands the hook.
export const spawn = async (api: FakeApi & ExtensionAPI, agent: string, ctx: ExtensionContext) => {
	const handler = api.handlers.get("before_subagent_spawn");
	if (!handler) {
		return "no handler";
	}
	const result = await handler({ type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [] }, ctx);
	return result === undefined ? "undefined" : result;
};

// What the provider meets when it reads a returned payload. A refusal must not be thenable, or
// the runner's own await trips it and sends the original payload instead.
export const describeRefusal = (payload: unknown): string => {
	if (payload === undefined) {
		return "undefined";
	}
	if ((payload as { then?: unknown }).then !== undefined) {
		return "thenable";
	}
	try {
		JSON.stringify(payload);
		return "readable";
	} catch (error) {
		return "refused: " + (error as Error).message;
	}
};

export const makeCtx = (
	sessionId: string,
	agent: string | null,
	authStorage: FakeAuthStorage,
	notices: string[],
	options: FakeCtxOptions = {},
): ExtensionContext =>
	({
		cwd: options.cwd,
		mode: options.mode ?? "print",
		isIdle: () => options.idle ?? true,
		ui: {
			notify: (message: string, level: string) => {
				notices.push(level + ": " + message);
			},
			setStatus: () => {},
			select: async (title: string, choices: unknown[]) =>
				options.select ? options.select(title, choices as { label: string; description?: string }[]) : undefined,
			input: async () => undefined,
			editor: async (_title: string, text: string) => text,
		},
		setInterval: () => 0,
		model: options.model ?? OPUS,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => options.entries ?? (agent ? [{ type: "session_init", agent }] : []),
			getBranch: () => options.branch ?? [],
		},
		models: {
			resolve: (pattern: string) => {
				if (options.resolve) {
					return options.resolve(pattern);
				}
				const base = String(pattern).split(":")[0];
				if (!base.includes("/")) {
					return MODELS.find(model => model.id.includes(base));
				}
				const [provider, id] = base.split("/");
				const row =
					MODELS.find(model => model.provider === provider && model.id === id) ??
					MODELS.find(model => model.provider === provider);
				return row ? { ...row, id } : undefined;
			},
			list: () => MODELS,
		},
		modelRegistry: { authStorage, getAll: () => MODELS },
	}) as unknown as ExtensionContext;

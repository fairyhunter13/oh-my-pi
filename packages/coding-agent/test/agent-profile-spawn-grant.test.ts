// The spawn grant built into agent-profile: 4 cheap subagents per user prompt run freely, and a
// fifth or any expensive one spends a user-confirmed grant. Only the model decides the tier. The
// first describe ports ccw's internal/policy/omp_spawn_grant_test.go (claude-code-workflows),
// where every spawn ran on the parent's Opus and so always needed the grant.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import {
	apiKey,
	CREDENTIALS,
	type FakeApi,
	HAIKU,
	makeAuthStorage,
	makeCtx,
	makePi,
} from "./helpers/agent-profile-harness";

const EXPENSIVE_MODELS = `expensiveModels:
  - "claude-opus"
  - "claude-fable"
  - "claude-mythos"
  - "(^|/)deepseek-v4-pro"
  - "(^|[/.])kimi-k3"
  - "(^|[/.-])glm-5[.-]3(-prime)?(:thinking)?$"
  - "("
`;

const HAND_YAML = `${EXPENSIVE_MODELS}profiles:
  tier:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: medium }
    sonic: { model: deepseek/deepseek-flash, thinking: high }
  keyed:
    task: { model: anthropic/claude-haiku-4-5, thinking: low, account: metered }
  fleet:
    task: { model: anthropic/claude-sonnet-5, thinking: medium, account: "a@example.com" }
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, account: "b@example.com" }
    sonic: { model: deepseek/deepseek-flash, thinking: off, account: spare }
`;

let agentDir: string;
let seq = 0;
const next = (prefix: string) => prefix + ++seq;

// The query string forces a fresh module instance per case (fresh APPLIED_PROFILE and caches, and
// AGENT_DIR read from this case's PI_CODING_AGENT_DIR), which a static import cannot do.
async function freshModule(): Promise<{
	createAgentProfileExtension: ExtensionFactory;
	expensiveModelPatterns: () => RegExp[];
}> {
	return (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as never;
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-spawn-grant-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.CCW_SPAWN_GRANT;
	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), HAND_YAML);
	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	process.env.CCW_SPAWN_GRANT = "off";
});

// Session entries in the shapes omp writes: { type: "message", id, message }, with a toolResult
// carrying the ask details (tools/ask.ts).
const msg = (message: Record<string, unknown>) => ({ type: "message", id: next("e"), message });
const user = (text: string) => msg({ role: "user", content: [{ type: "text", text }] });
const askMulti = (answer: Record<string, unknown>) => {
	const callId = next("ask");
	return [
		msg({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "ask",
					arguments: { questions: [{ id: "scope" }, { id: "subagents" }] },
				},
			],
		}),
		msg({
			role: "toolResult",
			toolName: "ask",
			toolCallId: callId,
			content: [],
			details: {
				results: [
					{ id: "scope", selectedOptions: ["All"] },
					{ id: "subagents", selectedOptions: [], ...answer },
				],
			},
		}),
	];
};
const askSingle = (id: string, answer: Record<string, unknown>) => {
	const callId = next("ask");
	return [
		msg({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "ask", arguments: { questions: [{ id }] } }],
		}),
		msg({
			role: "toolResult",
			toolName: "ask",
			toolCallId: callId,
			content: [],
			details: { selectedOptions: [], ...answer },
		}),
	];
};
const approve = (n: number) => askMulti({ selectedOptions: ["Approve " + n + " agents"] });

type Api = FakeApi & ExtensionAPI;

interface Session {
	pi: Api;
	ctx: ExtensionContext;
	entries: unknown[];
	notices: string[];
}

async function session(
	entries: unknown[],
	options: { agent?: string; model?: typeof HAIKU; profile?: string; credentials?: typeof CREDENTIALS } = {},
): Promise<Session> {
	const { createAgentProfileExtension } = await freshModule();
	const pi = makePi(createAgentProfileExtension);
	const notices: string[] = [];
	const all = options.agent ? [{ type: "session_init", agent: options.agent }, ...entries] : entries;
	const ctx = makeCtx(next("session"), null, makeAuthStorage(options.credentials), notices, {
		entries: all,
		model: options.model,
	});
	if (options.profile) {
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(options.profile, ctx);
	}
	return { pi, ctx, entries: all, notices };
}

const verdict = (result: unknown): string => {
	const r = result as { block?: boolean; reason?: string } | undefined;
	return r?.block ? "block: " + r.reason : "allow";
};
const spawn = (s: Session, agent = "scout", pattern = "", invocationKind = "task") =>
	verdict(
		s.pi.handlers.get("before_subagent_spawn")!(
			{ type: "before_subagent_spawn", agent, invocationKind, patterns: pattern ? [pattern] : [] },
			s.ctx,
		),
	);
const call = (s: Session, tasks: Record<string, unknown>[]) =>
	verdict(
		s.pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "task", toolCallId: "t", input: { tasks } },
			s.ctx,
		),
	);

const NONE = "(requested 1, left 0)";
const HAIKU_LOW = "anthropic/claude-haiku-4-5:low";

describe("the grant, ported: a spawn on the parent's Opus always needs it", () => {
	it("no grant refuses the task call and the spawn", async () => {
		const s = await session([user("go")]);
		expect(call(s, [{}])).toContain(NONE);
		expect(spawn(s)).toContain(NONE);
	});

	it("3 tasks on a grant of 2 are refused before any spawns, and 2 of 2 spend it", async () => {
		const s = await session([user("go"), ...approve(2)]);
		const wide = call(s, [{}, {}, {}]);
		expect(wide).toContain("expensive subagent");
		expect(wide).toContain("left 2)");
		expect([call(s, [{}, {}]), spawn(s), spawn(s), spawn(s)]).toEqual([
			"allow",
			"allow",
			"allow",
			expect.stringContaining(NONE),
		]);
	});

	it("a typed count grants that many", async () => {
		const s = await session([user("go"), ...askMulti({ customInput: " 3 " })]);
		expect([spawn(s), spawn(s), spawn(s), spawn(s)]).toEqual([
			"allow",
			"allow",
			"allow",
			expect.stringContaining(NONE),
		]);
	});

	it("an answer outside 1..32, a timeout and a new user prompt grant nothing", async () => {
		for (const label of ["No agents", "0", "33", "sure"]) {
			const s = await session([user("go"), ...askMulti({ selectedOptions: [label] })]);
			expect(spawn(s)).toContain(NONE);
		}
		const timedOut = await session([
			user("go"),
			...askMulti({ selectedOptions: ["Approve 2 agents"], timedOut: true }),
		]);
		expect(spawn(timedOut)).toContain(NONE);
		const newPrompt = await session([user("go"), ...approve(2), user("next")]);
		expect(spawn(newPrompt)).toContain(NONE);
	});

	it("a subagent never spawns, even with a grant or a cheap model", async () => {
		const s = await session([user("go"), ...approve(2)], { agent: "scout", model: HAIKU });
		expect(call(s, [{}])).toContain("a subagent never spawns a subagent");
		expect(spawn(s, "scout", HAIKU_LOW)).toContain("a subagent never spawns a subagent");
	});

	it("a single-question grant spends, and a single question with another id grants nothing", async () => {
		const single = await session([user("go"), ...askSingle("subagents", { selectedOptions: ["Approve 1 agents"] })]);
		expect([spawn(single), spawn(single)]).toEqual(["allow", expect.stringContaining(NONE)]);
		const other = await session([user("go"), ...askSingle("scope", { selectedOptions: ["1"] })]);
		expect(spawn(other)).toContain(NONE);
	});

	it("an eval spawn spends the grant, and the task call after it is refused", async () => {
		const s = await session([user("go"), ...approve(1)]);
		expect(spawn(s, "task", "", "eval")).toBe("allow");
		expect(call(s, [{}])).toContain(NONE);
	});

	it("a thrown read refuses", async () => {
		const s = await session([user("go")]);
		const thrown = verdict(
			s.pi.handlers.get("before_subagent_spawn")!({}, {
				...s.ctx,
				sessionManager: {
					...s.ctx.sessionManager,
					getEntries: () => {
						throw new Error("refused");
					},
				},
			} as ExtensionContext),
		);
		expect(thrown.startsWith("block: ")).toBe(true);
	});

	it("CCW_SPAWN_GRANT=off lets a spawn with no grant run", async () => {
		process.env.CCW_SPAWN_GRANT = "off";
		const s = await session([user("go")]);
		expect(call(s, [{}])).toBe("allow");
		expect(spawn(s)).toBe("allow");
	});
});

describe("tiers: 4 cheap spawns are free, an expensive one needs the grant", () => {
	it("4 cheap scouts run with no grant, and the 5th is refused with more than 4", async () => {
		const s = await session([user("go")], { model: HAIKU });
		expect(call(s, [{}, {}, {}, {}])).toBe("allow");
		expect(call(s, [{}, {}, {}, {}, {}])).toContain("more than 4 subagents in one user turn");
		for (let i = 0; i < 4; i++) {
			expect(spawn(s, "scout", HAIKU_LOW)).toBe("allow");
		}
		const fifth = spawn(s, "scout", HAIKU_LOW);
		expect(fifth).toContain("more than 4 subagents in one user turn");
		expect(fifth).toContain(NONE);
	});

	it("an Opus reviewer as the first spawn is refused as expensive", async () => {
		const s = await session([user("go")], { model: HAIKU, profile: "tier" });
		const reviewer = spawn(s, "reviewer");
		expect(reviewer).toContain("reviewer runs anthropic/claude-opus-5-5:medium (expensive model)");
		expect(reviewer).toContain("an expensive subagent needs a user-confirmed grant");
		expect(call(s, [{ agent: "reviewer" }])).toContain("expensive subagent");
	});

	it("a cheap model runs free at a high thinking level and on a stored API key", async () => {
		const tier = await session([user("go")], { model: HAIKU, profile: "tier" });
		expect(spawn(tier, "sonic")).toBe("allow");
		expect(spawn(tier, "scout")).toBe("allow");

		const credentials = [
			...CREDENTIALS.map(row => ({ ...row })),
			apiKey(13, "anthropic", "…k13", { label: "metered" }),
		] as typeof CREDENTIALS;
		const keyed = await session([user("go")], { model: HAIKU, profile: "keyed", credentials });
		expect(spawn(keyed, "task")).toBe("allow");
	});

	it("Approve 1 covers 4 cheap and 1 Opus in one batch, and a 6th Opus is refused", async () => {
		const s = await session([user("go"), ...approve(1)], { model: HAIKU, profile: "tier" });
		const batch = [
			{ agent: "scout" },
			{ agent: "scout" },
			{ agent: "scout" },
			{ agent: "scout" },
			{ agent: "reviewer" },
		];
		expect(call(s, batch)).toBe("allow");
		expect([
			spawn(s, "scout"),
			spawn(s, "scout"),
			spawn(s, "scout"),
			spawn(s, "scout"),
			spawn(s, "reviewer"),
		]).toEqual(["allow", "allow", "allow", "allow", "allow"]);
		const sixth = spawn(s, "reviewer");
		expect(sixth).toContain("expensive subagent");
		expect(sixth).toContain(NONE);
	});

	it("a new user prompt refills the free 4", async () => {
		const s = await session([user("go")], { model: HAIKU });
		for (let i = 0; i < 4; i++) {
			expect(spawn(s, "scout", HAIKU_LOW)).toBe("allow");
		}
		expect(spawn(s, "scout", HAIKU_LOW)).toContain("more than 4");
		s.entries.push(user("next"));
		for (let i = 0; i < 4; i++) {
			expect(spawn(s, "scout", HAIKU_LOW)).toBe("allow");
		}
		expect(spawn(s, "scout", HAIKU_LOW)).toContain("more than 4");
	});

	it("two Anthropic subscriptions and one DeepSeek key in one mapping: every cheap row runs free", async () => {
		const s = await session([user("go")], { model: HAIKU, profile: "fleet" });
		expect(spawn(s, "task")).toBe("allow");
		expect(spawn(s, "scout")).toBe("allow");
		expect(spawn(s, "sonic")).toBe("allow");
		expect(call(s, [{ agent: "sonic" }])).toBe("allow");
	});
});

// Prices from packages/catalog/src/models.json on 2026-09-26, in $/1M tokens.
const priced = (provider: string, id: string, input: number, output: number) => ({
	provider,
	id,
	cost: { input, output, cacheRead: 0, cacheWrite: 0 },
});
const CATALOG = [
	priced("anthropic", "claude-opus-5-5", 4, 20),
	priced("anthropic", "claude-haiku-4-5", 0.25, 1.25),
	priced("deepseek", "deepseek-flash", 0.3, 1.2),
	priced("deepseek", "deepseek-v4-pro", 1.32, 3.96),
	priced("deepseek-alt", "deepseek-flash", 0.3, 1.2),
	priced("deepseek-alt", "deepseek-v4-pro", 1.32, 3.96),
	priced("moonshot", "kimi-k2.7-code", 1.9, 8),
	priced("moonshot", "kimi-k3", 3, 15),
	priced("zai", "glm-5-flash", 0.1, 0.4),
	priced("zai", "glm-5.2", 1.4, 4.4),
	priced("zai", "glm-5.3", 1.4, 4.4),
	priced("openrouter", "moonshotai/kimi-k2.7-code", 1.9, 8),
	priced("openrouter", "moonshotai/kimi-k3", 3, 15),
	priced("openrouter", "openai/gpt-5.5-pro", 30, 180),
	priced("local", "a", 0, 0),
	priced("local", "b", 0, 0),
	priced("solo", "only", 2, 8),
];

describe("the most expensive model of its provider needs the grant", () => {
	it("marks each provider's top price, groups an aggregator by vendor, and skips a free or lone row", async () => {
		const { spawnTier } = await import(`../src/agent-profile/spawn-grant.ts?t=${Math.random()}`);
		const ctx = makeCtx(next("session"), null, makeAuthStorage(), [], { model: HAIKU, listModels: CATALOG });
		const tier = (pattern: string) => spawnTier(ctx, pattern, []).expensive;
		for (const pattern of [
			"deepseek/deepseek-v4-pro",
			"deepseek-alt/deepseek-v4-pro",
			"moonshot/kimi-k3",
			"zai/glm-5.2",
			"zai/glm-5.3",
			"openrouter/moonshotai/kimi-k3",
			"openrouter/openai/gpt-5.5-pro",
			"anthropic/claude-opus-5-5",
		]) {
			expect([pattern, tier(pattern)]).toEqual([pattern, true]);
		}
		for (const pattern of [
			"deepseek/deepseek-flash:xhigh",
			"moonshot/kimi-k2.7-code",
			"zai/glm-5-flash",
			"openrouter/moonshotai/kimi-k2.7-code",
			"anthropic/claude-haiku-4-5:max",
			"local/a",
			"solo/only",
		]) {
			expect([pattern, tier(pattern)]).toEqual([pattern, false]);
		}
		expect(spawnTier(ctx, "moonshot/kimi-k3", []).why).toBe("the most expensive model of moonshot");
	});
});

describe("expensiveModels names the flagships only", () => {
	it("matches the flagship ids, skips the cheaper siblings, and reports a pattern that does not compile", async () => {
		const { expensiveModelPatterns } = await freshModule();
		const patterns = expensiveModelPatterns();
		expect(patterns.length).toBe(6);
		const expensive = (id: string) => patterns.some(re => re.test(id));
		for (const id of [
			"deepseek-v4-pro",
			"kimi-k3",
			"moonshotai/kimi-k3",
			"glm-5.3",
			"z-ai/glm-5.3",
			"claude-opus-5-5",
		]) {
			expect([id, expensive(id)]).toEqual([id, true]);
		}
		for (const id of ["deepseek-v4-flash", "kimi-k2.7-code", "glm-5.3-flash", "claude-sonnet-5"]) {
			expect([id, expensive(id)]).toEqual([id, false]);
		}
		const s = await session([user("go")], { model: HAIKU, profile: "tier" });
		expect(s.notices.join(" | ")).toContain('expensiveModels: "(" is not a regular expression, so it was skipped');
	});
});

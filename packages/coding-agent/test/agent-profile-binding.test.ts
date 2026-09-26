// B1-B8, E1, A1-A2: the spawn hook and the request guard enforce a bound agent's model, thinking
// level and pinned account. Ported from ccw's internal/policy/omp_test.go (claude-code-workflows).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, settings, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { cfgTaskAgentModelOverrides, cfgTaskEnableEffort } from "../src/task/settings";
import {
	DEEPSEEK,
	describeRefusal,
	makeAuthStorage,
	makeCtx,
	makePi,
	OPUS,
	spawn,
} from "./helpers/agent-profile-harness";

// split binds reviewer to b@example.com at xhigh, scout to anthropic #1, sonic to deepseek at
// off, and task to a bad thinking suffix (so it never binds).
const CUSTOM_YAML = `profiles:
  split:
    reviewer: { model: anthropic/claude-opus-5, account: "b@example.com", thinking: xhigh }
    scout: { model: anthropic/claude-opus-5, account: "#1", thinking: medium }
    sonic: { model: deepseek/deepseek-flash, thinking: off }
`;

let agentDir: string;

// The module specifier is fixed; the query string is the runtime-selected part, forcing a fresh
// module instance (fresh BOUND map, fresh APPLIED_PROFILE) per test the way a real process
// restart would, since the extension's binding table is deliberately module-scope.
async function freshExtension(): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
	};
	return mod.createAgentProfileExtension;
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-binding-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), CUSTOM_YAML);
	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("B1-B8, E1: spawn hook and request guard", () => {
	it("B1: the spawn hook returns the bound pattern and a note naming the account; while a profile is applied, an agent it has no row for is refused", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const spawnReviewer = (await spawn(parent, "reviewer", parentCtx)) as { model: string; note: string };
		expect(spawnReviewer.model).toBe("anthropic/claude-opus-5:xhigh");
		expect(spawnReviewer.note).toContain("b@example.com");

		const spawnUnbound = (await spawn(parent, "security-reviewer", parentCtx)) as { block: boolean; reason: string };
		expect(spawnUnbound.block).toBe(true);
		expect(spawnUnbound.reason).toContain("profile split has no row for security-reviewer");
	});

	it("B2: the request guard refuses a request on an account other than the pinned one", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);
		await spawn(parent, "reviewer", parentCtx);

		const reviewer = makePi(factory, "xhigh");
		const reviewerCtx = makeCtx("child-reviewer", "reviewer", auth, notices);
		await (reviewer.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			reviewerCtx,
		);
		// The sticky row moves to account 1, as omp's hash pick or a /login reset would move it.
		auth.sticky["anthropic:child-reviewer"] = 1;
		const wrongAccount = describeRefusal(
			await (reviewer.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				reviewerCtx,
			),
		);
		expect(wrongAccount).toMatch(/^refused:/);
	});

	it("B3: the silent parent-model fallback is refused: sonic is bound to deepseek and the request runs Opus", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const sonic = makePi(factory);
		const sonicCtx = makeCtx("child-sonic", "sonic", auth, notices, { model: DEEPSEEK });
		await (sonic.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			sonicCtx,
		);
		const wrongModel = describeRefusal(
			await (sonic.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				makeCtx("child-sonic", "sonic", auth, notices, { model: OPUS }),
			),
		);
		expect(wrongModel).toMatch(/^refused:/);
	});

	it("B4: the bound model at the bound level is allowed; a level an effort argument moved is refused", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const sonic = makePi(factory);
		const sonicCtx = makeCtx("child-sonic", "sonic", auth, notices, { model: DEEPSEEK });
		await (sonic.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			sonicCtx,
		);
		const rightModel = describeRefusal(
			await (sonic.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				sonicCtx,
			),
		);
		expect(rightModel).toBe("undefined");

		sonic.thinking = "high";
		const wrongLevel = describeRefusal(
			await (sonic.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				sonicCtx,
			),
		);
		expect(wrongLevel).toMatch(/^refused:/);
	});

	it("E1: task.enableEffort stands the level check down, so the effort-moved level is no longer refused", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const sonic = makePi(factory, "high");
		const sonicCtx = makeCtx("child-sonic", "sonic", auth, notices, { model: DEEPSEEK });
		await (sonic.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			sonicCtx,
		);
		cfgTaskEnableEffort.override(settings, true);
		const levelWithEffort = describeRefusal(
			await (sonic.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				sonicCtx,
			),
		);
		expect(levelWithEffort).toBe("undefined");
	});

	it("B5: the parent and an unbound child are never refused, whatever model they run", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const parentRequest = describeRefusal(
			await (parent.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				makeCtx("parent", null, auth, notices, { model: DEEPSEEK }),
			),
		);
		expect(parentRequest).toBe("undefined");

		const unbound = makePi(factory);
		const unboundRequest = describeRefusal(
			await (unbound.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				makeCtx("child-unbound", "security-reviewer", auth, notices, { model: DEEPSEEK }),
			),
		);
		expect(unboundRequest).toBe("undefined");
	});

	it("B6: a profile naming a provider with no credential is refused at spawn, where omp would otherwise run the parent's model", async () => {
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			"profiles:\n  ghost:\n    scout: { model: nosuch/nosuch-model }\n",
		);
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		const noticesBefore = notices.length;
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("ghost", parentCtx);
		expect(notices.slice(noticesBefore).some(n => n.startsWith("error:") && n.includes("No usable model"))).toBe(
			true,
		);

		const spawnGhost = (await spawn(parent, "scout", parentCtx)) as { block: boolean };
		expect(spawnGhost.block).toBe(true);
	});

	it("B7: a bound child pins the credential the profile names for it", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const reviewer = makePi(factory, "xhigh");
		const reviewerCtx = makeCtx("child-reviewer", "reviewer", auth, notices);
		await (reviewer.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			reviewerCtx,
		);
		expect(auth.pins.some(pin => pin.sessionId === "child-reviewer" && pin.provider === "anthropic")).toBe(true);
		const pinnedId = auth.sticky["anthropic:child-reviewer"];
		const row = auth.credentials.find(r => r.id === pinnedId);
		expect(row?.identity).toBe("b@example.com");
	});

	it("B8: a selector that matches two accounts is refused at spawn, never served by a pick", async () => {
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			'profiles:\n  ambiguous:\n    reviewer: { model: anthropic/claude-opus-5, account: "twin@example.com", thinking: xhigh }\n',
		);
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("ambiguous", parentCtx);
		const spawnAmbiguous = (await spawn(parent, "reviewer", parentCtx)) as { block: boolean; reason: string };
		expect(spawnAmbiguous.block).toBe(true);
		expect(spawnAmbiguous.reason).toContain("matches 2 stored");
	});
});

describe("A1-A2: applying a profile and re-pinning under credential churn", () => {
	it("A1: an unknown profile name changes nothing", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);
		const before = { ...cfgTaskAgentModelOverrides.get(settings) };
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("nope", parentCtx);
		const after = cfgTaskAgentModelOverrides.get(settings);
		expect(after).toEqual(before);
	});

	it("A2: the turn boundary re-asserts a pin a credential reset dropped mid-run", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const reviewer = makePi(factory, "xhigh");
		const reviewerCtx = makeCtx("child-reviewer", "reviewer", auth, notices);
		await (reviewer.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			reviewerCtx,
		);
		// Simulate a /login wipe of the sticky row under the running child.
		delete auth.sticky["anthropic:child-reviewer"];
		const pinsBefore = auth.pins.length;
		await (reviewer.handlers.get("turn_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "turn_start", turnIndex: 1, timestamp: Date.now() },
			reviewerCtx,
		);
		expect(auth.pins.length).toBeGreaterThan(pinsBefore);
		expect(auth.sticky["anthropic:child-reviewer"]).toBe(2);
	});
});

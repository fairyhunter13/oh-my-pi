// C2, C3, C5, C6, G1, G4: session rehydrate precedence, a cold revive's own audit trail, an API
// key bound like an OAuth row, the thinking-level clamp notice, and set/unset plus credential
// churn clearing only the rows bound to the dead row. Ported from ccw's
// internal/policy/omp_test.go (claude-code-workflows).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, settings, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { cfgTaskAgentModelOverrides } from "../src/task/settings";
import { DEEPSEEK, makeAuthStorage, makeCtx, makePi, OPUS, spawn } from "./helpers/agent-profile-harness";

const CUSTOM_YAML = `profiles:
  split:
    reviewer: { model: anthropic/claude-opus-5, account: "b@example.com", thinking: xhigh }
    scout: { model: anthropic/claude-opus-5, account: "#1", thinking: medium }
    sonic: { model: deepseek/deepseek-flash, thinking: off }
  keyed:
    sonic: { model: deepseek/deepseek-flash, thinking: off, account: spare }
  clamped:
    scout: { model: anthropic/claude-opus-5, thinking: minimal }
    reviewer: { model: deepseek/deepseek-flash, thinking: max }
`;

let agentDir: string;

async function freshExtension(): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
	};
	return mod.createAgentProfileExtension;
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), CUSTOM_YAML);
	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.OMP_AGENT_PROFILE;
});

describe("C2: session rehydrate precedence", () => {
	it("a remembered profile beats OMP_AGENT_PROFILE on session_switch", async () => {
		process.env.OMP_AGENT_PROFILE = "rival";
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			CUSTOM_YAML +
				'  rival:\n    reviewer: { model: anthropic/claude-opus-5, account: "a@example.com", thinking: xhigh }\n',
		);
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const resumedCtx = makeCtx("parent-resumed", null, auth, notices, {
			branch: [{ type: "custom", customType: "ccw-agent-profile-state", data: { profile: "split" } }],
		});
		await (parent.handlers.get("session_switch") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "session_switch" },
			resumedCtx,
		);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		// split's reviewer is b@example.com; rival's is a@example.com. split must win.
		expect(overrides.reviewer).toBe("anthropic/claude-opus-5:xhigh");
		const spawnReviewer = (await spawn(parent, "reviewer", resumedCtx)) as { note: string };
		expect(spawnReviewer.note).toContain("b@example.com");
	});
});

describe("C3: a cold revive re-pins from its own audit trail", () => {
	it("a fresh module instance with an empty binding table pins from the child's own ccw-agent-account entry", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const cold = makePi(factory);
		const coldCtx = makeCtx("child-cold", "reviewer", auth, notices, {
			entries: [
				{ type: "session_init", agent: "reviewer" },
				{
					type: "custom",
					customType: "ccw-agent-account",
					data: { agent: "reviewer", provider: "anthropic", credentialId: 2, ok: true },
				},
			],
		});
		await (cold.handlers.get("session_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "session_start" },
			coldCtx,
		);
		expect(auth.pins.length).toBe(1);
		expect(auth.pins[0]).toMatchObject({ provider: "anthropic", sessionId: "child-cold", credentialId: 2 });
	});
});

describe("C5: an API key is a stored row like an OAuth one", () => {
	it("keyed binds sonic to the deepseek key labelled spare, and the model stays on deepseek", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("keyed", parentCtx);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		expect(overrides.sonic).toBe("deepseek/deepseek-flash:off");

		const spawnKeyed = (await spawn(parent, "sonic", parentCtx)) as { model: string };
		expect(spawnKeyed.model).toBe("deepseek/deepseek-flash:off");

		const keyedChild = makePi(factory, "off");
		const keyedCtx = makeCtx("child-keyed", "sonic", auth, notices, { model: DEEPSEEK });
		await (keyedChild.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			keyedCtx,
		);
		const keyedPins = auth.pins.filter(pin => pin.sessionId === "child-keyed");
		expect(keyedPins.length).toBe(1);
		expect(keyedPins[0].credentialId).toBe(12);
	});
});

describe("C6: the pre-flight names a thinking level clamp this fork applies silently", () => {
	it("scout takes the lowest supported level, and reviewer the highest below max", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		const before = notices.length;
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("clamped", parentCtx);
		const clampNotices = notices
			.slice(before)
			.filter(n => n.startsWith("warning:") && n.includes("Thinking level changed"));
		expect(clampNotices.length).toBe(1);
		// scout: anthropic/claude-opus-5 supports low..max, no "minimal" -> runs as low (lowest).
		expect(clampNotices[0]).toContain("scout: thinking minimal runs as low");
		// reviewer: deepseek/deepseek-flash supports high, xhigh only -> "max" runs as xhigh.
		expect(clampNotices[0]).toContain("reviewer: thinking max runs as xhigh");
	});
});

describe("G1, G4: set/unset and credential-disable/removal churn", () => {
	it("G1: a set that moves an agent to another provider leaves no stale key from the old one", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const scoutA = makePi(factory);
		await (scoutA.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			makeCtx("child-g1-scout-a", "scout", auth, notices, { model: OPUS }),
		);
		expect(auth.sticky["anthropic:child-g1-scout-a"]).toBe(1);

		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout account=deepseek/6 model=deepseek/deepseek-flash thinking=off scope=all",
			parentCtx,
		);
		const scoutB = makePi(factory);
		await (scoutB.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			makeCtx("child-g1-scout-b", "scout", auth, notices, { model: DEEPSEEK }),
		);
		const scoutBPins = auth.pins.filter(pin => pin.sessionId === "child-g1-scout-b");
		expect(scoutBPins.length).toBe(1);
		expect(scoutBPins[0]).toMatchObject({ provider: "deepseek", credentialId: 6 });
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"unset scout scope=all",
			parentCtx,
		);
	});

	it("G4: removing one credential clears only the rows bound to it, and every other row keeps its pin", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);

		const scoutPi = makePi(factory);
		await (scoutPi.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			makeCtx("child-g4-scout", "scout", auth, notices, { model: OPUS }),
		);
		const reviewerPi = makePi(factory);
		await (reviewerPi.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			makeCtx("child-g4-reviewer", "reviewer", auth, notices, { model: OPUS }),
		);
		expect(auth.sticky["anthropic:child-g4-scout"]).toBe(1);
		expect(auth.sticky["anthropic:child-g4-reviewer"]).toBe(2);

		const removedRow = auth.credentials.splice(0, 1)[0];
		const before = notices.length;
		await (parent.handlers.get("credential_removed") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "credential_removed", provider: "anthropic", credentials: [removedRow] },
			parentCtx,
		);
		expect(notices.slice(before).some(n => n.startsWith("error:") && n.includes("scout"))).toBe(true);
		const g4ScoutSpawn = (await spawn(parent, "scout", parentCtx)) as { block: boolean };
		expect(g4ScoutSpawn.block).toBe(true);
		const g4ReviewerSpawn = (await spawn(parent, "reviewer", parentCtx)) as { model: string };
		expect(g4ReviewerSpawn.model).toBe("anthropic/claude-opus-5:xhigh");
	});
});

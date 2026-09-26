// D1-D3, O1: default application (built-in default, session state, OMP_AGENT_PROFILE, off), and
// the built-in profiles the extension embeds from builtin-profiles.yml. Ported from ccw's
// internal/policy/omp_test.go (claude-code-workflows), which ran the same scenario as one
// embedded JS harness against a hardcoded BUILTIN object; setBuiltinProfilesForTest here plays
// the same fixture role, on the freshly imported module instance each test runs against.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, settings, Settings } from "../src/config/settings";
import type { ExtensionFactory } from "../src/extensibility/extensions";
import { cfgTaskAgentModelOverrides } from "../src/task/settings";
import { makeAuthStorage, makeCtx, makePi, spawn } from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
descriptions:
  opus: "Every delegated agent on Claude Opus 5.5"
  tiered: "The default"
  frugal: "Cheapest tiers throughout"
profiles:
  opus:
    scout: { model: anthropic/claude-opus-5-5, thinking: medium }
    sonic: { model: anthropic/claude-opus-5-5, thinking: medium }
    task: { model: anthropic/claude-opus-5-5, thinking: medium }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh }
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
  frugal:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off" }
    task: { model: anthropic/claude-haiku-4-5, thinking: medium }
    reviewer: { model: anthropic/claude-sonnet-5, thinking: high }
    security-reviewer: { model: anthropic/claude-sonnet-5, thinking: high }
`;

let agentDir: string;

// The module specifier is fixed; the query string is the runtime-selected part, forcing a fresh
// module instance (fresh APPLIED_PROFILE, fresh builtin-yaml override) per call the way a real
// process restart would -- a static import cannot re-run a module already in the cache.
async function freshExtension(builtinYaml: string | undefined): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
		setBuiltinProfilesForTest: (yaml: string | undefined) => void;
	};
	mod.setBuiltinProfilesForTest(builtinYaml);
	return mod.createAgentProfileExtension;
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-defaults-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("D1-D3: default application", () => {
	it("D1: with no state entry and no OMP_AGENT_PROFILE, a fresh session applies the built-in default and never records it", async () => {
		delete process.env.OMP_AGENT_PROFILE;
		const factory = await freshExtension(BUILTIN_YAML);
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("d1-parent", null, auth, notices);
		await (pi.handlers.get("session_start") as (e: unknown, c: typeof ctx) => Promise<void>)(
			{ type: "session_start" },
			ctx,
		);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		expect(overrides.scout).toBe("anthropic/claude-haiku-4-5:low");
		expect(overrides.task).toBe("anthropic/claude-sonnet-5:medium");
		const stateEntries = pi.entries.filter(entry => entry.customType === "ccw-agent-profile-state");
		expect(stateEntries.length).toBe(0);
	});

	it("D2: each of the five bundled agents spawns on the default's row", async () => {
		delete process.env.OMP_AGENT_PROFILE;
		const factory = await freshExtension(BUILTIN_YAML);
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("d2-parent", null, auth, notices);
		await (pi.handlers.get("session_start") as (e: unknown, c: typeof ctx) => Promise<void>)(
			{ type: "session_start" },
			ctx,
		);
		const want: Record<string, string> = {
			scout: "anthropic/claude-haiku-4-5:low",
			sonic: "anthropic/claude-haiku-4-5:off",
			task: "anthropic/claude-sonnet-5:medium",
			reviewer: "anthropic/claude-opus-5-5:xhigh",
			"security-reviewer": "anthropic/claude-opus-5-5:xhigh",
		};
		for (const [agent, pattern] of Object.entries(want)) {
			const result = (await spawn(pi, agent, ctx)) as { model?: string };
			expect(result.model).toBe(pattern);
		}
	});

	it("D3: /agent-profile off, recorded on a branch, beats the built-in default there", async () => {
		delete process.env.OMP_AGENT_PROFILE;
		const factory = await freshExtension(BUILTIN_YAML);
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const offCtx = makeCtx("d3-off", null, auth, notices, {
			branch: [{ type: "custom", customType: "ccw-agent-profile-state", data: { profile: "off" } }],
		});
		await (pi.handlers.get("session_switch") as (e: unknown, c: typeof offCtx) => Promise<void>)(
			{ type: "session_switch" },
			offCtx,
		);
		const result = await spawn(pi, "scout", offCtx);
		expect(result).toBe("undefined");
	});

	it("no builtin file: no default is applied and no spawn is refused (contract)", async () => {
		// No built-in text set: setBuiltinProfilesForTest("") plays no file at all.
		delete process.env.OMP_AGENT_PROFILE;
		const factory = await freshExtension("");
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("nofile-parent", null, auth, notices);
		await (pi.handlers.get("session_start") as (e: unknown, c: typeof ctx) => Promise<void>)(
			{ type: "session_start" },
			ctx,
		);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		expect(Object.keys(overrides).length).toBe(0);
		for (const agent of ["scout", "sonic", "task", "reviewer", "security-reviewer"]) {
			const result = await spawn(pi, agent, ctx);
			expect(result).toBe("undefined");
		}
		expect(notices.some(notice => notice.startsWith("error:"))).toBe(false);
	});
});

describe("O1: built-in profiles", () => {
	it("opus runs the judges at xhigh and every other agent at medium", async () => {
		const factory = await freshExtension(BUILTIN_YAML);
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("o1-parent", null, auth, notices);
		await (pi.command!.handler as (a: string, c: typeof ctx) => Promise<void>)("opus", ctx);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		expect(overrides.reviewer).toBe("anthropic/claude-opus-5-5:xhigh");
		expect(overrides["security-reviewer"]).toBe("anthropic/claude-opus-5-5:xhigh");
		expect(overrides.scout).toBe("anthropic/claude-opus-5-5:medium");
		await (pi.command!.handler as (a: string, c: typeof ctx) => Promise<void>)("frugal", ctx);
		const frugal = cfgTaskAgentModelOverrides.get(settings);
		expect(frugal.reviewer).toBe("anthropic/claude-sonnet-5:high");
		expect(frugal.scout).toBe("anthropic/claude-haiku-4-5:low");
	});

	it("a custom profile of the same name overrides the built-in", async () => {
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			"profiles:\n  tiered:\n    scout: { model: deepseek/deepseek-flash, thinking: off }\n",
		);
		const factory = await freshExtension(BUILTIN_YAML);
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("override-parent", null, auth, notices);
		await (pi.command!.handler as (a: string, c: typeof ctx) => Promise<void>)("tiered", ctx);
		const overrides = cfgTaskAgentModelOverrides.get(settings);
		expect(overrides.scout).toBe("deepseek/deepseek-flash:off");
		// A custom profile of the same name REPLACES the built-in whole, not per field: task
		// has no row in the custom profile, so it does not run at all under this override.
		expect(overrides.task).toBeUndefined();
	});
});

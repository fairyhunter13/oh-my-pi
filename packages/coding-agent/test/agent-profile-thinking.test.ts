// Fork-split plan step 2 (R5): every mapping layer accepts every thinking level THINKING_LEVELS
// defines -- the six efforts from core plus "off" and "auto" -- with no complaint, and step 12's
// jev warning on a thinking: auto row whose judge role resolves to typesafe.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import "../src/config/all-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { agentFile, makeAuthStorage, makeCtx, makePi, spawn } from "./helpers/agent-profile-harness";

// The exact set agent-profile/index.ts's own THINKING_LEVELS builds from the same two imports;
// built independently here so a drift in either constant fails this test rather than agreeing
// with itself.
const LEVELS: string[] = ["off", ...THINKING_EFFORTS, AUTO_THINKING];

// The module specifier is fixed; the query string is the runtime-selected part, forcing a fresh
// module instance (fresh APPLIED_PROFILE, fresh builtin/custom file caches) per call the way a
// real process restart would -- a static import cannot re-run a module already in the cache.
async function freshExtension(): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
	};
	return mod.createAgentProfileExtension;
}

let dirs: string[] = [];

function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

beforeEach(async () => {
	resetSettingsForTest();
});

afterEach(() => {
	resetSettingsForTest();
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	dirs = [];
	delete process.env.PI_CODING_AGENT_DIR;
});

// The binding's model pattern always ends in ":<level>", off and auto included: patternOf
// (index.ts) appends ":" + entry.thinking whenever entry.thinking is a non-empty string, and
// normalizeEntry (index.ts:719-737) stores off/auto as that plain string with no special case.
// resetSettingsForTest runs first: Settings.init caches its promise on the global singleton, so
// a second init in the same test (one call per level) would otherwise keep the first level's
// agentDir.
async function bindingPattern(
	profileYaml: string,
	profileName: string,
	agentDir: string,
	cwd: string | undefined,
): Promise<{ pattern: string; errors: string[] }> {
	resetSettingsForTest();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), profileYaml);
	await Settings.init({ inMemory: true, agentDir });
	const factory = await freshExtension();
	const auth = makeAuthStorage();
	const errors: string[] = [];
	const parent = makePi(factory);
	const parentCtx = makeCtx("parent", null, auth, errors, {
		cwd,
		entries: [{ type: "message", id: `user-${agentDir}`, message: { role: "user", content: [] } }],
	});
	await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(profileName, parentCtx);
	const result = (await spawn(parent, "probe", parentCtx)) as { model?: string };
	return { pattern: result.model ?? "", errors: errors.filter(note => note.startsWith("error:")) };
}

describe("R5: every mapping layer accepts every thinking level", () => {
	it("(a) a hand-profile row binds a user-level custom agent at every level, with no complaint", async () => {
		for (const level of LEVELS) {
			const agentDir = tmp("agent-profile-thinking-a-");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(join(agentDir, "agents", "probe.md"), agentFile("probe", "Exercises every thinking level"));
			const yaml = `profiles:\n  probe-hand:\n    probe: { model: anthropic/claude-sonnet-5, thinking: ${level} }\n`;
			const { pattern, errors } = await bindingPattern(yaml, "probe-hand", agentDir, undefined);
			expect(errors).toEqual([]);
			expect(pattern).toBe("anthropic/claude-sonnet-5:" + level);
		}
	});

	it("(b) a tracked repo overlay row (default:) binds the agent at every level, with no complaint", async () => {
		for (const level of LEVELS) {
			const agentDir = tmp("agent-profile-thinking-b-agent-");
			const repoDir = tmp("agent-profile-thinking-b-repo-");
			const repoCwd = join(repoDir, "src");
			mkdirSync(repoCwd, { recursive: true });
			mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
			writeFileSync(join(repoDir, ".omp", "agents", "probe.md"), agentFile("probe", "Exercises every level"));
			writeFileSync(
				join(repoDir, ".omp", "agent-profiles.yml"),
				`default:\n  probe: { model: anthropic/claude-sonnet-5, thinking: ${level} }\n`,
			);
			const yaml = "profiles:\n  base:\n    keeper: { model: anthropic/claude-sonnet-5, thinking: low }\n";
			const { pattern, errors } = await bindingPattern(yaml, "base", agentDir, repoCwd);
			expect(errors).toEqual([]);
			expect(pattern).toBe("anthropic/claude-sonnet-5:" + level);
		}
	});

	it("(c) a repo local-file row (default:) binds the agent at every level, with no complaint", async () => {
		for (const level of LEVELS) {
			const agentDir = tmp("agent-profile-thinking-c-agent-");
			const repoDir = tmp("agent-profile-thinking-c-repo-");
			const repoCwd = join(repoDir, "src");
			mkdirSync(repoCwd, { recursive: true });
			mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
			writeFileSync(join(repoDir, ".omp", "agents", "probe.md"), agentFile("probe", "Exercises every level"));
			writeFileSync(
				join(repoDir, ".omp", "agent-profiles.local.yml"),
				`default:\n  probe: { model: anthropic/claude-sonnet-5, thinking: ${level} }\n`,
			);
			const yaml = "profiles:\n  base:\n    keeper: { model: anthropic/claude-sonnet-5, thinking: low }\n";
			const { pattern, errors } = await bindingPattern(yaml, "base", agentDir, repoCwd);
			expect(errors).toEqual([]);
			expect(pattern).toBe("anthropic/claude-sonnet-5:" + level);
		}
	});

	it("(d) an assign row binds the agent at every level, with no complaint", async () => {
		for (const level of LEVELS) {
			const agentDir = tmp("agent-profile-thinking-d-");
			const yaml =
				"profiles:\n  base:\n    keeper: { model: anthropic/claude-sonnet-5, thinking: low }\n" +
				`assign:\n  probe: { model: anthropic/claude-sonnet-5, thinking: ${level} }\n`;
			const { pattern, errors } = await bindingPattern(yaml, "base", agentDir, undefined);
			expect(errors).toEqual([]);
			expect(pattern).toBe("anthropic/claude-sonnet-5:" + level);
		}
	});
});

describe("step 12: thinking: auto warns when the judge role spends jev, and only then", () => {
	it("an auto row with a typesafe judge role shows the warning in status and at apply", async () => {
		const agentDir = tmp("agent-profile-thinking-auto-typesafe-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			"profiles:\n  auto-profile:\n    probe: { model: anthropic/claude-sonnet-5, thinking: auto }\n",
		);
		await Settings.init({ inMemory: true, agentDir });
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices, {
			resolve: (spec: string) => (spec === "@judge" ? { provider: "typesafe", id: "jev-1" } : undefined),
		});
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("auto-profile", parentCtx);
		expect(notices.some(note => note.includes("thinking auto classifies every turn through the judge role"))).toBe(
			true,
		);

		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", parentCtx);
		expect(
			parent.reports.some(
				report => typeof report === "string" && report.includes("thinking auto classifies every turn"),
			),
		).toBe(true);
	});

	it("with the judge role unset, an auto row shows no warning", async () => {
		const agentDir = tmp("agent-profile-thinking-auto-unset-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "ccw-agent-profiles.yml"),
			"profiles:\n  auto-profile:\n    probe: { model: anthropic/claude-sonnet-5, thinking: auto }\n",
		);
		await Settings.init({ inMemory: true, agentDir });
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices, { resolve: () => undefined });
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("auto-profile", parentCtx);
		expect(notices.some(note => note.includes("thinking auto classifies every turn"))).toBe(false);

		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", parentCtx);
		expect(
			parent.reports.some(
				report => typeof report === "string" && report.includes("thinking auto classifies every turn"),
			),
		).toBe(false);
	});
});

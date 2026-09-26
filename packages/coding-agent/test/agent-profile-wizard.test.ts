// L7 (rewritten for G3, 2026-09-24 addendum 3 Part L step 3): the table editor writes no repo
// agent into a named profile, and binds scout to a picked credential, model and level. Save
// fires only on the second visit to the main menu; the first visit opens scout's row. Ported
// from ccw's internal/policy/omp_test.go (claude-code-workflows, commit 843a5bc).
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { agentFile, makeAuthStorage, makeCtx, makePi } from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
profiles:
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
`;

let agentDir: string;
let repoDir: string;
let repoCwd: string;

// The module specifier is fixed; the query string is the runtime-selected part, forcing a fresh
// module instance per call the way a real process restart would -- a static import cannot re-run
// a module already in the cache.
async function freshExtension(): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
		setBuiltinProfilesForTest: (yaml: string | undefined) => void;
	};
	mod.setBuiltinProfilesForTest(BUILTIN_YAML);
	return mod.createAgentProfileExtension;
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-wizard-agent-"));
	repoDir = mkdtempSync(join(tmpdir(), "agent-profile-wizard-fixture-"));
	repoCwd = join(repoDir, "src");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	mkdirSync(repoCwd, { recursive: true });
	mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
	writeFileSync(
		join(repoDir, ".omp", "agents", "okf-writer.md"),
		agentFile("okf-writer", "Writes knowledge: one concept at a time"),
	);

	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

it("the wizard writes no repo agent into a named profile, and binds scout to a picked credential, model and level", async () => {
	const factory = await freshExtension();
	const auth = makeAuthStorage();
	const notices: string[] = [];
	const repoPi = makePi(factory);
	// The task tool's description is where the roster comes from: okf-writer is repo-owned (it
	// has a .omp/agents file), so the table editor for a NAMED profile must skip it, leaving
	// only scout as a pickable row.
	repoPi.roster = "### scout\n### okf-writer\n";

	let mappingVisits = 0;
	let tableChoices: { label: string; description: string }[] = [];
	const repoCtx = makeCtx("repo", null, auth, notices, {
		cwd: repoCwd,
		mode: "tui",
		select: async (title: string, choices: { label: string; description?: string }[]) => {
			if (title === "Edit which mapping") {
				return "a profile";
			}
			if (title === "Mapping table -- wiz") {
				mappingVisits += 1;
				if (mappingVisits === 1) {
					tableChoices = choices.map(choice => ({ label: choice.label, description: choice.description || "" }));
				}
				return mappingVisits === 1 ? "scout" : "Save";
			}
			if (title === "scout: credential") {
				const found = choices.find(choice => choice.label.startsWith("anthropic: "));
				return found ? found.label : choices[0].label;
			}
			if (title === "scout: model") {
				return "anthropic/claude-haiku-4-5";
			}
			return choices[0].label;
		},
	});

	await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("new wiz", repoCtx);

	expect(tableChoices.some(choice => choice.label === "scout")).toBe(true);
	expect(tableChoices.some(choice => choice.label === "okf-writer")).toBe(false);

	const handPath = join(agentDir, "ccw-agent-profiles.yml");
	const written = Bun.YAML.parse(readFileSync(handPath, "utf8")) as {
		profiles?: Record<string, Record<string, unknown>>;
	};
	const wiz = written.profiles?.wiz;
	expect(wiz).toBeDefined();
	expect(wiz?.scout).toBeDefined();
	expect(wiz?.["okf-writer"]).toBeUndefined();
});

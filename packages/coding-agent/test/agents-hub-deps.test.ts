/**
 * `createAgentsHubDeps`: full-frontmatter writes, in-place edit, delete-to-
 * `.trash`, the writable-path refusal for a repo's `.claude/agents`, origin
 * classification, and the `/agent-profile` command hand-off.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const AGENT_MD = ["---", "name: alpha", "description: Alpha agent.", "---", "You are alpha."].join("\n");

// `getAvailableModels`/`generateAgent` are unused by the functions under test here.
const modelRegistryStub = {} as unknown as ModelRegistry;
const extensionRoots = (): EffectiveExtensionRoots => ({
	explicit: [],
	mode: "merge",
	configured: [],
	configuredLevel: "user",
});

describe("createAgentsHubDeps", () => {
	let projectDir: string;

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-hub-deps-"));
		initializeWithSettings(Settings.isolated({}));
	});

	afterEach(async () => {
		clearFsCache();
		await removeWithRetries(projectDir);
	});

	function makeDeps(commandRunner?: {
		hasCommand: (name: string) => boolean;
		runCommand: (text: string) => Promise<boolean>;
	}) {
		return createAgentsHubDeps(
			projectDir,
			Settings.isolated({}),
			modelRegistryStub,
			extensionRoots,
			undefined,
			undefined,
			commandRunner,
		);
	}

	test("saveAgent writes the full frontmatter (name, description, tools, thinking-level, model) and the body", async () => {
		const deps = makeDeps();
		const filePath = await deps.saveAgent("project", {
			identifier: "gamma",
			whenToUse: "Use this agent when gamma work is needed.",
			systemPrompt: "You are gamma.",
			tools: ["read", "grep"],
			thinkingLevel: "medium",
			model: "anthropic/claude-sonnet-5",
		});
		expect(filePath).toBe(path.join(projectDir, ".omp", "agents", "gamma.md"));
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toContain("name: gamma");
		expect(content).toContain("description: Use this agent when gamma work is needed.");
		expect(content).toContain("tools:");
		expect(content).toContain("- read");
		expect(content).toContain("- grep");
		expect(content).toContain("thinking-level: medium");
		expect(content).toContain("model: anthropic/claude-sonnet-5");
		expect(content).toContain("You are gamma.");
	});

	test("updateAgent rewrites an existing project .omp agent in place", async () => {
		const agentDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentDir, { recursive: true });
		const filePath = path.join(agentDir, "alpha.md");
		await fs.writeFile(filePath, AGENT_MD);
		const deps = makeDeps();
		await deps.updateAgent(filePath, {
			identifier: "alpha",
			whenToUse: "Use this agent when updated alpha work is needed.",
			systemPrompt: "You are updated alpha.",
			model: "anthropic/claude-sonnet-5",
		});
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toContain("Use this agent when updated alpha work is needed.");
		expect(content).toContain("You are updated alpha.");
		expect(content).toContain("model: anthropic/claude-sonnet-5");
	});

	test("deleteAgent moves a project .omp agent to its directory's .trash/", async () => {
		const agentDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentDir, { recursive: true });
		const filePath = path.join(agentDir, "alpha.md");
		await fs.writeFile(filePath, AGENT_MD);
		const deps = makeDeps();
		await deps.deleteAgent(filePath);
		await expect(fs.stat(filePath)).rejects.toThrow();
		const trashEntries = await fs.readdir(path.join(agentDir, ".trash"));
		expect(trashEntries).toHaveLength(1);
		expect(trashEntries[0]).toMatch(/^alpha-\d+\.md$/);
		const trashed = await fs.readFile(path.join(agentDir, ".trash", trashEntries[0]!), "utf-8");
		expect(trashed).toBe(AGENT_MD);
	});

	test("updateAgent and deleteAgent refuse a repo's .claude/agents file", async () => {
		const claudeDir = path.join(projectDir, ".claude", "agents");
		await fs.mkdir(claudeDir, { recursive: true });
		const filePath = path.join(claudeDir, "beta.md");
		await fs.writeFile(filePath, AGENT_MD);
		const deps = makeDeps();
		await expect(
			deps.updateAgent(filePath, { identifier: "beta", whenToUse: "Use this agent when beta.", systemPrompt: "x" }),
		).rejects.toThrow(/writable agent directory/);
		await expect(deps.deleteAgent(filePath)).rejects.toThrow(/writable agent directory/);
		expect(await fs.readFile(filePath, "utf-8")).toBe(AGENT_MD);
	});

	test("loadAgents classifies a project .omp agent as project-omp and editable", async () => {
		const agentDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "alpha.md"), AGENT_MD);
		const deps = makeDeps();
		const agents = await deps.loadAgents();
		const alpha = agents.find(agent => agent.name === "alpha");
		expect(alpha?.origin).toBe("project-omp");
		expect(alpha?.editable).toBe(true);
	});

	test("hasAgentProfileCommand and runAgentProfileSet delegate to the session's registered commands", async () => {
		const calls: string[] = [];
		const deps = makeDeps({
			hasCommand: name => name === "agent-profile",
			runCommand: async text => {
				calls.push(text);
				return true;
			},
		});
		expect(deps.hasAgentProfileCommand()).toBe(true);
		await deps.runAgentProfileSet("scout");
		expect(calls).toEqual(["/agent-profile set scout"]);
	});

	test("hasAgentProfileCommand is false and runAgentProfileSet is a no-op with no command runner", async () => {
		const deps = makeDeps();
		expect(deps.hasAgentProfileCommand()).toBe(false);
		await expect(deps.runAgentProfileSet("scout")).resolves.toBeUndefined();
	});
});

/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, type-to-filter search, the Space enable/disable toggle, and the
 * strip-driven configuration flows (property strips, pattern input, and the
 * model-browser pick) persisting to the per-agent settings records.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentsHubComponent,
	type AgentsHubDeps,
	type HubAgent,
	type HubAgentBindingChange,
} from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

/** Drains the microtask queue: a `saveBinding` result flows through `.then(async …)` then `#reload()`'s own `await`. */
async function flushAsync(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
interface TestSettings {
	get(key: string): string[] | Record<string, string> | undefined;
	set(key: string, value: string[] | Record<string, string>): void;
}

function createSettings(): TestSettings {
	const values = new Map<string, string[] | Record<string, string>>();
	return {
		get: (key: string) => values.get(key),
		set: (key: string, value: string[] | Record<string, string>) => {
			values.set(key, value);
		},
	};
}

// Narrow TUI stub: the hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});

async function createHub(
	settings: TestSettings,
	overrides: Partial<AgentsHubDeps> = {},
): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		{
			browserSource: {
				defaultThinkingLevel: "high",
				modelProviderOrder: [],
				knownRoleIds: [],
				mruOrder: [],
				modelPerf: new Map(),
				getModelRole: () => undefined,
				getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
				defaultRoleChain: () => [],
				resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
			},
			loadAgents: async () => {
				const agents: HubAgent[] = [
					{
						name: "dev",
						description: "Development agent",
						systemPrompt: "You are dev.",
						source: "project",
						filePath: "/tmp/agents-hub-test/.omp/agents/dev.md",
						origin: "project-omp",
						editable: true,
						disabled: false,
					},
					{
						name: "scout",
						description: "Read-only research",
						systemPrompt: "",
						source: "bundled",
						origin: "bundled",
						editable: false,
						disabled: false,
					},
					{
						name: "task",
						description: "Generic task agent",
						systemPrompt: "",
						source: "bundled",
						origin: "bundled",
						editable: false,
						disabled: false,
					},
				];
				for (const agent of agents) {
					agent.disabled =
						(settings.get("task.disabledAgents") as string[] | undefined)?.includes(agent.name) ?? false;
					agent.overrideModel = (settings.get("task.agentModelOverrides") as Record<string, string> | undefined)?.[
						agent.name
					];
					agent.prewalkOverride = (settings.get("task.agentPrewalk") as Record<string, string> | undefined)?.[
						agent.name
					];
					agent.advisorOverride = (settings.get("task.agentAdvisor") as Record<string, string> | undefined)?.[
						agent.name
					];
				}
				return agents;
			},
			getAvailableModels: () => [sonnet],
			effectiveModelPatterns: agent => (agent.overrideModel ? [agent.overrideModel] : []),
			resolvePatterns: () => undefined,
			effectivePrewalkPattern: () => undefined,
			effectiveAdvisorPattern: agent => (agent.advisorOverride === "on" ? "@advisor" : undefined),
			setDisabledAgents: names => settings.set("task.disabledAgents", names),
			setOverrides: (property, overrides) =>
				settings.set(
					property === "model"
						? "task.agentModelOverrides"
						: property === "prewalk"
							? "task.agentPrewalk"
							: "task.agentAdvisor",
					overrides,
				),
			generateAgent: async () => {
				throw new Error("Agent generation is not used by configuration tests");
			},
			saveAgent: async () => {
				throw new Error("saveAgent is not used by this test; pass an override");
			},
			updateAgent: async () => {
				throw new Error("updateAgent is not used by this test; pass an override");
			},
			deleteAgent: async () => {
				throw new Error("deleteAgent is not used by this test; pass an override");
			},
			hasAgentProfileCommand: () => false,
			runAgentProfileSet: async () => {},
			...overrides,
		},
		{ onCancel: () => (cancelled = true) },
	);
	return {
		hub,
		strip: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		type: (text: string) => {
			for (const char of text) hub.handleInput(char);
		},
		cancelled: () => cancelled,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		const { hub, strip } = await createHub(createSettings());
		const lines = hub.render(120);
		// top border + content rows + divider + footer + bottom border = terminal rows.
		expect(lines.length).toBe(30);
		const rendered = strip();
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("All agents");
		expect(rendered).toContain("Project");
		expect(rendered).toContain("Bundled");
		expect(rendered).toContain("dev");
		expect(rendered).toContain("scout");
		expect(rendered).toContain("+ New agent");
	});

	test("sidebar scope filters the rows to one source", async () => {
		const { hub, strip } = await createHub(createSettings());
		hub.handleInput("\x1b[D"); // left → scope focus
		hub.handleInput("\x1b[B"); // down → Project
		const rendered = strip();
		expect(rendered).toContain("Project agents · 1");
		expect(rendered).toContain("dev");
		expect(rendered).not.toContain("scout");
	});

	test("type-to-filter narrows the list and Esc clears the query first", async () => {
		const { hub, strip, type, cancelled } = await createHub(createSettings());
		type("sco");
		let rendered = strip();
		expect(rendered).toContain("scout");
		expect(rendered).not.toContain("dev");
		hub.handleInput("\x1b"); // Esc clears the query, not the hub
		expect(cancelled()).toBe(false);
		rendered = strip();
		expect(rendered).toContain("dev");
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(true);
	});
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles the selected agent's enabled state", async () => {
		const settings = createSettings();
		const { hub } = await createHub(settings);
		hub.handleInput(" ");
		expect(settings.get("task.disabledAgents")).toEqual(["dev"]);
		hub.handleInput(" ");
		expect(settings.get("task.disabledAgents")).toEqual([]);
	});

	test("Enter opens the property strip; advisor → on persists task.agentAdvisor", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip for `dev`
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b[C"); // model → prewalk
		hub.handleInput("\x1b[C"); // prewalk → advisor
		hub.handleInput("\r"); // advisor value strip
		expect(strip()).toContain("dev · advisor →");
		hub.handleInput("\x1b[C"); // agent default → on
		hub.handleInput("\r");
		expect(settings.get("task.agentAdvisor")).toEqual({ dev: "on" });
		expect(strip()).toContain("dev advisor: on (@advisor)");
	});

	test("pattern… commits a custom advisor pattern and empty submit clears it", async () => {
		const settings = createSettings();
		settings.set("task.agentAdvisor", { dev: "on" });
		const { hub, type } = await createHub(settings);
		hub.handleInput("\r");
		hub.handleInput("\x1b[C");
		hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // advisor strip
		// agent default → on → off → pick model… → pattern…
		for (let i = 0; i < 4; i++) hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // pattern input, pre-filled "on"
		type("\x7f\x7f"); // clear the prefill
		type("moonshot/k3:high");
		hub.handleInput("\r");
		expect(settings.get("task.agentAdvisor")).toEqual({ dev: "moonshot/k3:high" });
	});

	test("pick model… dives into the model browser and persists the model override", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip (model chip preselected)
		hub.handleInput("\r"); // model value strip → [pick model…] first
		expect(strip()).toContain("dev · model →");
		hub.handleInput("\r"); // assign mode: model browser
		expect(strip()).toContain("Picking model override for dev");
		expect(strip()).toContain("claude-sonnet-4-5");
		hub.handleInput("\r"); // pick the only model
		expect(settings.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-sonnet-4-5" });
		// Back on the list with the override reflected.
		expect(strip()).toContain("anthropic/claude-sonnet-4-5");
	});

	test("clear override chip removes an existing model override", async () => {
		const settings = createSettings();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		expect(strip()).toContain("clear override");
		hub.handleInput("\x1b[C"); // pick model… → pattern…
		hub.handleInput("\x1b[C"); // pattern… → clear override
		hub.handleInput("\r");
		expect(settings.get("task.agentModelOverrides")).toEqual({});
	});

	test("Esc steps back from a value strip to the agent strip before closing", async () => {
		const settings = createSettings();
		const { hub, strip, cancelled } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b"); // back to agent strip
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b"); // close strip
		expect(strip()).not.toContain("dev →");
		expect(cancelled()).toBe(false);
	});
});

describe("AgentsHub edit, delete, copy, and credential hand-off", () => {
	test("row source label distinguishes project .omp from bundled", async () => {
		const { strip } = await createHub(createSettings());
		const rendered = strip();
		expect(rendered).toContain("project .omp");
		expect(rendered).toContain("bundled");
	});

	test("ctrl+e opens the edit form for an editable agent; Enter save calls updateAgent", async () => {
		const settings = createSettings();
		const calls: Array<{ filePath: string; description: string }> = [];
		const { hub, strip } = await createHub(settings, {
			updateAgent: async (filePath, spec) => {
				calls.push({ filePath, description: spec.whenToUse });
			},
		});
		hub.handleInput("\x05"); // ctrl+e
		expect(strip()).toContain("Edit agent");
		expect(strip()).toContain("Name: dev");
		hub.handleInput("\r"); // save with the unedited fields
		expect(calls).toEqual([
			{ filePath: "/tmp/agents-hub-test/.omp/agents/dev.md", description: "Development agent" },
		]);
	});

	test("ctrl+e on a read-only (bundled) agent opens the copy form instead; Enter save calls saveAgent", async () => {
		const settings = createSettings();
		const calls: string[] = [];
		const { hub, strip } = await createHub(settings, {
			saveAgent: async (scope, spec) => {
				calls.push(`${scope}/${spec.identifier}`);
				return `/tmp/${scope}/${spec.identifier}.md`;
			},
		});
		hub.handleInput("\x1b[B"); // dev → scout
		hub.handleInput("\x05"); // ctrl+e
		expect(strip()).toContain("Copy agent");
		hub.handleInput("\r"); // save the copy
		expect(calls).toEqual(["user/scout"]);
	});

	test("ctrl+d opens a delete confirmation for an editable agent; confirming calls deleteAgent", async () => {
		const settings = createSettings();
		const calls: string[] = [];
		const { hub, strip } = await createHub(settings, {
			deleteAgent: async filePath => {
				calls.push(filePath);
			},
		});
		hub.handleInput("\x04"); // ctrl+d
		expect(strip()).toContain("Keep it");
		expect(strip()).toContain("Delete dev");
		hub.handleInput("\x1b[C"); // Keep it → Delete dev
		hub.handleInput("\r");
		expect(calls).toEqual(["/tmp/agents-hub-test/.omp/agents/dev.md"]);
	});

	test("ctrl+d on a read-only (bundled) agent shows a notice instead of deleting", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\x1b[B"); // dev → scout
		hub.handleInput("\x04"); // ctrl+d
		expect(strip()).toContain("read-only");
	});

	test("ctrl+k hands the mapping off to /agent-profile set <name> when the command is registered", async () => {
		const settings = createSettings();
		const calls: string[] = [];
		const { hub, strip } = await createHub(settings, {
			hasAgentProfileCommand: () => true,
			runAgentProfileSet: async name => {
				calls.push(name);
			},
		});
		hub.handleInput("\x0b"); // ctrl+k
		expect(calls).toEqual(["dev"]);
		expect(strip()).toContain("/agent-profile set dev");
	});

	test("ctrl+k names the command to run by hand when /agent-profile is not registered", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\x0b"); // ctrl+k
		expect(strip()).toContain("Map it with /agent-profile set dev");
	});

	test("J-5: typing e, d or c on an empty query filters the list instead of firing the ctrl+e/d/k action", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings, {
			loadAgents: async () => [
				{
					name: "critical-task",
					description: "Critical work agent",
					systemPrompt: "",
					source: "user",
					filePath: "/tmp/agents-hub-test/agents/critical-task.md",
					origin: "user",
					editable: true,
					disabled: false,
				},
				{
					name: "dev",
					description: "Development agent",
					systemPrompt: "",
					source: "project",
					filePath: "/tmp/agents-hub-test/.omp/agents/dev.md",
					origin: "project-omp",
					editable: true,
					disabled: false,
				},
			],
		});
		hub.handleInput("c");
		hub.handleInput("r");
		hub.handleInput("i");
		const rendered = strip();
		expect(rendered).toContain("critical-task");
		expect(rendered).not.toContain("dev");
		expect(rendered).not.toContain("Edit agent");
		expect(rendered).not.toContain("Delete");
		expect(rendered).not.toContain("/agent-profile set");
	});

	test("the model property strip maps via /agent-profile instead of picking, when the command is registered", async () => {
		const settings = createSettings();
		const calls: string[] = [];
		const { hub, strip } = await createHub(settings, {
			hasAgentProfileCommand: () => true,
			runAgentProfileSet: async name => {
				calls.push(name);
			},
		});
		hub.handleInput("\r"); // agent strip
		expect(strip()).toContain("set by /agent-profile");
		hub.handleInput("\r"); // model value strip
		expect(strip()).toContain("map with /agent-profile");
		hub.handleInput("\r");
		expect(calls).toEqual(["dev"]);
	});
});

describe("AgentsHub agent-profile bindings provider", () => {
	test("a model pattern edit calls saveBinding once and never calls setOverrides; the render shows its notice", async () => {
		const settings = createSettings();
		const saveBindingCalls: HubAgentBindingChange[] = [];
		const setOverridesCalls: Array<{ property: string; overrides: Record<string, string> }> = [];
		const { hub, strip, type } = await createHub(settings, {
			saveBinding: async change => {
				saveBindingCalls.push(change);
				return { ok: true, notice: "saved" };
			},
			setOverrides: (property, overrides) => {
				setOverridesCalls.push({ property, overrides });
			},
		});
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip: pick model… (index 0)
		hub.handleInput("\x1b[C"); // -> pattern…
		hub.handleInput("\r"); // pattern input
		type("anthropic/claude-sonnet-4-5");
		hub.handleInput("\r"); // submit
		await flushAsync();
		expect(saveBindingCalls).toEqual([{ agent: "dev", property: "model", value: "anthropic/claude-sonnet-4-5" }]);
		expect(setOverridesCalls).toEqual([]);
		expect(strip()).toContain("saved");
	});

	test("saveBinding returning undefined (no mapping applies) falls back to setOverrides", async () => {
		const settings = createSettings();
		const saveBindingCalls: HubAgentBindingChange[] = [];
		const { hub, type } = await createHub(settings, {
			saveBinding: async change => {
				saveBindingCalls.push(change);
				return undefined;
			},
		});
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b[C"); // -> pattern…
		hub.handleInput("\r"); // pattern input
		type("anthropic/claude-sonnet-4-5");
		hub.handleInput("\r"); // submit
		await flushAsync();
		expect(saveBindingCalls).toEqual([{ agent: "dev", property: "model", value: "anthropic/claude-sonnet-4-5" }]);
		expect(settings.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-sonnet-4-5" });
	});

	test("an agent with a binding shows the credential line in the detail pane and a credential chip in the model strip", async () => {
		const settings = createSettings();
		const { hub, strip } = await createHub(settings, {
			saveBinding: async () => undefined,
			loadAgents: async () => [
				{
					name: "dev",
					description: "Development agent",
					systemPrompt: "You are dev.",
					source: "project",
					filePath: "/tmp/agents-hub-test/.omp/agents/dev.md",
					origin: "project-omp",
					editable: true,
					disabled: false,
					binding: "split · anthropic: work #5",
				},
			],
		});
		expect(strip()).toContain("credential: split · anthropic: work #5");
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		const rendered = strip();
		expect(rendered).toContain("pick model…");
		expect(rendered).toContain("credential: split · anthropic: work #5 · map…");
	});
});

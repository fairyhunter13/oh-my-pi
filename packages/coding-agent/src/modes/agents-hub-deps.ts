import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentsHubDeps, GeneratedAgentSpec, HubAgentOrigin } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import {
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import agentCreationArchitectPrompt from "../prompts/system/agent-creation-architect.md" with { type: "text" };
import agentCreationUserPrompt from "../prompts/system/agent-creation-user.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import { refreshAgentDiscovery } from "../task";
import { discoverAgents } from "../task/discovery";
import { resolveAgentPrewalkDefault } from "../task/prewalk";
import type { AgentDefinition } from "../task/types";
import { createModelBrowserSource } from "./model-browser-source";

import {
	cfgTaskAgentAdvisor,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentPrewalk,
	cfgTaskDisabledAgents,
	cfgTaskPrewalk,
} from "../task/settings";

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || block.type !== "text" || !("text" in block)) return "";
				const value = block.text;
				return typeof value === "string" ? value : "";
			})
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}

/** Frontmatter object built from a form spec, kebab-cased where `parseAgentFields` expects it. */
function buildAgentFrontmatter(spec: GeneratedAgentSpec): Record<string, unknown> {
	const fields: Record<string, unknown> = { name: spec.identifier, description: spec.whenToUse };
	if (spec.tools && spec.tools.length > 0) fields.tools = spec.tools;
	if (spec.thinkingLevel) fields["thinking-level"] = spec.thinkingLevel;
	if (spec.model) fields.model = spec.model;
	return fields;
}

function agentFileContent(spec: GeneratedAgentSpec): string {
	const frontmatter = YAML.stringify(buildAgentFrontmatter(spec), null, 2).trimEnd();
	return `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`;
}

/** The four agent roots the hub distinguishes: writable project/user `.omp`, and read-only everything else. */
interface AgentRoots {
	projectOmp?: string;
	projectClaude?: string;
	userOmp?: string;
}

function resolveAgentRoots(cwd: string): AgentRoots {
	const nearestProjectDirs = findAllNearestProjectConfigDirs("agents", cwd);
	const projectOmp = nearestProjectDirs.find(entry => entry.source === ".omp")?.path;
	const projectClaude = nearestProjectDirs.find(entry => entry.source === ".claude")?.path;
	const userOmp = getConfigDirs("agents", { project: false }).find(entry => entry.source === ".omp")?.path;
	return {
		projectOmp: projectOmp ? path.resolve(projectOmp) : undefined,
		projectClaude: projectClaude ? path.resolve(projectClaude) : undefined,
		userOmp: userOmp ? path.resolve(userOmp) : undefined,
	};
}

function classifyAgentOrigin(
	filePath: string | undefined,
	isBundled: boolean,
	roots: AgentRoots,
): { origin: HubAgentOrigin; editable: boolean } {
	if (isBundled || !filePath) return { origin: "bundled", editable: false };
	const dir = path.resolve(path.dirname(filePath));
	if (roots.projectOmp && dir === roots.projectOmp) return { origin: "project-omp", editable: true };
	if (roots.projectClaude && dir === roots.projectClaude) return { origin: "project-claude", editable: false };
	if (roots.userOmp && dir === roots.userOmp) return { origin: "user", editable: true };
	return { origin: "plugin", editable: false };
}

/** Refuses to touch a file outside the writable project/user `.omp` agent roots. */
function assertWritableAgentPath(filePath: string, cwd: string): void {
	const roots = resolveAgentRoots(cwd);
	const dir = path.resolve(path.dirname(filePath));
	if (dir === roots.projectOmp || dir === roots.userOmp) return;
	throw new Error(`${shortenPath(filePath)} is not in a writable agent directory (project or user .omp/agents).`);
}

export function createAgentsHubDeps(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	extensionRoots: () => EffectiveExtensionRoots,
	activeModelPattern?: string,
	defaultModelPattern?: string,
	commandRunner?: {
		/** Whether a slash command of this name is registered on the session. */
		hasCommand: (name: string) => boolean;
		/** Run `text` (e.g. `"/agent-profile set scout"`) the way a typed slash command runs. */
		runCommand: (text: string) => Promise<boolean>;
	},
): AgentsHubDeps {
	return {
		browserSource: createModelBrowserSource(settings),
		loadAgents: async () => {
			const { agents } = await discoverAgents(cwd, undefined, extensionRoots());
			const disabled = new Set(cfgTaskDisabledAgents.get(settings));
			const overrides = cfgTaskAgentModelOverrides.get(settings);
			const prewalkOverrides = cfgTaskAgentPrewalk.get(settings);
			const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
			const roots = resolveAgentRoots(cwd);
			return agents.map(agent => {
				const override = overrides[agent.name];
				const overrideModel = (Array.isArray(override) ? override.join(",") : (override ?? "")).trim();
				const { origin, editable } = classifyAgentOrigin(agent.filePath, agent.source === "bundled", roots);
				return {
					...agent,
					origin,
					editable,
					disabled: disabled.has(agent.name),
					overrideModel: overrideModel || undefined,
					prewalkOverride: prewalkOverrides[agent.name]?.trim() || undefined,
					advisorOverride: advisorOverrides[agent.name]?.trim() || undefined,
				};
			});
		},
		getAvailableModels: () => modelRegistry.getAvailable(),
		effectiveModelPatterns: agent =>
			resolveAgentModelPatterns({
				settingsOverride: agent.overrideModel,
				agentModel: agent.model,
				settings,
				activeModelPattern,
				fallbackModelPattern: defaultModelPattern,
			}),
		resolvePatterns: patterns => {
			if (patterns.length === 0) return undefined;
			const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(
				patterns,
				modelRegistry,
				settings,
			);
			if (!model) return undefined;
			const level = explicitThinkingLevel && thinkingLevel ? `:${thinkingLevel}` : "";
			return `${model.provider}/${model.id}${level}`;
		},
		effectivePrewalkPattern: agent =>
			resolveAgentPrewalkPattern({
				settingsOverride: agent.prewalkOverride,
				// HubAgent widens `thinkingLevel` to `string` for the tui-side interface; the value
				// still came from a real AgentDefinition spread in loadAgents, so this is safe.
				agentPrewalk: resolveAgentPrewalkDefault(agent as unknown as AgentDefinition, cfgTaskPrewalk.get(settings)),
			}),
		effectiveAdvisorPattern: agent => {
			const selection = resolveAgentAdvisorSelection({
				settingsOverride: agent.advisorOverride,
				agentAdvisor: agent.advisor,
			});
			return selection ? (selection.model ?? "@advisor") : undefined;
		},
		setDisabledAgents: names => cfgTaskDisabledAgents.set(settings, names),
		setOverrides: (property, overrides) => {
			const setting =
				property === "model"
					? cfgTaskAgentModelOverrides
					: property === "prewalk"
						? cfgTaskAgentPrewalk
						: cfgTaskAgentAdvisor;
			setting.set(settings, overrides);
		},
		generateAgent: async (description, onText) => {
			await modelRegistry.refresh();
			const patterns = resolveConfiguredModelPatterns(
				activeModelPattern ?? defaultModelPattern ?? settings.getModelRole("default"),
				settings,
			);
			const { model } = resolveModelOverride(patterns, modelRegistry, settings);
			const selectedModel = model ?? modelRegistry.getAvailable()[0];
			if (!selectedModel) throw new Error("No available model to generate agent specification.");
			const { session } = await createAgentSession({
				cwd,
				authStorage: modelRegistry.authStorage,
				modelRegistry,
				settings,
				model: selectedModel,
				systemPrompt: [prompt.render(agentCreationArchitectPrompt, {})],
				hasUI: false,
				enableLsp: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				toolNames: ["__none__"],
				customTools: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				// A helper for the host session: the host keeps the process-wide effects and provider toggles.
				bindProcessState: false,
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_update" && "assistantMessageEvent" in event) {
					const ame = event.assistantMessageEvent;
					if (ame.type === "text_delta") onText(ame.delta);
				}
			});
			try {
				await session.prompt(prompt.render(agentCreationUserPrompt, { request: description }), {
					expandPromptTemplates: false,
				});
				const raw = extractAssistantText(session.state.messages);
				if (!raw) throw new Error("No response returned by agent creation architect.");
				return raw;
			} finally {
				unsubscribe();
				await session.dispose();
			}
		},
		saveAgent: async (scope, spec) => {
			const dirs = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd });
			const targetDir = dirs[0]?.path;
			if (!targetDir) throw new Error(`Cannot resolve ${scope} agents directory.`);
			const filePath = path.join(targetDir, `${spec.identifier}.md`);
			try {
				await fs.stat(filePath);
				throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await Bun.write(filePath, agentFileContent(spec));
			await refreshAgentDiscovery(cwd, extensionRoots());
			return filePath;
		},
		updateAgent: async (filePath, spec) => {
			assertWritableAgentPath(filePath, cwd);
			await Bun.write(filePath, agentFileContent(spec));
			await refreshAgentDiscovery(cwd, extensionRoots());
		},
		deleteAgent: async filePath => {
			assertWritableAgentPath(filePath, cwd);
			const dir = path.dirname(filePath);
			const trashDir = path.join(dir, ".trash");
			await fs.mkdir(trashDir, { recursive: true });
			const base = path.basename(filePath, ".md");
			const dest = path.join(trashDir, `${base}-${Date.now()}.md`);
			await fs.rename(filePath, dest);
			await refreshAgentDiscovery(cwd, extensionRoots());
		},
		hasAgentProfileCommand: () => commandRunner?.hasCommand("agent-profile") ?? false,
		runAgentProfileSet: async agentName => {
			await commandRunner?.runCommand(`/agent-profile set ${agentName}`);
		},
	};
}

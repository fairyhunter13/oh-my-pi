/**
 * Fullscreen /agents hub, shown on the alternate screen like /models.
 *
 * Layout mirrors the model hub: a sidebar of scopes (All agents, per-source
 * groups, "+ New agent"), a body listing agents with type-to-filter search,
 * and a footer that turns into a chip strip while configuring. Enter on an
 * agent opens its property strip (enabled / model / prewalk / advisor); a
 * property opens a value strip whose "pick model…" chip dives into the real
 * ModelBrowser and whose "pattern…" chip opens an inline pattern input, so
 * every per-agent knob is picked instead of memorized.
 *
 * `e`/`d` edit or delete a user/project `.omp` agent in place; a read-only
 * agent (bundled, plugin, or a repo's `.claude/agents`) offers `e` as "copy
 * to user/project" instead, since its file cannot be rewritten in place.
 * `c` hands a agent's credential mapping off to `/agent-profile set <name>`
 * when that extension command is registered on the session; otherwise it
 * just names the command to run by hand.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Editor,
	fuzzyMatch,
	Input,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import type { AgentSource } from "../tools/task";
import { shortenPath } from "../render/render-utils";
import { getEditorTheme, theme } from "../theme";
import { matchesAppFollowUp, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserSource,
	sortModelItems,
} from "./model-browser";
import {
	HubFrame,
	moveStripSelection,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";
import { HookEditorComponent } from "./hook-editor";

/** Where an agent's own file lives, for edit/delete gating and the row's source label. */
export type HubAgentOrigin = "project-omp" | "project-claude" | "user" | "plugin" | "bundled";

/** One agent with its per-agent settings overrides resolved for display. */
export interface HubAgent {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
	model?: string[];
	tools?: string[];
	thinkingLevel?: string;
	prewalk?: boolean | string;
	advisor?: boolean | string;
	disabled: boolean;
	/** `task.agentModelOverrides[name]` as a comma-joined pattern list. */
	overrideModel?: string;
	/** `task.agentPrewalk[name]`: "on", "off", or a model pattern. */
	prewalkOverride?: string;
	/** `task.agentAdvisor[name]`: "on", "off", or a model pattern. */
	advisorOverride?: string;
	/** Directory this agent's file lives in, resolved against the known agent roots. */
	origin: HubAgentOrigin;
	/** Whether the hub may rewrite or delete this agent's file (project `.omp` or user scope). */
	editable: boolean;
}

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};
const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, bundled: 2 };
const ORIGIN_LABEL: Record<HubAgentOrigin, string> = {
	"project-omp": "project .omp",
	"project-claude": "project .claude",
	user: "user",
	plugin: "plugin",
	bundled: "bundled",
};

interface SidebarEntry extends HubSidebarEntry<"all" | "source" | "new" | "separator"> {
	source?: AgentSource;
}

/** A body row of the agent list: an agent or the trailing "+ New agent…". */
type ListRow = { kind: "agent"; agent: HubAgent } | { kind: "new" };

/** The per-agent knob a strip or the model browser is editing. */
type PropertyKind = "model" | "prewalk" | "advisor";

type StripChip = HubStripChip<
	| { kind: "toggle" }
	| { kind: "property"; property: PropertyKind }
	| { kind: "set"; property: PropertyKind; value: string | undefined }
	| { kind: "pick"; property: PropertyKind }
	| { kind: "pattern"; property: PropertyKind }
	| { kind: "mapCredential" }
	| { kind: "edit" }
	| { kind: "delete" }
	| { kind: "copy" }
	| { kind: "keep" }
	| { kind: "confirmDelete" }
>;

type StripState =
	| (HubStripState<StripChip> & { kind: "chips"; agent: HubAgent; property?: PropertyKind })
	| { kind: "pattern"; agent: HubAgent; property: PropertyKind; input: Input };

export interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
	/** Frontmatter `tools:`; absent/empty inherits the agent's default tool set. */
	tools?: string[];
	/** Frontmatter `thinking-level:`. */
	thinkingLevel?: string;
	/** Frontmatter `model:`; one selector (a role alias, or `provider/model[:level]`). */
	model?: string;
	/** `mode: "copy"` only: the read-only source agent's file, whose unmanaged frontmatter keys (spawns, blocking, output, prewalk, advisor, read-summarize, autoload-skills, …) carry over to the copy. */
	sourceFilePath?: string;
}

/** The one-agent form shared by create-review, copy, and in-place edit. */
interface AgentFormState {
	mode: "create" | "copy" | "edit";
	/** Only meaningful for create/copy: which config dir the file lands in. */
	scope: "project" | "user";
	/** Set only for `mode: "edit"`: the file rewritten in place. */
	filePath?: string;
	/** Set only for `mode: "copy"`: the read-only source agent's file. */
	sourceFilePath?: string;
	/** Read-only display; also the frontmatter `name:` written back. */
	name: string;
	description: string;
	/** Comma-separated tool list, "" = inherit the agent's default tools. */
	tools: string;
	thinkingLevel: string;
	model: string;
	systemPrompt: string;
	/** Non-null while a single field's inline `Input` editor is open. */
	field: "description" | "tools" | "thinkingLevel" | "model" | null;
	fieldInput: Input | null;
}

/** Runtime-owned discovery, settings, generation and persistence. */
export interface AgentsHubDeps {
	browserSource: ModelBrowserSource;
	loadAgents: () => Promise<HubAgent[]>;
	getAvailableModels: () => Model[];
	effectiveModelPatterns: (agent: HubAgent) => string[];
	resolvePatterns: (patterns: string[]) => string | undefined;
	effectivePrewalkPattern: (agent: HubAgent) => string | undefined;
	effectiveAdvisorPattern: (agent: HubAgent) => string | undefined;
	setDisabledAgents: (names: string[]) => void;
	setOverrides: (property: PropertyKind, overrides: Record<string, string>) => void;
	generateAgent: (description: string, onText: (text: string) => void) => Promise<string>;
	saveAgent: (scope: "project" | "user", spec: GeneratedAgentSpec) => Promise<string>;
	/** Rewrite an existing user/project `.omp` agent's frontmatter and body in place. */
	updateAgent: (filePath: string, spec: GeneratedAgentSpec) => Promise<void>;
	/** Move an existing user/project `.omp` agent's file to its directory's `.trash/`. */
	deleteAgent: (filePath: string) => Promise<void>;
	/** Edit long text (the system prompt) in the host's configured `$VISUAL`/`$EDITOR`. */
	externalEditor?: (text: string) => Promise<string | null>;
	/** Whether the `/agent-profile` extension command is registered on the session. */
	hasAgentProfileCommand: () => boolean;
	/** Run `/agent-profile set <name>` the way a typed slash command runs. */
	runAgentProfileSet: (agentName: string) => Promise<void>;
}

export interface AgentsHubCallbacks {
	onCancel: () => void;
}

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

function extractJsonObject(raw: string): string {
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) return raw.slice(start, end + 1).trim();
	return raw.trim();
}

function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed = JSON.parse(extractJsonObject(raw)) as Partial<GeneratedAgentSpec>;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Model output is not a JSON object");
	}
	if (
		typeof parsed.identifier !== "string" ||
		typeof parsed.whenToUse !== "string" ||
		typeof parsed.systemPrompt !== "string"
	) {
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	}
	const identifier = parsed.identifier.trim();
	const whenToUse = parsed.whenToUse.trim();
	const systemPrompt = parsed.systemPrompt.trim();
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	}
	if (!whenToUse.toLowerCase().startsWith("use this agent when")) {
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	}
	if (!systemPrompt) {
		throw new Error("Generated systemPrompt is empty");
	}
	return { identifier, whenToUse, systemPrompt };
}

function matchAgent(agent: HubAgent, query: string): boolean {
	const text = `${agent.name} ${agent.description} ${ORIGIN_LABEL[agent.origin]} ${agent.overrideModel ?? ""}`;
	return query
		.trim()
		.split(/\s+/)
		.every(token => fuzzyMatch(token, text).matches);
}

/**
 * The fullscreen agents hub component. Hosted via
 * `ui.showOverlay(..., { fullscreen: true })`; the host must call
 * {@link AgentsHubComponent.dispose} when the overlay closes.
 */
export class AgentsHubComponent implements Component {
	#tui: TUI;
	#deps: AgentsHubDeps;
	#callbacks: AgentsHubCallbacks;

	#allAgents: HubAgent[] = [];
	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#focus: "scope" | "list" = "list";

	#rows: ListRow[] = [];
	#rowIndex = 0;
	#rowHover: number | null = null;
	#listScroll = 0;
	#searchQuery = "";
	#notice: string | null = null;
	#loadError: string | null = null;

	#strip: StripState | null = null;
	/** Non-null while the body shows the model browser for one agent property. */
	#assigning: { agent: HubAgent; property: PropertyKind } | null = null;
	#browser: ModelBrowser;

	// Create / copy / edit flow (one agent's fields, form-shaped).
	#createInput: Editor | null = null;
	#createDescription = "";
	#createScope: "project" | "user" = "project";
	#createGenerating = false;
	#createError: string | null = null;
	#createStreamingText = "";
	/** Non-null once a spec exists to review — from AI generation, from a copy source, or from an existing agent. */
	#form: AgentFormState | null = null;
	/** Non-null while the system prompt is open in the multiline dialog (with `$EDITOR` escape). */
	#promptEditor: HookEditorComponent | null = null;

	#renderBodyPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines: string[] = [this.#statusRow(width)];
		if (this.#promptEditor) {
			lines.push(...this.#promptEditor.render(width));
		} else if (this.#createActive) {
			lines.push(...this.#renderCreate(width, rows - 1));
		} else if (this.#assigning) {
			this.#browser.setMaxVisible(rows - 1 - 5);
			this.#browser.setFocused(true);
			lines.push(...this.#browser.render(width));
		} else {
			lines.push(...this.#renderList(width, rows - 1));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #frame: HubFrame = new HubFrame(
		"Agents",
		{ min: 16, max: 24 },
		(width, rows) =>
			this.#frame.renderSidebar(
				this.#entries,
				width,
				rows,
				{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: true, clamp: false },
				this.#sidebarStyle,
			),
		this.#renderBodyPane,
	);
	/** First agent-list row's offset in body-line coordinates (after the status row). */
	#listRowStart = 2;

	private constructor(tui: TUI, deps: AgentsHubDeps, callbacks: AgentsHubCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#callbacks = callbacks;
		this.#browser = new ModelBrowser(deps.browserSource, {
			emptyText: () => "  No models available — configure a provider in /models first.",
		});
		this.#browser.setShowProvider(true);
		this.#browser.onActivate = item => this.#commitPickedModel(item);
		this.#browser.onCancel = () => this.#cancelAssign();
	}

	static async create(
		tui: TUI,
		deps: AgentsHubDeps,
		callbacks: AgentsHubCallbacks = { onCancel: () => {} },
	): Promise<AgentsHubComponent> {
		const hub = new AgentsHubComponent(tui, deps, callbacks);
		await hub.#reload();
		return hub;
	}

	dispose(): void {}
	invalidate(): void {
		this.#frame.invalidate();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	async #reload(): Promise<void> {
		this.#loadError = null;
		try {
			const selectedName = this.#selectedAgent()?.name;
			this.#allAgents = (await this.#deps.loadAgents()).sort((a, b) => {
				const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
				return sourceCmp !== 0 ? sourceCmp : a.name.localeCompare(b.name);
			});
			this.#buildSidebar();
			this.#buildRows();
			if (selectedName) {
				const index = this.#rows.findIndex(r => r.kind === "agent" && r.agent.name === selectedName);
				if (index >= 0) this.#rowIndex = index;
			}
			this.#clampRowIndex();
		} catch (error) {
			this.#allAgents = [];
			this.#buildSidebar();
			this.#buildRows();
			this.#loadError = error instanceof Error ? error.message : String(error);
		}
		this.#tui.requestRender();
	}

	#buildSidebar(): void {
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of this.#allAgents) counts[agent.source]++;
		const entries: SidebarEntry[] = [
			{ id: "all", kind: "all", label: "All agents", annotation: String(this.#allAgents.length) },
		];
		const sources = (["project", "user", "bundled"] as const).filter(source => counts[source] > 0);
		if (sources.length > 0) {
			entries.push({ id: "sep:sources", kind: "separator", label: "" });
			for (const source of sources) {
				entries.push({
					id: `source:${source}`,
					kind: "source",
					label: SOURCE_LABEL[source],
					source,
					annotation: String(counts[source]),
				});
			}
		}
		entries.push({ id: "sep:actions", kind: "separator", label: "" });
		entries.push({ id: "new", kind: "new", label: "New agent" });
		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) this.#activeEntryId = "all";
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#buildRows(): void {
		const entry = this.#activeEntry();
		const scoped =
			entry.kind === "source" ? this.#allAgents.filter(agent => agent.source === entry.source) : this.#allAgents;
		const filtered = this.#searchQuery ? scoped.filter(agent => matchAgent(agent, this.#searchQuery)) : scoped;
		this.#rows = [...filtered.map(agent => ({ kind: "agent", agent }) as ListRow), { kind: "new" }];
	}

	#clampRowIndex(): void {
		this.#rowIndex = Math.max(0, Math.min(this.#rowIndex, this.#rows.length - 1));
	}

	#selectedAgent(): HubAgent | undefined {
		const rowDef = this.#rows[this.#rowIndex];
		return rowDef?.kind === "agent" ? rowDef.agent : undefined;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mutations
	// ═══════════════════════════════════════════════════════════════════════

	#toggleAgent(agent: HubAgent): void {
		agent.disabled = !agent.disabled;
		const disabled = this.#allAgents
			.filter(entry => entry.disabled)
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b));
		this.#deps.setDisabledAgents(disabled);
		this.#notice = `${agent.name} ${agent.disabled ? "disabled" : "enabled"}`;
		this.#tui.requestRender();
	}

	#persistRecord(property: PropertyKind): void {
		const overrides: Record<string, string> = {};
		for (const agent of this.#allAgents) {
			const value = this.#overrideFor(agent, property)?.trim();
			if (value) overrides[agent.name] = value;
		}
		this.#deps.setOverrides(property, overrides);
	}

	#overrideFor(agent: HubAgent, property: PropertyKind): string | undefined {
		switch (property) {
			case "model":
				return agent.overrideModel;
			case "prewalk":
				return agent.prewalkOverride;
			case "advisor":
				return agent.advisorOverride;
		}
	}

	#setOverride(agent: HubAgent, property: PropertyKind, value: string | undefined): void {
		const trimmed = value?.trim() || undefined;
		switch (property) {
			case "model":
				agent.overrideModel = trimmed;
				break;
			case "prewalk":
				agent.prewalkOverride = trimmed;
				break;
			case "advisor":
				agent.advisorOverride = trimmed;
				break;
		}
		this.#persistRecord(property);
		this.#notice = this.#describeProperty(agent, property);
		this.#tui.requestRender();
	}

	/** One-line effective description used for notices and the status row. */
	#describeProperty(agent: HubAgent, property: PropertyKind): string {
		switch (property) {
			case "model": {
				const patterns = this.#deps.effectiveModelPatterns(agent);
				const resolved = this.#deps.resolvePatterns(patterns);
				const base = agent.overrideModel ?? (patterns.length > 0 ? patterns.join(",") : "session model");
				return `${agent.name} model: ${base}${resolved ? ` → ${resolved}` : ""}`;
			}
			case "prewalk": {
				const pattern = this.#deps.effectivePrewalkPattern(agent);
				return `${agent.name} prewalk: ${pattern ? `on (${pattern})` : "off"}`;
			}
			case "advisor": {
				const pattern = this.#deps.effectiveAdvisorPattern(agent);
				return `${agent.name} advisor: ${pattern ? `on (${pattern})` : "off"}`;
			}
		}
	}

	/** Fire `/agent-profile set <name>` when the command is registered; otherwise just say so. */
	#runAgentProfileMapping(agentName: string): void {
		if (!this.#deps.hasAgentProfileCommand()) {
			this.#notice = `Map it with /agent-profile set ${agentName}`;
			this.#tui.requestRender();
			return;
		}
		this.#notice = `Running /agent-profile set ${agentName}…`;
		this.#tui.requestRender();
		void this.#deps
			.runAgentProfileSet(agentName)
			.then(() => {
				this.#notice = `/agent-profile set ${agentName} done`;
				this.#tui.requestRender();
			})
			.catch(error => {
				this.#notice = `/agent-profile set ${agentName} failed: ${error instanceof Error ? error.message : String(error)}`;
				this.#tui.requestRender();
			});
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Strips
	// ═══════════════════════════════════════════════════════════════════════

	#propertySummary(agent: HubAgent, property: PropertyKind): string {
		if (property === "model" && this.#deps.hasAgentProfileCommand()) return "set by /agent-profile";
		switch (property) {
			case "model":
				return agent.overrideModel ?? "auto";
			case "prewalk": {
				const pattern = this.#deps.effectivePrewalkPattern(agent);
				return pattern ?? "off";
			}
			case "advisor": {
				const pattern = this.#deps.effectiveAdvisorPattern(agent);
				return pattern ?? "off";
			}
		}
	}

	/** Level-1 strip: pick which knob of `agent` to change. */
	#openAgentStrip(agent: HubAgent): void {
		const enabledChip: StripChip = {
			label: agent.disabled ? "enable" : "disable",
			styled: agent.disabled
				? theme.fg("success", `${theme.status.enabled} enable`)
				: theme.fg("dim", `${theme.status.disabled} disable`),
			action: { kind: "toggle" },
		};
		const propertyChip = (property: PropertyKind): StripChip => {
			const summary = this.#propertySummary(agent, property);
			return {
				label: property,
				styled: `${theme.fg("accent", property)}${theme.fg("dim", `: ${summary}`)}`,
				action: { kind: "property", property },
			};
		};
		const chips: StripChip[] = [enabledChip, propertyChip("model"), propertyChip("prewalk"), propertyChip("advisor")];
		if (agent.editable) {
			chips.push({ label: "edit", styled: theme.fg("accent", "edit"), action: { kind: "edit" } });
			chips.push({ label: "delete", styled: theme.fg("error", "delete"), action: { kind: "delete" } });
		} else {
			chips.push({ label: "copy…", styled: theme.fg("accent", "copy…"), action: { kind: "copy" } });
		}
		this.#strip = { kind: "chips", agent, chips, index: 1 };
	}

	/** Level-2 strip: value choices for one property of `agent`. */
	#openPropertyStrip(agent: HubAgent, property: PropertyKind): void {
		if (property === "model" && this.#deps.hasAgentProfileCommand()) {
			this.#strip = {
				kind: "chips",
				agent,
				property,
				chips: [
					{
						label: "map with /agent-profile",
						styled: theme.fg("accent", "map with /agent-profile"),
						action: { kind: "mapCredential" },
					},
				],
				index: 0,
			};
			return;
		}
		const current = this.#overrideFor(agent, property)?.toLowerCase();
		const chips: StripChip[] = [];
		const mark = (label: string, active: boolean, color: "accent" | "muted" = "muted"): string =>
			active ? theme.fg("accent", `${theme.status.enabled} ${label}`) : theme.fg(color, label);
		if (property === "model") {
			chips.push({
				label: "pick model…",
				styled: theme.fg("accent", "pick model…"),
				action: { kind: "pick", property },
			});
			chips.push({
				label: "pattern…",
				styled: theme.fg("muted", "pattern…"),
				action: { kind: "pattern", property },
			});
			if (agent.overrideModel) {
				chips.push({
					label: "clear override",
					styled: theme.fg("warning", "clear override"),
					action: { kind: "set", property, value: undefined },
				});
			}
		} else {
			chips.push({
				label: "agent default",
				styled: mark("agent default", current === undefined),
				action: { kind: "set", property, value: undefined },
			});
			chips.push({
				label: "on",
				styled: mark("on", current === "on"),
				action: { kind: "set", property, value: "on" },
			});
			chips.push({
				label: "off",
				styled: mark("off", current === "off"),
				action: { kind: "set", property, value: "off" },
			});
			chips.push({
				label: "pick model…",
				styled: theme.fg("accent", "pick model…"),
				action: { kind: "pick", property },
			});
			chips.push({
				label: "pattern…",
				styled: theme.fg("muted", "pattern…"),
				action: { kind: "pattern", property },
			});
		}
		this.#strip = { kind: "chips", agent, property, chips, index: 0 };
	}

	#openPatternStrip(agent: HubAgent, property: PropertyKind): void {
		const input = new Input();
		const current = this.#overrideFor(agent, property);
		if (current) input.setValue(current);
		this.#strip = { kind: "pattern", agent, property, input };
	}

	/** Confirmation strip for `d` / the "delete" chip: `Keep it` or `Delete <name>`. */
	#openDeleteConfirm(agent: HubAgent): void {
		this.#strip = {
			kind: "chips",
			agent,
			chips: [
				{ label: "Keep it", styled: theme.fg("muted", "Keep it"), action: { kind: "keep" } },
				{
					label: `Delete ${agent.name}`,
					styled: theme.fg("error", `Delete ${agent.name}`),
					action: { kind: "confirmDelete" },
				},
			],
			index: 0,
		};
	}

	#closeStrip(): void {
		this.#strip = null;
		this.#frame.chipRanges = [];
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "chips") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		const action = chip.action;
		switch (action.kind) {
			case "toggle":
				this.#toggleAgent(strip.agent);
				this.#closeStrip();
				return;
			case "property":
				this.#openPropertyStrip(strip.agent, action.property);
				return;
			case "set":
				this.#setOverride(strip.agent, action.property, action.value);
				this.#closeStrip();
				return;
			case "pick":
				this.#closeStrip();
				this.#startAssign(strip.agent, action.property);
				return;
			case "pattern":
				this.#openPatternStrip(strip.agent, action.property);
				return;
			case "mapCredential":
				this.#closeStrip();
				this.#runAgentProfileMapping(strip.agent.name);
				return;
			case "edit":
				this.#closeStrip();
				this.#beginEditFlow(strip.agent);
				return;
			case "delete":
				this.#openDeleteConfirm(strip.agent);
				return;
			case "copy":
				this.#closeStrip();
				this.#beginCopyFlow(strip.agent);
				return;
			case "keep":
				this.#closeStrip();
				return;
			case "confirmDelete": {
				const agent = strip.agent;
				this.#closeStrip();
				void this.#deps
					.deleteAgent(agent.filePath ?? "")
					.then(async () => {
						this.#notice = `Deleted ${agent.name}`;
						await this.#reload();
					})
					.catch(error => {
						this.#notice = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
						this.#tui.requestRender();
					});
				return;
			}
		}
	}

	#submitPattern(): void {
		const strip = this.#strip;
		if (strip?.kind !== "pattern") return;
		this.#setOverride(strip.agent, strip.property, strip.input.getValue());
		this.#closeStrip();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Model browser assign mode
	// ═══════════════════════════════════════════════════════════════════════

	#startAssign(agent: HubAgent, property: PropertyKind): void {
		const items = buildBrowserItems(this.#deps.getAvailableModels());
		sortModelItems(items, { mruOrder: this.#deps.browserSource.mruOrder });
		this.#assigning = { agent, property };
		this.#browser.setItems(items);
		this.#browser.setQuery("");
		const current = this.#overrideFor(agent, property);
		if (current) this.#browser.selectSelector(current);
	}

	#commitPickedModel(item: ModelBrowserItem): void {
		const target = this.#assigning;
		if (!target) return;
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setOverride(target.agent, target.property, item.selector);
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Create / copy / edit flow
	// ═══════════════════════════════════════════════════════════════════════

	get #createActive(): boolean {
		return this.#createInput !== null || this.#createGenerating || this.#form !== null;
	}

	#beginCreateFlow(): void {
		if (this.#createGenerating) return;
		this.#createError = null;
		this.#form = null;
		this.#createDescription = "";
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.setMaxHeight(Math.max(3, Math.min(8, this.#terminalRows() - 12)));
		editor.disableSubmit = true;
		editor.onChange = value => {
			this.#createDescription = value;
		};
		this.#createInput = editor;
		this.#tui.requestRender();
	}

	/** Read-only agent (bundled, plugin, a repo's `.claude/agents`, or a ccw-generated user agent): copy it into an editable scope. */
	#beginCopyFlow(agent: HubAgent): void {
		this.#createError = null;
		this.#createInput = null;
		this.#createGenerating = false;
		this.#form = {
			mode: "copy",
			// J-3: a project `.claude` agent is shadowed by a same-named user
			// agent (project `.omp` wins over user, per discovery precedence),
			// so its copy must default into the project scope, not user.
			scope: agent.origin === "user" || agent.origin === "project-claude" ? "project" : "user",
			sourceFilePath: agent.filePath,
			name: agent.name,
			description: agent.description,
			tools: (agent.tools ?? []).join(", "),
			thinkingLevel: agent.thinkingLevel ?? "",
			model: (agent.model ?? []).join(","),
			systemPrompt: agent.systemPrompt,
			field: null,
			fieldInput: null,
		};
		this.#tui.requestRender();
	}

	/** An editable (project `.omp` or user) agent: rewrite its file in place. Name stays read-only. */
	#beginEditFlow(agent: HubAgent): void {
		if (!agent.editable || !agent.filePath) return;
		this.#createError = null;
		this.#createInput = null;
		this.#createGenerating = false;
		this.#form = {
			mode: "edit",
			scope: agent.origin === "user" ? "user" : "project",
			filePath: agent.filePath,
			name: agent.name,
			description: agent.description,
			tools: (agent.tools ?? []).join(", "),
			thinkingLevel: agent.thinkingLevel ?? "",
			model: (agent.model ?? []).join(","),
			systemPrompt: agent.systemPrompt,
			field: null,
			fieldInput: null,
		};
		this.#tui.requestRender();
	}

	#clearCreateFlow(): void {
		this.#createInput = null;
		this.#createDescription = "";
		this.#createGenerating = false;
		this.#form = null;
		this.#createError = null;
		this.#createStreamingText = "";
		this.#promptEditor = null;
	}

	async #generateAgentFromDescription(rawDescription: string): Promise<void> {
		const description = rawDescription.trim();
		this.#createDescription = description;
		if (!description) {
			this.#createError = "Description is required.";
			this.#tui.requestRender();
			return;
		}
		this.#createGenerating = true;
		this.#createError = null;
		this.#form = null;
		this.#createStreamingText = "";
		this.#tui.requestRender();
		try {
			const spec = await this.#runAgentCreationArchitect(description);
			this.#form = {
				mode: "create",
				scope: this.#createScope,
				name: spec.identifier,
				description: spec.whenToUse,
				tools: "",
				thinkingLevel: "",
				model: "",
				systemPrompt: spec.systemPrompt,
				field: null,
				fieldInput: null,
			};
			this.#notice = null;
		} catch (error) {
			this.#createError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#createGenerating = false;
			this.#tui.requestRender();
		}
	}

	async #runAgentCreationArchitect(description: string): Promise<GeneratedAgentSpec> {
		const raw = await this.#deps.generateAgent(description, text => {
			this.#createStreamingText += text;
			this.#tui.requestRender();
		});
		return parseGeneratedAgentSpec(raw);
	}

	/** Open a single-line `Input` editor for one form field, prefilled with its current value. */
	#openFormField(form: AgentFormState, field: "description" | "tools" | "thinkingLevel" | "model"): void {
		const input = new Input();
		input.setValue(form[field]);
		form.field = field;
		form.fieldInput = input;
		this.#tui.requestRender();
	}

	/** Open the system prompt in the multiline dialog, with `$EDITOR` as an escape hatch. */
	#openPromptEditor(): void {
		const form = this.#form;
		if (!form) return;
		this.#promptEditor = new HookEditorComponent(
			this.#tui,
			"System prompt",
			form.systemPrompt,
			value => {
				form.systemPrompt = value;
				this.#promptEditor = null;
				this.#tui.requestRender();
			},
			() => {
				this.#promptEditor = null;
				this.#tui.requestRender();
			},
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#tui.requestRender();
	}

	async #submitForm(): Promise<void> {
		const form = this.#form;
		if (!form) return;
		const spec: GeneratedAgentSpec = {
			identifier: form.name,
			whenToUse: form.description,
			systemPrompt: form.systemPrompt,
			tools: form.tools.trim()
				? form.tools
						.split(",")
						.map(s => s.trim())
						.filter(Boolean)
				: undefined,
			thinkingLevel: form.thinkingLevel.trim() || undefined,
			model: form.model.trim() || undefined,
			sourceFilePath: form.mode === "copy" ? form.sourceFilePath : undefined,
		};
		if (form.mode === "edit") {
			if (!form.filePath) throw new Error("Missing file path for this agent.");
			await this.#deps.updateAgent(form.filePath, spec);
			this.#clearCreateFlow();
			this.#notice = `Updated agent ${spec.identifier}`;
			await this.#reload();
			return;
		}
		const filePath = await this.#deps.saveAgent(form.scope, spec);
		this.#clearCreateFlow();
		this.#notice = `${form.mode === "copy" ? "Copied" : "Created"} agent ${spec.identifier} at ${shortenPath(filePath)}`;
		await this.#reload();
		this.#runAgentProfileMapping(spec.identifier);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			this.#tui.requestRender();
			return;
		}

		if (this.#promptEditor) {
			this.#promptEditor.handleInput(data);
			this.#tui.requestRender();
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			this.#tui.requestRender();
			return;
		}

		if (this.#createActive) {
			this.#handleCreateInput(data);
			this.#tui.requestRender();
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigning) {
				this.#cancelAssign();
				return;
			}
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = "";
				this.#buildRows();
				this.#clampRowIndex();
				this.#tui.requestRender();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		if (this.#assigning) {
			this.#browser.handleInput(data);
			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			void this.#reload();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#focus = "list";
			this.#tui.requestRender();
			return;
		}

		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				this.#tui.requestRender();
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				this.#tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (this.#activeEntry().kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#focus = "list";
				}
				this.#tui.requestRender();
				return;
			}
		}

		if (matchesSelectUp(data)) {
			this.#rowIndex = Math.max(0, this.#rowIndex - 1);
			this.#tui.requestRender();
			return;
		}
		if (matchesSelectDown(data)) {
			this.#rowIndex = Math.min(this.#rows.length - 1, this.#rowIndex + 1);
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateRow(this.#rows[this.#rowIndex]);
			this.#tui.requestRender();
			return;
		}
		if (data === " " && this.#searchQuery.length === 0) {
			const agent = this.#selectedAgent();
			if (agent) this.#toggleAgent(agent);
			return;
		}
		// J-5: base keys, not ctrl chords, would shadow every search that starts
		// with e/d/c (e.g. typing "cri" for critical-task fires the c action on
		// the first keystroke, before "ri" ever reaches the filter). Type-to-filter
		// below handles the bare letters; only the chord form runs the action.
		if (matchesKey(data, "ctrl+e")) {
			const agent = this.#selectedAgent();
			if (agent) {
				if (agent.editable) this.#beginEditFlow(agent);
				else this.#beginCopyFlow(agent);
			}
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			const agent = this.#selectedAgent();
			if (agent) {
				if (agent.editable) this.#openDeleteConfirm(agent);
				else
					this.#notice = `${agent.name} is read-only (${ORIGIN_LABEL[agent.origin]}) — press ctrl+e to copy it first.`;
			}
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+k")) {
			const agent = this.#selectedAgent();
			if (agent) this.#runAgentProfileMapping(agent.name);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#buildRows();
				this.#clampRowIndex();
				this.#tui.requestRender();
			}
			return;
		}
		// Type-to-filter: any printable character extends the query.
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.#searchQuery += data;
			this.#focus = "list";
			this.#buildRows();
			this.#rowIndex = 0;
			this.#listScroll = 0;
			this.#tui.requestRender();
		}
	}

	#activateRow(rowDef: ListRow | undefined): void {
		if (!rowDef) return;
		if (rowDef.kind === "new") {
			this.#beginCreateFlow();
			return;
		}
		this.#openAgentStrip(rowDef.agent);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			// A property strip steps back up to the agent strip instead of closing.
			if (strip.kind === "chips" && strip.property) {
				this.#openAgentStrip(strip.agent);
				return;
			}
			if (strip.kind === "pattern") {
				this.#openPropertyStrip(strip.agent, strip.property);
				return;
			}
			this.#closeStrip();
			return;
		}
		if (strip.kind === "pattern") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitPattern();
				return;
			}
			strip.input.handleInput(data);
			return;
		}
		if (moveStripSelection(strip, data)) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#handleCreateInput(data: string): void {
		if (this.#form) {
			this.#handleFormInput(data);
			return;
		}
		if (matchesSelectCancel(data)) {
			if (!this.#createGenerating) this.#clearCreateFlow();
			return;
		}
		if (this.#createGenerating) return;
		if (matchesAppFollowUp(data)) {
			void this.#generateAgentFromDescription(this.#createInput?.getExpandedText() ?? this.#createDescription);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#createScope = this.#createScope === "project" ? "user" : "project";
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#createInput?.handleInput("\n");
			this.#createDescription = this.#createInput?.getExpandedText() ?? "";
			return;
		}
		this.#createInput?.handleInput(data);
		this.#createDescription = this.#createInput?.getExpandedText() ?? "";
	}

	#handleFormInput(data: string): void {
		const form = this.#form;
		if (!form) return;
		if (form.field) {
			if (matchesSelectCancel(data)) {
				form.field = null;
				form.fieldInput = null;
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				const value = form.fieldInput?.getValue() ?? "";
				switch (form.field) {
					case "description":
						form.description = value;
						break;
					case "tools":
						form.tools = value;
						break;
					case "thinkingLevel":
						form.thinkingLevel = value;
						break;
					case "model":
						form.model = value;
						break;
				}
				form.field = null;
				form.fieldInput = null;
				return;
			}
			form.fieldInput?.handleInput(data);
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#clearCreateFlow();
			return;
		}
		if ((matchesKey(data, "tab") || matchesKey(data, "shift+tab")) && form.mode !== "edit") {
			form.scope = form.scope === "project" ? "user" : "project";
			return;
		}
		if (form.mode === "create" && (data === "r" || data === "R")) {
			this.#form = null;
			void this.#generateAgentFromDescription(this.#createDescription);
			return;
		}
		if (data === "d" || data === "D") {
			this.#openFormField(form, "description");
			return;
		}
		if (data === "t" || data === "T") {
			this.#openFormField(form, "tools");
			return;
		}
		if (data === "l" || data === "L") {
			this.#openFormField(form, "thinkingLevel");
			return;
		}
		if (data === "m" || data === "M") {
			this.#openFormField(form, "model");
			return;
		}
		if (data === "p" || data === "P") {
			this.#openPromptEditor();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			void this.#submitForm().catch(error => {
				this.#createError = error instanceof Error ? error.message : String(error);
				this.#tui.requestRender();
			});
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && entry.kind !== "separator") {
				this.#activeEntryId = entry.id;
				if (entry.kind !== "new") {
					this.#buildRows();
					this.#rowIndex = 0;
					this.#listScroll = 0;
				}
				return;
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (this.#promptEditor) return true;

		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);

		if (footerColumn !== undefined && this.#strip?.kind === "chips") {
			const strip = this.#strip;
			if (event.leftClick && this.#frame.selectChipAt(strip, footerColumn)) {
				this.#activateStripChip();
			}
			return true;
		}

		if (this.#assigning) {
			if (overBody) this.#browser.routeMouse(event, bodyLine);
			return true;
		}
		if (this.#createActive || this.#strip) return true;

		if (event.wheel !== null) {
			if (overSidebar) {
				this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
			} else if (overBody) {
				this.#rowIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#rowIndex + event.wheel));
			}
			return true;
		}

		if (event.motion) {
			// Hover is stored as an absolute row index so paint and click agree.
			const hoverRow = bodyLine - this.#listRowStart + this.#listScroll;
			this.#rowHover = overBody && hoverRow >= 0 && hoverRow < this.#rows.length ? hoverRow : null;
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#frame.sidebarScroll + contentLine;
			const clicked = this.#entries[index];
			if (clicked && clicked.kind !== "separator") {
				if (clicked.kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#activeEntryId = clicked.id;
					this.#buildRows();
					this.#rowIndex = 0;
					this.#focus = "scope";
				}
			}
			return true;
		}
		if (overBody) {
			this.#focus = "list";
			const listLine = bodyLine - this.#listRowStart + this.#listScroll;
			if (listLine >= 0 && listLine < this.#rows.length) {
				if (listLine === this.#rowIndex) {
					this.#activateRow(this.#rows[listLine]);
				} else {
					this.#rowIndex = listLine;
				}
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#terminalRows(): number {
		return Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
	}

	#sidebarStyle = (entry: SidebarEntry): SidebarStyle => {
		const icon = entry.kind === "all" ? theme.icon.model : entry.kind === "new" ? "+" : theme.status.enabled;
		return {
			icon: theme.fg(entry.kind === "new" ? "dim" : "accent", icon),
			annotation: theme.fg("dim", entry.annotation ?? ""),
		};
	};

	#statusRow(width: number): string {
		if (this.#loadError) return truncateToWidth(theme.fg("error", ` ${this.#loadError}`), width);
		if (this.#assigning) {
			const { agent, property } = this.#assigning;
			const what = property === "model" ? "model override" : `${property} model`;
			return truncateToWidth(
				theme.fg("accent", ` Picking ${what} for ${theme.bold(agent.name)} — Enter assigns, Esc cancels`),
				width,
			);
		}
		if (this.#createActive) {
			return truncateToWidth(theme.fg("accent", " New agent — describe it and let the architect draft it"), width);
		}
		if (this.#notice) return truncateToWidth(theme.fg("success", ` ${this.#notice}`), width);
		const entry = this.#activeEntry();
		const scopeLabel = entry.kind === "source" ? `${entry.label} agents` : "All agents";
		const count = this.#rows.filter(rowDef => rowDef.kind === "agent").length;
		return truncateToWidth(theme.fg("muted", ` ${scopeLabel} · ${count}`), width);
	}

	#renderList(width: number, rows: number): string[] {
		const lines: string[] = [];
		const searchText = this.#searchQuery ? theme.fg("accent", this.#searchQuery) : theme.fg("dim", "type to filter");
		lines.push(truncateToWidth(` ${theme.fg("muted", "search:")} ${searchText}`, width));
		lines.push("");
		this.#listRowStart = lines.length;

		const detailRows = 4;
		const visibleRows = Math.max(3, rows - lines.length - detailRows);
		if (this.#rowIndex < this.#listScroll) this.#listScroll = this.#rowIndex;
		else if (this.#rowIndex >= this.#listScroll + visibleRows) this.#listScroll = this.#rowIndex - visibleRows + 1;
		this.#listScroll = Math.max(0, Math.min(this.#listScroll, Math.max(0, this.#rows.length - visibleRows)));

		let nameWidth = 0;
		for (const rowDef of this.#rows) {
			if (rowDef.kind === "agent") nameWidth = Math.max(nameWidth, visibleWidth(rowDef.agent.name));
		}

		const listFocused = this.#focus === "list";
		for (let i = this.#listScroll; i < Math.min(this.#rows.length, this.#listScroll + visibleRows); i++) {
			const rowDef = this.#rows[i];
			if (!rowDef) continue;
			const selected = i === this.#rowIndex;
			const hovered = i === this.#rowHover;
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";
			if (rowDef.kind === "new") {
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", "+ New agent…")}`;
				if (hovered) line = theme.bg("selectedBg", line);
				lines.push(truncateToWidth(line, width));
				continue;
			}
			const agent = rowDef.agent;
			const dot = agent.disabled
				? theme.fg("dim", theme.status.disabled)
				: theme.fg("success", theme.status.enabled);
			const name = replaceTabs(agent.name).padEnd(nameWidth);
			const nameStyled = agent.disabled
				? theme.fg("dim", name)
				: selected
					? theme.bold(theme.fg("accent", name))
					: name;
			const badges: string[] = [];
			if (agent.overrideModel) badges.push(theme.fg("warning", agent.overrideModel));
			const prewalk = this.#deps.effectivePrewalkPattern(agent);
			if (prewalk) badges.push(theme.fg("dim", `pre:${prewalk}`));
			const advisor = this.#deps.effectiveAdvisorPattern(agent);
			if (advisor) badges.push(theme.fg("dim", `adv:${advisor}`));
			const sourceTag = theme.fg("dim", ORIGIN_LABEL[agent.origin]);
			let line = ` ${cursor} ${dot} ${nameStyled}  ${sourceTag}`;
			const right = badges.join("  ");
			const rightWidth = visibleWidth(right);
			const lineWidth = visibleWidth(line);
			if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
			}
			line = truncateToWidth(line, width);
			if (hovered) {
				const w = visibleWidth(line);
				if (w < width) line += " ".repeat(width - w);
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}

		// Selected-agent detail block pinned to the bottom of the body pane.
		while (lines.length < rows - detailRows) lines.push("");
		const agent = this.#selectedAgent();
		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		if (agent) {
			lines.push(truncateToWidth(` ${theme.fg("dim", replaceTabs(agent.description))}`, width));
			const patterns = this.#deps.effectiveModelPatterns(agent);
			const resolved = this.#deps.resolvePatterns(patterns);
			const modelLine = `${theme.fg("muted", "model:")} ${patterns.length > 0 ? replaceTabs(patterns.join(",")) : theme.fg("dim", "(session model)")}${resolved ? ` ${theme.fg("dim", "→")} ${theme.fg("success", resolved)}` : ""}`;
			lines.push(truncateToWidth(` ${modelLine}`, width));
			const prewalk = this.#deps.effectivePrewalkPattern(agent);
			const advisor = this.#deps.effectiveAdvisorPattern(agent);
			const flagLine = [
				`${theme.fg("muted", "prewalk:")} ${prewalk ? theme.fg("success", prewalk) : theme.fg("dim", "off")}`,
				`${theme.fg("muted", "advisor:")} ${advisor ? theme.fg("success", advisor) : theme.fg("dim", "off")}`,
				agent.filePath ? theme.fg("dim", shortenPath(agent.filePath)) : "",
			]
				.filter(Boolean)
				.join("   ");
			lines.push(truncateToWidth(` ${flagLine}`, width));
		} else {
			lines.push(theme.fg("dim", " Select an agent to inspect"));
			lines.push("");
			lines.push("");
		}
		return lines.slice(0, rows);
	}

	#renderCreate(width: number, rows: number): string[] {
		if (this.#form?.field) return this.#renderFormField(width, rows);
		if (this.#form) return this.#renderFormScreen(width, rows);
		return this.#renderDescribeStep(width, rows);
	}

	#renderFormField(width: number, rows: number): string[] {
		const form = this.#form;
		if (!form || !form.field || !form.fieldInput) return [];
		const labels: Record<string, string> = {
			description: "Description",
			tools: "Tools (comma-separated; empty = agent default)",
			thinkingLevel: "Thinking level (empty = agent default)",
			model: "Model pattern (empty = session model)",
		};
		const lines: string[] = [];
		lines.push(truncateToWidth(theme.bold(theme.fg("accent", ` ${labels[form.field]}`)), width));
		lines.push("");
		lines.push(truncateToWidth(` ${form.fieldInput.render(Math.max(20, width - 4))[0] ?? ""}`, width));
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#renderFormScreen(width: number, rows: number): string[] {
		const form = this.#form;
		if (!form) return [];
		const lines: string[] = [];
		const heading =
			form.mode === "edit" ? "Edit agent" : form.mode === "copy" ? "Copy agent" : "Review generated agent";
		lines.push(truncateToWidth(theme.bold(theme.fg("accent", ` ${heading}`)), width));
		lines.push("");
		lines.push(truncateToWidth(theme.fg("muted", ` Name: ${form.name}`), width));
		if (form.mode !== "edit") {
			lines.push(truncateToWidth(theme.fg("muted", ` Scope: ${form.scope}`), width));
		}
		lines.push(truncateToWidth(`${theme.fg("muted", " Description:")} ${replaceTabs(form.description)}`, width));
		lines.push(
			truncateToWidth(
				`${theme.fg("muted", " Tools:")} ${form.tools ? replaceTabs(form.tools) : theme.fg("dim", "(agent default)")}`,
				width,
			),
		);
		lines.push(
			truncateToWidth(
				`${theme.fg("muted", " Thinking level:")} ${form.thinkingLevel ? form.thinkingLevel : theme.fg("dim", "(agent default)")}`,
				width,
			),
		);
		lines.push(
			truncateToWidth(
				`${theme.fg("muted", " Model:")} ${form.model ? form.model : theme.fg("dim", "(session model)")}`,
				width,
			),
		);
		lines.push("");
		lines.push(theme.fg("muted", " systemPrompt preview:"));
		const promptWidth = Math.max(20, width - 4);
		const wrapped: string[] = [];
		for (const raw of form.systemPrompt.split("\n")) {
			for (const w of wrapTextWithAnsi(replaceTabs(raw), promptWidth)) wrapped.push(w);
		}
		const budget = Math.max(3, rows - lines.length - 3);
		for (const line of wrapped.slice(0, budget)) {
			lines.push(truncateToWidth(`   ${theme.fg("dim", line)}`, width));
		}
		if (wrapped.length > budget) {
			lines.push(theme.fg("dim", `   … ${wrapped.length - budget} more lines`));
		}
		if (this.#createError) {
			lines.push("");
			lines.push(truncateToWidth(theme.fg("error", ` ${replaceTabs(this.#createError)}`), width));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#renderDescribeStep(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push("");
		lines.push(truncateToWidth(theme.bold(theme.fg("accent", " Create new agent")), width));
		lines.push("");
		lines.push(
			truncateToWidth(
				theme.fg("muted", " Describe what the agent should do; scope: ") + theme.fg("accent", this.#createScope),
				width,
			),
		);
		lines.push("");
		if (this.#createInput && !this.#createGenerating) {
			for (const line of this.#createInput.render(Math.max(20, width - 2))) {
				lines.push(truncateToWidth(line, width));
			}
		}
		if (this.#createGenerating) {
			lines.push(theme.fg("muted", " Generating…"));
			lines.push("");
			const contentWidth = Math.max(20, width - 4);
			const wrapped: string[] = [];
			for (const raw of this.#createStreamingText.split("\n")) {
				for (const w of wrapTextWithAnsi(replaceTabs(raw), contentWidth)) wrapped.push(w);
			}
			const budget = Math.max(3, rows - lines.length - 2);
			for (const line of wrapped.slice(-budget)) {
				lines.push(truncateToWidth(`  ${theme.fg("dim", line)}`, width));
			}
		}
		if (this.#createError) {
			lines.push("");
			lines.push(truncateToWidth(theme.fg("error", ` ${replaceTabs(this.#createError)}`), width));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		if (this.#promptEditor) {
			return "ctrl+q/ctrl+enter apply · esc cancel · ctrl+g external editor";
		}
		if (this.#strip) {
			if (this.#strip.kind === "pattern") {
				const property = this.#strip.property;
				const values = property === "model" ? "a model pattern" : '"on", "off", or a model pattern';
				return `Enter ${values} (role aliases like @smol and :level suffixes work; empty clears) · Esc back`;
			}
			return this.#strip.property ? "←/→ choose · Enter apply · Esc back" : "←/→ choose · Enter open · Esc cancel";
		}
		if (this.#assigning) {
			return "Enter pick · ↑/↓ models · type to search · Esc cancel";
		}
		if (this.#createActive) {
			const form = this.#form;
			if (form) {
				if (form.field) return "Enter apply · Esc cancel";
				const scopeHint = form.mode === "edit" ? "" : "Tab scope · ";
				const regenHint = form.mode === "create" ? "r regenerate · " : "";
				return `d description · t tools · l thinking-level · m model · p prompt · ${scopeHint}${regenHint}Enter save · Esc cancel`;
			}
			if (this.#createGenerating) return "Generating…";
			return "Ctrl+Q/Ctrl+Enter generate · Enter newline · Tab scope · Esc cancel";
		}
		if (this.#focus === "scope") {
			return "↑/↓ scopes · →/Enter agents · Esc close";
		}
		return "Enter configure · Space enable/disable · Ctrl+E edit/copy · Ctrl+D delete · Ctrl+K map credential · ↑/↓ rows · type to search · Ctrl+R reload · Esc close";
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		return this.#frame.renderFooter(
			width,
			this.#footerHint(),
			strip ? () => this.#renderStrip(width, strip) : undefined,
		);
	}

	#renderStrip(width: number, strip: StripState): string {
		if (strip.kind === "pattern") {
			const label = theme.fg("accent", `${strip.agent.name} ${strip.property} pattern:`);
			const labelWidth = visibleWidth(`${strip.agent.name} ${strip.property} pattern:`);
			const inputWidth = Math.max(8, Math.min(40, width - labelWidth - 4));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			return truncateToWidth(`${label} ${inputLine}`, width);
		}
		const prefix = strip.property
			? `${theme.fg("accent", strip.agent.name)}${theme.fg("dim", ` · ${strip.property} →`)} `
			: `${theme.fg("accent", strip.agent.name)}${theme.fg("dim", " →")} `;
		return this.#frame.renderChips(width, prefix, strip);
	}

	render(width: number): readonly string[] {
		return this.#frame.render(width, this.#terminalRows(), this.#entries, this.#renderFooter(width - 4));
	}
}

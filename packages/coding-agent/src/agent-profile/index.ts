// createAgentProfileExtension: the /agent-profile command that swaps the model mix delegated
// agents run on with no restart, and pins each delegated agent to a named provider ACCOUNT.
//
// This mechanism used to live in claude-code-workflows (ccw) as ccw-agent-profile.js, generating
// its built-in profile DATA to agent-profiles.builtin.yml. Both the mechanism and the data live
// here now: the data is builtin-profiles.yml, embedded at build time (see loadBuiltin below).
//
// task.agentModelOverrides is tier 2 of four in resolveEffectiveAgentModelSelection
// (config/model-resolver.ts) and beats a bundled agent's own model: frontmatter. It is read at
// spawn time (task/structured-subagent.ts), so the very next delegation sees a new map.
//
// The write is override and never set. override puts the map in the runtime layer only, so it
// is undone by the clearOverride below and by /agent-profile off; set queues a debounced save to
// config.yml, which ccw's seeding never revisits once written -- a set here would look exactly
// like an /agents edit and stick forever, past the next re-apply and the next install alike.
//
// A child whose model has no usable credential is rerouted to the parent's model with no
// message (model-resolver.ts). So enforcement is strict and in two places: before_subagent_spawn
// refuses the spawn or pins the bound pattern, and before_provider_request, inside the child,
// refuses any request whose model, thinking level or pinned account differs from the binding.
// While any profile is applied, the spawn hook also refuses an agent the profile has no row for,
// so a new agent cannot run on a model nobody chose. That is why every built-in binds all five
// bundled agents.
//
// Custom profiles live in ~/.omp/agent/ccw-agent-profiles.yml, which this extension does not
// generate and never prunes. A repo maps the agents it defines in its own .omp/agents in
// <repo>/.omp/agent-profiles.yml, laid over the applied profile at apply time.
//
// Every credential lives in this fork's own auth store. The /providers -> Credentials surface
// lists, names, adds and removes them, so account: resolves against
// modelRegistry.authStorage.listCredentials, and the child pins its row with
// pinSessionCredential, an OAuth row and an API key alike.
//
// One: task.agentModelOverrides values MUST stay strings. The setting is a record of
// string | string[], and structured-subagent.ts hands each value to normalizeModelPatternList,
// which calls value.split(","). An object there throws a TypeError and FAILS the spawn. So the
// account travels beside that setting and never inside it.
//
// Two: module scope is the parent-to-child channel. A subagent session re-binds this module's
// factory to its own ExtensionAPI WITHOUT re-evaluating the module graph (sdk.ts,
// bindPreparedExtensions), so a module-level table is one object in both, where factory-level
// state is not. Nothing else carries it: the spawn wire has getApiKey and
// credentialSourceSessionId and no account field.
//
// Three: the child pins itself. An account is keyed by (provider, sessionId) and nothing else,
// every subagent runs under its own provider session id, and concurrent siblings all share the
// PARENT's id -- so a parent-side pin races at task.maxConcurrency and the child-side one cannot.
// The child reads its own agent name from session_init.agent, an entry a main session never
// carries, and pins on before_agent_start with before_provider_request as the guard: those two
// are the only awaited hooks that run before the first request.
//
// Four: a pin is an affinity and not a lock. Usage-limit rotation still routes around an
// exhausted account, so the child's request guard compares the credential this fork chose with
// the pinned one and refuses the request when they differ: a bound agent stops at its account's
// 5-hour limit rather than spend the other subscription.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lookup as lookupSetting } from "../config/registry";
import { settings } from "../config/settings";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import { DEFAULT_SPAWN_AGENT } from "../task/spawn-policy";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import builtinProfilesYaml from "./builtin-profiles.yml" with { type: "text" };
import { spawnGrantPreCheck, spendSpawn } from "./spawn-grant";
import { hasNativeJudge } from "../judgment";

// This fork's own agent dir: PI_CODING_AGENT_DIR moves it, so a sandbox never reads the real
// files.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
const PROFILES_FILE = join(AGENT_DIR, "ccw-agent-profiles.yml");
// The built-in profiles and the default name, embedded from builtin-profiles.yml at build time.
// Shape: { defaultProfile: <name>, descriptions?: { <name>: <text> }, profiles: { <name>: { <agent>: row } } }.
// A test may replace the embedded text with setBuiltinProfilesForTest; production code never
// calls it, and the bundled text is what a real process always reads.

// The real path of $HOME, resolved once. repoScope and the scope=repo fallback both refuse this
// exact directory as a repo root: a stray ~/.omp/agents or ~/.claude/agents would otherwise make
// every session anywhere under $HOME with no closer project dir look like it is running inside a
// repo.
const REAL_HOME = (() => {
	try {
		return realpathSync(homedir());
	} catch {
		return resolve(homedir());
	}
})();

// Where a stored credential is named, added or removed: this fork's own /providers, which owns
// every credential.
const CREDENTIALS_FIX = "name it in /providers → Credentials";

// One stored credential as every picker and status line prints it: label, identity (an email) or
// a key's last characters, the org when one email holds two subscriptions, and #id.
const credentialLabel = (row: any): string =>
	[row.label, row.identity || row.hint, row.org ? "(" + row.org + ")" : null, "#" + row.id].filter(Boolean).join(" ");

// The same row as a picker lists it: label (email or key hint, org) #id.
const pickerLabel = (row: any): string =>
	(row.label ? row.label + " " : "") +
	"(" +
	(row.identity || row.hint || row.kind) +
	(row.org ? ", " + row.org : "") +
	") #" +
	row.id;

// The selector a picker writes for one row: its label, else its identity when no other row
// shares it, else #<id>. A label or an email survives a new login; a row id does not.
const selectorOf = (row: any, rows: any[]): string => {
	if (row.label) {
		return row.label;
	}
	if (row.identity && rows.filter(other => other.identity === row.identity).length === 1) {
		return row.identity;
	}
	return "#" + row.id;
};

// The rows one selector names, most specific first: <provider>/<id> (both exact), then the label
// (case-insensitive), then the identity, then #<id>. A row id is durable for the row's life, but
// a new login makes a new row, so a label or an email is the selector that survives one. No
// substring tier: a selector names one row or the spawn is refused.
const matchCredentials = (rows: any[], selector: unknown): any[] => {
	const wanted = String(selector).trim().toLowerCase();
	const slash = wanted.match(/^([a-z0-9._-]+)\/(\d+)$/);
	if (slash) {
		return rows.filter(row => String(row.provider).toLowerCase() === slash[1] && String(row.id) === slash[2]);
	}
	const byLabel = rows.filter(row => row.label && row.label.toLowerCase() === wanted);
	if (byLabel.length > 0) {
		return byLabel;
	}
	const byIdentity = rows.filter(row => row.identity && row.identity.toLowerCase() === wanted);
	if (byIdentity.length > 0) {
		return byIdentity;
	}
	if (wanted.startsWith("#")) {
		return rows.filter(row => String(row.id) === wanted.slice(1));
	}
	return [];
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const stampNow = (): string => {
	const now = new Date();
	return (
		String(now.getFullYear()) +
		pad2(now.getMonth() + 1) +
		pad2(now.getDate()) +
		"-" +
		pad2(now.getHours()) +
		pad2(now.getMinutes()) +
		pad2(now.getSeconds())
	);
};

const PROFILE_NAME_SHAPE = /^[a-z0-9][a-z0-9_.-]*$/;

// The { default:, profiles: } shape a repo overlay holds. Rows stay raw here: the scope rule
// needs the repo, so they are checked at apply.
const normalizeLayers = (label: string, parsed: any, complaints: string[]): { defaults: any; profiles: any } => {
	const defaults: any = {};
	const profiles: any = {};
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		complaints.push((label || "the file") + ": expected a map with default: and profiles:");
		return { defaults, profiles };
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "default" && key !== "profiles") {
			complaints.push(label + key + ": not default or profiles, so it was ignored");
		}
	}
	if (parsed.default !== undefined && parsed.default !== null) {
		if (typeof parsed.default === "object" && !Array.isArray(parsed.default)) {
			Object.assign(defaults, parsed.default);
		} else {
			complaints.push(label + "default: not a map of agent to row");
		}
	}
	if (parsed.profiles !== undefined && parsed.profiles !== null) {
		if (typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
			complaints.push(label + "profiles: not a map of profile name to rows");
		} else {
			for (const [name, map] of Object.entries(parsed.profiles)) {
				if (map && typeof map === "object" && !Array.isArray(map)) {
					profiles[name] = map;
				} else {
					complaints.push(label + "profiles." + name + ": not a map of agent to row");
				}
			}
		}
	}
	return { defaults, profiles };
};

const ASSIGN_PREAMBLE = [
	"# Per-agent rows for /agent-profile set, laid over whichever profile is applied.",
	"# /agent-profile off drops them with everything else.",
];

// Write the new lines to targetFile, with the pre-edit bytes saved to a stamped backup first.
//
// The backup is written from the bytes already in hand rather than copied: a second read could
// see a different file than the one the splice was computed from. The stamp has one-second
// resolution and two writes inside one second are ordinary -- an import followed by a
// correction. The FIRST backup is the one holding the pre-edit file, so a collision adds a
// suffix rather than overwrite it.
const writeWithBackup = (
	targetFile: string,
	original: string | Buffer,
	lines: string[],
): { ok: boolean; backup: string; error: string | null } => {
	let backup = "";
	if (original.length > 0) {
		const stem = targetFile + ".bak-" + stampNow();
		backup = stem;
		for (let n = 1; n < 100 && existsSync(backup); n++) {
			backup = stem + "-" + n;
		}
	}
	try {
		if (backup) {
			writeFileSync(backup, original);
		}
		// The repo's own .omp may not exist yet: a .claude/agents-only repo has no .omp at all
		// until its first tracked or local write.
		mkdirSync(dirname(targetFile), { recursive: true });
		writeFileSync(targetFile, lines.join("\n") + "\n");
	} catch (error) {
		return { ok: false, backup: "", error: String(error) };
	}
	return { ok: true, backup, error: null };
};

// The top-level blocks spliceKeys may create, with the comment that opens each.
const KEY_PREAMBLES: Record<string, string[]> = { assign: ASSIGN_PREAMBLE };

// Replace, insert or delete ONE one-line row at any depth in targetFile, and leave every other
// byte alone. keys is the path from a top-level key, as ["assign", "profiles", "tiered",
// "scout"]; value is the row's flow text, or null to delete it. Each level takes the indent its
// file already uses. A parent a delete empties goes with it, and a comment line is never
// deleted.
const spliceKeys = (
	targetFile: string,
	keys: string[],
	value: string | null,
): { ok: boolean; backup: string; error: string | null } => {
	let original: string | Buffer = "";
	try {
		original = readFileSync(targetFile, "utf8");
	} catch {
		original = "";
	}
	const lines = original.length > 0 ? original.toString().replace(/\n+$/, "").split("\n") : [];
	const openedAt = (i: number) => {
		const match = lines[i].match(/^( *)(?:"([^"]*)"|'([^']*)'|([^\s#"'-][^:]*?)):(?:\s|$)/);
		return match ? { indent: match[1].length, key: match[2] ?? match[3] ?? match[4] } : null;
	};
	const quoted = (key: string) => (/^(~\/|[A-Za-z0-9_/.])[A-Za-z0-9_./~-]*$/.test(key) ? key : JSON.stringify(key));
	// The end of the block a key opens at start: the first later line that opens at or left of
	// its indent. Blank lines and comments before that line introduce what follows, so they are
	// given back.
	const blockEnd = (start: number, limit: number, indent: number) => {
		let end = limit;
		for (let i = start + 1; i < limit; i++) {
			const text = lines[i].trim();
			if (text !== "" && !text.startsWith("#") && lines[i].length - lines[i].trimStart().length <= indent) {
				end = i;
				break;
			}
		}
		while (end > start + 1 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith("#"))) {
			end--;
		}
		return end;
	};
	const found: { at: number; indent: number }[] = [];
	let first = 0;
	let last = lines.length;
	let indent = 0;
	for (let depth = 0; depth < keys.length; depth++) {
		let at = -1;
		for (let i = first; i < last; i++) {
			const open = openedAt(i);
			if (open && open.indent === indent && open.key === keys[depth]) {
				at = i;
				break;
			}
		}
		if (at < 0) {
			break;
		}
		// A parent written inline, as assign: {}, has no body a row can go under.
		const rest = lines[at].slice(lines[at].indexOf(":") + 1).trim();
		if (depth < keys.length - 1 && rest !== "" && !rest.startsWith("#")) {
			return {
				ok: false,
				backup: "",
				error: keys.slice(0, depth + 1).join(".") + " is written inline. Write it as a block, one key per line",
			};
		}
		found.push({ at, indent });
		first = at + 1;
		last = blockEnd(at, last, indent);
		let child = indent + 2;
		for (let i = first; i < last; i++) {
			const open = openedAt(i);
			if (open) {
				child = open.indent;
				break;
			}
		}
		indent = child;
	}
	if (found.length === keys.length) {
		const leaf = found[found.length - 1];
		const end = blockEnd(leaf.at, lines.length, leaf.indent);
		if (value !== null) {
			lines.splice(leaf.at, end - leaf.at, " ".repeat(leaf.indent) + quoted(keys[keys.length - 1]) + ": " + value);
		} else {
			lines.splice(leaf.at, end - leaf.at);
			for (let depth = found.length - 2; depth >= 0; depth--) {
				const parent = found[depth];
				const parentEnd = blockEnd(parent.at, lines.length, parent.indent);
				if (lines.slice(parent.at + 1, parentEnd).some(line => line.trim() !== "")) {
					break;
				}
				lines.splice(parent.at, parentEnd - parent.at);
				// A top-level block that goes takes the preamble spliceKeys wrote for it, and the
				// blank line before that. A comment the user wrote is never matched, so it stays.
				const preamble = depth === 0 ? KEY_PREAMBLES[keys[0]] || [] : [];
				const from = parent.at - preamble.length;
				if (preamble.length > 0 && from >= 0 && preamble.every((text, i) => lines[from + i] === text)) {
					const blank = from > 0 && lines[from - 1].trim() === "" ? 1 : 0;
					lines.splice(from - blank, preamble.length + blank);
				}
			}
		}
	} else if (value === null) {
		return { ok: false, backup: "", error: keys.join(".") + " is not in " + targetFile };
	} else {
		const block = keys
			.slice(found.length)
			.map(
				(key, offset) =>
					" ".repeat(indent + 2 * offset) +
					quoted(key) +
					":" +
					(found.length + offset === keys.length - 1 ? " " + value : ""),
			);
		if (found.length === 0) {
			if (lines.length > 0) {
				lines.push("");
			}
			lines.push(...(KEY_PREAMBLES[keys[0]] || []), ...block);
		} else {
			lines.splice(last, 0, ...block);
		}
	}
	return writeWithBackup(targetFile, original, lines);
};

// One provider's usable stored credentials, OAuth rows and API keys alike, from this fork's own
// store (modelRegistry.authStorage.listCredentials, which /providers → Credentials edits). A
// disabled row is left out.
const storedCredentials = (ctx: ExtensionContext, provider: string): any[] => {
	const auth = ctx.modelRegistry.authStorage;
	let rows: any[] = [];
	try {
		rows = auth.listCredentials(provider, ctx.sessionManager.getSessionId()) || [];
	} catch {
		rows = [];
	}
	return rows.filter(row => !row.disabled);
};

const SETTING = "task.agentModelOverrides";
// The four other per-agent knobs a profile binds, through the same runtime override layer as the
// model map.
const PREWALK_SETTING = "task.agentPrewalk";
const ADVISOR_SETTING = "task.agentAdvisor";
const TIER_SETTING = "task.agentServiceTierOverrides";
const DISABLED_SETTING = "task.disabledAgents";
// SERVICE_TIER_INHERIT_SETTING_VALUES (config/service-tier.ts). A value outside it throws from
// the setting hook, so it is refused here first with a readable complaint.
const SERVICE_TIERS = ["inherit", "none", "auto", "default", "flex", "scale", "priority"];
const STATUS_KEY = "agentProfile";
// ccw seeds this file's defaults once and never overrides a value set in it afterward. While a
// profile is applied, apply moves each per-agent entry /agents wrote here into the profile, with
// a backup of this file, and removes the entry through this fork's own settings write.
const GENERATED_CONFIG = join(AGENT_DIR, "config.yml");
// The user-level agents this fork discovers: getConfigDirs("agents") filtered to .omp.
const USER_AGENTS_DIR = join(AGENT_DIR, "agents");
// The five agents this fork bundles. A file of the same name in a project or user agents dir
// shadows one, and a repo row still may not bind it.
const BUNDLED_AGENTS = ["scout", "reviewer", "security-reviewer", "task", "sonic"];

// Applied to every session that has no state entry and no OMP_AGENT_PROFILE, off included: "off"
// is the answer when the built-in file is missing or names no default, per contract, never a
// refusal.
const OFF_DESCRIPTION = "Drop the override; each agent uses its own model";

const MODEL_SHAPE = /^[^/\s]+\/[^/\s]+$/;

// agentName -> { <provider>: credentialId }, plus the profile that bound it.
//
// Module scope on purpose. A subagent session re-binds this module's factory to its own
// ExtensionAPI without re-evaluating the module (sdk.ts, bindPreparedExtensions), so this table
// is one object in the parent and the child. Factory scope would be invisible in the child, and
// the spawn wire carries no account field to put it on instead.
const BOUND = new Map<string, Record<string, number>>();
let BOUND_PROFILE = "";

// What /agent-profile status reports. BOUND_PROFILE above names the profile that bound an
// ACCOUNT, which is empty for a profile that pins none; these two name the profile that is
// applied at all, and where the request to apply it came from.
let APPLIED_NAME = "off";
let APPLIED_SOURCE = "";
// The applied profile itself, snapshotted at apply time, with the repo overlay already laid over
// the fleet rows. The spawn hook and the child guard judge against this and never re-read either
// file, so an edit after apply cannot make them enforce a profile the settings layer does not
// hold. A repo row reaches a child through this one object, as a fleet row does.
let APPLIED_PROFILE: Record<string, any> | null = null;
let APPLIED_DISABLED: string[] = [];
// agent -> the reason its layered row was refused, for the ones in APPLIED_DISABLED that a
// refusal put there rather than the profile's own disabled: list.
let APPLIED_REFUSED_REASONS: Record<string, string> = {};
// agent -> the layer that supplied each applied row: builtin, hand, repo, assign or
// assign-profile.
let APPLIED_SOURCES: Record<string, string> = {};
// agent -> the label of the layer whose row won for it: default, profiles.<P>, local-default,
// local-profiles.<P>, assign or assign.profiles.<P>. Absent when the mapping's own row (built-in
// or hand profile) is the top one. /agents writes where this points.
let APPLIED_LAYERS: Record<string, string> = {};
// True while apply moves config.yml entries into the mapping, so the reapply each write runs
// does not start a second migration.
let MIGRATING = false;
// key|agent|value of config.yml entries a migration already failed to move in this process, so
// the next apply does not write, refuse and restore the same row again.
const MIGRATION_KEPT = new Set<string>();
// How many spawns the before_subagent_spawn hook saw.
let SPAWNS_SEEN = 0;
// m<N> -> the row a model the user tagged runs under: the applied profile's task row with the
// tagged model in place of task's, because this fork builds each tagged agent as a task clone.
// Module scope for the same reason as BOUND: the spawn hook writes it in the parent and the
// child's guard reads it.
let MENTION_ROWS: Record<string, any> = {};

// The eight levels a model pattern suffix accepts: the six efforts, plus off and auto.
// "inherit" is deliberately absent -- parseCliThinkingLevel rejects it and an omitted key
// already means inherit.
const THINKING_LEVELS = ["off", ...THINKING_EFFORTS, AUTO_THINKING];

// The effort order, least to most.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

// getSupportedEfforts (pi-catalog/src/model-thinking.ts) requires a defined model; effortsOf
// guards the undefined case its call sites need.
const effortsOf = (model: any): string[] => (model ? [...getSupportedEfforts(model)] : []);

// Copy of clampThinkingLevelForModel: the level a child actually runs. off and auto are not
// efforts and are never clamped.
const clampLevel = (efforts: string[], level: string): string | undefined => {
	if (level === "off" || level === "auto") {
		return level;
	}
	if (efforts.length === 0) {
		return undefined;
	}
	if (efforts.includes(level)) {
		return level;
	}
	const wanted = EFFORT_ORDER.indexOf(level);
	let below: string | undefined;
	for (const effort of efforts) {
		if (EFFORT_ORDER.indexOf(effort) > wanted) {
			break;
		}
		below = effort;
	}
	return below ?? efforts[0];
};

// jev is spent only where a decision needs it (knowledge/decisions/jev-is-spent-only-where-
// the-evidence-leaves-a-decision-open.md). Under thinking: auto, session/model-controls.ts
// classifies every turn through the judge role, so a row bound to auto spends jev on each
// child turn once that role resolves to a native judge -- with no decision behind any one of
// them. This warns, but the row still binds. hasNativeJudge is core's own test: a judgment
// model is not a chat model, so ctx.models.resolve("@judge") never finds it.
const autoThinkingWarning = (ctx: ExtensionContext, agent: string, thinking: unknown): string | null => {
	if (thinking !== AUTO_THINKING) {
		return null;
	}
	let native = false;
	try {
		native = hasNativeJudge(settings, ctx.modelRegistry);
	} catch {
		native = false;
	}
	if (!native) {
		return null;
	}
	return (
		agent +
		": thinking auto classifies every turn through the judge role (jev). Pick a fixed level to avoid that spend."
	);
};

const PROFILES_PREAMBLE = [
	"# Custom profiles for /agent-profile. Nothing generates this file, so a hand edit",
	"# survives ccw install --apply. A profile may say extends: <profile> to start from",
	"# another one and change only some rows. assign: binds one agent beside the profiles.",
	"# Credentials are named in /providers → Credentials. Run /agent-profile format for the format.",
	"profiles:",
];

// Names no profile may take: off, and the top-level blocks beside profiles:. repos:, accounts:
// and credentials: are retired blocks, kept here so a leftover one is never read as a profile.
const RESERVED_NAMES = ["off", "credentials", "accounts", "assign", "repos", "expensiveModels"];

// assign: in the hand file. Its agent rows lay over whatever profile is applied, and
// assign.profiles.<name> lays over those. repos and profiles are reserved keys, so neither is
// read as an agent: assign.repos is removed, and a leftover block draws a complaint. Rows stay
// raw here: the scope rule needs the repo and the like: rule needs the applied profile, so both
// are checked at apply.
const normalizeAssign = (raw: any, complaints: string[]): { rows: any; profiles: any } => {
	const assign = { rows: {} as any, profiles: {} as any };
	if (raw === undefined || raw === null) {
		return assign;
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		complaints.push("assign: not a map of agent to row");
		return assign;
	}
	for (const [key, value] of Object.entries(raw)) {
		if (key !== "repos" && key !== "profiles") {
			assign.rows[key] = value;
		}
	}
	if (raw.repos !== undefined) {
		complaints.push("assign.repos is removed; move each row to <repo>/.omp/agent-profiles.local.yml under default:");
	}
	const map = raw.profiles;
	if (map === undefined || map === null) {
		return assign;
	}
	if (typeof map !== "object" || Array.isArray(map)) {
		complaints.push("assign.profiles: not a map, so it was ignored");
		return assign;
	}
	for (const [key, rows] of Object.entries(map)) {
		if (rows !== null && (typeof rows !== "object" || Array.isArray(rows))) {
			complaints.push("assign.profiles." + key + ": not a map of agent to row, so it was ignored");
			continue;
		}
		assign.profiles[key] = rows || {};
	}
	return assign;
};

// Replace, insert or delete ONE named block under root, and leave every other byte of the file
// alone. bodyLines === null deletes.
//
// A read-modify-write through Bun.YAML would be shorter and is wrong: stringify emits flow style
// and carries no comments, so the preamble above and any note an operator left beside a profile
// would vanish on the first write. Splicing lines keeps them.
const spliceBlock = (
	root: string,
	name: string,
	bodyLines: string[] | null,
): { ok: boolean; backup: string; error: string | null } => {
	let original: string | Buffer = "";
	try {
		original = readFileSync(PROFILES_FILE, "utf8");
	} catch {
		original = "";
	}
	const lines = original.length > 0 ? original.toString().replace(/\n+$/, "").split("\n") : [];
	const rootAt = lines.findIndex(line => line.replace(/[ \t]+$/, "") === root + ":");
	// loadCustom reads parsed.profiles ?? parsed, so a file may omit the profiles root. A profile
	// name sits at indent 0 there and at indent 2 under one.
	const bare =
		root === "profiles" &&
		rootAt < 0 &&
		lines.some(
			line => /^[^\s#][^:]*:/.test(line) && !/^(credentials|repos|assign|accounts|expensiveModels):/.test(line),
		);
	const pad = bare ? "" : "  ";
	// The section is [first, last): the lines under root, up to the next top-level key.
	let first = lines.length;
	let last = lines.length;
	if (bare) {
		first = 0;
	} else if (rootAt >= 0) {
		first = rootAt + 1;
		for (let i = first; i < lines.length; i++) {
			if (/^[^\s#]/.test(lines[i])) {
				last = i;
				break;
			}
		}
	}
	const block = bodyLines === null ? [] : [pad + name + ":", ...bodyLines.map(line => pad + "  " + line)];

	let start = -1;
	for (let i = first; i < last; i++) {
		if (lines[i].startsWith(pad + name + ":")) {
			start = i;
			break;
		}
	}
	if (start >= 0) {
		let end = last;
		for (let i = start + 1; i < last; i++) {
			if (lines[i].trim() === "") {
				continue;
			}
			if (lines[i].length - lines[i].trimStart().length <= pad.length) {
				end = i;
				break;
			}
		}
		// Give a blank separator line back to the block that follows.
		while (end > start + 1 && lines[end - 1].trim() === "") {
			end--;
		}
		// A deleted block takes its separator with it, so no double gap is left behind.
		if (bodyLines === null && end < lines.length && lines[end].trim() === "") {
			end++;
		}
		lines.splice(start, end - start, ...block);
	} else if (bodyLines === null) {
		return { ok: false, backup: "", error: name + " is not in " + root };
	} else if (bare || rootAt >= 0) {
		// The END OF THE SECTION, never the end of the file: once another top-level block follows
		// profiles:, an appended profile would parse as part of it. Blank lines and column-0
		// comments at the tail belong to whatever follows, so step back over them.
		let at = last;
		while (at > first && (lines[at - 1].trim() === "" || lines[at - 1].startsWith("#"))) {
			at--;
		}
		lines.splice(at, 0, ...block);
	} else {
		lines.push(...PROFILES_PREAMBLE, ...block);
	}

	return writeWithBackup(PROFILES_FILE, original, lines);
};

// prewalk and advisor take what resolveAgentPrewalkPattern and resolveAgentAdvisorSelection
// accept: on, off, or a model pattern, which may be a role alias. true and false are their
// spellings of on and off. A pattern is shape-checked here, because this fork takes any other
// string as a pattern and fails it only at the hand-off.
const switchValue = (label: string, value: unknown, complaints: string[]): string | undefined => {
	const text = String(value).trim();
	const lowered = text.toLowerCase();
	if (lowered === "on" || lowered === "true") {
		return "on";
	}
	if (lowered === "off" || lowered === "false") {
		return "off";
	}
	const cut = text.lastIndexOf(":");
	const level = cut > 0 ? text.slice(cut + 1).toLowerCase() : "";
	const base = THINKING_LEVELS.includes(level) ? text.slice(0, cut) : text;
	if (MODEL_SHAPE.test(base) || /^@[a-z0-9_-]+$/i.test(base)) {
		return text;
	}
	complaints.push(label + ': "' + text + '" is not on, off, @<role> or provider/model[:level]');
	return undefined;
};

// One profile entry normalizes to { model?, accounts? }. A bare string is the original shape and
// still means a model, so every profile written before accounts existed reads unchanged.
const normalizeEntry = (label: string, value: unknown, complaints: string[]): Record<string, any> | null => {
	if (typeof value === "string") {
		// override() validates nothing, and a model with no usable credential is rerouted to the
		// parent silently. So this shape check is the only thing between a typo and a delegation
		// that quietly runs the wrong model.
		if (!MODEL_SHAPE.test(value)) {
			complaints.push(label + ": expected provider/model, got " + value);
			return null;
		}
		return { model: value };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		complaints.push(label + ": expected provider/model or {model, account}, got " + String(value));
		return null;
	}
	const row = value as Record<string, any>;
	const entry: Record<string, any> = {};
	for (const key of Object.keys(row)) {
		if (!["model", "account", "thinking", "prewalk", "advisor", "serviceTier"].includes(key)) {
			complaints.push(label + ': unknown key "' + key + '"');
		}
	}
	if (row.model !== undefined) {
		if (typeof row.model !== "string" || !MODEL_SHAPE.test(row.model)) {
			complaints.push(label + ": expected provider/model, got " + String(row.model));
		} else {
			entry.model = row.model;
		}
	}
	if (row.account !== undefined) {
		const accounts: Record<string, string> = {};
		if (typeof row.account === "string" || typeof row.account === "number") {
			// A bare selector borrows its provider from the model, so it needs one.
			if (entry.model) {
				accounts[entry.model.split("/")[0]] = String(row.account);
			} else {
				complaints.push(
					label +
						': account "' +
						String(row.account) +
						'" needs a model, or use account: {<provider>: <selector>}',
				);
			}
		} else if (row.account && typeof row.account === "object" && !Array.isArray(row.account)) {
			for (const [provider, selector] of Object.entries(row.account)) {
				if (typeof selector === "string" || typeof selector === "number") {
					accounts[provider] = String(selector);
				} else {
					complaints.push(label + "." + provider + ": expected an account selector, got " + String(selector));
				}
			}
		} else {
			complaints.push(label + ": account must be a selector or a map of provider to selector");
		}
		if (Object.keys(accounts).length > 0) {
			entry.accounts = accounts;
		}
	}
	if (row.thinking !== undefined) {
		// The thinking level is NOT a second setting. A value in task.agentModelOverrides is a
		// model PATTERN, and a pattern carries a trailing :level that
		// parseModelPatternWithContext reads and structured-subagent.ts places on the child
		// session at creation. So the level rides on the string, and the setting stays
		// string-typed.
		const level = String(row.thinking).trim().toLowerCase();
		if (!THINKING_LEVELS.includes(level)) {
			// A bad suffix does NOT fail the spawn: model-resolver.ts warns, drops it and runs the
			// agent at its own default. So the only place a typo can be caught is here.
			complaints.push(
				label + ': thinking "' + String(row.thinking) + '" is not one of ' + THINKING_LEVELS.join(", "),
			);
		} else if (!entry.model) {
			complaints.push(label + ": thinking needs a model, because the level rides on it");
		} else if (THINKING_LEVELS.some(known => entry.model.endsWith(":" + known))) {
			complaints.push(label + ": the thinking level is named twice, in the model and in thinking");
		} else {
			entry.thinking = level;
		}
	}
	for (const key of ["prewalk", "advisor"]) {
		if (row[key] !== undefined) {
			const normalized = switchValue(label + "." + key, row[key], complaints);
			if (normalized !== undefined) {
				entry[key] = normalized;
			}
		}
	}
	if (row.serviceTier !== undefined) {
		const tier = String(row.serviceTier).trim().toLowerCase();
		if (SERVICE_TIERS.includes(tier)) {
			entry.serviceTier = tier;
		} else {
			complaints.push(
				label + ': serviceTier "' + String(row.serviceTier) + '" is not one of ' + SERVICE_TIERS.join(", "),
			);
		}
	}
	if (!entry.model && !entry.accounts && !entry.prewalk && !entry.advisor && !entry.serviceTier) {
		complaints.push(label + ": nothing survived: no model, account, prewalk, advisor or serviceTier");
		return null;
	}
	return entry;
};

// A row laid over a normalized entry field by field, then validated as ONE row by
// normalizeEntry. So an inherited model lends its provider to a bare account selector and its
// level to a row that names none, and every value passes the check a plain row passes.
const layerRow = (label: string, base: any, value: unknown, complaints: string[]): Record<string, any> | null => {
	const row = typeof value === "string" ? { model: value } : (value as any);
	if (!base || !row || typeof row !== "object" || Array.isArray(row)) {
		return normalizeEntry(label, value, complaints);
	}
	const merged: Record<string, any> = { ...row };
	for (const key of ["model", "prewalk", "advisor", "serviceTier"]) {
		if (merged[key] === undefined && base[key] !== undefined) {
			merged[key] = base[key];
		}
	}
	// A model that carries its own :level must not inherit a second one.
	const ownLevel = typeof row.model === "string" && THINKING_LEVELS.some(known => row.model.endsWith(":" + known));
	if (merged.thinking === undefined && base.thinking !== undefined && !ownLevel) {
		merged.thinking = base.thinking;
	}
	if (merged.account === undefined && base.accounts) {
		merged.account = base.accounts;
	}
	return normalizeEntry(label, merged, complaints);
};

// One agent binds one credential of one provider, one model and one thinking level. An account
// naming several providers, a model on a provider the account does not name, a missing thinking
// level, or a prewalk/advisor value other than off would each let the agent run on a second
// model under the same account pin, so the whole row is refused rather than half-bound. Runs on
// the fleet base itself, inside normalizeProfile, and again on every row a repo or assign layer
// lays over it, inside composeProfile.
const enforceOneBinding = (
	agent: string,
	entry: Record<string, any> | null,
	complaints: string[],
): Record<string, any> | null => {
	if (!entry || !entry.accounts) {
		return entry;
	}
	const providers = Object.keys(entry.accounts);
	if (providers.length > 1) {
		complaints.push(agent + ": one agent binds one credential of one provider. The row was ignored");
		return null;
	}
	const provider = providers[0];
	const modelProvider = entry.model ? entry.model.split("/")[0] : "";
	if (!entry.model || modelProvider !== provider) {
		complaints.push(
			agent +
				": bound to a " +
				provider +
				" credential, but its model is " +
				(entry.model || "unset") +
				". One agent binds one model of its account's own provider. The row was ignored",
		);
		return null;
	}
	const hasLevel = entry.thinking !== undefined || THINKING_LEVELS.some(level => entry.model.endsWith(":" + level));
	if (!hasLevel) {
		complaints.push(
			agent + ": bound to a " + provider + " credential, so it needs a thinking level. The row was ignored",
		);
		return null;
	}
	for (const key of ["prewalk", "advisor"]) {
		if (entry[key] !== undefined && entry[key] !== "off") {
			complaints.push(
				agent +
					": bound to a " +
					provider +
					" credential, so " +
					key +
					": must be off, not " +
					entry[key] +
					". A second model would break one agent, one credential. The row was ignored",
			);
			return null;
		}
	}
	return entry;
};

// "disabled" and "extends" are the profile-level keys, so neither is read as an agent name. base
// is the profile an extends names; each row is laid over its row there.
const normalizeProfile = (
	name: string,
	map: Record<string, any>,
	complaints: string[],
	base?: Record<string, any>,
): Record<string, any> => {
	const clean: Record<string, any> = {};
	for (const [agent, value] of Object.entries(map)) {
		if (agent === "disabled" || agent === "extends") {
			continue;
		}
		const entry = layerRow(name + "." + agent, base ? base[agent] : undefined, value, complaints);
		if (entry) {
			// The fleet base (a built-in or a hand profiles.<name> row) must obey the one-binding
			// rule too, not only a row a repo or assign layer later lays over it in composeProfile.
			// Otherwise a hand-authored two-provider account, a missing level or a prewalk model on
			// a bound agent spawns unchecked.
			const bound = enforceOneBinding(name + "." + agent, entry, complaints);
			if (bound) {
				clean[agent] = bound;
			}
		}
	}
	return clean;
};

// The agents a profile refuses to spawn, through task.disabledAgents, whose preflight throws
// before any model resolves.
const normalizeDisabled = (name: string, map: Record<string, any>, complaints: string[]): string[] => {
	const raw = map.disabled;
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw) || raw.some(agent => typeof agent !== "string" || agent.trim() === "")) {
		complaints.push(name + ".disabled: expected a list of agent names");
		return [];
	}
	const names = [...new Set(raw.map((agent: string) => agent.trim()))];
	for (const agent of names) {
		if (map[agent] !== undefined) {
			complaints.push(name + ": " + agent + " is both bound and disabled");
		}
	}
	return names;
};

interface BuiltinState {
	defaultProfile: string;
	descriptions: Record<string, string>;
	normalized: Record<string, Record<string, any>>;
	disabled: Record<string, string[]>;
	sources: Record<string, Record<string, string>>;
	fleetAgents: string[];
	expensiveModels: string[];
}

const EMPTY_BUILTIN: BuiltinState = {
	defaultProfile: "",
	descriptions: {},
	normalized: {},
	disabled: {},
	sources: {},
	fleetAgents: [],
	expensiveModels: [],
};

// undefined reads the embedded builtin-profiles.yml; a test sets this to run against a fixture
// instead, and to "" to run the "no built-in profiles" contract with no file to omit.
let builtinYamlOverride: string | undefined;
let builtinCache: BuiltinState | null = null;

// A test seam only. Production code never calls this: the embedded text is what a real process
// always reads. Clears the memo, so the next loadBuiltin() call reparses.
export function setBuiltinProfilesForTest(yaml: string | undefined): void {
	builtinYamlOverride = yaml;
	builtinCache = null;
}

// Parses the embedded text once and memoizes it: nothing in a real process moves the text, so
// there is no file to stat and no reload rule. Unparseable or empty means no built-in profiles
// and no default: apply() then behaves as off, and before_subagent_spawn never refuses because
// APPLIED_PROFILE stays null. Built-ins carry no account: an account identity is machine-local
// and must never ship as a fleet constant, so normalizeEntry's own account validation is the
// only thing that would ever admit one, and builtin-profiles.yml never writes one.
const loadBuiltin = (): BuiltinState => {
	if (builtinCache) {
		return builtinCache;
	}
	const text = builtinYamlOverride ?? builtinProfilesYaml;
	try {
		const parsed = (Bun.YAML.parse(text) || {}) as Record<string, any>;
		const defaultProfile = typeof parsed.defaultProfile === "string" ? parsed.defaultProfile.trim() : "";
		const descriptions: Record<string, string> = {};
		if (parsed.descriptions && typeof parsed.descriptions === "object" && !Array.isArray(parsed.descriptions)) {
			for (const [name, text] of Object.entries(parsed.descriptions)) {
				if (typeof text === "string") {
					descriptions[name] = text;
				}
			}
		}
		const rawProfiles =
			parsed.profiles && typeof parsed.profiles === "object" && !Array.isArray(parsed.profiles)
				? parsed.profiles
				: {};
		const normalized: Record<string, Record<string, any>> = {};
		const disabled: Record<string, string[]> = {};
		for (const [name, map] of Object.entries(rawProfiles)) {
			if (!map || typeof map !== "object" || Array.isArray(map)) {
				continue;
			}
			normalized[name] = normalizeProfile(name, map as Record<string, any>, []);
			disabled[name] = normalizeDisabled(name, map as Record<string, any>, []);
		}
		const sources: Record<string, Record<string, string>> = {};
		for (const [name, profile] of Object.entries(normalized)) {
			sources[name] = Object.fromEntries(Object.keys(profile).map(agent => [agent, "builtin"]));
		}
		const fleetAgents = [...new Set(Object.values(normalized).flatMap(map => Object.keys(map)))];
		const expensiveModels = Array.isArray(parsed.expensiveModels)
			? parsed.expensiveModels.filter((pattern: unknown): pattern is string => typeof pattern === "string")
			: [];
		builtinCache = {
			defaultProfile,
			descriptions,
			normalized,
			disabled,
			sources,
			fleetAgents,
			expensiveModels,
		};
	} catch {
		// Broken embedded text must not take the extension down: no built-in profiles, no default.
		builtinCache = EMPTY_BUILTIN;
	}
	return builtinCache;
};

// The model-id patterns (case-insensitive) that flag a spawn as expensive under spawn-grant.ts's
// tier rule, from the top-level expensiveModels: key of the embedded builtin profiles and of the
// hand file PROFILES_FILE. An unparsable pattern is skipped here, and loadCustom reports one in
// the hand file.
const loadCustomExpensiveModels = (): string[] => {
	try {
		const parsed = (Bun.YAML.parse(readFileSync(PROFILES_FILE, "utf8")) || {}) as Record<string, any>;
		return Array.isArray(parsed.expensiveModels)
			? parsed.expensiveModels.filter((pattern: unknown): pattern is string => typeof pattern === "string")
			: [];
	} catch {
		return [];
	}
};

export const expensiveModelPatterns = (): RegExp[] => {
	const raw = new Set([...loadBuiltin().expensiveModels, ...loadCustomExpensiveModels()]);
	const patterns: RegExp[] = [];
	for (const pattern of raw) {
		try {
			patterns.push(new RegExp(pattern, "i"));
		} catch {
			// Skipped: an unparsable pattern must not take spawning down.
		}
	}
	return patterns;
};

// name -> file for every agent one directory defines, read the way this fork reads it: *.md
// files and links in name order, the first file with a name wins, and the name is the
// frontmatter name, which needs a description beside it and may not be main or sub. The
// frontmatter cut copies pi-utils/src/frontmatter.ts.
const agentFiles = (dir: string): Record<string, string> => {
	const found: Record<string, string> = {};
	let names: string[] = [];
	try {
		names = readdirSync(dir, { withFileTypes: true })
			.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return found;
	}
	for (const file of names) {
		const path = join(dir, file);
		let text = "";
		try {
			text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
		} catch {
			continue;
		}
		const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
		if (end < 0) {
			continue;
		}
		let meta: Record<string, any> = {};
		try {
			meta = Bun.YAML.parse(text.slice(4, end)) || {};
		} catch {
			// This fork repairs a description such as "a: b" and then falls back to one key per
			// line, so an agent it loads is never missed here.
			for (const line of text.slice(4, end).split("\n")) {
				const match = line.match(/^(name|description):\s*(.*)$/);
				if (match) {
					meta[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
				}
			}
		}
		const name = typeof meta.name === "string" ? meta.name : "";
		const lowered = name.trim().toLowerCase();
		if (!name || typeof meta.description !== "string" || lowered === "main" || lowered === "sub" || found[name]) {
			continue;
		}
		found[name] = path;
	}
	return found;
};

// The git toplevel of cwd, else cwd itself, as a real path: the root scope=repo binds into when
// the repo defines no agents of its own yet.
const holdingRepo = (cwd: string): string => {
	if (typeof cwd !== "string" || cwd === "") {
		return "";
	}
	let root = cwd;
	try {
		const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 2000 });
		if (run.status === 0 && run.stdout.trim() !== "") {
			root = run.stdout.trim();
		}
	} catch {}
	try {
		return realpathSync(root);
	} catch {
		return resolve(root);
	}
};

// The nearest .omp/agents dir walking up from the session cwd, and the nearest .claude/agents
// dir, walked up SEPARATELY: this fork's own discoverAgents runs findAllNearestProjectConfigDirs
// once per directory name, each unaware of the other's depth. .omp/agents is the one directory
// this fork loads project agents from; .claude/agents is the Claude dialect, taken only when its
// own nearest dir shares its parent with the nearest .omp/agents dir. A nested repo whose own
// .omp/agents sits closer to cwd than an unrelated outer .claude/agents must never pull that
// outer directory in: the two searches can land on different directories entirely, and only an
// exact match counts. With no .omp/agents anywhere above cwd, whatever .claude/agents the walk
// finds is used with no root check, matching discoverAgents. The tracked overlay and the
// gitignored local file both sit beside .omp/agents, in the same .omp. agents merges both
// directories, .omp last, so a same-named .omp agent wins.
//
// $HOME itself is skipped at both directories: ~/.claude/agents is Claude Code's own user agent
// dir, so every session anywhere under $HOME with no closer project dir would otherwise resolve
// to a "repo" rooted at $HOME.
const findNearestAgentsDir = (start: string, subdir: string): { root: string; agentsDir: string } | null => {
	let dir = start;
	for (;;) {
		if (dir !== REAL_HOME) {
			const agentsDir = join(dir, subdir, "agents");
			let isDir = false;
			try {
				isDir = statSync(agentsDir).isDirectory();
			} catch {}
			if (isDir) {
				return { root: dir, agentsDir };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
};

interface RepoScope {
	root: string;
	overlay: string;
	local: string;
	agents: Record<string, string>;
}

const repoScope = (cwd: string): RepoScope | null => {
	if (typeof cwd !== "string" || cwd === "") {
		return null;
	}
	const start = resolve(cwd);
	const omp = findNearestAgentsDir(start, ".omp");
	const claude = findNearestAgentsDir(start, ".claude");
	const useClaude = claude !== null && (omp === null || claude.root === omp.root);
	if (omp === null && !useClaude) {
		return null;
	}
	const dir = omp !== null ? omp.root : (claude as { root: string; agentsDir: string }).root;
	return {
		root: dir,
		overlay: join(dir, ".omp", "agent-profiles.yml"),
		local: join(dir, ".omp", "agent-profiles.local.yml"),
		agents: {
			...(useClaude ? agentFiles((claude as { root: string; agentsDir: string }).agentsDir) : {}),
			...(omp !== null ? agentFiles(omp.agentsDir) : {}),
		},
	};
};

// Whether a repo row may bind this agent: the repo defines it, and it is not a bundled agent, a
// user-level agent or one a built-in binds.
const repoOwns = (repo: RepoScope | null, users: Record<string, string>, agent: string): boolean =>
	Boolean(repo && repo.agents[agent]) &&
	!BUNDLED_AGENTS.includes(agent) &&
	!loadBuiltin().fleetAgents.includes(agent) &&
	!users[agent];

// Where a row for this agent goes. A repo agent's row lives in the tracked overlay, and an
// account a shared repo must not carry goes in the gitignored local file beside it. Every other
// agent's row lives in the hand file.
const bindingPlace = (repo: RepoScope | null, users: Record<string, string>, agent: string): string => {
	if (!repoOwns(repo, users, agent)) {
		return PROFILES_FILE;
	}
	return (repo as RepoScope).overlay + ", and its account under " + (repo as RepoScope).local;
};

// repoScope, or a synthetic scope rooted at the git (or plain) repo holding cwd when repoScope
// found no .omp/agents or .claude/agents there yet. scope=repo binds an agent before the repo
// defines any of its own, so a plain repo must still get a local file to bind into. The
// synthetic scope carries no tracked overlay (empty path, which loadOverlay reads as "no file,
// no rows") and no agents of its own, so repoOwns is false for every agent there --
// scope=repo-shared still requires a real repoScope. $HOME is refused as this fallback root the
// same way repoScope refuses it as a project root.
const repoScopeOrHolding = (cwd: string): RepoScope | null => {
	const repo = repoScope(cwd);
	if (repo) {
		return repo;
	}
	const root = holdingRepo(cwd);
	if (root === "" || root === REAL_HOME) {
		return null;
	}
	return { root, overlay: "", local: join(root, ".omp", "agent-profiles.local.yml"), agents: {} };
};

export const createAgentProfileExtension: ExtensionFactory = pi => {
	const cfg = {
		get: (id: string) => {
			const handle = lookupSetting(id);
			if (!handle) {
				throw new Error(id + " is not a registered setting");
			}
			return handle.get(settings);
		},
		set: (id: string, value: unknown) => {
			const handle = lookupSetting(id);
			if (!handle) {
				throw new Error(id + " is not a registered setting");
			}
			handle.set(settings, value as never);
		},
		override: (id: string, value: unknown) => {
			const handle = lookupSetting(id);
			if (!handle) {
				throw new Error(id + " is not a registered setting");
			}
			handle.override(settings, value as never);
		},
		clearOverride: (id: string) => {
			const handle = lookupSetting(id);
			if (!handle) {
				throw new Error(id + " is not a registered setting");
			}
			handle.clearOverride(settings);
		},
	};

	// Re-read only when the file moves. There is no file-watch anywhere in the extension API, so
	// one stat per invocation is the cheapest correct substitute.
	let cache = {
		mtimeMs: -1,
		profiles: {} as Record<string, Record<string, any>>,
		disabled: {} as Record<string, string[]>,
		sources: {} as Record<string, Record<string, string>>,
		unusable: [] as string[],
		assign: { rows: {} as any, profiles: {} as any },
		error: null as string | null,
	};

	const loadCustom = (force: boolean) => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(PROFILES_FILE).mtimeMs;
		} catch {
			// No file is the normal case, not an error.
			cache = {
				mtimeMs: -1,
				profiles: {},
				disabled: {},
				sources: {},
				unusable: [],
				assign: { rows: {}, profiles: {} },
				error: null,
			};
			return cache;
		}
		if (!force && mtimeMs === cache.mtimeMs) {
			return cache;
		}
		try {
			const parsed = (Bun.YAML.parse(readFileSync(PROFILES_FILE, "utf8")) || {}) as Record<string, any>;
			const bare = parsed.profiles === undefined || parsed.profiles === null;
			const raw = bare ? parsed : parsed.profiles;
			const profiles: Record<string, Record<string, any>> = {};
			const disabled: Record<string, string[]> = {};
			const sources: Record<string, Record<string, string>> = {};
			const unusable: string[] = [];
			const complaints: string[] = [];
			const raws: Record<string, Record<string, any>> = {};
			for (const [name, map] of Object.entries(raw)) {
				if (RESERVED_NAMES.includes(name)) {
					// In the bare form the other top-level blocks are sibling roots, not profiles.
					if (!(bare && name !== "off")) {
						complaints.push('"' + name + '" is reserved and was ignored');
					}
					continue;
				}
				if (!map || typeof map !== "object" || Array.isArray(map)) {
					complaints.push(name + ": not a map of agent to model");
					continue;
				}
				raws[name] = map as Record<string, any>;
			}
			const builtin = loadBuiltin();
			// name -> { profile, disabled, sources }, or null for a profile an extends makes
			// unusable. A name extends another hand profile first, then a built-in, and a profile
			// that extends its own name gets the built-in of that name.
			const resolved: Record<string, { profile: any; disabled: string[]; sources: any } | null> = {};
			const resolveHand = (
				name: string,
				stack: string[],
			): { profile: any; disabled: string[]; sources: any } | null => {
				if (Object.hasOwn(resolved, name)) {
					return resolved[name];
				}
				if (stack.includes(name)) {
					complaints.push(name + ": extends cycle " + [...stack.slice(stack.indexOf(name)), name].join(" -> "));
					return null;
				}
				const map = raws[name];
				let base: { profile: any; disabled: string[]; sources: any } | null = {
					profile: {},
					disabled: [],
					sources: {},
				};
				if (map.extends !== undefined && map.extends !== null) {
					const parent = typeof map.extends === "string" ? map.extends.trim() : "";
					if (parent !== name && Object.hasOwn(raws, parent)) {
						// An unusable parent already complained, so the child says nothing more.
						base = resolveHand(parent, [...stack, name]);
					} else if (Object.hasOwn(builtin.normalized, parent)) {
						base = {
							profile: builtin.normalized[parent],
							disabled: builtin.disabled[parent] || [],
							sources: builtin.sources[parent] || {},
						};
					} else {
						complaints.push(name + ': extends "' + String(map.extends) + '", which names no profile');
						base = null;
					}
				}
				if (!base) {
					resolved[name] = null;
					return null;
				}
				const clean = normalizeProfile(name, map, complaints, base.profile);
				const refused =
					map.disabled === undefined || map.disabled === null
						? base.disabled
						: normalizeDisabled(name, map, complaints);
				const profile = { ...base.profile, ...clean };
				const from = { ...base.sources };
				for (const agent of Object.keys(clean)) {
					from[agent] = "hand";
				}
				// A child that disables an agent its parent binds means the agent is not spawned.
				for (const agent of refused) {
					delete profile[agent];
					delete from[agent];
				}
				resolved[name] = { profile, disabled: refused, sources: from };
				return resolved[name];
			};
			for (const name of Object.keys(raws)) {
				const result = resolveHand(name, []);
				if (!result) {
					unusable.push(name);
				} else if (Object.keys(result.profile).length > 0 || result.disabled.length > 0) {
					profiles[name] = result.profile;
					disabled[name] = result.disabled;
					sources[name] = result.sources;
				}
			}
			// Naming a credential moved into this fork's own /providers, which stores the name on
			// the row.
			for (const retired of ["accounts", "credentials"]) {
				if (parsed[retired] !== undefined) {
					complaints.push(
						retired +
							": is no longer read, so it binds nothing. " +
							CREDENTIALS_FIX +
							", then use the name in account:",
					);
				}
			}
			for (const pattern of Array.isArray(parsed.expensiveModels) ? parsed.expensiveModels : []) {
				try {
					new RegExp(String(pattern), "i");
				} catch {
					complaints.push(
						'expensiveModels: "' + String(pattern) + '" is not a regular expression, so it was skipped',
					);
				}
			}
			const assign = normalizeAssign(parsed.assign, complaints);
			cache = {
				mtimeMs,
				profiles,
				disabled,
				sources,
				unusable,
				assign,
				error: complaints.length > 0 ? complaints.join("; ") : null,
			};
		} catch (error) {
			// A broken file must not take the built-ins down with it.
			cache = {
				mtimeMs: mtimeMs!,
				profiles: {},
				disabled: {},
				sources: {},
				unusable: [],
				assign: { rows: {}, profiles: {} },
				error: "cannot parse " + PROFILES_FILE + ": " + String(error),
			};
		}
		return cache;
	};

	// A custom profile of the same name wins. Overriding a built-in is deliberate: it is how one
	// machine departs from the fleet default with no ccw commit.
	const allProfiles = () => ({ ...loadBuiltin().normalized, ...loadCustom(false).profiles });
	const allDisabled = () => ({ ...loadBuiltin().disabled, ...loadCustom(false).disabled });
	const allSources = () => ({ ...loadBuiltin().sources, ...loadCustom(false).sources });

	// A row's account: stripped, with a complaint, when it came from a file that may not carry
	// one: the tracked overlay is git-tracked, and an account there is a fact about one machine's
	// login, which git must never see.
	const stripRowAccount = (agent: string, row: any, complaints: string[]) => {
		if (row && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, "account")) {
			complaints.push(agent + ": account: belongs in .omp/agent-profiles.local.yml, so it was ignored");
			const { account: _account, ...rest } = row;
			return rest;
		}
		return row;
	};

	// The repo overlay or its local file, re-read only when its path or its mtime moves, as the
	// hand file is. allowAccount is false for the tracked overlay.
	const overlayCaches = new Map<
		string,
		{ path: string; mtimeMs: number; defaults: any; profiles: any; error: string | null }
	>();
	const loadOverlay = (path: string, allowAccount: boolean) => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return { path, mtimeMs: -1, defaults: {} as any, profiles: {} as any, error: null as string | null };
		}
		const cached = overlayCaches.get(path);
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached;
		}
		let result: { path: string; mtimeMs: number; defaults: any; profiles: any; error: string | null };
		try {
			const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) || {};
			const complaints: string[] = [];
			const { defaults, profiles } = normalizeLayers("", parsed, complaints);
			if (!allowAccount) {
				for (const agent of Object.keys(defaults)) {
					defaults[agent] = stripRowAccount(agent, defaults[agent], complaints);
				}
				for (const map of Object.values(profiles) as any[]) {
					for (const agent of Object.keys(map)) {
						map[agent] = stripRowAccount(agent, map[agent], complaints);
					}
				}
			}
			result = { path, mtimeMs, defaults, profiles, error: complaints.length > 0 ? complaints.join("; ") : null };
		} catch (error) {
			result = { path, mtimeMs, defaults: {}, profiles: {}, error: "cannot parse: " + String(error) };
		}
		overlayCaches.set(path, result);
		return result;
	};

	// The effective profile, lowest layer first: the applied profile's rows, the repo overlay
	// (default, then profiles.<name>), the repo's local file (default, then profiles.<name>),
	// then the hand file's assign rows and assign.profiles.<name>. Each field merges on its own,
	// so an account-only row keeps the model and level below it. A layer that moves an agent to
	// another provider and names no account drops the old one, so the agent runs on the new
	// provider's pool. The tracked overlay binds only an agent the repo defines, and never an
	// account; the local file, gitignored, binds any agent, account included; the hand file's
	// assign layers bind any agent too. like: is read once, after every layer, so an account from
	// any layer satisfies its provider check.
	const composeProfile = (
		name: string,
		fleet: Record<string, any>,
		fleetSources: Record<string, string>,
		ctx: ExtensionContext,
	) => {
		const profile: Record<string, any> = { ...fleet };
		const sources: Record<string, string> = { ...fleetSources };
		const complaints: string[] = [];
		const custom = loadCustom(false);
		const repo = repoScopeOrHolding(ctx.cwd);
		const users = agentFiles(USER_AGENTS_DIR);
		const fleetNames = Object.keys(allProfiles());
		const layers: Record<string, string> = {};
		// [label, rows, source, repo agents only]
		const stack: [string, Record<string, any>, string, boolean][] = [];
		if (repo) {
			const loaded = loadOverlay(repo.overlay, false);
			if (loaded.error) {
				complaints.push(repo.overlay + ": " + loaded.error);
			}
			for (const key of Object.keys(loaded.profiles)) {
				if (!fleetNames.includes(key)) {
					complaints.push("profiles." + key + ": no fleet profile has that name, so it was ignored");
				}
			}
			stack.push(["default", loaded.defaults, "repo", true]);
			stack.push(["profiles." + name, loaded.profiles[name] || {}, "repo", true]);
			const local = loadOverlay(repo.local, true);
			if (local.error) {
				complaints.push(repo.local + ": " + local.error);
			}
			for (const key of Object.keys(local.profiles)) {
				if (!fleetNames.includes(key)) {
					complaints.push("profiles." + key + ": no fleet profile has that name, so it was ignored");
				}
			}
			stack.push(["local-default", local.defaults, "repo-local", false]);
			stack.push(["local-profiles." + name, local.profiles[name] || {}, "repo-local", false]);
		}
		stack.push(["assign", custom.assign.rows, "assign", false]);
		for (const key of Object.keys(custom.assign.profiles)) {
			if (!fleetNames.includes(key)) {
				complaints.push("assign.profiles." + key + ": no fleet profile has that name, so it was ignored");
			}
		}
		stack.push(["assign.profiles." + name, custom.assign.profiles[name] || {}, "assign-profile", false]);

		// The provider a raw row runs on, reading through like: before like: is resolved, so a
		// move off the like-agent's provider is seen as a move.
		const providerOf = (candidate: Record<string, any>) => {
			const likeName = candidate.like === undefined ? "" : String(candidate.like).trim();
			const model =
				typeof candidate.model === "string"
					? candidate.model
					: Object.hasOwn(fleet, likeName)
						? fleet[likeName].model
						: undefined;
			return model ? model.split("/")[0] : "";
		};
		const rows: Record<string, any> = {};
		const rowSources: Record<string, string> = {};
		const rowLayers: Record<string, string> = {};
		for (const [layer, map, source, repoOnly] of stack) {
			for (const [agent, value] of Object.entries(map)) {
				const label = layer + "." + agent;
				if (repoOnly && !repoOwns(repo, users, agent)) {
					complaints.push(
						label +
							": " +
							agent +
							" is not an agent this repo defines in .omp/agents or .claude/agents, and a " +
							"repo layer maps only its own agents. The row was ignored",
					);
					continue;
				}
				const row = typeof value === "string" ? { model: value } : (value as Record<string, any>);
				if (!row || typeof row !== "object" || Array.isArray(row)) {
					complaints.push(label + ": expected { model, thinking, account, like, ... }, got " + String(value));
					continue;
				}
				let merged = rows[agent];
				if (!merged) {
					merged = {};
					const base = Object.hasOwn(fleet, agent) ? fleet[agent] : undefined;
					for (const key of ["model", "thinking", "prewalk", "advisor", "serviceTier"]) {
						if (base && base[key] !== undefined) {
							merged[key] = base[key];
						}
					}
					if (base && base.accounts) {
						merged.account = { ...base.accounts };
					}
				}
				const before = providerOf(merged);
				const next = { ...merged, ...row };
				const after = providerOf(next);
				if (typeof row.account === "string" && row.account.trim().toLowerCase() === "pool") {
					next.account = "pool";
				} else if (typeof row.account === "string" || typeof row.account === "number") {
					// A bare selector names an account of the model this layer ends on.
					if (after) {
						next.account = { [after]: String(row.account) };
					}
				} else if (row.account === undefined && before && after && before !== after) {
					// The old provider's account never follows the agent to a new provider, and the
					// agent runs on the new provider's pool.
					if (next.account && typeof next.account === "object" && next.account[after] !== undefined) {
						next.account = { [after]: next.account[after] };
					} else if (next.account !== undefined) {
						next.account = "pool";
					}
				}
				// A model that carries its own :level ends the level below it.
				if (
					typeof row.model === "string" &&
					row.thinking === undefined &&
					THINKING_LEVELS.some(known => row.model.endsWith(":" + known))
				) {
					delete next.thinking;
				}
				rows[agent] = next;
				rowSources[agent] = source;
				rowLayers[agent] = layer;
			}
		}
		const refused: { agent: string; reason: string }[] = [];
		for (const [agent, row] of Object.entries(rows)) {
			const { like, ...fields } = row as Record<string, any>;
			// pool is an explicit choice: it takes no account, and like: lends none.
			const pooled = fields.account === "pool";
			if (pooled) {
				delete fields.account;
			}
			if (fields.model === undefined && like === undefined && fields.account === undefined) {
				complaints.push(agent + ": needs a model, an account or like: <fleet agent>. The row was ignored");
				refused.push({ agent, reason: complaints[complaints.length - 1].slice(agent.length + 2) });
				continue;
			}
			let entry: Record<string, any> | null;
			if (like === undefined) {
				entry = normalizeEntry(agent, fields, complaints);
			} else {
				const likeName = String(like).trim();
				const likeEntry = Object.hasOwn(fleet, likeName) ? fleet[likeName] : undefined;
				if (!likeEntry) {
					complaints.push(
						agent + ": like " + likeName + " names no agent profile " + name + " binds. The row was ignored",
					);
					refused.push({ agent, reason: complaints[complaints.length - 1].slice(agent.length + 2) });
					continue;
				}
				// The like-agent's account is left out of the base, so a bare selector in the row
				// takes its provider from the final model and an account from any layer beats the
				// borrowed one.
				const { accounts, ...likeFields } = likeEntry;
				entry = layerRow(agent, likeFields, fields, complaints);
				const likeProvider = likeEntry.model ? likeEntry.model.split("/")[0] : "";
				const provider = entry && entry.model ? entry.model.split("/")[0] : "";
				if (entry && !pooled && fields.account === undefined && provider !== likeProvider && accounts) {
					complaints.push(
						agent +
							": runs on " +
							(provider || "its own model") +
							", but " +
							likeName +
							" is bound to a " +
							likeProvider +
							" login, which cannot follow it to another provider. Name an account, or " +
							"drop like. The row was ignored",
					);
					refused.push({ agent, reason: complaints[complaints.length - 1].slice(agent.length + 2) });
					continue;
				}
				if (entry && accounts && !pooled && fields.account === undefined) {
					entry.accounts = accounts;
				}
			}
			if (entry) {
				entry = enforceOneBinding(agent, entry, complaints);
			}
			if (entry) {
				profile[agent] = entry;
				sources[agent] = rowSources[agent];
				if (rowLayers[agent] !== undefined) {
					layers[agent] = rowLayers[agent];
				}
			} else {
				// A row this layer attempted was refused (a bad shape, or the one-binding rule), so
				// the agent must not silently keep running on the fleet's old row or the pool: drop
				// it here, and the caller disables it with the reason, through task.disabledAgents,
				// so the preflight refuses the spawn outright.
				delete profile[agent];
				delete sources[agent];
				delete layers[agent];
				const last = complaints[complaints.length - 1] || agent + ": the row was refused";
				const prefix = agent + ": ";
				refused.push({ agent, reason: last.startsWith(prefix) ? last.slice(prefix.length) : last });
			}
		}
		for (const [agent, entry] of Object.entries(profile)) {
			const warning = autoThinkingWarning(ctx, agent, (entry as Record<string, unknown>).thinking);
			if (warning) {
				complaints.push(warning);
			}
		}
		return { profile, sources, layers, complaints, root: repo ? repo.root : "", refused };
	};

	const describe = (name: string): string => {
		if (name === "off") {
			return OFF_DESCRIPTION;
		}
		const custom = loadCustom(false).profiles[name];
		const builtinDesc = loadBuiltin().descriptions[name];
		if (custom) {
			return builtinDesc ? "custom, overrides the built-in" : "custom";
		}
		return builtinDesc ?? "custom";
	};

	// The pattern the setting receives, which is also what the report prints: one string, so
	// what the operator reads is byte-for-byte what the resolver parses.
	const patternOf = (entry: Record<string, any>) =>
		entry.model ? entry.model + (entry.thinking ? ":" + entry.thinking : "") : "";

	// The three knobs beside the model, as report and status print them. Empty when all inherit.
	const knobsOf = (entry: Record<string, any> | undefined) => {
		const parts: string[] = [];
		for (const key of ["prewalk", "advisor", "serviceTier"]) {
			if (entry && entry[key]) {
				parts.push(key + "=" + entry[key]);
			}
		}
		return parts.length > 0 ? "  " + parts.join(" ") : "";
	};

	// "aside" starts a turn when the session is idle, so every report cost the parent a model
	// turn, on whatever model the parent runs. "nextTurn" only displays when idle, but hides
	// while streaming, where "aside" is the one that shows.
	const show = (ctx: ExtensionContext, content: string) => {
		pi.sendMessage(
			{ customType: "ccw-agent-profile", content, display: true },
			{ deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
		);
	};

	// One line for APPLIED_DISABLED: an agent a refusal put there carries its reason, an agent
	// the profile's own disabled: list named does not.
	const disabledLine = () =>
		"  disabled: " +
		APPLIED_DISABLED.map(agent =>
			APPLIED_REFUSED_REASONS[agent] ? agent + " (" + APPLIED_REFUSED_REASONS[agent] + ")" : agent,
		).join(", ");

	const report = (
		ctx: ExtensionContext,
		name: string,
		profile: Record<string, any> | null,
		labels: Record<string, string[]> | null,
	) => {
		const lines = profile
			? Object.keys(profile)
					.sort()
					.map(agent => {
						const bound = labels && labels[agent] ? "  [" + labels[agent].join(", ") + "]" : "";
						return (
							"  " +
							agent +
							": " +
							(patternOf(profile[agent]) || "(its own model)") +
							bound +
							knobsOf(profile[agent])
						);
					})
			: ["  (none -- each agent uses its own model)"];
		if (profile && APPLIED_DISABLED.length > 0) {
			lines.push(disabledLine());
		}
		show(ctx, "agent profile: " + name + "\n" + lines.join("\n"));
	};

	// Resolve every selector to a durable credentialId, in the PARENT, because that is the only
	// session that has a ctx while the profile is being chosen. A selector that fails leaves the
	// agent unbound and says so: silently serving "some account" would defeat the whole point of
	// splitting quota.
	const resolveAccounts = (profile: Record<string, any>, ctx: ExtensionContext) => {
		const labels: Record<string, string[]> = {};
		const listed = new Map<string, any[]>();
		const rowsOf = (provider: string) => {
			if (!listed.has(provider)) {
				listed.set(provider, storedCredentials(ctx, provider));
			}
			return listed.get(provider) as any[];
		};
		for (const [agent, entry] of Object.entries(profile)) {
			for (const [provider, selector] of Object.entries((entry as Record<string, any>).accounts || {})) {
				const rows = rowsOf(provider);
				const matches = matchCredentials(rows, selector);
				if (matches.length !== 1) {
					ctx.ui.notify(
						agent +
							': "' +
							selector +
							'" matches ' +
							matches.length +
							" stored " +
							provider +
							" credentials" +
							(matches.length > 1 ? ": " + matches.map(credentialLabel).join(", ") : "") +
							". " +
							CREDENTIALS_FIX,
						"error",
					);
					continue;
				}
				BOUND.set(agent, { [provider]: matches[0].id });
				labels[agent] = [...(labels[agent] || []), provider + ": " + credentialLabel(matches[0])];
			}
		}
		return labels;
	};

	// announce is false at session start. report() goes through pi.sendMessage, which injects
	// into the CONVERSATION rather than the UI, and in print mode the agent is already
	// processing by the time session_start runs: the rejected promise is an unhandled
	// AgentBusyError that kills the session. setStatus and notify are UI and stay safe.
	const apply = (name: string, ctx: ExtensionContext, announce: boolean, source: string) => {
		// Resolve BEFORE mutating. A typo used to clear the binding table and then return on the
		// unknown name, which unbound every account while leaving the previous model override and
		// the status chip in place -- a half-dismantled mix reported as nothing worse than a
		// spelling complaint.
		const custom = loadCustom(false);
		if (name !== "off" && custom.unusable.includes(name)) {
			ctx.ui.notify('Agent profile "' + name + '" is unusable: ' + custom.error + ". Nothing changed.", "error");
			return;
		}
		const fleet = name === "off" ? null : allProfiles()[name];
		if (name !== "off" && !fleet) {
			ctx.ui.notify('Unknown agent profile "' + name + '". Nothing changed.', "error");
			return;
		}
		const composed = fleet ? composeProfile(name, fleet, allSources()[name] || {}, ctx) : null;
		const profile = composed ? composed.profile : null;
		if (composed && composed.complaints.length > 0) {
			ctx.ui.notify(
				"agent profile layers" +
					(composed.root ? " for " + composed.root : "") +
					": " +
					composed.complaints.join("; "),
				"error",
			);
		}
		APPLIED_NAME = name;
		// A reapply after /agent-profile set keeps the reason the profile was applied at all.
		APPLIED_SOURCE = source === "reapply" ? APPLIED_SOURCE : source || "command";
		BOUND.clear();
		MENTION_ROWS = {};
		BOUND_PROFILE = "";
		for (const key of [SETTING, PREWALK_SETTING, ADVISOR_SETTING, TIER_SETTING, DISABLED_SETTING]) {
			cfg.clearOverride(key);
		}
		APPLIED_LAYERS = composed ? composed.layers : {};
		// An entry /agents wrote into config.yml moves into this mapping: an echo of the binding
		// is dropped, and one that cannot move stays, named in status. The second apply composes
		// the mapping the moves just wrote.
		if (composed && !MIGRATING && !agentNameOf(ctx) && migrateGenerated(profile, ctx)) {
			MIGRATING = true;
			try {
				apply(name, ctx, announce, source);
			} finally {
				MIGRATING = false;
			}
			return;
		}
		APPLIED_PROFILE = profile;
		APPLIED_DISABLED = profile
			? [...new Set([...(allDisabled()[name] || []), ...(composed!.refused || []).map(item => item.agent)])]
			: [];
		APPLIED_REFUSED_REASONS = profile
			? Object.fromEntries((composed!.refused || []).map(item => [item.agent, item.reason]))
			: {};
		APPLIED_SOURCES = composed ? composed.sources : {};
		// The session remembers what is applied, so a /resume, a /fork or a cold start lands on
		// the same mix instead of on the machine default. Skipped when the source IS a session
		// entry: re-recording a rehydrate would append one row per session event. The built-in
		// default is skipped too, so a resumed session follows the current default.
		if (source !== "session" && source !== "default" && source !== "reapply") {
			try {
				pi.appendEntry("ccw-agent-profile-state", { profile: name });
			} catch {}
		}
		if (name === "off") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (announce) {
				report(ctx, "off", null, null);
			}
			return;
		}
		const models: Record<string, string> = {};
		for (const [agent, entry] of Object.entries(profile!)) {
			if ((entry as Record<string, any>).model) {
				models[agent] = patternOf(entry as Record<string, any>);
			}
		}
		// A key that names nothing is inert at spawn, so this warns and never refuses. It fires
		// only when the roster was actually read: see roster() for why a fallback stays silent.
		if (announce) {
			const known = roster();
			const unknown = known.trusted ? Object.keys(profile!).filter(agent => !known.names.includes(agent)) : [];
			if (unknown.length > 0) {
				ctx.ui.notify(
					'Profile "' +
						name +
						'" names ' +
						unknown.sort().join(", ") +
						", which no agent answers to. Those entries do nothing.",
					"warning",
				);
			}
		}
		// Strings only. normalizeModelPatternList calls value.split(","), so an object here
		// throws and fails the spawn.
		cfg.override(SETTING, models);
		// The three knobs come from the profile alone. This fork deep-merges this record over
		// config.yml's, so an agent the profile does not set keeps config.yml's value.
		const knobs: Record<string, Record<string, string>> = {
			[PREWALK_SETTING]: {},
			[ADVISOR_SETTING]: {},
			[TIER_SETTING]: {},
		};
		for (const [agent, entry] of Object.entries(profile!)) {
			const row = entry as Record<string, any>;
			if (row.prewalk) {
				knobs[PREWALK_SETTING][agent] = row.prewalk;
			}
			if (row.advisor) {
				knobs[ADVISOR_SETTING][agent] = row.advisor;
			}
			if (row.serviceTier) {
				knobs[TIER_SETTING][agent] = row.serviceTier;
			}
		}
		for (const [key, map] of Object.entries(knobs)) {
			if (Object.keys(map).length > 0) {
				cfg.override(key, map);
			}
		}
		if (APPLIED_DISABLED.length > 0) {
			const base = cfg.get(DISABLED_SETTING);
			cfg.override(DISABLED_SETTING, [...new Set([...(Array.isArray(base) ? base : []), ...APPLIED_DISABLED])]);
		}
		// Pre-flight, in the PARENT, before any child exists.
		//
		// There are TWO silent-fallback sites and they share one cause: the mapped model is not
		// in modelRegistry.getAvailable(). Site A fires when the provider HAS a credential row
		// but getApiKey yields nothing, and it logs one logger.warn. Site B fires when the
		// provider has NO credential at all, and it logs NOTHING -- the executor resolves no
		// model, createAgentSession widens to getAll() and swaps in the parent's.
		//
		// ctx.models.resolve() runs resolveModelRoleValue over exactly that getAvailable() set,
		// so a model that resolves here is one the executor can resolve too. This is the only
		// check that runs BEFORE the spend.
		if (ctx.models) {
			const unusable: string[] = [];
			const adjusted: string[] = [];
			// A prewalk or advisor target that resolves to nothing fails at the hand-off, and the
			// child guard refuses a model outside the binding, so it is named now.
			for (const [agent, entry] of Object.entries(profile!)) {
				const row = entry as Record<string, any>;
				for (const key of ["prewalk", "advisor"]) {
					const value = row[key];
					if (!value || value === "on" || value === "off") {
						continue;
					}
					let target;
					try {
						target = ctx.models.resolve(value);
					} catch {
						target = undefined;
					}
					if (!target) {
						unusable.push(agent + " " + key + ": " + value);
					}
				}
			}
			for (const [agent, pattern] of Object.entries(models)) {
				let resolved;
				try {
					resolved = ctx.models.resolve(pattern);
				} catch {
					resolved = undefined;
				}
				if (!resolved) {
					unusable.push(agent + ": " + pattern);
					continue;
				}
				// A fuzzy pattern legitimately resolves to another id, so only a PROVIDER change is
				// reported: that is the one that means a different credential.
				const wanted = pattern.split("/")[0];
				if (resolved.provider !== wanted) {
					unusable.push(agent + ": " + pattern + " resolves to " + resolved.provider + "/" + resolved.id);
					continue;
				}
				// This fork clamps an unsupported level at spawn with no message, so this is the
				// only place it is said.
				const level = profile![agent].thinking;
				if (level && level !== "off" && level !== "auto") {
					const efforts = effortsOf(resolved);
					const runs = clampLevel(efforts, level);
					const target = resolved.provider + "/" + resolved.id;
					if (runs === undefined) {
						adjusted.push(agent + ": " + target + " has no thinking levels, so " + level + " is ignored");
					} else if (runs !== level) {
						adjusted.push(
							agent +
								": thinking " +
								level +
								" runs as " +
								runs +
								" on " +
								target +
								" (supported: " +
								efforts.join(", ") +
								")",
						);
					}
				}
			}
			if (unusable.length > 0) {
				ctx.ui.notify(
					"No usable model for " +
						unusable.join("; ") +
						". omp would run those agents on the parent's model; ccw-agent-profile refuses them " +
						"instead. Check with: omp token <provider> --list",
					"error",
				);
			}
			if (adjusted.length > 0) {
				ctx.ui.notify("Thinking level changed at spawn: " + adjusted.join("; "), "warning");
			}
		}
		const labels = resolveAccounts(profile!, ctx);
		if (BOUND.size > 0) {
			BOUND_PROFILE = name;
		}
		ctx.ui.setStatus(STATUS_KEY, "agents: " + name + (BOUND.size > 0 ? " (" + BOUND.size + " pinned)" : ""));
		if (announce) {
			report(ctx, name, profile, labels);
		}
	};

	// ---- the child half ----

	// ExtensionContext carries no agent name, and only a subagent session holds a session_init
	// entry. A MISS is never cached: the entry is appended after the session exists, so an early
	// call can legitimately see none.
	let myAgent: string | undefined;
	// provider -> the credentialId this session last WROTE. Not a one-shot latch: /login, a
	// credential removal and a credential disable all reset the provider's whole pin map and the
	// persisted sticky cache prefix. A latch that refused a second write would leave a
	// long-running child finishing on the balancer's account with nothing said. So the pin is
	// re-asserted, and the map only decides whether the audit entry is a repeat.
	const lastPinned = new Map<string, number>();

	const agentNameOf = (ctx: ExtensionContext): string => {
		if (myAgent) {
			return myAgent;
		}
		try {
			const entries = ctx.sessionManager.getEntries() || [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (entry && entry.type === "session_init") {
					myAgent = String(entry.agent || "");
					return myAgent;
				}
			}
		} catch {}
		return "";
	};

	// The child's own audit trail, newest first. This is the only record of what a revived child
	// was pinned to: a revived child passes no credentialSourceSessionId, so the child inherits
	// nothing, and BOUND is empty in a fresh process because the parent never applied a profile
	// in it.
	const revivedCredential = (ctx: ExtensionContext, agent: string, provider: string): number | undefined => {
		try {
			const entries = ctx.sessionManager.getEntries() || [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (
					entry &&
					entry.type === "custom" &&
					entry.customType === "ccw-agent-account" &&
					entry.data &&
					entry.data.agent === agent &&
					entry.data.provider === provider &&
					entry.data.ok !== false
				) {
					return entry.data.credentialId;
				}
			}
		} catch {}
		return undefined;
	};

	// ---- strict enforcement ----
	//
	// A bound agent runs on exactly what the applied profile names, or it does not run. Every
	// refusal below is worded as the fix, and each one avoids the words this fork's retry
	// classifier treats as transient or as an auth failure, so a refused turn ends instead of
	// being replayed on another model or account.

	// The live binding of one agent under the applied profile, or null when the profile leaves
	// the agent alone. problem is set when the binding cannot be honoured. Shared by the spawn
	// hook in the spawning session and by the child's snapshot below.
	const bindingOf = (ctx: ExtensionContext, agent: string): Record<string, any> | null => {
		let entry = APPLIED_PROFILE ? APPLIED_PROFILE[agent] : undefined;
		if (!entry && APPLIED_PROFILE && Object.hasOwn(MENTION_ROWS, agent)) {
			entry = MENTION_ROWS[agent];
		}
		if (!entry) {
			return null;
		}
		const binding: Record<string, any> = {
			agent,
			profile: APPLIED_NAME,
			model: entry.model,
			thinking: entry.thinking,
			pattern: patternOf(entry),
			credentials: {} as Record<string, number>,
			labels: {} as Record<string, string>,
			problem: null as string | null,
		};
		const fail = (why: string) => {
			binding.problem ??=
				"profile " +
				APPLIED_NAME +
				" binds " +
				agent +
				" to " +
				(binding.pattern || "its own model") +
				", but " +
				why;
		};
		if (entry.model) {
			const provider = entry.model.split("/")[0];
			let listed: any[] = [];
			try {
				listed = ctx.models.list() || [];
			} catch {}
			if (!listed.some(model => model.provider + "/" + model.id === entry.model)) {
				fail(
					entry.model +
						" has no working credential in this session. Check omp token " +
						provider +
						" --list, or run /login " +
						provider,
				);
			}
		}
		for (const [provider, selector] of Object.entries(entry.accounts || {})) {
			const rows = storedCredentials(ctx, provider);
			const matches = matchCredentials(rows, selector);
			if (matches.length === 1) {
				binding.credentials[provider] = matches[0].id;
				binding.labels[provider] = credentialLabel(matches[0]);
			} else if (matches.length === 0) {
				fail(
					"no stored " +
						provider +
						' credential matches "' +
						selector +
						'". Match its label, its email, #<id> or ' +
						provider +
						"/<id> as /providers → Credentials shows it, or " +
						CREDENTIALS_FIX,
				);
			} else {
				fail(
					'"' +
						selector +
						'" matches ' +
						matches.length +
						" stored " +
						provider +
						" credentials (" +
						matches.map(credentialLabel).join(", ") +
						"). Use #<id>, or " +
						CREDENTIALS_FIX,
				);
			}
		}
		// An advisor runs as a second agent under its own random provider session id, which no
		// pin here can reach. So an advisor on a provider this binding pins an account for would
		// spend whichever account this fork balances onto, and the binding is refused instead.
		for (const target of secondaryOf(ctx, agent, [ADVISOR_SETTING])) {
			const provider = target.split("/")[0];
			if (binding.credentials[provider] !== undefined || (entry.accounts || {})[provider] !== undefined) {
				fail(
					"its advisor runs on " +
						target +
						" under its own provider session, which no account pin reaches. " +
						"Set advisor: off for " +
						agent +
						", or give the advisor another provider",
				);
			}
		}
		return binding;
	};

	// The prewalk and advisor targets this fork may legitimately switch a child to, as
	// provider/id. Read from the settings layer, which holds config.yml's values over the
	// profile's. A target set by an agent's frontmatter is invisible here, so a child armed that
	// way is refused at its hand-off until the profile binds prewalk or advisor itself. keys
	// narrows the read to one of the two settings.
	const secondaryOf = (ctx: ExtensionContext, agent: string, keys?: string[]): string[] => {
		const targets: string[] = [];
		for (const [key, role] of [
			[PREWALK_SETTING, "@smol"],
			[ADVISOR_SETTING, "@advisor"],
		]) {
			if (keys && !keys.includes(key)) {
				continue;
			}
			let value: unknown;
			try {
				const map = cfg.get(key) as Record<string, unknown>;
				value = map && typeof map === "object" ? map[agent] : undefined;
				// The bundled task agent arms prewalk from task.prewalk.
				if (value === undefined && key === PREWALK_SETTING && agent === "task" && cfg.get("task.prewalk")) {
					value = "on";
				}
			} catch {
				value = undefined;
			}
			const text = String(value ?? "").trim();
			const lowered = text.toLowerCase();
			if (!text || lowered === "off" || lowered === "false") {
				continue;
			}
			let target;
			try {
				target = ctx.models.resolve(lowered === "on" || lowered === "true" ? role : text);
			} catch {
				target = undefined;
			}
			if (target) {
				targets.push(target.provider + "/" + target.id);
			}
		}
		return targets;
	};

	// This child's binding, fixed the first time the child needs it, so a profile switched
	// mid-run does not re-judge a child spawned under the old one. undefined means not read yet.
	// The parent never caches, because session_init can land after an early call.
	let mine: Record<string, any> | null | undefined;
	const myBinding = (ctx: ExtensionContext): Record<string, any> | null => {
		if (mine !== undefined) {
			return mine;
		}
		const agent = agentNameOf(ctx);
		if (!agent) {
			return null;
		}
		const live = bindingOf(ctx, agent);
		if (live) {
			live.secondary = secondaryOf(ctx, agent);
			mine = live;
			// A revived child in a fresh process has no applied profile, so this entry is what it
			// is judged against. appendEntry never reaches the model.
			try {
				pi.appendEntry("ccw-agent-binding", { ...live, sessionId: ctx.sessionManager.getSessionId() });
			} catch {}
			return mine;
		}
		mine = null;
		try {
			const entries = ctx.sessionManager.getEntries() || [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (
					entry &&
					entry.type === "custom" &&
					entry.customType === "ccw-agent-binding" &&
					entry.data &&
					entry.data.agent === agent
				) {
					mine = { ...entry.data };
					break;
				}
			}
		} catch {}
		return mine ?? null;
	};

	// The reason one request breaks the binding, or null. ctx.model is the REQUEST's model, and
	// the credential for it is already chosen: the agent loop resolves the key before the stream
	// starts, and it records it as the session's sticky credential, which listCredentials reports
	// as active.
	const judge = (ctx: ExtensionContext, binding: Record<string, any>): string | null => {
		if (binding.problem) {
			return binding.problem;
		}
		const request = ctx.model!;
		const actual = request.provider + "/" + request.id;
		const main = !binding.model || actual === binding.model;
		if (!main && !(binding.secondary || []).includes(actual)) {
			return (
				"expected " +
				binding.pattern +
				", got " +
				actual +
				". omp runs a child on the parent's model " +
				"when the bound one has no working credential, and a model the caller names beats the profile"
			);
		}
		// task.enableEffort is a /settings choice. Turned on, the user wants a task effort
		// argument to pick the level, so this level check stands down; the model check above and
		// the credential check below still run regardless.
		if (
			main &&
			binding.model &&
			binding.thinking &&
			binding.thinking !== "auto" &&
			cfg.get("task.enableEffort") !== true
		) {
			const want = clampLevel(effortsOf(request), binding.thinking) ?? "off";
			let got;
			try {
				got = pi.getThinkingLevel();
			} catch {
				got = undefined;
			}
			got = got ?? "off";
			if (got !== want) {
				return (
					"expected thinking " +
					want +
					" on " +
					actual +
					", got " +
					got +
					". A task effort argument moved " +
					"it; turning task.enableEffort on in /settings lets that argument decide the level instead of " +
					"this profile"
				);
			}
		}
		// A prewalk hand-off swaps the model on the SAME agent and provider session, so the pin
		// covers it and the account is checked for it as for the bound model. An advisor on a
		// pinned provider never gets this far: bindingOf refuses it.
		const pinned = (binding.credentials || {})[request.provider];
		if (pinned !== undefined) {
			const rows = storedCredentials(ctx, request.provider);
			const active = rows.find(row => row.active);
			if (!active || active.id !== pinned) {
				return (
					"expected " +
					request.provider +
					" credential " +
					((binding.labels || {})[request.provider] || "#" + pinned) +
					", got " +
					(active ? credentialLabel(active) : "no pinned credential") +
					". The child's pin was cleared, or its row was removed or disabled. /agent-profile status shows the bindings"
				);
			}
		}
		return null;
	};

	// A handler cannot refuse by throwing: the runner catches the throw, reports it and sends the
	// ORIGINAL payload. So it returns a payload whose every read throws. The provider reads it
	// inside its own try before it serializes the body, so nothing is sent and the message
	// becomes the turn's error. "then" answers undefined, or the runner's own await would trip it
	// and fall back to the original payload.
	const refusal = (message: string) => {
		const refuse = () => {
			throw new Error(message);
		};
		return new Proxy(
			{},
			{
				get: (_target, key) => (key === "then" || typeof key === "symbol" ? undefined : refuse()),
				has: refuse,
				ownKeys: refuse,
				getOwnPropertyDescriptor: refuse,
			},
		);
	};

	// guardOnly is the before_provider_request path: it must not write on every request, so it
	// acts once and then leaves the turn boundary to keep the pin warm.
	const pinAccount = (ctx: ExtensionContext, guardOnly: boolean) => {
		const agent = agentNameOf(ctx);
		if (!agent) {
			return;
		}
		const provider = ctx.model?.provider;
		if (!provider || (guardOnly && lastPinned.has(provider))) {
			return;
		}
		const snapshot = myBinding(ctx);
		const bound = BOUND.get(agent);
		let credentialId = snapshot && snapshot.credentials ? snapshot.credentials[provider] : undefined;
		if (credentialId === undefined) {
			credentialId = bound ? bound[provider] : undefined;
		}
		if (credentialId === undefined) {
			credentialId = revivedCredential(ctx, agent, provider);
		}
		if (credentialId === undefined) {
			// An unmapped agent, or the model was rerouted to another provider. Either way the
			// child keeps the pin it inherited from the parent.
			return;
		}
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) {
			return;
		}
		const auth = ctx.modelRegistry.authStorage;
		// One call for an OAuth row and an API key alike. exclusive: a model that only other
		// accounts serve moves a plain pin for one request, and a bound agent must run on its
		// account or not at all.
		const ok = auth.pinSessionCredential(provider, sid, credentialId, { exclusive: true });
		const repeat = lastPinned.get(provider) === credentialId;
		lastPinned.set(provider, credentialId);
		if (repeat) {
			// The same id re-asserted on a later turn. The write still matters, because the sticky
			// row may have been deleted under it; a second audit line does not.
			return;
		}
		let reason: string | undefined;
		if (!ok) {
			try {
				reason = auth.keys.describe(provider, sid) || "pin refused";
			} catch {
				reason = "pin refused";
			}
		}
		// A subagent runs hasUI:false, so the audit trail is a session entry. appendEntry is not
		// sent to the model, so it costs the child no context.
		pi.appendEntry("ccw-agent-account", {
			agent,
			provider,
			credentialId,
			sessionId: sid,
			profile: BOUND_PROFILE,
			// The model ACTUALLY about to run, which is the post-fallback value. Recording it
			// beside the account is what makes a silent reroute visible after the fact.
			model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined,
			ok,
			reason,
		});
	};

	// One entry per agent, the first time the child sees its own model.
	const MISMATCH_SEEN = new Set<string>();

	// The post-mortem half of the pre-flight in apply(). The parent's check runs before the
	// spend and can be wrong about a fuzzy pattern; this one runs inside the child, where
	// ctx.model is the model the request will actually use, and it is the only record that
	// survives site B, which logs nothing at all.
	const checkModel = (ctx: ExtensionContext) => {
		const agent = agentNameOf(ctx);
		if (!agent || MISMATCH_SEEN.has(agent)) {
			return;
		}
		// Module scope reaches the parent's applied profile, because a subagent re-binds the
		// factory without re-evaluating the module.
		const profile = APPLIED_PROFILE;
		const wanted = profile && profile[agent] ? profile[agent].model : undefined;
		if (!wanted || !ctx.model) {
			return;
		}
		const actual = ctx.model.provider + "/" + ctx.model.id;
		MISMATCH_SEEN.add(agent);
		if (actual === wanted) {
			return;
		}
		pi.appendEntry("ccw-agent-model-mismatch", {
			agent,
			wanted,
			actual,
			profile: APPLIED_NAME,
			sessionId: ctx.sessionManager.getSessionId(),
		});
	};

	// before_agent_start is the anchor and before_provider_request the guard: those two are the
	// only awaited hooks that run before the child's first request. before_agent_start returns
	// undefined. before_provider_request returns undefined for every request the binding allows,
	// because a returned value replaces the request payload, and it returns refusal() for every
	// request the binding forbids. Only a bound child is ever refused: the parent and an unbound
	// child fall through on myBinding() returning null.
	pi.on("before_agent_start", (_event, ctx) => {
		try {
			pinAccount(ctx, false);
			checkModel(ctx);
		} catch {}
	});

	pi.on("before_provider_request", (_event, ctx) => {
		try {
			pinAccount(ctx, true);
		} catch {}
		let binding;
		try {
			binding = myBinding(ctx);
		} catch {
			binding = null;
		}
		if (!binding || !ctx.model) {
			return undefined;
		}
		let problem: string | null;
		try {
			problem = judge(ctx, binding);
		} catch (error) {
			// Fail closed: a bound child whose guard broke is not a child known to be bound.
			problem = "the guard could not check the request: " + String(error);
		}
		if (!problem) {
			return undefined;
		}
		try {
			pi.appendEntry("ccw-agent-refused", {
				agent: binding.agent,
				profile: binding.profile,
				expected: binding.pattern,
				actual: ctx.model.provider + "/" + ctx.model.id,
				reason: problem,
				sessionId: ctx.sessionManager.getSessionId(),
			});
		} catch {}
		return refusal("ccw-agent-profile refused a request from " + binding.agent + ": " + problem) as never;
	});

	// This fires in the SPAWNING session before a child's model resolves. A block throws a
	// preflight error carrying the reason. A model replaces the patterns and the note rides
	// beside the resolved model; the runner keeps the last model and stops at the first block.
	//
	// Strict: while any profile is applied, an agent it does not bind does not run, and the
	// reason names the file that binds it. Under off this fork's own resolution holds. An m<N>
	// agent is a model the user tagged, built as a task clone, so it runs on the tagged model
	// under task's level and account, and the child guard holds it there.
	function routeSpawn(event: any, ctx: ExtensionContext): any {
		SPAWNS_SEEN++;
		try {
			const agent = String((event as any).agent || "");
			if (APPLIED_PROFILE && !Object.hasOwn(APPLIED_PROFILE, agent) && /^m\d+$/.test(agent)) {
				// The selector comes from the branch the user tagged it on, the first entry per
				// agent winning as readModelMentions does, and never from the patterns, which a
				// model the caller names would replace.
				let selector: unknown;
				try {
					for (const entry of (ctx.sessionManager.getBranch() || []) as any[]) {
						if (
							entry &&
							entry.type === "custom" &&
							entry.customType === "model_mention" &&
							entry.data &&
							entry.data.agent === agent
						) {
							selector = entry.data.selector;
							break;
						}
					}
				} catch {}
				if (typeof selector !== "string" || !MODEL_SHAPE.test(selector)) {
					return {
						block: true,
						reason:
							"ccw-agent-profile: " +
							agent +
							" names a tagged model, but no model_mention entry on this " +
							"branch says which, so it has no binding. Tag the model again",
					} as never;
				}
				const task = APPLIED_PROFILE.task || {};
				const taskProvider = task.model ? task.model.split("/")[0] : "";
				// One agent binds one credential of one provider, one model and one thinking level.
				// A tagged model would run task's account under a model the account was never
				// checked against, even on task's own provider, so every tag is refused once task
				// holds an account, not only a tag on another provider.
				if (taskProvider && task.accounts && task.accounts[taskProvider]) {
					const taskBinding = bindingOf(ctx, "task");
					const label =
						(taskBinding && !taskBinding.problem && taskBinding.labels[taskProvider]) ||
						task.accounts[taskProvider];
					return {
						block: true,
						reason:
							"ccw-agent-profile: task is bound to " +
							(task.model || taskProvider) +
							" as " +
							label +
							". A tagged model cannot run on that binding. Tag nothing, or run /agent-profile off",
					} as never;
				}
				const row: Record<string, any> = { model: selector };
				if (task.thinking) {
					row.thinking = task.thinking;
				}
				if (task.accounts) {
					row.accounts = task.accounts;
				}
				MENTION_ROWS[agent] = row;
			}
			const binding = bindingOf(ctx, agent);
			if (!binding) {
				if (!APPLIED_PROFILE || APPLIED_DISABLED.includes(agent)) {
					return undefined;
				}
				const repo = repoScope(ctx.cwd);
				return {
					block: true,
					reason:
						"ccw-agent-profile: profile " +
						APPLIED_NAME +
						" has no row for " +
						agent +
						", and an agent " +
						"with no row does not run while a profile is applied. Add a row for " +
						agent +
						" to " +
						bindingPlace(repo, agentFiles(USER_AGENTS_DIR), agent) +
						", or run /agent-profile off",
				} as never;
			}
			if (binding.problem) {
				return { block: true, reason: "ccw-agent-profile: " + binding.problem } as never;
			}
			// Refresh the table the child pins from: a re-login mints a new credentialId for the
			// same email, and the selector finds it where the id resolved at apply does not.
			if (Object.keys(binding.credentials).length > 0) {
				BOUND.set(agent, { ...binding.credentials });
			}
			if (!binding.pattern) {
				return undefined;
			}
			const via = binding.labels[binding.model.split("/")[0]];
			return {
				model: binding.pattern,
				note: "profile " + binding.profile + ": " + binding.pattern + (via ? " as " + via : ""),
			} as never;
		} catch (error) {
			return {
				block: true,
				reason: "ccw-agent-profile could not check " + (event as any).agent + ": " + String(error),
			} as never;
		}
	}

	// The tier rule (spawn-grant.ts) needs the model this handler actually resolved, since a
	// pinned pattern replaces event.patterns. before_subagent_spawn refuses over the applied
	// profile first; only a spawn the profile allows reaches the spend check.
	pi.on("before_subagent_spawn", (event, ctx) => {
		const r = routeSpawn(event, ctx);
		if (r && (r as any).block) {
			return r;
		}
		const agent = String((event as any).agent || "");
		const refusal = spendSpawn(
			ctx,
			agent,
			typeof (r as any)?.model === "string" ? (r as any).model : (event.patterns?.[0] ?? ""),
			expensiveModelPatterns(),
		);
		return refusal ?? r;
	});

	// A pre-check over the whole batch: refuses before ANY child in it spawns, and spends
	// nothing itself (before_subagent_spawn above spends per spawn, once each one it allows
	// actually reaches it).
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "task") {
			return undefined;
		}
		const rawTasks: any[] = Array.isArray((event.input as any)?.tasks) ? (event.input as any).tasks : [];
		const candidates = (rawTasks.length > 0 ? rawTasks : [{}]).map(task => {
			const agent = (typeof task?.agent === "string" && task.agent.trim()) || DEFAULT_SPAWN_AGENT;
			return { agent, pattern: bindingOf(ctx, agent)?.pattern ?? "" };
		});
		return spawnGrantPreCheck(ctx, candidates, expensiveModelPatterns());
	});

	// The turn boundary is what survives a credential wipe mid-run. One write per turn, not per
	// request.
	pi.on("turn_start", (_event, ctx) => {
		try {
			pinAccount(ctx, false);
		} catch {}
	});

	// The newest state entry on THIS branch, or "" when the branch carries none. getBranch walks
	// the ancestry rather than the whole tree, so a fork inherits the profile its parent had at
	// the fork point.
	const rememberedProfile = (ctx: ExtensionContext): string => {
		try {
			const branch = ctx.sessionManager.getBranch() || [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as any;
				if (entry && entry.type === "custom" && entry.customType === "ccw-agent-profile-state" && entry.data) {
					return String(entry.data.profile || "");
				}
			}
		} catch {}
		return "";
	};

	// The agent-name guard is load-bearing and not a precaution. A SUBAGENT receives
	// session_start too, so without it a child under OMP_AGENT_PROFILE would re-apply the
	// profile, clear the binding table every sibling reads, and call ctx.ui on a hasUI:false
	// session.
	//
	// Precedence: a state entry beats OMP_AGENT_PROFILE, which beats the built-in default. The
	// entry is the operator's last explicit choice on this branch, the variable is a machine
	// default, and the built-in is the fleet default. So every session applies a profile, and
	// /agent-profile off, which records "off", is the one way to run a branch without one.
	const rehydrate = (_event: unknown, ctx: ExtensionContext) => {
		try {
			if (agentNameOf(ctx)) {
				// A revived child has an empty BOUND and no inherited affinity, so this is where
				// it re-pins from its own entries.
				pinAccount(ctx, false);
				return;
			}
			const remembered = rememberedProfile(ctx);
			if (remembered) {
				apply(remembered, ctx, false, "session");
				return;
			}
			const wanted = String(process.env.OMP_AGENT_PROFILE || "")
				.trim()
				.toLowerCase();
			apply(wanted || loadBuiltin().defaultProfile || "off", ctx, false, wanted ? "OMP_AGENT_PROFILE" : "default");
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	};

	// The four events autoresearch treats as one session change.
	pi.on("session_start", rehydrate);
	pi.on("session_switch", rehydrate);
	pi.on("session_branch", rehydrate);
	pi.on("session_tree", rehydrate);

	// A disabled or removed credential must not keep being re-pinned every turn, and the agents
	// bound to it are named at once rather than at their next refused spawn, together with the
	// credential itself: two rows of one provider must never read the same.
	const dropDeadBindings = (
		ctx: ExtensionContext,
		provider: string,
		what: { status: string; text: string },
		event: any,
	) => {
		const live = new Set((storedCredentials(ctx, provider) || []).map(row => row.id));
		const held = lastPinned.get(provider);
		if (held !== undefined && !live.has(held)) {
			lastPinned.delete(provider);
		}
		const dropped: string[] = [];
		const deadIds = new Set<number>();
		for (const [agent, bound] of BOUND) {
			const credentialId = bound[provider];
			if (credentialId === undefined || live.has(credentialId)) {
				continue;
			}
			delete bound[provider];
			if (Object.keys(bound).length === 0) {
				BOUND.delete(agent);
			}
			dropped.push(agent);
			deadIds.add(credentialId);
		}
		if (dropped.length === 0 || agentNameOf(ctx)) {
			// A child shares this module's table, so it drops the binding too. Only the parent has
			// a UI to say so on.
			return;
		}
		// This fork's credential_disabled names its row; credential_removed carries the rows.
		// Otherwise the unfiltered list still holds a disabled row.
		let rows: any[] = [];
		try {
			rows = ctx.modelRegistry.authStorage.listCredentials(provider) || [];
		} catch {}
		const nameOf = (id: number) => {
			const removed = ((event && event.credentials) || []).find((row: any) => row.id === id);
			if (removed) {
				return credentialLabel(removed);
			}
			if (event && event.credentialId === id) {
				return [event.email, event.orgName ? "(" + event.orgName + ")" : null, "#" + id].filter(Boolean).join(" ");
			}
			const row = rows.find(candidate => candidate.id === id);
			return row ? credentialLabel(row) : "#" + id;
		};
		const names = [...deadIds]
			.sort((a, b) => a - b)
			.map(nameOf)
			.join(", ");
		ctx.ui.setStatus(STATUS_KEY, "agents: " + APPLIED_NAME + " (account " + what.status + ")");
		ctx.ui.notify(
			"The " +
				provider +
				" credential " +
				names +
				" for " +
				dropped.sort().join(", ") +
				" " +
				what.text +
				". Those agents are refused until the profile names a live account.",
			"error",
		);
	};

	pi.on("credential_disabled", (event, ctx) => {
		try {
			dropDeadBindings(
				ctx,
				event.provider,
				{ status: "disabled", text: "was disabled: " + event.disabledCause },
				event,
			);
		} catch {}
	});

	pi.on("credential_removed", (event, ctx) => {
		try {
			dropDeadBindings(ctx, event.provider, { status: "removed", text: "was removed" }, event);
		} catch {}
	});
	// Only a session that ran a subagent ITSELF carries these; a parent never sees its children's
	// entries. So the section is printed only when it has rows, which is inside a child or after
	// a revive.
	const sessionPins = (ctx: ExtensionContext) => {
		const pins: any[] = [];
		try {
			for (const entry of (ctx.sessionManager.getEntries() || []) as any[]) {
				if (entry && entry.type === "custom" && entry.customType === "ccw-agent-account" && entry.data) {
					pins.push(entry.data);
				}
			}
		} catch {}
		return pins;
	};

	// The four task keys besides disabledAgents that /agents writes into config.yml, each a
	// record of agent name to value.
	const GENERATED_KEYS: Record<string, string> = {
		agentModelOverrides: "model",
		agentPrewalk: "prewalk",
		agentAdvisor: "advisor",
		agentServiceTierOverrides: "serviceTier",
	};

	// The credential one agent's child will run on, as status prints it: [provider: label
	// identity #id] for a pinned row of either kind, [pool] when nothing is pinned, and [refused:
	// ...] when the binding cannot be honoured. The label is the one /providers → Credentials
	// stores.
	const credentialOf = (ctx: ExtensionContext, agent: string): string => {
		let binding;
		try {
			binding = bindingOf(ctx, agent);
		} catch (error) {
			return "[refused: " + String(error) + "]";
		}
		if (!binding) {
			return "[pool]";
		}
		if (binding.problem) {
			return "[refused: " + binding.problem + "]";
		}
		const parts = Object.keys(binding.credentials)
			.sort()
			.map(provider => provider + ": " + binding.labels[provider]);
		return parts.length > 0 ? "[" + parts.join(", ") + "]" : "[pool]";
	};

	// One agent as status and set print it: pattern, credential, knobs and the layer behind it.
	const bindingLine = (ctx: ExtensionContext, agent: string): string => {
		const entry = APPLIED_PROFILE ? APPLIED_PROFILE[agent] : undefined;
		if (!entry) {
			return "  " + agent + ": (no row)";
		}
		return (
			"  " +
			agent +
			": " +
			(patternOf(entry) || "(its own model)") +
			"  " +
			credentialOf(ctx, agent) +
			knobsOf(entry) +
			"  source=" +
			(APPLIED_SOURCES[agent] || "builtin")
		);
	};

	const statusReport = (ctx: ExtensionContext) => {
		const lines = ["agent profile: " + APPLIED_NAME + (APPLIED_SOURCE ? " (" + APPLIED_SOURCE + ")" : "")];
		const profile = APPLIED_PROFILE;
		if (profile) {
			// The table first: one line per row that pins a credential, which agents share each
			// credential, then the rows still on the pool. bindingLine below repeats the per-agent
			// detail; this is the whole mapping at a glance.
			const rows = Object.keys(profile)
				.sort()
				.map(agent => ({ agent, binding: bindingOf(ctx, agent) }))
				.filter(row => row.binding && !row.binding.problem);
			const bound = rows.filter(row => Object.keys(row.binding!.credentials).length > 0);
			const pool = rows.filter(row => Object.keys(row.binding!.credentials).length === 0);
			if (bound.length > 0) {
				lines.push("mapping:");
				const byCredential = new Map<string, { label: string; provider: string; kind: string; agents: string[] }>();
				for (const { agent, binding } of bound) {
					const provider = Object.keys(binding!.credentials)[0];
					const id = binding!.credentials[provider];
					lines.push(
						"  " +
							agent +
							"  " +
							binding!.labels[provider] +
							" · " +
							provider +
							" · " +
							(binding!.model || "(its own model)") +
							" · " +
							(binding!.thinking || "(inherit)") +
							"  (" +
							(APPLIED_SOURCES[agent] || "builtin") +
							")",
					);
					const key = provider + "#" + id;
					if (!byCredential.has(key)) {
						const row = (storedCredentials(ctx, provider) || []).find(candidate => candidate.id === id);
						byCredential.set(key, {
							label: binding!.labels[provider],
							provider,
							kind: row && row.kind === "api_key" ? "API key" : "subscription",
							agents: [],
						});
					}
					byCredential.get(key)!.agents.push(agent);
				}
				lines.push("credentials in this mapping:");
				for (const info of byCredential.values()) {
					lines.push(
						"  " + info.label + " (" + info.provider + ", " + info.kind + "): " + info.agents.sort().join(", "),
					);
				}
			}
			if (pool.length > 0) {
				lines.push("pool:");
				for (const { agent, binding } of pool) {
					lines.push(
						"  " +
							agent +
							"  " +
							(binding!.model || "(its own model)") +
							" · " +
							(binding!.thinking || "(inherit)"),
					);
				}
			}
			for (const agent of Object.keys(profile).sort()) {
				lines.push(bindingLine(ctx, agent));
				const warning = autoThinkingWarning(ctx, agent, (profile[agent] as Record<string, unknown>).thinking);
				if (warning) {
					lines.push(warning);
				}
			}
			if (APPLIED_DISABLED.length > 0) {
				lines.push(disabledLine());
			}
			// The roster is the bundled agents, the user and repo agent files, and whatever the
			// running task tool lists, which is where a plugin agent appears.
			const repo = repoScope(ctx.cwd);
			const users = agentFiles(USER_AGENTS_DIR);
			const known = new Set([
				...BUNDLED_AGENTS,
				...Object.keys(users),
				...(repo ? Object.keys(repo.agents) : []),
				...agentRoster(),
			]);
			const unbound = [...known].filter(agent => !profile[agent] && !APPLIED_DISABLED.includes(agent)).sort();
			if (unbound.length > 0) {
				lines.push("no row, so refused at spawn:");
				for (const agent of unbound) {
					lines.push("  " + agent + " -> add a row to " + bindingPlace(repo, users, agent));
				}
			}
			lines.push(
				"enforcement: the spawn hook checked " +
					SPAWNS_SEEN +
					" spawn(s); the request guard checks every bound child",
			);
		} else {
			lines.push("  (none -- each agent uses its own model)");
			lines.push("off drops every layer, assign: included. Apply a profile to bring them back.");
		}
		const pins = sessionPins(ctx);
		if (pins.length > 0) {
			lines.push("pins this session wrote:");
			for (const pin of pins) {
				lines.push(
					"  " +
						pin.agent +
						" -> " +
						pin.provider +
						" #" +
						pin.credentialId +
						(pin.ok === false ? "  REFUSED: " + (pin.reason || "unknown") : ""),
				);
			}
		}
		let task: Record<string, unknown> = {};
		try {
			task = (settings.getGlobalSettings().task as Record<string, unknown>) || {};
		} catch {}
		const strays = new Set<string>();
		for (const key of Object.keys(GENERATED_KEYS)) {
			const map = task[key];
			if (map && typeof map === "object" && !Array.isArray(map)) {
				for (const agent of Object.keys(map)) {
					strays.add(agent);
				}
			}
		}
		if (strays.size > 0) {
			lines.push(
				APPLIED_NAME === "off"
					? strays.size +
							" /agents " +
							(strays.size === 1 ? "entry" : "entries") +
							" in " +
							GENERATED_CONFIG +
							" apply while off, and move into the next profile applied: " +
							[...strays].sort().join(", ")
					: strays.size +
							" /agents " +
							(strays.size === 1 ? "entry" : "entries") +
							" in " +
							GENERATED_CONFIG +
							" could not be moved into " +
							APPLIED_NAME +
							", and yield to its row for the same agent: " +
							[...strays].sort().join(", "),
			);
		}
		const strayDisabled = Array.isArray(task.disabledAgents) ? (task.disabledAgents as string[]) : [];
		if (strayDisabled.length > 0) {
			lines.push(GENERATED_CONFIG + " disables " + strayDisabled.join(", "));
		}
		show(ctx, lines.join("\n"));
	};

	// The roster comes from the RUNNING process, not from a copy of the bundled list.
	// pi.getAllTools() returns ToolInfo[], and the task tool's description is rendered from
	// one "### <name>" per spawnable agent. So a project agent, a user agent and a plugin agent
	// are all in the list. An m<N> heading is a model the user tagged in the conversation, not a
	// configurable agent, so it is dropped.
	const agentRoster = (): string[] => {
		const names = new Set<string>();
		try {
			for (const tool of pi.getAllTools() || []) {
				if (!tool || tool.name !== "task" || typeof tool.description !== "string") {
					continue;
				}
				for (const match of tool.description.matchAll(/^### (\S+)/gm)) {
					if (!/^m\d+$/.test(match[1])) {
						names.add(match[1]);
					}
				}
			}
		} catch {}
		return [...names].sort();
	};

	// trusted:false means the roster could not be read -- spawning is off, or the upstream
	// template changed. A false "unknown agent" complaint is worse than no check, so nothing
	// warns on the fallback.
	const roster = (): { names: string[]; trusted: boolean } => {
		const found = agentRoster();
		if (found.length > 0) {
			return { names: found, trusted: true };
		}
		const fallback = new Set<string>();
		for (const profile of Object.values(allProfiles())) {
			for (const agent of Object.keys(profile)) {
				fallback.add(agent);
			}
		}
		return { names: [...fallback].sort(), trusted: false };
	};

	// select resolves to the LABEL, so index back by it. undefined means the operator dismissed
	// the dialog, and every caller treats that as abort-the-whole-run.
	const choose = async (ctx: ExtensionContext, title: string, options: { label: string; description?: string }[]) => {
		const picked = await ctx.ui.select(title, options);
		if (picked === undefined) {
			return undefined;
		}
		const index = options.findIndex(option => option.label === picked);
		return index < 0 ? undefined : index;
	};

	// A selector is quoted unconditionally. An email is a plain scalar, but "#3" opens a YAML
	// comment and would silently become an empty mapping value. prewalk and advisor are quoted
	// for the same reason: "@smol" cannot open a plain scalar. pool and like appear only in an
	// assign row, where pool drops the account a lower layer named.
	const renderEntry = (agent: string, entry: Record<string, any>): string => {
		const parts: string[] = [];
		if (entry.model) {
			parts.push("model: " + entry.model);
		}
		if (entry.pool) {
			parts.push("account: pool");
		} else if (entry.accounts && Object.keys(entry.accounts).length > 0) {
			const pairs = Object.keys(entry.accounts).map(provider => provider + ': "' + entry.accounts[provider] + '"');
			parts.push("account: { " + pairs.join(", ") + " }");
		}
		if (entry.like) {
			parts.push("like: " + entry.like);
		}
		if (entry.thinking) {
			parts.push("thinking: " + entry.thinking);
		}
		for (const key of ["prewalk", "advisor"]) {
			if (entry[key]) {
				parts.push(key + ': "' + entry[key] + '"');
			}
		}
		if (entry.serviceTier) {
			parts.push("serviceTier: " + entry.serviceTier);
		}
		if (parts.length === 1 && entry.model) {
			return agent + ": " + entry.model;
		}
		return agent + ": { " + parts.join(", ") + " }";
	};

	// One screen lists every known agent as a row with its live binding, plus Save and Cancel.
	// Picking a row walks credential -> model -> level. Nothing is written until Save, and
	// enforceOneBinding (the one-binding rule, normalizeEntry first) runs on every row before it
	// lands, so the editor cannot write a refused row. Replaces the old per-agent wizard, which
	// forced every agent through the same three questions.
	const tableEditor = async (ctx: ExtensionContext, prefillName?: string) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The table editor needs the interactive TUI. Edit the file directly instead.", "error");
			return;
		}
		const repo = repoScopeOrHolding(ctx.cwd);
		const targets = [
			{ label: "a profile", description: "writes profiles.<name> in " + PROFILES_FILE },
			...(repo ? [{ label: "this repo (local file)", description: "writes " + repo.local }] : []),
		];
		const targetPick = targets.length > 1 ? await choose(ctx, "Edit which mapping", targets) : 0;
		if (targetPick === undefined) {
			return;
		}
		const inRepo = targets[targetPick].label === "this repo (local file)";
		const targetFile = inRepo ? (repo as RepoScope).local : PROFILES_FILE;
		const cancel = () => {
			ctx.ui.notify("Cancelled. " + targetFile + " is unchanged.", "info");
		};
		let name = prefillName;
		let prefill: Record<string, any> | undefined;
		let prefillDisabled: string[] = [];
		if (inRepo) {
			prefill = loadOverlay((repo as RepoScope).local, true).defaults;
		} else {
			if (!name) {
				const names = Object.keys(allProfiles()).sort();
				const options = [{ label: "(new profile)" }, ...names.map(n => ({ label: n, description: describe(n) }))];
				const picked = await choose(ctx, "Which profile", options);
				if (picked === undefined) {
					return;
				}
				if (picked === 0) {
					name = String((await ctx.ui.input("New profile name")) || "")
						.trim()
						.toLowerCase();
					if (!name) {
						return;
					}
				} else {
					name = names[picked - 1];
				}
			}
			if (RESERVED_NAMES.includes(name)) {
				ctx.ui.notify('"' + name + '" is reserved.', "error");
				return;
			}
			if (!PROFILE_NAME_SHAPE.test(name)) {
				ctx.ui.notify('"' + name + '" is not a usable profile name. Use letters, digits, . _ or -.', "error");
				return;
			}
			prefill = allProfiles()[name] || {};
			prefillDisabled = allDisabled()[name] || [];
		}
		const patterns = [...new Set((ctx.models.list() || []).map(model => model.provider + "/" + model.id))].sort();
		if (patterns.length === 0) {
			ctx.ui.notify("No authenticated models this session. Run /login first.", "error");
			return;
		}
		const users = agentFiles(USER_AGENTS_DIR);
		const known = roster();
		const repoForOwn = inRepo ? repo : repoScope(ctx.cwd);
		const agentNames = [
			...new Set([
				...known.names,
				...BUNDLED_AGENTS,
				...Object.keys(users),
				...(repo ? Object.keys(repo.agents) : []),
				...Object.keys(prefill || {}),
			]),
		]
			.filter(agent => !/^m\d+$/.test(agent))
			.sort();
		// A repo's own agent is bound in its overlay or its local file, never in a named profile,
		// where the row would apply in every repo that defines an agent of that name.
		const skipped = inRepo ? [] : agentNames.filter(agent => repoOwns(repoForOwn, users, agent));
		const rows = agentNames.filter(agent => !skipped.includes(agent));
		if (rows.length === 0) {
			ctx.ui.notify("No delegated agents to configure.", "error");
			return;
		}
		if (skipped.length > 0) {
			ctx.ui.notify(
				skipped.join(", ") +
					" belong to this repo, so the table editor for a profile does not list them. " +
					"Edit this repo (local file) instead, or /agent-profile set <agent> scope=repo-shared.",
				"info",
			);
		}
		const cache2 = new Map<string, any[]>();
		const accountsOf = (provider: string) => {
			if (!cache2.has(provider)) {
				cache2.set(provider, storedCredentials(ctx, provider) || []);
			}
			return cache2.get(provider)!;
		};
		const providers = [...new Set(patterns.map(pattern => pattern.split("/")[0]))];
		// The picker's own working shape is raw, exactly what normalizeEntry reads: account,
		// singular, a provider -> selector map. allProfiles() returns rows normalizeEntry already
		// validated -- accounts, plural, an id map already resolved -- so a profile-target prefill
		// is converted once here. A repo-local prefill is the file's own raw rows already, in that
		// same raw shape.
		const chosen: Record<string, any> = {};
		// Only an agent the picker actually walked reaches Save: an untouched row is left byte-
		// for-byte alone, never re-run through normalizeEntry. A repo-local file may carry a shape
		// normalizeEntry alone cannot validate -- a bare account: with no model, valid to
		// composeProfile's own layering (the agent keeps its own frontmatter model) but not to
		// normalizeEntry, which requires a model to anchor a bare selector's provider. Re-running
		// every prefilled row through it on every Save silently dropped that row.
		const touched = new Set<string>();
		for (const agent of rows) {
			const base = prefill && prefill[agent];
			if (!base) {
				continue;
			}
			if (inRepo) {
				chosen[agent] = { ...base };
				continue;
			}
			const { accounts, ...rest } = base;
			chosen[agent] = accounts ? { ...rest, account: { ...accounts } } : { ...rest };
		}
		// What the agent runs now, every layer composed. Same text pickAssignment shows.
		const appliedOf = (agent: string) =>
			APPLIED_PROFILE
				? "applied: " +
					bindingLine(ctx, agent)
						.trim()
						.slice(agent.length + 2)
				: "applied: none (off), so it runs its own model";
		// Only the fields this file's row sets. A missing field comes from the layers below.
		const rowOf = (agent: string): string => {
			const entry = chosen[agent];
			if (!entry) {
				return inRepo ? "no row in this file" : "no row in this profile";
			}
			const parts: string[] = [];
			if (entry.model) parts.push(entry.model);
			if (entry.thinking) parts.push(entry.thinking);
			if (entry.like) parts.push("like " + entry.like);
			const acc = entry.account;
			if (entry.pool || (typeof acc === "string" && acc.trim().toLowerCase() === "pool")) {
				parts.push("pool");
			} else if (acc && typeof acc === "object" && !Array.isArray(acc)) {
				for (const provider of Object.keys(acc).sort()) {
					const matches = matchCredentials(accountsOf(provider), acc[provider]);
					parts.push(provider + ": " + (matches.length === 1 ? credentialLabel(matches[0]) : acc[provider]));
				}
			} else if (acc !== undefined && acc !== null) {
				parts.push('account "' + String(acc) + '"');
			}
			return "row: " + (parts.length > 0 ? parts.join(" · ") : "(empty)");
		};
		const summaryOf = (agent: string) =>
			inRepo || name === APPLIED_NAME ? rowOf(agent) + " | " + appliedOf(agent) : rowOf(agent);
		for (;;) {
			const options = [
				...rows.map(agent => ({ label: agent, description: summaryOf(agent) })),
				{ label: "Save" },
				{ label: "Cancel" },
			];
			const picked = await choose(ctx, "Mapping table" + (name ? " -- " + name : ""), options);
			if (picked === undefined || options[picked].label === "Cancel") {
				cancel();
				return;
			}
			if (options[picked].label === "Save") {
				break;
			}
			const agent = rows[picked];
			const accountOptions = [
				{ label: "no credential (pool)", provider: undefined as string | undefined, row: undefined as any },
				...providers.flatMap(provider =>
					accountsOf(provider).map(row => ({ label: provider + ": " + credentialLabel(row), provider, row })),
				),
			];
			const accountPick = await choose(ctx, agent + ": credential", accountOptions);
			if (accountPick === undefined) {
				cancel();
				return;
			}
			// "no credential (pool)" is a deliberate choice, not a clear: it still runs a named
			// model at a named level, only with no account pinned.
			const pooled = accountPick === 0;
			const modelChoices = pooled
				? patterns
				: patterns.filter(pattern => pattern.startsWith(accountOptions[accountPick].provider + "/"));
			if (modelChoices.length === 0) {
				ctx.ui.notify("No authenticated " + accountOptions[accountPick].provider + " model this session.", "error");
				continue;
			}
			const modelPick = await choose(
				ctx,
				agent + ": model",
				modelChoices.map(pattern => ({ label: pattern })),
			);
			if (modelPick === undefined) {
				cancel();
				return;
			}
			const model = modelChoices[modelPick];
			let pickedModel;
			try {
				pickedModel = (ctx.modelRegistry.getAll("chat") || []).find(
					listed => listed.provider + "/" + listed.id === model,
				);
			} catch {
				pickedModel = undefined;
			}
			// off and auto are always offered beside whatever efforts the model supports, in
			// THINKING_LEVELS order.
			const supported = effortsOf(pickedModel);
			const levels = THINKING_LEVELS.filter(
				level => level === "off" || level === "auto" || supported.includes(level),
			);
			const levelPick = await choose(
				ctx,
				agent + ": thinking level",
				levels.map(level => ({ label: level })),
			);
			if (levelPick === undefined) {
				cancel();
				return;
			}
			const entry: Record<string, any> = { model, thinking: levels[levelPick] };
			if (!pooled) {
				const { provider, row } = accountOptions[accountPick];
				entry.account = { [provider as string]: selectorOf(row, accountsOf(provider as string)) };
			}
			chosen[agent] = entry;
			touched.add(agent);
		}
		// The one-binding rule runs here, so a row the wizard built cannot reach disk half-bound.
		// Only a touched row is validated; an untouched one is never re-run through it.
		const complaints: string[] = [];
		const result: Record<string, any> = {};
		for (const agent of Object.keys(chosen).sort()) {
			if (!touched.has(agent)) {
				continue;
			}
			const entry = normalizeEntry(agent, chosen[agent], complaints);
			const bound = entry ? enforceOneBinding(agent, entry, complaints) : entry;
			if (bound) {
				result[agent] = bound;
			}
		}
		if (complaints.length > 0) {
			ctx.ui.notify(complaints.join("; "), "error");
		}
		if (inRepo) {
			const localCreated = !existsSync(targetFile);
			let backup;
			let changed = false;
			for (const agent of rows) {
				if (!touched.has(agent)) {
					// Never walked in this session: the file's own bytes for this key stay untouched.
					continue;
				}
				const hasResult = Object.hasOwn(result, agent);
				const hadPrefill = prefill && Object.hasOwn(prefill, agent);
				if (!hasResult && !hadPrefill) {
					// The row was touched and refused, and there was nothing on disk to remove:
					// spliceKeys(..., null) on a key the file never had fails outright, so there is
					// nothing safe to write for this agent.
					continue;
				}
				const value = hasResult ? renderEntry(agent, result[agent]).slice(agent.length + 2) : null;
				const write = spliceKeys(targetFile, ["default", agent], value);
				if (!write.ok) {
					ctx.ui.notify("Cannot write " + targetFile + ": " + write.error, "error");
					return;
				}
				backup = backup || write.backup;
				changed = true;
			}
			if (!changed) {
				ctx.ui.notify("Nothing changed in " + targetFile + ".", "info");
				return;
			}
			if (localCreated) {
				ensureLocalGitignored((repo as RepoScope).root);
			}
			const state = loadCustom(true);
			if (state.error) {
				ctx.ui.notify("agent profiles: " + state.error, "error");
			}
			// The local file layers onto whichever profile is applied, at every session, so its
			// edits take effect now, the same way /agent-profile set does.
			if (APPLIED_NAME && APPLIED_NAME !== "off") {
				apply(APPLIED_NAME, ctx, false, "reapply");
			}
			ctx.ui.notify("Saved the table to " + targetFile + "." + (backup ? " Backup: " + backup + "." : ""), "info");
			return;
		}
		// An untouched agent keeps its already-normalized prefill shape verbatim (allProfiles()
		// validated it once already, at load time), never re-run through normalizeEntry here.
		const body = Object.keys(chosen)
			.sort()
			.map(agent =>
				touched.has(agent)
					? Object.hasOwn(result, agent)
						? renderEntry(agent, result[agent])
						: null
					: prefill && prefill[agent]
						? renderEntry(agent, prefill[agent])
						: null,
			)
			.filter((line): line is string => line !== null);
		if (prefillDisabled.length > 0) {
			body.push("disabled: [" + prefillDisabled.join(", ") + "]");
		}
		if (body.length === 0) {
			ctx.ui.notify("No agent has a row, so there is nothing to write.", "info");
			return;
		}
		const write = spliceBlock("profiles", name!, body);
		if (!write.ok) {
			ctx.ui.notify("Cannot write " + PROFILES_FILE + ": " + write.error, "error");
			return;
		}
		const state = loadCustom(true);
		if (state.error) {
			ctx.ui.notify("agent profiles: " + state.error, "error");
		}
		ctx.ui.notify(
			'Wrote profile "' +
				name +
				'". Run /agent-profile ' +
				name +
				" to apply it." +
				(write.backup ? " Backup: " + write.backup + "." : ""),
			"info",
		);
	};

	const formatHelp = (): string =>
		"Custom profiles: " +
		PROFILES_FILE +
		"\n" +
		"Nothing generates or overwrites this file. Format:\n\n" +
		"profiles:\n" +
		"  frugal:\n" +
		"    scout: deepseek/deepseek-flash\n" +
		"    task: deepseek/deepseek-flash\n" +
		"  split:\n" +
		"    scout: { model: anthropic/claude-opus-5-5, account: me@personal.example, thinking: medium }\n" +
		"    sonic: { model: deepseek/deepseek-flash, thinking: off }\n" +
		"    reviewer:\n" +
		"      model: anthropic/claude-opus-5-5\n" +
		'      account: { anthropic: "#2" }\n' +
		"      thinking: xhigh\n" +
		"      prewalk: off\n" +
		"      advisor: off\n" +
		"      serviceTier: priority\n" +
		"    disabled: [security-reviewer]\n" +
		"  mine:\n" +
		"    extends: tiered\n" +
		"    task: { account: work }\n\n" +
		"A name matching a built-in replaces it. Every model must read provider/model.\n" +
		"extends: <profile> starts from another profile: a hand profile of that name first, then\n" +
		"a built-in, and a profile that extends its own name starts from the built-in. Rows merge\n" +
		"per agent and per field, so mine above runs task on tiered's model and level with the\n" +
		"account added. disabled replaces the parent's list when present. A cycle or an unknown\n" +
		"name makes the profile unusable. new and edit write every row out, with no extends.\n" +
		"Every credential lives in omp's own store, and /providers → Credentials lists, names,\n" +
		"adds and removes them: each OAuth subscription and each API key of any provider. An\n" +
		"account selector names one of those rows: its label (any case), its email, #<id>, or\n" +
		"<provider>/<id>.\n" +
		"It must name exactly one row, or the spawn is refused. A bare selector uses the provider\n" +
		"its model names; the map form names the provider itself. The child pins that row, an\n" +
		"OAuth subscription or an API key alike.\n" +
		"thinking is one of " +
		THINKING_LEVELS.join(", ") +
		". It rides on the model as a\n" +
		":level suffix, so it needs a model. Omit it to inherit. A level the model does not\n" +
		"support runs as the highest supported level below it, or the lowest one when none is\n" +
		"below. /agent-profile warns when that happens, and new/edit offer only the levels the\n" +
		"model supports.\n" +
		"One agent binds one credential of one provider, one model and one thinking level: an\n" +
		"account naming two providers, a model on another provider, a missing level, or\n" +
		"prewalk/advisor set to anything but off are each refused whole, never half-bound.\n" +
		"\n" +
		"assign: binds one agent, any agent, beside the profiles, so no profile exists only to\n" +
		"carry an account:\n\n" +
		"assign:\n" +
		"  okf-writer: { account: work }\n" +
		"  reviewer: { model: openai-codex/gpt-5, thinking: high, account: work }\n" +
		"  profiles:\n" +
		"    tiered:\n" +
		"      scout: { account: pool }\n\n" +
		"The layers run, lowest first: the profile's row, the repo's own tracked file, the repo's\n" +
		"own local file, assign, assign.profiles.<name>. Each field merges on\n" +
		"its own, so an account-only row keeps the model and level below it. A layer that moves an\n" +
		"agent to another provider and names no account puts it on that provider's pool; account:\n" +
		"pool says so outright. Every assign layer binds any agent. /agent-profile set\n" +
		"writes these rows with pickers, or as set <agent> model=... thinking=... account=...\n" +
		"scope=all|profile|repo|repo-shared; unset <agent> [scope] removes one. /agent-profile off\n" +
		"drops every layer, assign included.\n" +
		"prewalk and advisor take on, off, a role such as @smol, or provider/model[:level]. Omit\n" +
		"either to inherit what config.yml holds. serviceTier is one of " +
		SERVICE_TIERS.join(", ") +
		";\n" +
		"omit it to inherit. disabled, beside the agents, lists agents the profile never spawns.\n" +
		"Enforcement is strict. A bound agent runs on its bound model, level and account, or it\n" +
		"does not run: the spawn hook refuses the spawn, and the request guard refuses the\n" +
		"request inside the child, where omp would otherwise fall back to the parent's\n" +
		"model or another account.\n" +
		"While a profile is applied, an agent it has no row for is refused at spawn too, and the\n" +
		"refusal names the file to add the row to. An account is enforced only where a profile\n" +
		"names one, and on a prewalk hand-off too. An advisor runs under its own provider session,\n" +
		"which no pin reaches, so an agent whose advisor shares a pinned provider is refused. A model\n" +
		"you tag (m1, m2, ...) runs as task's row with that model: task's level, and task's account\n" +
		"only when task names none. A tag is refused outright once task holds an account, because\n" +
		"the tagged model was never checked against it.\n\n" +
		"Repo agents: a repo maps the agents it defines in .omp/agents, or in .claude/agents (the\n" +
		"Claude dialect), in the .omp that holds the nearest .omp/agents or .claude/agents above\n" +
		"the session directory. Two files live there. The tracked agent-profiles.yml is checked\n" +
		"into git and may never hold account: -- a row that does is refused and the account is\n" +
		"dropped, with a complaint. The gitignored agent-profiles.local.yml, beside it, may bind\n" +
		"any agent at all, fleet and bundled ones included, account included:\n\n" +
		"# agent-profiles.yml, tracked\n" +
		"default:\n" +
		"  okf-writer: { model: anthropic/claude-sonnet-5, thinking: medium, like: task }\n" +
		"profiles:\n" +
		"  frugal:\n" +
		"    okf-writer: { model: anthropic/claude-haiku-4-5 }\n\n" +
		"# agent-profiles.local.yml, gitignored\n" +
		"default:\n" +
		"  okf-writer: { account: work }\n" +
		"  scout: { account: anthropic/3 }\n\n" +
		"Each file's default lays over whichever profile is applied, and its profiles.<name> over\n" +
		"its own default when that profile is applied, per agent and per field, tracked file\n" +
		"first, then the local file over it. A row takes model, thinking, account, prewalk,\n" +
		"advisor, serviceTier and like. account takes the grammar above.\n" +
		"like: <agent> names an agent the applied profile binds: each field the row omits comes\n" +
		"from it, and so does its account, but only while the row stays on that agent's provider.\n" +
		"An account from any layer beats the borrowed one. A row for an agent the repo does not\n" +
		"define, such as scout or reviewer, is refused in the tracked file, and taken in the\n" +
		"local file.\n\n" +
		(loadBuiltin().defaultProfile || "off") +
		" applies to every session with no other choice. Set OMP_AGENT_PROFILE to\n" +
		"apply another at startup, and /agent-profile off to run a branch with none.\n\n" +
		"Verbs: set [agent], unset <agent>, new [name], edit [name], status, reload, format.\n" +
		"new and edit open one table: every known agent as a row, plus Save and Cancel. Each row\n" +
		"shows what the edited file's own row sets (row: ..., or no row), and, for this repo's file or\n" +
		"the applied profile, what the agent runs now with every layer composed (applied: ...). The\n" +
		"first question is a profile or this repo's local file. Picking a row walks credential, then\n" +
		"model, then thinking level.\n" +
		"A repo's own agent is not listed under a profile: set it with scope=repo or scope=repo-shared,\n" +
		"or edit this repo's local file directly. Nothing is written before Save, and the one-binding\n" +
		"rule runs on every row then, so a refused row never reaches disk.\n" +
		"/agents is omp's own hub for the same rows. While a profile is applied, an /agents edit\n" +
		"writes one row into it, at the layer that already wins for that agent, and a per-agent\n" +
		"entry found in " +
		GENERATED_CONFIG +
		" moves into the applied profile, with a backup of\n" +
		"that file. Under off, /agents writes " +
		GENERATED_CONFIG +
		" itself, and the next profile\n" +
		"applied moves the entry. Enable and disable stay machine-wide in " +
		GENERATED_CONFIG +
		".";

	// ---- one agent, one credential: assign ----

	// The key path a set writes under assign: in the hand file, for scope=all or scope=profile.
	// scope=repo and scope=repo-shared write a different file entirely, and are handled in
	// setCommand directly: their key path is always ["default", agent].
	const assignKeys = (scope: string, agent: string): string[] => {
		if (scope === "profile") {
			return ["assign", "profiles", APPLIED_NAME, agent];
		}
		return ["assign", agent];
	};

	// The raw row a hand-file key path names now, or undefined, at any depth: profiles.<P>.<agent>
	// reads as written, where a loaded profile holds normalized accounts rather than the raw
	// account.
	const handRowAt = (keys: string[]): any => {
		let node: any;
		try {
			node = Bun.YAML.parse(readFileSync(PROFILES_FILE, "utf8"));
		} catch {
			return undefined;
		}
		for (const key of keys) {
			if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, key)) {
				return undefined;
			}
			node = node[key];
		}
		return node === null ? undefined : node;
	};

	interface WriteTarget {
		file: string;
		keys: string[];
		label: string;
		local: boolean;
		root: string;
	}

	// target: { file, keys, label, local, root }. local marks a repo's gitignored file, the one
	// file besides the hand file an account may sit in; root is that repo, for its .gitignore.
	const rowAt = (target: WriteTarget): any => {
		if (target.file === PROFILES_FILE) {
			return handRowAt(target.keys);
		}
		const loaded = loadOverlay(target.file, target.local);
		const agent = target.keys[target.keys.length - 1];
		return target.keys[0] === "default" ? loaded.defaults[agent] : (loaded.profiles[target.keys[1]] || {})[agent];
	};

	// The one row writer set, /agents and the config.yml migration share. change holds the fields
	// to set (model, thinking, account, prewalk, advisor); clear names the fields to delete, or
	// is "row" to delete the whole row. A write that leaves the agent refused where it was not
	// refused before is put back byte for byte, and the refusal is returned.
	const writeRow = (
		ctx: ExtensionContext,
		target: WriteTarget,
		agent: string,
		change: Record<string, unknown>,
		clear: string[] | "row",
	): { ok: boolean; noop?: boolean; error: string | null; backup: string } => {
		const existing = rowAt(target);
		const reasonBefore = APPLIED_REFUSED_REASONS[agent];
		// A hand profile refuses a bad row while it loads, so the agent just drops out of it and
		// no layer reason is recorded. Its complaint names <profile>.<agent>.
		const handComplaint = (text: string | null) => {
			const prefix = APPLIED_NAME + "." + agent + ": ";
			const all = String(text || "");
			for (let at = all.indexOf(prefix); at >= 0; at = all.indexOf(prefix, at + 1)) {
				if (at === 0 || all.slice(at - 2, at) === "; ") {
					const rest = all.slice(at + prefix.length);
					const end = rest.indexOf("; ");
					return end < 0 ? rest : rest.slice(0, end);
				}
			}
			return "";
		};
		const complaintBefore = handComplaint(loadCustom(false).error);
		let before: Buffer | null = null;
		try {
			before = readFileSync(target.file);
		} catch {}
		let result: { ok: boolean; backup: string; error: string | null };
		if (clear === "row") {
			if (existing === undefined) {
				return { ok: true, noop: true, error: null, backup: "" };
			}
			result = spliceKeys(target.file, target.keys, null);
		} else {
			const row: Record<string, any> = typeof existing === "string" ? { model: existing } : { ...existing };
			for (const [field, value] of Object.entries(change)) {
				if (value !== undefined) {
					row[field] = value;
				}
			}
			for (const field of clear || []) {
				delete row[field];
			}
			const entry: Record<string, any> = {
				model: row.model,
				thinking: row.thinking,
				like: row.like,
				prewalk: row.prewalk,
				advisor: row.advisor,
				serviceTier: row.serviceTier,
			};
			const account = typeof row.account === "string" ? row.account.trim() : row.account;
			if (typeof account === "string" && account.toLowerCase() === "pool") {
				entry.pool = true;
			} else if (account && typeof account === "object") {
				entry.accounts = { ...account };
			} else if (account !== undefined) {
				const text = String(account);
				const cut = text.indexOf(":");
				const current = APPLIED_PROFILE && APPLIED_PROFILE[agent] ? APPLIED_PROFILE[agent].model : "";
				const provider = cut > 0 ? text.slice(0, cut) : String(row.model || current || "/").split("/")[0];
				if (!provider) {
					return {
						ok: false,
						error: "account needs a provider: name model= too, or write account=<provider>:<selector>.",
						backup: "",
					};
				}
				entry.accounts = { [provider]: cut > 0 ? text.slice(cut + 1) : text };
			}
			// As between layers, an account named for the old provider does not follow a new model.
			if (change.model !== undefined && change.account === undefined && entry.accounts) {
				const provider = (change.model as string).split("/")[0];
				if (entry.accounts[provider] === undefined) {
					delete entry.accounts;
				} else {
					entry.accounts = { [provider]: entry.accounts[provider] };
				}
			}
			if (Object.values(entry).every(value => value === undefined)) {
				if (existing === undefined) {
					return { ok: true, noop: true, error: null, backup: "" };
				}
				result = spliceKeys(target.file, target.keys, null);
			} else {
				result = spliceKeys(target.file, target.keys, renderEntry(agent, entry).slice(agent.length + 2));
			}
		}
		if (!result.ok) {
			return { ok: false, error: "Cannot write " + target.file + ": " + result.error, backup: "" };
		}
		if (before === null && target.local && target.root) {
			ensureLocalGitignored(target.root);
		}
		const state = loadCustom(true);
		if (APPLIED_NAME !== "off") {
			apply(APPLIED_NAME, ctx, false, "reapply");
			const complaint = handComplaint(state.error);
			const reason =
				APPLIED_REFUSED_REASONS[agent] && !reasonBefore
					? APPLIED_REFUSED_REASONS[agent]
					: complaint && !complaintBefore
						? complaint
						: "";
			if (reason) {
				try {
					if (before === null) {
						rmSync(target.file, { force: true });
					} else {
						writeFileSync(target.file, before);
					}
				} catch {}
				loadCustom(true);
				apply(APPLIED_NAME, ctx, false, "reapply");
				return { ok: false, error: agent + ": " + reason, backup: result.backup };
			}
		}
		if (state.error) {
			ctx.ui.notify("agent profiles: " + state.error, "error");
		}
		return { ok: true, error: null, backup: result.backup };
	};

	// Where an /agents edit or a migrated config.yml entry for agent lands in the current
	// mapping: the layer that already wins for it, or one above it, so no higher layer hides the
	// write. A tracked repo file is shared, so an edit of its row goes to the local file over it.
	const mappingTarget = (ctx: ExtensionContext, agent: string): WriteTarget => {
		const P = APPLIED_NAME === "off" ? loadBuiltin().defaultProfile || "off" : APPLIED_NAME;
		const L = APPLIED_LAYERS[agent];
		const repo = repoScopeOrHolding(ctx.cwd);
		const users = agentFiles(USER_AGENTS_DIR);
		const hand = (keys: string[]): WriteTarget => ({
			file: PROFILES_FILE,
			keys,
			label: keys.join("."),
			local: false,
			root: "",
		});
		const local = (keys: string[]): WriteTarget => ({
			file: (repo as RepoScope).local,
			keys,
			label: (repo as RepoScope).local + ": " + keys.join("."),
			local: true,
			root: (repo as RepoScope).root,
		});
		if (repo && (L === "local-default" || L === "default" || L === "profiles." + P)) {
			return local(["default", agent]);
		}
		if (repo && L === "local-profiles." + P) {
			return local(["profiles", P, agent]);
		}
		if (L === "assign" || L === "assign.profiles." + P) {
			return hand(["assign", "profiles", P, agent]);
		}
		if (
			repo &&
			(existsSync(repo.local) || (repo.overlay !== "" && existsSync(repo.overlay)) || repoOwns(repo, users, agent))
		) {
			return local(["default", agent]);
		}
		if (loadCustom(false).profiles[P]) {
			return hand(["profiles", P, agent]);
		}
		return hand(["assign", "profiles", P, agent]);
	};

	// One provider/model[:level] from what /agents holds: a comma list or a fuzzy pattern
	// resolves to its first available model, as this fork's own spawn would pick it. A
	// provider/model shape is taken as written only when it names an available model: the hub
	// prefills the current value, so a pattern typed after it reads provider/model:<junk>.
	const parseHubModel = (
		ctx: ExtensionContext,
		text: unknown,
	): { model?: string; thinking?: string; resolvedFrom?: string; error?: string } => {
		const trimmed = String(text ?? "").trim();
		for (const raw of trimmed.split(",")) {
			let part = raw.trim();
			let thinking: string | undefined;
			const cut = part.lastIndexOf(":");
			if (cut > 0 && THINKING_LEVELS.includes(part.slice(cut + 1).toLowerCase())) {
				thinking = part.slice(cut + 1).toLowerCase();
				part = part.slice(0, cut);
			}
			if (!part) {
				continue;
			}
			let listed: any[] = [];
			try {
				listed = ctx.models.list() || [];
			} catch {}
			if (MODEL_SHAPE.test(part) && listed.some(model => model.provider + "/" + model.id === part)) {
				return { model: part, thinking, resolvedFrom: trimmed.includes(",") ? trimmed : undefined };
			}
			let found;
			try {
				found = ctx.models.resolve(part);
			} catch {
				found = undefined;
			}
			if (found && found.provider && found.id) {
				return { model: found.provider + "/" + found.id, thinking, resolvedFrom: trimmed };
			}
		}
		return { error: 'no available model matches "' + trimmed + '"' };
	};

	// Move each per-agent entry /agents left in config.yml into the applied mapping. Returns true
	// when it moved or dropped one, so apply composes the mapping again.
	const migrateGenerated = (profile: Record<string, any> | null, ctx: ExtensionContext): boolean => {
		let task: Record<string, unknown> | undefined;
		try {
			task = settings.getGlobalSettings().task as Record<string, unknown> | undefined;
		} catch {
			return false;
		}
		if (!task || typeof task !== "object") {
			return false;
		}
		const moved: string[] = [];
		const dropped: string[] = [];
		const kept: string[] = [];
		const remaining: Record<string, Record<string, unknown>> = {};
		MIGRATING = true;
		try {
			for (const [key, field] of Object.entries(GENERATED_KEYS)) {
				const map = task[key];
				if (!map || typeof map !== "object" || Array.isArray(map)) {
					continue;
				}
				remaining[key] = {};
				for (const [agent, value] of Object.entries(map as Record<string, unknown>)) {
					const text = Array.isArray(value) ? value.map(String).join(",") : String(value);
					const row = profile ? profile[agent] : undefined;
					if (row && (field === "model" ? patternOf(row) === text : row[field] === value)) {
						dropped.push(agent + "." + field);
						continue;
					}
					const tag = key + "|" + agent + "|" + text;
					const keep = (why: string) => {
						MIGRATION_KEPT.add(tag);
						remaining[key][agent] = value;
						kept.push(agent + " " + field + " " + text + (why ? " (" + why + ")" : ""));
					};
					if (MIGRATION_KEPT.has(tag)) {
						keep("");
						continue;
					}
					let change: Record<string, unknown> = { [field]: value };
					let clear: string[] = [];
					if (field === "model") {
						const parsed = parseHubModel(ctx, text);
						if (parsed.error) {
							keep(parsed.error);
							continue;
						}
						change = { model: parsed.model };
						if (parsed.thinking) {
							change.thinking = parsed.thinking;
						} else {
							clear = ["thinking"];
						}
					}
					const target = mappingTarget(ctx, agent);
					const result = writeRow(ctx, target, agent, change, clear);
					if (!result.ok) {
						keep(result.error || "");
						continue;
					}
					moved.push(agent + " " + field + " → " + target.label);
				}
			}
		} finally {
			MIGRATING = false;
		}
		if (moved.length === 0 && dropped.length === 0) {
			return false;
		}
		let backup = "";
		if (existsSync(GENERATED_CONFIG)) {
			const stem = GENERATED_CONFIG + ".bak-" + stampNow();
			backup = stem;
			for (let n = 1; n < 100 && existsSync(backup); n++) {
				backup = stem + "-" + n;
			}
			try {
				copyFileSync(GENERATED_CONFIG, backup);
			} catch (error) {
				ctx.ui.notify("Cannot back up " + GENERATED_CONFIG + ": " + String(error) + ". It is unchanged.", "error");
				return true;
			}
		}
		for (const [key, map] of Object.entries(remaining)) {
			cfg.set("task." + key, map);
		}
		const count = moved.length + dropped.length;
		ctx.ui.notify(
			"moved " +
				count +
				" /agents " +
				(count === 1 ? "entry" : "entries") +
				" from " +
				GENERATED_CONFIG +
				" into " +
				APPLIED_NAME +
				": " +
				[...moved, ...dropped.map(item => item + " (already bound)")].join("; ") +
				(backup ? "; backup " + backup : "") +
				(kept.length > 0 ? "; kept (not representable): " + kept.join("; ") : ""),
			"info",
		);
		return true;
	};

	// scope=repo writes the gitignored local file. The first time it creates that file, the
	// repo's .gitignore gets a line for it, so the account it may carry never reaches a commit by
	// surprise. Already-ignored (by any mechanism git itself recognizes) is left alone.
	const LOCAL_FILE_RELATIVE = join(".omp", "agent-profiles.local.yml");
	const ensureLocalGitignored = (root: string) => {
		let ignored = false;
		let noRepo = false;
		try {
			const run = spawnSync("git", ["check-ignore", "-q", LOCAL_FILE_RELATIVE], { cwd: root, timeout: 2000 });
			// 0 (ignored) and 1 (not ignored) both mean git ran and answered. Anything else -- 128,
			// or no status at all -- means root is not a git repo, so no .gitignore of its own
			// exists to append to.
			noRepo = run.status !== 0 && run.status !== 1;
			ignored = run.status === 0;
		} catch {
			noRepo = true;
		}
		if (ignored || noRepo) {
			return;
		}
		const giPath = join(root, ".gitignore");
		let original: string | Buffer = "";
		try {
			original = readFileSync(giPath, "utf8");
		} catch {
			original = "";
		}
		if (
			original
				.toString()
				.split("\n")
				.some(line => line.trim() === LOCAL_FILE_RELATIVE)
		) {
			return;
		}
		const lines = original.length > 0 ? original.toString().replace(/\n+$/, "").split("\n") : [];
		lines.push(LOCAL_FILE_RELATIVE);
		writeWithBackup(giPath, original, lines);
	};

	// The interactive half of set: agent, model, level, credential, scope. null means cancelled.
	const pickAssignment = async (
		ctx: ExtensionContext,
		agent: string,
		repo: RepoScope | null,
		users: Record<string, string>,
	) => {
		const KEEP = "(keep)";
		let target = agent;
		if (!target) {
			const names = [
				...new Set([
					...agentRoster(),
					...BUNDLED_AGENTS,
					...Object.keys(users),
					...(repo ? Object.keys(repo.agents) : []),
					...Object.keys(APPLIED_PROFILE || {}),
				]),
			]
				.filter(name => !/^m\d+$/.test(name))
				.sort();
			const options = names.map(name => ({
				label: name,
				description: bindingLine(ctx, name)
					.trim()
					.slice(name.length + 2),
			}));
			const index = await choose(ctx, "Set which agent", options);
			if (index === undefined) {
				return null;
			}
			target = names[index];
		}
		const current = APPLIED_PROFILE ? APPLIED_PROFILE[target] : undefined;
		// Authenticated models only.
		const patterns = [...new Set((ctx.models.list() || []).map(model => model.provider + "/" + model.id))].sort();
		const modelOptions = [
			{ label: KEEP, description: current && current.model ? patternOf(current) : undefined },
			...patterns.map(pattern => ({ label: pattern, description: undefined as string | undefined })),
		];
		const modelPick = await choose(ctx, target + ": model", modelOptions);
		if (modelPick === undefined) {
			return null;
		}
		const args: Record<string, string> = {};
		if (modelPick > 0) {
			args.model = patterns[modelPick - 1];
		}
		const effective = args.model || (current && current.model) || "";
		let listed;
		try {
			listed = (ctx.modelRegistry.getAll("chat") || []).find(model => model.provider + "/" + model.id === effective);
		} catch {
			listed = undefined;
		}
		const efforts = effortsOf(listed);
		const levels = efforts.length > 0 ? ["off", ...efforts, "auto"] : ["off"];
		const levelPick = await choose(ctx, target + ": thinking level", [
			{ label: KEEP },
			...levels.map(level => ({ label: level })),
		]);
		if (levelPick === undefined) {
			return null;
		}
		if (levelPick > 0) {
			args.thinking = levels[levelPick - 1];
		}
		const provider = effective ? effective.split("/")[0] : "";
		if (provider) {
			const credentials = storedCredentials(ctx, provider);
			const options = [
				{ label: KEEP, description: undefined as string | undefined },
				...credentials.map(credential => ({
					label: pickerLabel(credential),
					description: credential.isDefault ? "default" : undefined,
				})),
				{ label: "any (pool)", description: undefined as string | undefined },
			];
			const pick = await choose(ctx, target + ": which " + provider + " credential", options);
			if (pick === undefined) {
				return null;
			}
			if (pick === options.length - 1) {
				args.account = "pool";
			} else if (pick > 0) {
				args.account = provider + ":" + selectorOf(credentials[pick - 1], credentials);
			}
		}
		const scopes: [string, string][] = [["all", "every profile"]];
		if (APPLIED_NAME !== "off") {
			scopes.push(["profile", "this profile only (" + APPLIED_NAME + ")"]);
		}
		if (repo) {
			scopes.push(["repo", "this repo only, local, account allowed (" + repo.local + ")"]);
			// repo-shared refuses an account outright, so it is not offered once one is picked:
			// offering it and then refusing it wastes the pick.
			if (args.account === undefined && repoOwns(repo, users, target)) {
				scopes.push(["repo-shared", "this repo only, tracked, no account (" + repo.overlay + ")"]);
			}
		}
		const scopePick = await choose(
			ctx,
			target + ": scope",
			scopes.map(([, label]) => ({ label })),
		);
		if (scopePick === undefined) {
			return null;
		}
		return { agent: target, scope: scopes[scopePick][0], args };
	};

	// set writes one agent's row, merged per field with the row already at that scope, and
	// re-applies the current profile at once. unset removes the row, which restores whatever the
	// layers below it bind. scope=all and scope=profile write assign: in the hand file;
	// scope=repo writes default: in the repo's gitignored local file, any agent, account
	// included; scope=repo-shared writes default: in the repo's tracked overlay, a repo-defined
	// agent only, and never an account.
	const setCommand = async (parts: string[], ctx: ExtensionContext, remove: boolean) => {
		const repo = repoScopeOrHolding(ctx.cwd);
		const users = agentFiles(USER_AGENTS_DIR);
		const args: Record<string, string> = {};
		const loose: string[] = [];
		for (const part of parts.slice(1)) {
			const cut = part.indexOf("=");
			if (cut > 0) {
				args[part.slice(0, cut).toLowerCase()] = part.slice(cut + 1);
			} else {
				loose.push(part);
			}
		}
		let agent = loose[0] || "";
		let scope = String(args.scope || (remove ? loose[1] || "" : "")).toLowerCase();
		const usage = remove
			? "Usage: /agent-profile unset <agent> [all|profile|repo|repo-shared]"
			: "Usage: /agent-profile set <agent> [model=<provider/model>] [thinking=<level>] " +
				"[account=<name, email, #id or provider/id>|pool] [scope=all|profile|repo|repo-shared]";
		if (!remove && !["model", "thinking", "account"].some(key => args[key] !== undefined)) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(usage, "error");
				return;
			}
			const picked = await pickAssignment(ctx, agent, repo, users);
			if (!picked) {
				ctx.ui.notify("Cancelled. " + PROFILES_FILE + " is unchanged.", "info");
				return;
			}
			agent = picked.agent;
			scope = picked.scope;
			Object.assign(args, picked.args);
		}
		scope = scope || "all";
		if (
			!agent ||
			!["all", "profile", "repo", "repo-shared"].includes(scope) ||
			agent === "repos" ||
			agent === "profiles"
		) {
			ctx.ui.notify(usage, "error");
			return;
		}
		if (scope === "profile" && APPLIED_NAME === "off") {
			ctx.ui.notify(
				"No profile is applied, so scope=profile names none. Use scope=all, or apply a profile first.",
				"error",
			);
			return;
		}
		if ((scope === "repo" || scope === "repo-shared") && !repo) {
			ctx.ui.notify(
				"This session is not inside a repo's .omp/agents or .claude/agents, so scope=" +
					scope +
					" names no repo. " +
					"Use scope=all or scope=profile.",
				"error",
			);
			return;
		}
		if (scope === "repo-shared" && !repoOwns(repo, users, agent)) {
			ctx.ui.notify(
				agent +
					" is not an agent this repo defines, so scope=repo-shared cannot bind it. Use scope=repo or scope=all.",
				"error",
			);
			return;
		}
		if (scope === "repo-shared" && args.account !== undefined) {
			ctx.ui.notify(
				"account belongs in " + (repo as RepoScope).local + ", not the tracked file. Use scope=repo.",
				"error",
			);
			return;
		}
		const target: WriteTarget =
			scope === "repo"
				? {
						file: (repo as RepoScope).local,
						keys: ["default", agent],
						local: true,
						root: (repo as RepoScope).root,
						label: "",
					}
				: scope === "repo-shared"
					? { file: (repo as RepoScope).overlay, keys: ["default", agent], local: false, root: "", label: "" }
					: { file: PROFILES_FILE, keys: assignKeys(scope, agent), local: false, root: "", label: "" };
		target.label = (target.file === PROFILES_FILE ? "" : target.file + ": ") + target.keys.join(".");
		const change: Record<string, unknown> = {};
		if (!remove) {
			if (args.model !== undefined) {
				if (!MODEL_SHAPE.test(args.model)) {
					ctx.ui.notify("model must read provider/model, got " + args.model, "error");
					return;
				}
				change.model = args.model;
			}
			if (args.thinking !== undefined) {
				const level = args.thinking.trim().toLowerCase();
				if (!THINKING_LEVELS.includes(level)) {
					ctx.ui.notify('thinking "' + args.thinking + '" is not one of ' + THINKING_LEVELS.join(", "), "error");
					return;
				}
				change.thinking = level;
			}
			if (args.account !== undefined) {
				change.account = args.account.trim();
			}
		}
		const result = writeRow(ctx, target, agent, change, remove ? "row" : []);
		if (result.noop) {
			ctx.ui.notify(target.label + " holds no row, so nothing changed.", "info");
			return;
		}
		if (!result.ok) {
			ctx.ui.notify(result.error || "", "error");
			return;
		}
		show(
			ctx,
			(remove ? "unset " : "set ") +
				target.label +
				"\n" +
				bindingLine(ctx, agent) +
				(APPLIED_NAME === "off" ? "\noff is applied, so no layer applies until a profile is." : "") +
				(result.backup ? "\nBackup: " + result.backup : ""),
		);
	};

	// This fork's /agents hub edits the applied mapping through this provider, and shows each
	// agent's credential from it.
	const layerOf = (agent: string) => APPLIED_LAYERS[agent] || APPLIED_SOURCES[agent] || "builtin";
	const credentialsOf = (ctx: ExtensionContext, agent: string): Record<string, number> => {
		try {
			const binding = bindingOf(ctx, agent);
			return binding && !binding.problem ? binding.credentials : {};
		} catch {
			return {};
		}
	};
	pi.registerAgentBindings({
		describe: (agent, ctx) => {
			if (APPLIED_NAME === "off") {
				return "off: no mapping";
			}
			if (APPLIED_DISABLED.includes(agent)) {
				return APPLIED_NAME + " · refused: " + (APPLIED_REFUSED_REASONS[agent] || "disabled by " + APPLIED_NAME);
			}
			if (!APPLIED_PROFILE || APPLIED_PROFILE[agent] === undefined) {
				return APPLIED_NAME + " · no row, refused at spawn";
			}
			return APPLIED_NAME + " · " + credentialOf(ctx, agent).slice(1, -1) + " · " + layerOf(agent);
		},
		save: async (change, ctx) => {
			if (agentNameOf(ctx)) {
				return { ok: false, notice: "only the parent session edits a mapping" };
			}
			// off is a choice made in /agent-profile, so /agents keeps this fork's own config.yml
			// write.
			if (APPLIED_NAME === "off") {
				return undefined;
			}
			const agent = String((change as any).agent || "");
			if ((change as any).property === "disabled") {
				let persisted: string[] = [];
				try {
					const task = settings.getGlobalSettings().task;
					persisted =
						task && Array.isArray((task as any).disabledAgents) ? (task as any).disabledAgents.map(String) : [];
				} catch {}
				const list = (change as any).disabled
					? [...new Set([...persisted, agent])]
					: persisted.filter(name => name !== agent);
				cfg.set(DISABLED_SETTING, list);
				apply(APPLIED_NAME, ctx, false, "reapply");
				if (!(change as any).disabled && APPLIED_DISABLED.includes(agent)) {
					return {
						ok: true,
						notice:
							agent +
							" is enabled in " +
							GENERATED_CONFIG +
							", and " +
							APPLIED_NAME +
							" still disables it: " +
							(APPLIED_REFUSED_REASONS[agent] || "its disabled: list"),
					};
				}
				return {
					ok: true,
					notice: agent + ((change as any).disabled ? " disabled" : " enabled") + " in " + GENERATED_CONFIG,
				};
			}
			if (!["model", "prewalk", "advisor"].includes((change as any).property)) {
				return { ok: false, notice: "/agents cannot set " + String((change as any).property) + " on a mapping" };
			}
			const target = mappingTarget(ctx, agent);
			let set: Record<string, unknown> = {};
			let clear: string[] = [];
			let resolvedFrom: string | undefined;
			let shown: string;
			const value = (change as any).value === undefined ? "" : String((change as any).value).trim();
			if ((change as any).property === "model" && value === "") {
				const row = rowAt(target);
				if (!(typeof row === "string" || (row && typeof row === "object" && row.model !== undefined))) {
					return {
						ok: false,
						notice:
							agent + "'s model comes from " + layerOf(agent) + "; change it there with /agent-profile edit",
					};
				}
				clear = ["model", "thinking"];
				shown = "cleared";
			} else if ((change as any).property === "model") {
				const parsed = parseHubModel(ctx, value);
				if (parsed.error) {
					return { ok: false, notice: parsed.error };
				}
				set = { model: parsed.model };
				if (parsed.thinking) {
					set.thinking = parsed.thinking;
				} else {
					clear = ["thinking"];
				}
				resolvedFrom = parsed.resolvedFrom;
				shown = parsed.model + (parsed.thinking ? ":" + parsed.thinking : "");
			} else if (value === "") {
				clear = [(change as any).property];
				shown = "cleared";
			} else {
				set = { [(change as any).property]: value };
				shown = value;
			}
			const before = credentialsOf(ctx, agent);
			const result = writeRow(ctx, target, agent, set, clear);
			if (!result.ok) {
				return { ok: false, notice: result.error || "" };
			}
			let notice = agent + " " + (change as any).property + " → " + shown + " in " + target.label;
			if (resolvedFrom) {
				notice += ' (resolved from "' + resolvedFrom + '")';
			}
			const after = credentialsOf(ctx, agent);
			const lost = Object.keys(before).filter(provider => after[provider] === undefined);
			if (lost.length > 0 && Object.keys(after).length === 0) {
				const entry = APPLIED_PROFILE ? APPLIED_PROFILE[agent] : undefined;
				const next = entry && entry.model ? entry.model.split("/")[0] : "new";
				notice +=
					"; its " +
					lost.join(", ") +
					" credential does not follow, so it runs on the " +
					next +
					" pool. Ctrl+K maps one";
			}
			return { ok: true, notice };
		},
	});

	pi.registerCommand("agent-profile", {
		description: "Swap the model, the account and the thinking level delegated agents run on",
		getArgumentCompletions: prefix => {
			const wanted = String(prefix || "").toLowerCase();
			const VERBS: Record<string, string> = {
				new: "Build a profile from pickers, one agent at a time",
				edit: "Re-walk the pickers with an existing profile prefilled",
				status: "What is applied, what is pinned, and what config.yml still holds",
				reload: "Re-read the profiles file now",
				set: "Bind one agent to a model, level and stored credential, in every profile or one scope",
				unset: "Remove one agent's set row, restoring what the layers below bind",
				format: "Print the file path and its format",
			};
			return [...Object.keys(allProfiles()), "off", ...Object.keys(VERBS)]
				.filter(name => name.toLowerCase().startsWith(wanted))
				.map(name => ({
					value: name,
					label: name,
					description: VERBS[name] ?? describe(name),
				}));
		},
		handler: async (args, ctx) => {
			try {
				const parts = String(args || "")
					.trim()
					.split(/\s+/)
					.filter(Boolean);
				const wanted = (parts[0] || "").toLowerCase();
				const rest = parts.slice(1).join(" ").toLowerCase();

				if (wanted === "format") {
					show(ctx, formatHelp());
					return;
				}

				if (wanted === "reload") {
					const state = loadCustom(true);
					if (state.error) {
						ctx.ui.notify("agent profiles: " + state.error, "error");
					}
					const names = Object.keys(state.profiles);
					ctx.ui.notify(
						names.length > 0
							? "Loaded " + names.length + " custom profile(s): " + names.join(", ")
							: "No custom profiles in " + PROFILES_FILE,
						"info",
					);
					return;
				}

				if (wanted === "set" || wanted === "unset") {
					await setCommand(parts, ctx, wanted === "unset");
					return;
				}

				if (wanted === "status") {
					statusReport(ctx);
					return;
				}

				if (wanted === "new" || wanted === "edit") {
					await tableEditor(ctx, rest || undefined);
					return;
				}

				const state = loadCustom(false);
				if (state.error) {
					// Reported every time: a silently ignored profile is worse than a repeated
					// warning, because the user believes a map is live that is not.
					ctx.ui.notify("agent profiles: " + state.error, "error");
				}

				if (!wanted) {
					const names = [...Object.keys(allProfiles()), "off"];
					const options = names.map(name => name + " -- " + describe(name));
					const picked = await ctx.ui.select("Model mix for delegated agents", options);
					if (picked === undefined) {
						return;
					}
					const index = options.indexOf(picked);
					if (index < 0) {
						return;
					}
					apply(names[index], ctx, true, "command");
					return;
				}

				apply(wanted, ctx, true, "command");
			} catch (error) {
				ctx.ui.notify("/agent-profile failed: " + String(error), "error");
			}
		},
	});
};

// A subagent spawn spends a user-confirmed grant, the same rule Claude Code enforces in
// internal/hooks/spawngrant.go. Ported from ccw's ccw-spawn-grant.js (claude-code-workflows,
// internal/policy/ompjs), which was itself already written against these session shapes
// (tools/ask.ts:1061-1069, :1139), so isChild/grant/countOf below carry over unchanged.
//
// Beyond that port, this file adds a tier: up to 4 CHEAP subagents in one user turn spend no
// grant at all (FREE_SPAWNS). A 5th cheap one, or any expensive one, needs the same grant the
// old code always required. Only the model decides the tier (Hafiz, 2026-09-26): a named
// flagship, a model priced at or above the cheapest Opus, or its provider's most expensive
// model. A thinking level and a pay-per-token key do not. The grant and the free count both
// reset at the next user prompt, since both are keyed off the same window.
import type { Message, Model, ToolCall } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "../extensibility/extensions";
import type { SessionEntry, SessionMessageEntry } from "../session/session-entries";

export const grantOff = (): boolean => process.env.CCW_SPAWN_GRANT === "off";
const GRANT_ID = "subagents";
const ANSWER = /^(?:approve\s+)?(\d+)\b/i;
export const FREE_SPAWNS = 4;

export const REFUSE_CHILD =
	"Subagent spawn refused: a subagent never spawns a subagent. Do the work inline, or return what you have to the parent.";

export const ASK_TAIL =
	'Do the work inline, or ask first: one question with id "subagents" in omp or header "Subagents" in Claude Code, ' +
	'listing each agent\'s task and model, with options "No agents" and "Approve N agents". The user may type ' +
	"another count. A grant ends at the next user prompt.";

export const refuseOver = (requested: number, left: number): string =>
	"Subagent spawn refused: more than " +
	FREE_SPAWNS +
	" subagents in one user turn need a user-confirmed grant (requested " +
	requested +
	", left " +
	Math.max(left, 0) +
	"). " +
	ASK_TAIL;

export const refuseExpensive = (agent: string, pattern: string, why: string, left: number): string =>
	"Subagent spawn refused: " +
	agent +
	" runs " +
	pattern +
	" (" +
	why +
	"), and an expensive subagent needs a user-confirmed grant (requested 1, left " +
	Math.max(left, 0) +
	"). " +
	ASK_TAIL;

// grant key (the ask toolCallId) -> spawns consumed. Module scope: a subagent session re-binds
// this module's factory to its own ExtensionAPI without re-evaluating the module graph, so this
// table is the parent-to-child channel (see agent-profile/index.ts's own header on the point).
const USED = new Map<string, number>();
// session id + user-prompt key -> free (non-grant) spawns already spent this turn.
const FREE = new Map<string, number>();

interface AskAnswer {
	timedOut?: boolean;
	customInput?: unknown;
	selectedOptions?: unknown[];
}

const countOf = (answer: unknown): number => {
	if (answer === null || typeof answer !== "object") {
		return 0;
	}
	const { timedOut, customInput, selectedOptions } = answer as AskAnswer;
	if (timedOut) {
		return 0;
	}
	const options = Array.isArray(selectedOptions) ? selectedOptions : [];
	const text = String(customInput ?? options[0] ?? "").trim();
	const match = ANSWER.exec(text);
	const n = match ? Number(match[1]) : 0;
	return n >= 1 && n <= 32 ? n : 0;
};

const isMessageEntry = (entry: SessionEntry): entry is SessionMessageEntry => entry.type === "message";

// `entry.message` is `AgentMessage` (Message | app-declared custom messages); the four LLM
// roles below are the only shapes ccw-spawn-grant.js ever read, and no custom message in this
// fork declares one of them, so the runtime check IS the narrowing -- the cast just names it.
const asAppMessage = (entry: SessionMessageEntry): Message | undefined => {
	const role: unknown = (entry.message as { role?: unknown }).role;
	if (role === "user" || role === "developer" || role === "assistant" || role === "toolResult") {
		return entry.message as Message;
	}
	return undefined;
};

const isChild = (ctx: ExtensionContext): boolean => {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_init") {
			return Boolean(entry.agent);
		}
	}
	return false;
};

// Walks back to the latest user message; returns { key, n } for the latest grant, else null.
const grant = (ctx: ExtensionContext): { key: string; n: number } | null => {
	const entries = ctx.sessionManager.getEntries();
	const window: Message[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isMessageEntry(entry)) {
			continue;
		}
		const message = asAppMessage(entry);
		if (!message) {
			continue;
		}
		if (message.role === "user") {
			break;
		}
		window.push(message);
	}
	for (const message of window) {
		if (message.role !== "toolResult" || message.toolName !== "ask") {
			continue;
		}
		const details = message.details;
		const results =
			details !== null && typeof details === "object" && Array.isArray((details as { results?: unknown }).results)
				? (details as { results: unknown[] }).results
				: undefined;
		let answer: unknown;
		if (results) {
			answer = results.find(
				result => result !== null && typeof result === "object" && (result as { id?: unknown }).id === GRANT_ID,
			);
		} else {
			const call = window
				.filter((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant")
				.flatMap(m => m.content)
				.find((block): block is ToolCall => block.type === "toolCall" && block.id === message.toolCallId);
			const questions = call?.arguments.questions;
			const firstQuestion = Array.isArray(questions) ? questions[0] : undefined;
			if (
				firstQuestion !== null &&
				typeof firstQuestion === "object" &&
				(firstQuestion as { id?: unknown }).id === GRANT_ID
			) {
				answer = details;
			}
		}
		if (answer) {
			return { key: message.toolCallId, n: countOf(answer) };
		}
	}
	return null;
};

// The window a free count and a grant both reset on: this session and its latest user
// message's id, or that message's index when an entry carries none.
const promptKey = (ctx: ExtensionContext): string => {
	const entries = ctx.sessionManager.getEntries();
	const session = ctx.sessionManager.getSessionId?.() ?? "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isMessageEntry(entry) && asAppMessage(entry)?.role === "user") {
			return session + "\0" + (entry.id || String(i));
		}
	}
	return session + "\0";
};

const price = (m: Model): number => (m.cost ? m.cost.input + m.cost.output : 0);

// An aggregator such as openrouter lists many vendors, so its group is the vendor prefix of the id.
const groupOf = (m: Pick<Model, "provider" | "id">): string =>
	m.id.includes("/") ? m.provider + "/" + m.id.slice(0, m.id.indexOf("/")) : m.provider;

/**
 * Classifies one spawn by its model alone: a named flagship, a catalog price at or above the
 * cheapest Opus, or the most expensive model of its provider. `pattern` is
 * `provider/id[:level]`; an empty pattern falls back to the parent session's own current model,
 * and a session with no current model fails closed (expensive).
 */
export function spawnTier(
	ctx: ExtensionContext,
	pattern: string,
	expensiveModels: RegExp[],
): { expensive: boolean; why: string } {
	let providerId = "";
	let modelId = "";
	const parsed = /^([^/]+)\/([^:]+)(?::(.+))?$/.exec(pattern);
	if (parsed) {
		providerId = parsed[1];
		modelId = parsed[2];
	} else {
		const current = ctx.model;
		if (!current) {
			return { expensive: true, why: "unknown model" };
		}
		providerId = current.provider;
		modelId = current.id;
	}

	// 1. a named flagship model.
	const combined = providerId + "/" + modelId;
	if (expensiveModels.some(re => re.test(modelId) || re.test(combined))) {
		return { expensive: true, why: "expensive model" };
	}

	let listed: Model[] = [];
	try {
		listed = ctx.models.list() || [];
	} catch {
		listed = [];
	}
	const model = listed.find(m => m.provider === providerId && m.id === modelId);
	if (!model || price(model) <= 0) {
		return { expensive: false, why: "" };
	}

	// 2. priced at or above the cheapest current Opus.
	const opusRefs = listed
		.filter(m => m.provider === "anthropic" && /claude-opus/i.test(m.id) && m.cost && m.cost.output > 0)
		.sort((a, b) => a.cost.output - b.cost.output);
	const ref = opusRefs[0];
	if (ref && (model.cost.input >= ref.cost.input || model.cost.output >= ref.cost.output)) {
		return { expensive: true, why: "priced at or above Opus" };
	}

	// 3. the most expensive model of its provider. A lone priced model is the top of nothing,
	// so a group needs two; rule 2 still catches a lone model priced like Opus.
	const group = groupOf(model);
	const peers = listed.filter(m => groupOf(m) === group && price(m) > 0);
	if (peers.length >= 2 && peers.every(m => price(m) <= price(model))) {
		return { expensive: true, why: "the most expensive model of " + group };
	}

	return { expensive: false, why: "" };
}

/**
 * Called once a spawn has already cleared the profile's own checks (agent-profile/index.ts's
 * routeSpawn). Spends a free slot first, then a grant slot, refusing when both are gone.
 */
export function spendSpawn(
	ctx: ExtensionContext,
	agent: string,
	pattern: string,
	expensiveModels: RegExp[],
): { block: true; reason: string } | undefined {
	if (grantOff()) {
		return undefined;
	}
	try {
		if (isChild(ctx)) {
			return { block: true, reason: REFUSE_CHILD };
		}
		const { expensive, why } = spawnTier(ctx, pattern, expensiveModels);
		const key = promptKey(ctx);
		const usedFree = FREE.get(key) || 0;
		if (!expensive && usedFree < FREE_SPAWNS) {
			FREE.set(key, usedFree + 1);
			return undefined;
		}
		const found = grant(ctx);
		const remaining = found ? found.n - (USED.get(found.key) || 0) : 0;
		if (remaining >= 1 && found) {
			USED.set(found.key, (USED.get(found.key) || 0) + 1);
			return undefined;
		}
		return {
			block: true,
			reason: expensive ? refuseExpensive(agent, pattern, why, remaining) : refuseOver(1, remaining),
		};
	} catch {
		return { block: true, reason: refuseOver(1, 0) };
	}
}

/** One task's classification input for {@link spawnGrantPreCheck}. */
export interface SpawnCandidate {
	agent: string;
	pattern: string;
}

/**
 * Pre-checks a whole `task` batch before any child in it spawns: refuses the batch when it
 * would need more than the grant covers, so a caller never watches 3 of 4 requested subagents
 * start before the 4th is refused. Spends nothing -- before_subagent_spawn spends per spawn,
 * once each one this pre-check allowed actually reaches it.
 */
export function spawnGrantPreCheck(
	ctx: ExtensionContext,
	candidates: SpawnCandidate[],
	expensiveModels: RegExp[],
): { block: true; reason: string } | undefined {
	if (grantOff()) {
		return undefined;
	}
	try {
		if (isChild(ctx)) {
			return { block: true, reason: REFUSE_CHILD };
		}
		const freeLeft = Math.max(0, FREE_SPAWNS - (FREE.get(promptKey(ctx)) || 0));
		let expensiveCount = 0;
		let cheapCount = 0;
		let firstExpensive: { agent: string; pattern: string; why: string } | undefined;
		for (const { agent, pattern } of candidates) {
			const { expensive, why } = spawnTier(ctx, pattern, expensiveModels);
			if (expensive) {
				expensiveCount++;
				firstExpensive ??= { agent, pattern, why };
			} else {
				cheapCount++;
			}
		}
		const need = expensiveCount + Math.max(0, cheapCount - freeLeft);
		const found = grant(ctx);
		const remaining = found ? found.n - (USED.get(found.key) || 0) : 0;
		if (need > remaining) {
			return {
				block: true,
				reason: firstExpensive
					? refuseExpensive(firstExpensive.agent, firstExpensive.pattern, firstExpensive.why, remaining)
					: refuseOver(candidates.length, remaining),
			};
		}
		return undefined;
	} catch {
		return { block: true, reason: refuseOver(candidates.length || 1, 0) };
	}
}

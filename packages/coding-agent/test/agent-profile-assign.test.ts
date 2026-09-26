// L1-L6, K5, P4: the assign layer (fleet row, repo tracked overlay, repo local file, assign,
// assign.profiles.<name>) and /agent-profile set/unset, on a hand file swapped in whole so
// nothing above reads its rows. Ported from ccw's internal/policy/omp_test.go
// (claude-code-workflows, commit 843a5bc).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, settings, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { cfgTaskAgentServiceTierOverrides, cfgTaskDisabledAgents } from "../src/task/settings";
import { agentFile, describeRefusal, makeAuthStorage, makeCtx, makePi, spawn } from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
profiles:
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
`;

// layered/moved/named extend repo-split/tiered so the assign layer stack has something below
// it; threecred and repo-split are not needed here.
const HAND_PROFILES = `profiles:
  repo-split:
    task: { model: anthropic/claude-sonnet-5, account: "b@example.com", thinking: medium }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh }
  layered:
    extends: repo-split
    stack: { model: anthropic/claude-haiku-4-5, thinking: low, serviceTier: flex }
  moved:
    extends: repo-split
  named:
    extends: tiered
`;

// The labels work/personal live on stored rows: #1 -> work, #2 -> personal, #7 -> work (a
// second provider under the same label). accounts: names them once for assign to reuse; assign
// binds stack, pinned, security-reviewer and sonic beside the profiles, and assign.profiles
// narrows serviceTier/account to one profile each.
const HAND_ASSIGN = `accounts:
  work: { anthropic: "a@example.com", openai-codex: "o@example.com" }
  personal: { anthropic: "b@example.com" }
  ghost: { anthropic: "nobody@example.com" }
assign:
  security-reviewer: { account: { anthropic: "a@example.com" } }
  sonic: { account: ghost }
  stack: { account: { anthropic: "b@example.com" }, serviceTier: priority }
  pinned: { account: personal }
  profiles:
    layered:
      stack: { serviceTier: default }
    moved:
      pinned: { model: deepseek/deepseek-flash, thinking: high }
    named:
      task: { account: work }
      reviewer: { model: openai-codex/gpt-5, account: work }
`;

// The tracked overlay's stack row is the layer L1 shows the model coming from; pinned borrows
// task's row through like:. The local file's stack thinking (high) beats the tracked file's
// (medium).
const REPO_TRACKED_YAML = `default:
  stack: { model: anthropic/claude-sonnet-5, thinking: medium }
  pinned: { like: task }
  okf-writer: { model: anthropic/claude-sonnet-5, thinking: medium, like: task }
`;
const REPO_LOCAL_YAML = `default:
  stack: { thinking: high, account: { anthropic: "a@example.com" } }
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

// c@example.org (#3) and the two twin@example.com rows (#10, #11) are unlabelled, so the picker
// prints their identity. #4 (disabled OAuth) and #5 (disabled API key) never appear.
function labelCredentials(auth: ReturnType<typeof makeAuthStorage>) {
	const byId = (id: number) => auth.credentials.find(row => row.id === id) as { label: string | null };
	byId(1).label = "work";
	byId(2).label = "personal";
	byId(7).label = "work";
}

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-assign-agent-"));
	repoDir = mkdtempSync(join(tmpdir(), "agent-profile-assign-fixture-"));
	repoCwd = join(repoDir, "src");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), HAND_PROFILES + HAND_ASSIGN);

	mkdirSync(repoCwd, { recursive: true });
	mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
	writeFileSync(join(repoDir, ".omp", "agents", "stack.md"), agentFile("stack", "Runs the five-layer case"));
	writeFileSync(join(repoDir, ".omp", "agents", "pinned.md"), agentFile("pinned", "Names its own login"));
	writeFileSync(join(repoDir, ".omp", "agents", "binder.md"), agentFile("binder", "Exercises the one-binding rule"));
	writeFileSync(
		join(repoDir, ".omp", "agents", "okf-writer.md"),
		agentFile("okf-writer", "Writes knowledge: one concept at a time"),
	);
	writeFileSync(join(repoDir, ".omp", "agent-profiles.yml"), REPO_TRACKED_YAML);
	writeFileSync(join(repoDir, ".omp", "agent-profiles.local.yml"), REPO_LOCAL_YAML);

	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("L1: four layers, each the top one for one field", () => {
	it("the overlay's model beats the fleet row, assign's account beats the local file's, assign.profiles beats assign's serviceTier", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("layered", repoCtx);

		const stackIn = (await spawn(repoPi, "stack", repoCtx)) as { note: string };
		expect(stackIn.note).toBe("profile layered: anthropic/claude-sonnet-5:high as personal b@example.com #2");
		const tierIn = cfgTaskAgentServiceTierOverrides.get(settings).stack;
		expect(tierIn).toBe("default");

		const pinnedLayered = (await spawn(repoPi, "pinned", repoCtx)) as { note: string };
		expect(pinnedLayered.note.endsWith(" as personal b@example.com #2")).toBe(true);

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"layered",
			makeCtx("repo", null, auth, notices, { cwd: process.cwd() }),
		);
		const stackOut = (await spawn(repoPi, "stack", makeCtx("repo", null, auth, notices, { cwd: process.cwd() }))) as {
			note: string;
		};
		expect(stackOut.note).toBe("profile layered: anthropic/claude-haiku-4-5:low as personal b@example.com #2");

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("repo-split", repoCtx);

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("layered", repoCtx);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", repoCtx);
		const status = repoPi.reports.at(-1) as string;
		const hasLine = (prefix: string, text: string) =>
			status.split("\n").some(line => line.startsWith(prefix) && line.includes(text));
		expect(hasLine("  stack: ", "source=assign-profile")).toBe(true);
		expect(hasLine("  stack: ", "[anthropic: personal b@example.com #2]")).toBe(true);
	});
});

describe("L2: a layer that moves an agent to another provider and names no account runs it on that provider's pool", () => {
	it("moved's pinned row keeps deepseek/high with no account", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("moved", repoCtx);
		const pinnedMoved = (await spawn(repoPi, "pinned", repoCtx)) as { model: string; note?: string };
		expect(pinnedMoved.model).toBe("deepseek/deepseek-flash:high");
		expect(pinnedMoved.note ?? "").not.toContain(" as ");
	});
});

describe("L3, P4: an account-only row keeps the profile's model and level; a dead label refuses; status names every credential", () => {
	it("security-reviewer keeps tiered's row bound to work's account; sonic on the ghost label is refused", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);

		const securityTiered = (await spawn(repoPi, "security-reviewer", repoCtx)) as { note: string };
		expect(securityTiered.note).toBe("profile tiered: anthropic/claude-opus-5-5:xhigh as work a@example.com #1");

		const sonicGhost = (await spawn(repoPi, "sonic", repoCtx)) as { block: boolean; reason: string };
		expect(sonicGhost.block).toBe(true);
		expect(sonicGhost.reason).toContain('no stored anthropic credential matches "ghost"');
		expect(sonicGhost.reason).toContain("name it in /providers → Credentials");

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", repoCtx);
		const status = repoPi.reports.at(-1) as string;
		const hasLine = (prefix: string, text: string) =>
			status.split("\n").some(line => line.startsWith(prefix) && line.includes(text));
		expect(hasLine("  security-reviewer: ", "[anthropic: work a@example.com #1]")).toBe(true);
		expect(hasLine("  security-reviewer: ", "source=assign")).toBe(true);
		expect(hasLine("  scout: ", "[pool]")).toBe(true);
		expect(hasLine("  sonic: ", "[refused: ")).toBe(true);
	});
});

describe("L4: set writes one row with a backup and re-applies at once; unset restores the binding", () => {
	it("scout after set is bound to personal at high, and unset restores tiered's own row", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);
		const scoutBefore = await spawn(repoPi, "scout", repoCtx);

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout account=personal thinking=high",
			repoCtx,
		);
		const setReport = repoPi.reports.at(-1) as string;
		expect(setReport).toContain("\nBackup: ");
		const scoutSet = (await spawn(repoPi, "scout", repoCtx)) as { note: string };
		expect(scoutSet.note).toBe("profile tiered: anthropic/claude-haiku-4-5:high as personal b@example.com #2");

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("unset scout", repoCtx);
		const scoutUnset = await spawn(repoPi, "scout", repoCtx);
		expect(scoutUnset).toEqual(scoutBefore);
	});
});

describe("L5: a label pins its row, and one label on two providers resolves per provider", () => {
	it("named binds task to work's anthropic row and reviewer to work's openai-codex row", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("named", repoCtx);
		const namedTask = (await spawn(repoPi, "task", repoCtx)) as { note: string };
		expect(namedTask.note).toBe("profile named: anthropic/claude-sonnet-5:medium as work a@example.com #1");
		const namedReviewer = (await spawn(repoPi, "reviewer", repoCtx)) as { note: string };
		expect(namedReviewer.note).toBe("profile named: openai-codex/gpt-5:xhigh as work o@example.com #7");
	});
});

describe("L6: the credential picker lists usable rows for the provider, then the pool; disabled rows are hidden", () => {
	it("offers (keep), each usable anthropic row and any (pool)", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, {
			cwd: repoCwd,
			mode: "tui",
			select: async (title: string, choices: { label: string }[]) => {
				if (title === "okf-writer: model") return "(keep)";
				if (title === "okf-writer: thinking level") return "(keep)";
				if (title === "okf-writer: which anthropic credential") {
					credentialChoices = choices.map(c => c.label);
					return "(keep)";
				}
				if (title === "okf-writer: scope") return "every profile";
				return choices[0].label;
			},
		});
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);
		let credentialChoices: string[] = [];
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("set okf-writer", repoCtx);
		expect(credentialChoices).toEqual([
			"(keep)",
			"work (a@example.com) #1",
			"personal (b@example.com) #2",
			"(c@example.org) #3",
			"(twin@example.com) #10",
			"(twin@example.com) #11",
			"any (pool)",
		]);
	});
});

describe("K5: the one-binding rule refuses a row rather than half-binding it", () => {
	async function applyBinder(row: string) {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		writeFileSync(
			join(repoDir, ".omp", "agent-profiles.local.yml"),
			`default:\n  stack: { thinking: high, account: { anthropic: "a@example.com" } }\n  binder: ${row}\n`,
		);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("reload", repoCtx);
		const before = notices.length;
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);
		return { notices: notices.slice(before), repoPi, repoCtx, auth };
	}

	it("(a) an account naming two providers is refused outright", async () => {
		const { notices, repoPi, repoCtx } = await applyBinder(
			'{ model: anthropic/claude-opus-5, thinking: medium, account: { anthropic: "a@example.com", deepseek: "6" } }',
		);
		expect(notices.join(" | ")).toContain(
			"binder: one agent binds one credential of one provider. The row was ignored",
		);
		expect(await spawn(repoPi, "binder", repoCtx)).toBe("undefined");
		expect(cfgTaskDisabledAgents.get(settings)).toContain("binder");
	});

	it("(b) a bound row with no thinking level is refused", async () => {
		const { notices, repoPi, repoCtx } = await applyBinder(
			'{ model: anthropic/claude-opus-5, account: "a@example.com" }',
		);
		expect(notices.join(" | ")).toContain(
			"binder: bound to a anthropic credential, so it needs a thinking level. The row was ignored",
		);
		expect(await spawn(repoPi, "binder", repoCtx)).toBe("undefined");
		expect(cfgTaskDisabledAgents.get(settings)).toContain("binder");
	});

	it("(c) a bound row with prewalk: anything but off is refused", async () => {
		const { notices, repoPi, repoCtx } = await applyBinder(
			'{ model: anthropic/claude-opus-5, thinking: medium, account: "a@example.com", prewalk: "@smol" }',
		);
		expect(notices.join(" | ")).toContain(
			"binder: bound to a anthropic credential, so prewalk: must be off, not @smol",
		);
		expect(await spawn(repoPi, "binder", repoCtx)).toBe("undefined");
		expect(cfgTaskDisabledAgents.get(settings)).toContain("binder");
	});

	it("(d) an API-key row bound by <provider>/<id> passes the guard on the active row", async () => {
		const { repoPi, repoCtx, auth } = await applyBinder(
			"{ model: deepseek/deepseek-flash, thinking: off, account: deepseek/6 }",
		);
		const binder = (await spawn(repoPi, "binder", repoCtx)) as { model: string; note: string };
		expect(binder.model).toBe("deepseek/deepseek-flash:off");
		expect(binder.note.endsWith(" as …a1b2 #6")).toBe(true);

		const binderChild = makePi(await freshExtension(), "off");
		const notices2: string[] = [];
		const binderCtx = makeCtx("child-binder", "binder", auth, notices2, {
			cwd: repoCwd,
			model: {
				provider: "deepseek",
				id: "deepseek-flash",
				reasoning: true,
				thinking: { mode: "effort", efforts: ["high", "xhigh"] },
				cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
			},
		});
		// A fresh module instance has no APPLIED_PROFILE, so re-apply tiered in it first.
		await (binderChild.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", binderCtx);
		await (binderChild.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			binderCtx,
		);
		const binderPins = auth.pins.filter(pin => pin.sessionId === "child-binder");
		expect(binderPins.length).toBe(1);
		expect(binderPins[0]).toMatchObject({ provider: "deepseek", credentialId: 6, exclusive: true });
		const binderGuard = describeRefusal(
			await (binderChild.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				binderCtx,
			),
		);
		expect(binderGuard).toBe("undefined");
	});

	it("(e) a fleet agent bound by <provider>/<id> in the repo's local file", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		writeFileSync(
			join(repoDir, ".omp", "agent-profiles.local.yml"),
			'default:\n  stack: { thinking: high, account: { anthropic: "a@example.com" } }\n  scout: { model: anthropic/claude-sonnet-5, thinking: high, account: "anthropic/2" }\n',
		);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("reload", repoCtx);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);
		const scoutByProviderId = (await spawn(repoPi, "scout", repoCtx)) as { model: string; note: string };
		expect(scoutByProviderId.model).toBe("anthropic/claude-sonnet-5:high");
		expect(scoutByProviderId.note.endsWith(" as personal b@example.com #2")).toBe(true);
	});
});

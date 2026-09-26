// R1-R8, A3, the model-mention cases (m1-m4), and the three-credential concurrent-spawn batch:
// a repo maps the agents it defines in its own .omp/agents, overlays a tracked file and a
// gitignored local file over the applied profile, and a tagged model runs as task's row.
// Ported from ccw's internal/policy/omp_test.go (claude-code-workflows, commit 843a5bc).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import {
	agentFile,
	DEEPSEEK,
	describeRefusal,
	makeAuthStorage,
	makeCtx,
	makePi,
	OPUS55,
	SONNET,
	spawn,
} from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
profiles:
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
`;

// The custom hand profiles this repo suite needs. Byte-identical to ccw's agentProfilesYAML
// (the parts this file exercises).
const HAND_PROFILES = `profiles:
  repo-split:
    task: { model: anthropic/claude-sonnet-5, account: "b@example.com", thinking: medium }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh }
  inherits:
    extends: tiered
    task: { account: "b@example.com" }
  loop-a:
    extends: loop-b
    scout: anthropic/claude-opus-5
  loop-b:
    extends: loop-a
  threecred:
    scout: { model: anthropic/claude-opus-5, account: "#1", thinking: medium }
    reviewer: { model: anthropic/claude-opus-5, account: "#2", thinking: xhigh }
    sonic: { model: deepseek/deepseek-flash, thinking: off, account: spare }
`;

// assign.repos is removed and binds nothing; the "~" and named-link rows would move modelonly's
// account if the retired feature still worked. credentials: and repos: are retired blocks too.
const HAND_ASSIGN = `credentials:
  deepseek-alt: { from: deepseek }
repos:
  /nowhere:
    default:
      modelonly: { account: "a@example.com" }
assign:
  repos:
    /somewhere:
      modelonly: { account: "b@example.com" }
    "~":
      repo-lint: { model: anthropic/claude-haiku-4-5 }
      modelonly: { account: "a@example.com" }
`;

// okf-writer borrows task's account through like:, pinned names its own account (in the local
// file only: a tracked file may never carry one), modelonly takes its account from the local
// file, and reviewer shadows the bundled judge, so its row is refused.
const REPO_TRACKED_YAML = `default:
  okf-writer: { model: anthropic/claude-sonnet-5, thinking: medium, like: task }
  reviewer: { model: anthropic/claude-haiku-4-5, thinking: low }
  pinned: { like: task }
  modelonly: { model: anthropic/claude-haiku-4-5, thinking: low }
`;

const REPO_LOCAL_YAML = `default:
  pinned: { account: "a@example.com" }
  modelonly: { account: "b@example.com" }
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
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-repo-agent-"));
	repoDir = mkdtempSync(join(tmpdir(), "agent-profile-repo-fixture-"));
	repoCwd = join(repoDir, "src");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), HAND_PROFILES + HAND_ASSIGN);
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "user-helper.md"), agentFile("user-helper", "A user agent with no row"));

	mkdirSync(repoCwd, { recursive: true });
	mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
	writeFileSync(
		join(repoDir, ".omp", "agents", "okf-writer.md"),
		agentFile("okf-writer", "Writes knowledge: one concept at a time"),
	);
	writeFileSync(
		join(repoDir, ".omp", "agents", "reviewer.md"),
		agentFile("reviewer", "A repo copy of the bundled judge"),
	);
	writeFileSync(join(repoDir, ".omp", "agents", "pinned.md"), agentFile("pinned", "Names its own login"));
	writeFileSync(
		join(repoDir, ".omp", "agents", "modelonly.md"),
		agentFile("modelonly", "Takes its login from this machine"),
	);
	writeFileSync(join(repoDir, ".omp", "agents", "repo-lint.md"), agentFile("repo-lint", "Has no row anywhere"));
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

describe("R1-R3: a repo overlay borrows or names an account, and refuses a fleet judge", () => {
	it("okf-writer borrows task's account through like:, pinned names its own, modelonly's account survives assign.repos removal, reviewer is refused", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		const before = notices.length;
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("repo-split", repoCtx);
		const repoNotices = notices.slice(before).join(" | ");

		const writer = (await spawn(repoPi, "okf-writer", repoCtx)) as { model: string; note: string };
		expect(writer.model).toBe("anthropic/claude-sonnet-5:medium");
		expect(writer.note).toBe("profile repo-split: anthropic/claude-sonnet-5:medium as b@example.com #2");

		const pinned = (await spawn(repoPi, "pinned", repoCtx)) as { note: string };
		expect(pinned.note).toBe("profile repo-split: anthropic/claude-sonnet-5:medium as a@example.com #1");

		const modelonly = (await spawn(repoPi, "modelonly", repoCtx)) as { note: string };
		expect(modelonly.note).toBe("profile repo-split: anthropic/claude-haiku-4-5:low as b@example.com #2");

		const reviewer = (await spawn(repoPi, "reviewer", repoCtx)) as { model: string; note: string };
		expect(reviewer.model).toBe("anthropic/claude-opus-5-5:xhigh");
		expect(reviewer.note).not.toContain(" as ");

		expect(repoNotices).toContain("agent profile layers for " + repoDir);
		expect(repoNotices).toContain("default.reviewer: reviewer is not an agent this repo defines in .omp/agents");
		expect(repoNotices).toContain(
			"assign.repos is removed; move each row to <repo>/.omp/agent-profiles.local.yml under default:",
		);
	});

	it("R2: the child pins the borrowed account and its guard judges the repo row", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("repo-split", repoCtx);

		const writer = makePi(factory, "medium");
		const writerCtx = makeCtx("child-writer", "okf-writer", auth, notices, { cwd: repoCwd, model: SONNET });
		await (writer.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			writerCtx,
		);
		const writerPins = auth.pins.filter(pin => pin.sessionId === "child-writer");
		expect(writerPins.length).toBe(1);
		expect(writerPins[0].credentialId).toBe(2);

		const writerRight = describeRefusal(
			await (writer.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				writerCtx,
			),
		);
		expect(writerRight).toBe("undefined");

		const writerWrong = describeRefusal(
			await (writer.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown)(
				{ type: "before_provider_request", payload: {} },
				makeCtx("child-writer", "okf-writer", auth, notices, { cwd: repoCwd, model: OPUS55 }),
			),
		);
		expect(writerWrong).toContain("expected anthropic/claude-sonnet-5:medium, got anthropic/claude-opus-5-5");
	});
});

describe("R4: extends tiered, adding this repo's own agents", () => {
	it("inherits keeps tiered's model and level for every fleet agent, and adds an account only to task", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("inherits", repoCtx);

		const task = (await spawn(repoPi, "task", repoCtx)) as { note: string };
		expect(task.note.endsWith(" as b@example.com #2")).toBe(true);
		const scout = (await spawn(repoPi, "scout", repoCtx)) as { model: string };
		expect(scout.model).toBe("anthropic/claude-haiku-4-5:low");
		const reviewer = (await spawn(repoPi, "reviewer", repoCtx)) as { model: string };
		expect(reviewer.model).toBe("anthropic/claude-opus-5-5:xhigh");
		const writer = (await spawn(repoPi, "okf-writer", repoCtx)) as { model: string };
		expect(writer.model).toBe("anthropic/claude-sonnet-5:medium");
	});
});

describe("R5-R6: an agent with no row is refused under a profile, and left to omp under off", () => {
	it("names the file to edit, then leaves both agents alone under off", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);

		const strictRepo = (await spawn(repoPi, "repo-lint", repoCtx)) as { block: boolean; reason: string };
		expect(strictRepo.block).toBe(true);
		expect(strictRepo.reason).toContain("profile tiered has no row for");
		expect(strictRepo.reason).toContain(join(repoDir, ".omp", "agent-profiles.yml"));

		const strictUser = (await spawn(repoPi, "user-helper", repoCtx)) as { block: boolean; reason: string };
		expect(strictUser.block).toBe(true);
		expect(strictUser.reason).toContain(join(agentDir, "ccw-agent-profiles.yml"));

		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("off", repoCtx);
		expect(await spawn(repoPi, "repo-lint", repoCtx)).toBe("undefined");
		expect(await spawn(repoPi, "user-helper", repoCtx)).toBe("undefined");
	});
});

describe("R7: a cycle makes both profiles unusable", () => {
	it("names the cycle once, and applying one changes nothing", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("loop-a", repoCtx);
		expect(notices.some(n => n.includes("loop-a: extends cycle loop-a -> loop-b -> loop-a"))).toBe(true);
		expect(notices.some(n => n.includes('Agent profile "loop-a" is unusable'))).toBe(true);
	});
});

describe("R8: status names the layer behind each row, and every unbound agent with the file to fix it", () => {
	it("shows source=builtin/hand/repo/repo-local and points at the right file", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("inherits", repoCtx);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", repoCtx);
		const status = repoPi.reports.at(-1) as string;
		const hasLine = (prefix: string, text: string) =>
			status.split("\n").some(line => line.startsWith(prefix) && line.includes(text));
		expect(hasLine("  scout: ", "source=builtin")).toBe(true);
		expect(hasLine("  task: ", "source=hand")).toBe(true);
		expect(hasLine("  okf-writer: ", "source=repo")).toBe(true);
		expect(hasLine("  pinned: ", "source=repo-local")).toBe(true);
		expect(hasLine("  modelonly: ", "source=repo-local")).toBe(true);
		expect(
			hasLine(
				"  repo-lint -> ",
				join(repoDir, ".omp", "agent-profiles.yml") +
					", and its account under " +
					join(repoDir, ".omp", "agent-profiles.local.yml"),
			),
		).toBe(true);
		expect(hasLine("  user-helper -> ", join(agentDir, "ccw-agent-profiles.yml"))).toBe(true);
	});
});

describe("A3, model-mention m1-m4: a tagged model runs as task's row", () => {
	it("m1 is refused once task holds an account, m2 with no mention entry is refused, m3 (cross-provider) is refused the same way", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"repo-split",
			makeCtx("repo", null, auth, notices, { cwd: repoCwd }),
		);
		const mentionCtx = makeCtx("repo", null, auth, notices, {
			cwd: repoCwd,
			branch: [
				{
					type: "custom",
					customType: "model_mention",
					data: { agent: "m1", selector: "anthropic/claude-opus-5-5", name: "Opus" },
				},
			],
		});
		const m1 = (await spawn(repoPi, "m1", mentionCtx)) as { block: boolean; reason: string };
		expect(m1.block).toBe(true);
		expect(m1.reason).toContain("task is bound to");
		expect(m1.reason).toContain("cannot run on that binding");

		const m2Ctx = makeCtx("repo", null, auth, notices, { cwd: repoCwd, branch: [] });
		const m2 = (await spawn(repoPi, "m2", m2Ctx)) as { block: boolean; reason: string };
		expect(m2.block).toBe(true);
		expect(m2.reason).toContain("no model_mention entry");

		const m3Ctx = makeCtx("repo", null, auth, notices, {
			cwd: repoCwd,
			branch: [
				{
					type: "custom",
					customType: "model_mention",
					data: { agent: "m3", selector: "deepseek/deepseek-flash", name: "DeepSeek" },
				},
			],
		});
		const m3 = (await spawn(repoPi, "m3", m3Ctx)) as { block: boolean; reason: string };
		expect(m3.block).toBe(true);
		expect(m3.reason).toContain("task is bound to");
		expect(m3.reason).toContain("cannot run on that binding");
	});

	it("m4: an unbound task (tiered names no account) still lets a tag through, unpinned", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		const repoCtx = makeCtx("repo", null, auth, notices, { cwd: repoCwd });
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);
		const m4Ctx = makeCtx("repo", null, auth, notices, {
			cwd: repoCwd,
			branch: [
				{
					type: "custom",
					customType: "model_mention",
					data: { agent: "m4", selector: "deepseek/deepseek-flash", name: "DeepSeek" },
				},
			],
		});
		const m4 = (await spawn(repoPi, "m4", m4Ctx)) as { block: boolean; model: string };
		expect(m4.block).toBeFalsy();
		expect(m4.model).toBe("deepseek/deepseek-flash:medium");

		const mentionedUnbound = makePi(factory, "off");
		await (mentionedUnbound.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
			{ type: "before_agent_start" },
			makeCtx("child-m4", "m4", auth, notices, { model: DEEPSEEK }),
		);
		const m4Pins = auth.pins.filter(pin => pin.sessionId === "child-m4");
		expect(m4Pins.length).toBe(0);
		const m4Wrong = describeRefusal(
			await (
				mentionedUnbound.handlers.get("before_provider_request") as (e: unknown, c: ExtensionContext) => unknown
			)(
				{ type: "before_provider_request", payload: {} },
				makeCtx("child-m4", "m4", auth, notices, { model: SONNET }),
			),
		);
		expect(m4Wrong).not.toBe("undefined");
	});
});

describe("three-credential concurrent spawn: each child pins its own row", () => {
	it("two anthropic subscriptions and one deepseek API key, spawned together", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const repoPi = makePi(factory);
		await (repoPi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"threecred",
			makeCtx("repo", null, auth, notices, { cwd: repoCwd }),
		);
		const threeScout = makePi(factory, "medium");
		const threeReviewer = makePi(factory, "xhigh");
		const threeSonic = makePi(factory, "off");
		await Promise.all([
			(threeScout.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
				{ type: "before_agent_start" },
				makeCtx("child-three-scout", "scout", auth, notices, { cwd: repoCwd }),
			),
			(threeReviewer.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
				{ type: "before_agent_start" },
				makeCtx("child-three-reviewer", "reviewer", auth, notices, { cwd: repoCwd }),
			),
			(threeSonic.handlers.get("before_agent_start") as (e: unknown, c: ExtensionContext) => Promise<void>)(
				{ type: "before_agent_start" },
				makeCtx("child-three-sonic", "sonic", auth, notices, { cwd: repoCwd, model: DEEPSEEK }),
			),
		]);
		const sessions = ["child-three-scout", "child-three-reviewer", "child-three-sonic"];
		const want: Record<string, { provider: string; credentialId: number }> = {
			"child-three-scout": { provider: "anthropic", credentialId: 1 },
			"child-three-reviewer": { provider: "anthropic", credentialId: 2 },
			"child-three-sonic": { provider: "deepseek", credentialId: 12 },
		};
		const threeCredPins = auth.pins.filter(pin => sessions.includes(pin.sessionId));
		expect(threeCredPins.length).toBe(3);
		for (const pin of threeCredPins) {
			expect(pin.provider).toBe(want[pin.sessionId].provider);
			expect(pin.credentialId).toBe(want[pin.sessionId].credentialId);
			expect(pin.exclusive).toBe(true);
		}
		const threeCredEntries = [...threeScout.entries, ...threeReviewer.entries, ...threeSonic.entries].filter(
			entry => entry.customType === "ccw-agent-account" && sessions.includes(entry.sessionId as string),
		);
		expect(threeCredEntries.length).toBe(3);
		for (const entry of threeCredEntries) {
			const w = want[entry.sessionId as string];
			expect(entry.provider).toBe(w.provider);
			expect(entry.credentialId).toBe(w.credentialId);
			expect(entry.ok).toBe(true);
		}
	});
});

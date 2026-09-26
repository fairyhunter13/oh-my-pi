// H2, H5, H3-H4 (Part H addenda), G-1, K5(f), L4b-d: repoScope's edge cases, each guarding a
// branch that has broken before. Ported from ccw's internal/policy/omp_test.go
// (claude-code-workflows, commit 843a5bc).
//
// - H2: a repo's TRACKED overlay naming an account directly is refused and dropped, with a
//   complaint naming the local file it belongs in; the row's model still binds the agent on the
//   pool.
// - H5: scope=repo-shared refuses an account outright, even for an agent the repo defines, and
//   writes nothing.
// - H3/H4: a repo that defines only .claude/agents (no .omp/agents at all) is a repo scope too,
//   and its local file's account: accepts a <provider>/<id> selector; a second set does not add
//   a second .gitignore line.
// - G-1: repoScope runs two independent nearest-dir walks, .omp/agents and .claude/agents. A
//   nearer directory holding only .claude/agents must not win over a farther .omp/agents above
//   it -- the two searches are independent, and .omp/agents is preferred.
// - K5(f) (F12/F13): a git repo nested under $HOME, with no agents of its own, resolves
//   scope=repo to itself through the holdingRepo fallback, never to $HOME -- even though $HOME
//   carries its own .claude/agents (Claude Code's user directory), which REAL_HOME excludes.
// - L4b: scope=repo now takes ANY agent into the repo's gitignored LOCAL file, not only a
//   repo-owned one; a sibling repo with no row for that agent keeps it on the fleet's own row.
// - L4c (F13): a plain git repo with no .omp/agents or .claude/agents anywhere above it still
//   gets scope=repo, falling back to the git toplevel's own gitignored local file.
// - L4d: set then unset on a hand file with no assign block gives the file back byte for byte.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { agentFile, makeAuthStorage, makeCtx, makePi, spawn } from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
profiles:
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
`;

let root: string;
let home: string;
let agentDir: string;
let originalHome: string | undefined;

async function freshExtension(): Promise<ExtensionFactory> {
	const mod = (await import(`../src/agent-profile/index.ts?t=${Math.random()}`)) as {
		createAgentProfileExtension: ExtensionFactory;
	};
	return mod.createAgentProfileExtension;
}

function labelCredentials(auth: ReturnType<typeof makeAuthStorage>) {
	const byId = (id: number) => auth.credentials.find(row => row.id === id) as { label: string | null };
	byId(1).label = "work";
	byId(2).label = "personal";
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "agent-profile-scope-"));
	home = join(root, "home");
	agentDir = join(home, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	originalHome = process.env.HOME;
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	writeFileSync(join(agentDir, "agent-profiles.builtin.yml"), BUILTIN_YAML);
	writeFileSync(join(agentDir, "ccw-agent-profiles.yml"), "profiles: {}\n");

	// $HOME's own .claude/agents (Claude Code's user directory): REAL_HOME must keep this out of
	// every repoScope walk-up, or a session anywhere under $HOME with no closer project dir would
	// resolve to a "repo" rooted at $HOME.
	mkdirSync(join(home, ".claude", "agents"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "agents", "ignored.md"),
		agentFile("ignored", "$HOME's own directory, never a repo"),
	);

	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(root, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("H2, L4b: a repo's tracked account is refused; scope=repo binds any agent into the local file", () => {
	it("repo A's scope=repo write reaches a fleet agent; repo B's tracked account is dropped and its own agent still runs, on the pool", async () => {
		const repoADir = join(root, "repo-a");
		const repoACwd = join(repoADir, "src");
		mkdirSync(repoACwd, { recursive: true });
		// repoScope needs a real .omp/agents directory to find this as a repo at all, even though
		// scout itself is a fleet agent, not one repo A defines.
		mkdirSync(join(repoADir, ".omp", "agents"), { recursive: true });
		writeFileSync(
			join(repoADir, ".omp", "agents", "placeholder.md"),
			agentFile("placeholder", "Marks this directory as a repo"),
		);

		const repoBDir = join(root, "repo-b");
		mkdirSync(join(repoBDir, ".omp", "agents"), { recursive: true });
		writeFileSync(join(repoBDir, ".omp", "agents", "other.md"), agentFile("other", "Repo B's own agent"));
		// H2: an account written directly into the TRACKED overlay must be refused and dropped.
		writeFileSync(
			join(repoBDir, ".omp", "agent-profiles.yml"),
			'default:\n  other: { model: anthropic/claude-opus-5, account: "a@example.com" }\n',
		);

		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const pi = makePi(factory);

		// L4b: scope=repo takes scout, a fleet agent, into repo A's gitignored local file.
		const repoACtx = makeCtx("repo-a", null, auth, notices, { cwd: repoACwd });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoACtx);
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout model=anthropic/claude-sonnet-5 account=personal scope=repo",
			repoACtx,
		);
		const setRepoReport = pi.reports.at(-1) as string;
		const repoALocal = join(repoADir, ".omp", "agent-profiles.local.yml");
		expect(setRepoReport.startsWith("set " + repoALocal + ": default.scout\n")).toBe(true);
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout thinking=high scope=repo",
			repoACtx,
		);
		const scoutInRepoA = (await spawn(pi, "scout", repoACtx)) as { note: string };
		expect(scoutInRepoA.note).toBe("profile tiered: anthropic/claude-sonnet-5:high as personal b@example.com #2");

		// Repo B has no row of its own for scout, so tiered's fleet row applies, unbound.
		const repoBCtx = makeCtx("repo-b", null, auth, notices, { cwd: repoBDir });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoBCtx);
		const scoutInRepoB = (await spawn(pi, "scout", repoBCtx)) as { model: string; note?: string };
		expect(scoutInRepoB.model).toBe("anthropic/claude-haiku-4-5:low");
		expect(scoutInRepoB.note ?? "").not.toContain(" as ");

		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", repoBCtx);
		const repoBStatus = pi.reports.at(-1) as string;
		const hasLine = (status: string, prefix: string, text: string) =>
			status.split("\n").some(line => line.startsWith(prefix) && line.includes(text));
		expect(hasLine(repoBStatus, "  scout: ", "anthropic/claude-haiku-4-5:low  [pool]")).toBe(true);
		expect(hasLine(repoBStatus, "  scout: ", "source=builtin")).toBe(true);

		// H2: repo B's own tracked account is refused and dropped, and "other" still runs, on
		// the pool, since its model survives.
		const noticesBefore = notices.length;
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoBCtx);
		const trackedAccountNotices = notices.slice(noticesBefore).join(" | ");
		expect(trackedAccountNotices).toContain("other: account: belongs in .omp/agent-profiles.local.yml");
		const otherInRepoB = (await spawn(pi, "other", repoBCtx)) as { block: boolean; note?: string };
		expect(otherInRepoB.block).toBeFalsy();
		expect(otherInRepoB.note ?? "").not.toContain(" as ");
	});
});

describe("H5: scope=repo-shared refuses an account outright", () => {
	it("writes nothing and names the local file the account belongs in", async () => {
		const repoDir = join(root, "repo-shared");
		const repoCwd = join(repoDir, "src");
		mkdirSync(repoCwd, { recursive: true });
		mkdirSync(join(repoDir, ".omp", "agents"), { recursive: true });
		writeFileSync(join(repoDir, ".omp", "agents", "okf-writer.md"), agentFile("okf-writer", "Writes knowledge"));
		writeFileSync(join(repoDir, ".omp", "agent-profiles.yml"), "default: {}\n");

		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const repoCtx = makeCtx("repo-shared", null, auth, notices, { cwd: repoCwd });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", repoCtx);

		const before = notices.length;
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set okf-writer account=personal scope=repo-shared",
			repoCtx,
		);
		const sharedAccountNotices = notices.slice(before).join(" | ");
		const repoLocal = join(repoDir, ".omp", "agent-profiles.local.yml");
		expect(sharedAccountNotices).toContain("account belongs in " + repoLocal);
	});
});

describe("H3, H4: a repo that defines only .claude/agents is a repo scope too", () => {
	it("its local file's account accepts <provider>/<id>: right provider matches, wrong provider does not; one .gitignore line survives two sets", async () => {
		const repoClaudeDir = join(root, "repo-claude");
		mkdirSync(join(repoClaudeDir, ".claude", "agents"), { recursive: true });
		writeFileSync(
			join(repoClaudeDir, ".claude", "agents", "demo.md"),
			agentFile("demo", "Claude-dialect agent, no .omp/agents here"),
		);
		execFileSync("git", ["init", "-q", repoClaudeDir]);

		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const pi = makePi(factory);
		const claudeCtx = makeCtx("repo-claude", null, auth, notices, { cwd: repoClaudeDir });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", claudeCtx);

		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set demo model=anthropic/claude-haiku-4-5 thinking=low account=anthropic/1 scope=repo",
			claudeCtx,
		);
		const setClaudeReport = pi.reports.at(-1) as string;
		const claudeLocal = join(repoClaudeDir, ".omp", "agent-profiles.local.yml");
		expect(setClaudeReport.startsWith("set " + claudeLocal + ": default.demo\n")).toBe(true);
		const demoRightProvider = (await spawn(pi, "demo", claudeCtx)) as { note: string };
		expect(demoRightProvider.note.endsWith(" as work a@example.com #1")).toBe(true);

		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set demo account=openai-codex/1 scope=repo",
			claudeCtx,
		);
		const demoWrongProvider = (await spawn(pi, "demo", claudeCtx)) as { block: boolean; reason: string };
		expect(demoWrongProvider.block).toBe(true);
		expect(demoWrongProvider.reason).toContain('no stored anthropic credential matches "openai-codex/1"');

		const claudeGitignore = readFileSync(join(repoClaudeDir, ".gitignore"), "utf8");
		const lineCount = claudeGitignore.split(".omp/agent-profiles.local.yml").length - 1;
		expect(lineCount).toBe(1);
	});
});

describe("G-1: the .omp/agents and .claude/agents walks run independently, and the farther .omp/agents wins", () => {
	it("the nearer, unrelated .claude/agents dir is never treated as this repo's own", async () => {
		const nestOuter = join(root, "nest-outer");
		mkdirSync(join(nestOuter, ".omp", "agents"), { recursive: true });
		writeFileSync(
			join(nestOuter, ".omp", "agents", "outer-omp-demo.md"),
			agentFile("outer-omp-demo", "The farther .omp/agents dir, the one that must win"),
		);
		const inner = join(nestOuter, "inner-claude");
		mkdirSync(join(inner, ".claude", "agents"), { recursive: true });
		writeFileSync(
			join(inner, ".claude", "agents", "inner-claude-demo.md"),
			agentFile("inner-claude-demo", "The nearer, unrelated .claude/agents dir, which must lose"),
		);

		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const nestedCtx = makeCtx("nested-inner", null, auth, notices, { cwd: inner, mode: "print" });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", nestedCtx);
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("status", nestedCtx);
		const status = pi.reports.at(-1) as string;
		expect(status).toContain("outer-omp-demo");
		expect(status).not.toContain("inner-claude-demo");
	});
});

describe("K5(f): a git repo nested under $HOME resolves scope=repo to itself, never to $HOME", () => {
	it("$HOME's own .claude/agents never becomes the repo", async () => {
		// Bun's os.homedir() reads HOME only at process start, so REAL_HOME (computed once at
		// module import) cannot be overridden inside this already-running test process. This
		// case runs as a real child `bun` process instead, with its own HOME, the same way the
		// original harness ran as a `bun` subprocess with a fixed HOME env var.
		const nestedRepo = join(home, "nested-repo");
		mkdirSync(join(nestedRepo, "src"), { recursive: true });
		execFileSync("git", ["init", "-q", nestedRepo]);

		const runnerPath = join(__dirname, "helpers", "agent-profile-k5f-runner.ts");
		const out = execFileSync("bun", ["run", runnerPath], {
			env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
		});
		const got = JSON.parse(out.trim().split("\n").pop() as string) as {
			setReport: string;
			spawnResult: { model?: string; note?: string };
			gitignore: string;
			notices: string[];
		};

		const nestedLocal = join(nestedRepo, ".omp", "agent-profiles.local.yml");
		expect(got.setReport.startsWith("set " + nestedLocal + ": default.scout\n")).toBe(true);
		expect(got.spawnResult.model).toBe("anthropic/claude-haiku-4-5:low");
		expect((got.spawnResult.note ?? "").endsWith(" as personal b@example.com #2")).toBe(true);
		const lineCount = got.gitignore.split(".omp/agent-profiles.local.yml").length - 1;
		expect(lineCount).toBe(1);
	});
});

describe("L4c: a plain git repo with no .omp/agents or .claude/agents anywhere still gets scope=repo", () => {
	it("falls back to the git toplevel's own gitignored local file", async () => {
		const plainDir = join(root, "plain");
		mkdirSync(join(plainDir, "src"), { recursive: true });
		execFileSync("git", ["init", "-q", plainDir]);

		const factory = await freshExtension();
		const auth = makeAuthStorage();
		labelCredentials(auth);
		const notices: string[] = [];
		const pi = makePi(factory);
		const plainCtx = makeCtx("plain", null, auth, notices, { cwd: join(plainDir, "src") });
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", plainCtx);

		const before = notices.length;
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout account=personal scope=repo",
			plainCtx,
		);
		const plainSetNotices = notices.slice(before).join(" | ");
		expect(plainSetNotices).not.toContain("is not inside a repo's .omp/agents or .claude/agents");

		const scoutInPlain = (await spawn(pi, "scout", plainCtx)) as { model: string; note: string };
		expect(scoutInPlain.model).toBe("anthropic/claude-haiku-4-5:low");
		expect(scoutInPlain.note.endsWith(" as personal b@example.com #2")).toBe(true);

		const plainGitignore = readFileSync(join(plainDir, ".gitignore"), "utf8");
		const lineCount = plainGitignore.split(".omp/agent-profiles.local.yml").length - 1;
		expect(lineCount).toBe(1);
	});
});

describe("L4d: set then unset on a hand file with no assign block gives it back byte for byte", () => {
	it("the preamble set wrote goes with the block it introduced", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const pi = makePi(factory);
		const ctx = makeCtx("scope-round-trip", null, auth, notices);

		const handPath = join(agentDir, "ccw-agent-profiles.yml");
		const roundTripBase = "# mine\nprofiles:\n  mine:\n    extends: tiered\n";
		writeFileSync(handPath, roundTripBase);
		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("reload", ctx);

		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)(
			"set scout thinking=high scope=all",
			ctx,
		);
		const roundTripSet = readFileSync(handPath, "utf8");
		expect(roundTripSet).not.toBe(roundTripBase);
		expect(roundTripSet).toContain("assign:");

		await (pi.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("unset scout scope=all", ctx);
		const roundTripBack = readFileSync(handPath, "utf8");
		expect(roundTripBack).toBe(roundTripBase);
	});
});

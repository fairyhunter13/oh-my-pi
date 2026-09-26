#!/usr/bin/env bun
/**
 * Self-test for the ccw commits on this tree: `bun scripts/ccw-selftest.ts [<path-to-oh-my-pi-checkout>]`.
 *
 * The script lives in the fork, not in claude-code-workflows (ccw), so its check list rebases
 * with the commits it checks: a rebase that drops a file this script runs against fails the
 * check with no separate signal.
 *
 * The credential-storage checks (migration, resolution, pinning, removal, revival, the
 * request path) live in this tree as packages/ai/test/ccw-credentials.test.ts, because they
 * test the fork's own AuthStorage code. This script proves the tree still ships and passes
 * that file, the built-in mailbox and agent-profile extensions, the fork's own knowledge
 * bundle, and the one thing only an outside view can check: that upstream has not moved onto
 * the fork's own schema version. Prints one line per check. Exit 0 only when all pass.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = process.argv[2] ?? process.cwd();
if (!fs.existsSync(path.join(root, "packages", "ai", "src", "auth-storage.ts"))) {
	console.error("usage: bun scripts/ccw-selftest.ts [<path-to-oh-my-pi-checkout>]");
	process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-src-selftest-"));
// Nothing may reach the real agent directory, even through a default path.
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
delete process.env.PI_PROFILE;

type Check = { name: string; run: () => void | Promise<void> };
const checks: Check[] = [];
const check = (name: string, run: () => void | Promise<void>) => checks.push({ name, run });
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
// A check that names its own precondition as absent, rather than failed.
class Skip extends Error {}

function runGlob(glob: string, env: string): void {
	const tests = new Bun.Glob(glob);
	const files = [...tests.scanSync({ cwd: root })];
	assert(files.length > 0, `this tree has no ${glob}`);
	// Apply runs this first in a freshly built tree, where a first test or hook took 5.7 to 8.6 s
	// against bun's 5 s default, and 1.4 s once warm.
	const run = Bun.spawnSync(["bun", "test", "--timeout", "30000", ...files.map(file => `./${file}`)], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, env) },
	});
	const out = `${run.stdout.toString()}${run.stderr.toString()}`;
	assert(
		run.exitCode === 0,
		`bun test ${files.join(" ")} exited ${run.exitCode}:\n${out.split("\n").slice(-25).join("\n")}`,
	);
}

// Credential-storage behavior (migration, resolution, pinning, removal, revival, the request
// path) is a fork test. A rebase that drops the file would lose the coverage with no error, so
// the tree's own test runs here too.
check("the fork's credential tests pass in this tree", () => {
	runGlob("packages/ai/test/ccw-credentials.test.ts", "credential-tests");
});

// The mailbox is built into the fork (packages/coding-agent/src/mailbox), and sdk.ts binds it
// in every session, a task child included. Same rationale as the credential check above.
check("the built-in mailbox passes its own tests in this tree", () => {
	runGlob("packages/coding-agent/test/mailbox-*.test.ts", "mailbox-tests");
});

// /agent-profile is built into the fork (packages/coding-agent/src/agent-profile), and sdk.ts
// binds it in every session, a task child included. A rebase that drops either hunk would lose
// the per-agent binding with no error, so the tree's own agent-profile tests run here.
check("the built-in agent-profile extension passes its own tests in this tree", () => {
	runGlob("packages/coding-agent/test/agent-profile-*.test.ts", "agent-profile-tests");
});

// The fork's schema V9 (label, is_default) owns version 9 only while upstream stops at 8. An
// upstream V9 would read the fork's recorded 9 as current and skip its own migration.
check("the upstream release this tree sits on still stops auth schema at version 8", () => {
	const git = (...args: string[]) => {
		const run = Bun.spawnSync(["git", "-C", root, ...args]);
		assert(run.exitCode === 0, `git ${args.join(" ")}: ${run.stderr.toString().trim()}`);
		return run.stdout.toString();
	};
	const tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*").trim();
	const source = git("show", `${tag}:packages/ai/src/auth/sqlite-credential-store.ts`);
	const version = Number(/const AUTH_SCHEMA_VERSION = (\d+);/.exec(source)?.[1]);
	assert(Number.isInteger(version), `${tag} names no AUTH_SCHEMA_VERSION`);
	assert(
		version < 9,
		`${tag} ships auth schema ${version}, so the fork's V9 collides: renumber the fork's migration above it`,
	);
});

// The fork's own knowledge bundle (moved from ccw's, 2026-09-26) must stay conformant. Skipped
// where neither okfrules nor the bundle exists, so a tree with no bundle yet does not fail here.
check("the fork's knowledge bundle passes okfrules", () => {
	if (!fs.existsSync(path.join(root, "knowledge"))) {
		throw new Skip("this tree has no knowledge/");
	}
	const whichRun = Bun.spawnSync(["which", "okfrules"]);
	const okfrules = fs.existsSync(path.join(os.homedir(), "go", "bin", "okfrules"))
		? path.join(os.homedir(), "go", "bin", "okfrules")
		: whichRun.exitCode === 0
			? whichRun.stdout.toString().trim()
			: "";
	if (!okfrules) {
		throw new Skip("okfrules is not installed");
	}
	const run = Bun.spawnSync([okfrules, "-strict", "check", "-Werror", "knowledge"], { cwd: root });
	const out = `${run.stdout.toString()}${run.stderr.toString()}`;
	assert(
		run.exitCode === 0,
		`okfrules -strict check -Werror knowledge exited ${run.exitCode}:\n${out.split("\n").slice(-25).join("\n")}`,
	);
});

let failed = 0;
let skipped = 0;
for (const { name, run } of checks) {
	try {
		await run();
		console.log(`PASS ${name}`);
	} catch (error) {
		if (error instanceof Skip) {
			skipped += 1;
			console.log(`SKIP ${name}: ${error.message}`);
			continue;
		}
		failed += 1;
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
fs.rmSync(tmp, { recursive: true, force: true });
const ran = checks.length - skipped;
console.log(failed === 0 ? `selftest: all ${ran} checks passed` : `selftest: ${failed} of ${ran} failed`);
process.exit(failed === 0 ? 0 : 1);

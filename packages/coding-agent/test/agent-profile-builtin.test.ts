// The built-in /agent-profile profiles, ported from ccw's internal/policy/omp_test.go
// (claude-code-workflows): TestEveryBuiltinAgentProfileBindsTheFiveBundledAgentsAtALevelItsModelLists
// and TestTheExpensiveModelsListNamesTheFlagshipsOnly. Read against the real embedded
// builtin-profiles.yml, not a fixture, because these checks exist to catch a mistake in that
// file itself.
import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "../src/task/agents";

// Bun.YAML.parse gives back the same shape loadBuiltin() reads. Parsed directly here, rather than
// through the extension, because these checks are about the file's own content and not about
// what a session does with it.
const builtinYaml = await Bun.file(new URL("../src/agent-profile/builtin-profiles.yml", import.meta.url)).text();
const parsed = Bun.YAML.parse(builtinYaml) as {
	defaultProfile: string;
	descriptions: Record<string, string>;
	profiles: Record<string, Record<string, Record<string, string>>>;
	expensiveModels: string[];
};

describe("the built-in profiles bind every bundled agent at a level its model lists", () => {
	it("defaultProfile names a built-in profile", () => {
		expect(parsed.profiles[parsed.defaultProfile]).toBeDefined();
	});

	// The step 3 spawn-grant tier reads this list case-insensitively against a bare model id
	// (after `provider/`), so a level outside the model's own catalog range would silently clamp
	// and the profile would not run what it says.
	const levels: Record<string, string[]> = {
		"anthropic/claude-haiku-4-5": ["off", "minimal", "low", "medium", "high", "xhigh"],
		"anthropic/claude-sonnet-5": ["off", "low", "medium", "high", "xhigh", "max"],
		"anthropic/claude-opus-5-5": ["off", "low", "medium", "high", "xhigh", "max"],
	};

	// Every bundled agent `loadBundledAgents()` returns, not a hardcoded list: a new bundled
	// agent with no row in a built-in profile is exactly the gap this test exists to catch.
	const bundled = loadBundledAgents().map(agent => agent.name);

	for (const name of Object.keys(parsed.profiles)) {
		const profile = parsed.profiles[name];
		it(`${name} has a description`, () => {
			expect(parsed.descriptions[name]).toBeTruthy();
		});
		it(`${name} binds exactly the bundled agents`, () => {
			expect(Object.keys(profile).sort()).toEqual([...bundled].sort());
		});
		for (const agent of bundled) {
			it(`${name}.${agent} names a known model at a level that model lists`, () => {
				const row = profile[agent];
				expect(row).toBeDefined();
				const allowed = levels[row.model];
				expect(allowed).toBeDefined();
				expect(allowed).toContain(row.thinking);
			});
		}
	}
});

describe("the expensive models list names the flagships only", () => {
	it("expensiveModels is not empty", () => {
		expect(parsed.expensiveModels.length).toBeGreaterThan(0);
	});

	const patterns = parsed.expensiveModels.map(pattern => new RegExp(pattern, "i"));
	const matches = (id: string) => patterns.some(pattern => pattern.test(id));

	it("compiles every pattern", () => {
		for (const pattern of parsed.expensiveModels) {
			expect(() => new RegExp(pattern, "i")).not.toThrow();
		}
	});

	for (const id of [
		"deepseek-v4-pro",
		"kimi-k3",
		"moonshotai/kimi-k3",
		"glm-5.3",
		"z-ai/glm-5.3",
		"claude-opus-5-5",
	]) {
		it(`${id} matches the expensive list`, () => {
			expect(matches(id)).toBe(true);
		});
	}

	for (const id of ["deepseek-v4-flash", "kimi-k2.7-code", "glm-5.3-flash", "claude-sonnet-5"]) {
		it(`${id} does not match the expensive list`, () => {
			expect(matches(id)).toBe(false);
		});
	}
});

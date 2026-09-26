// H1-H6, M1, K1: the registerAgentBindings provider that backs /agents, and the migration of
// config.yml entries into the applied mapping. Ported from ccw's internal/policy/omp_test.go
// (claude-code-workflows).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/all-settings";
import { resetSettingsForTest, settings, Settings } from "../src/config/settings";
import type { AgentBindingChange, ExtensionContext, ExtensionFactory } from "../src/extensibility/extensions";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "../src/task/settings";
import { makeAuthStorage, makeCtx, makePi, spawn } from "./helpers/agent-profile-harness";

const BUILTIN_YAML = `defaultProfile: tiered
profiles:
  tiered:
    scout: { model: anthropic/claude-haiku-4-5, thinking: low, prewalk: "off", advisor: "off" }
    sonic: { model: anthropic/claude-haiku-4-5, thinking: "off", prewalk: "off", advisor: "off" }
    task: { model: anthropic/claude-sonnet-5, thinking: medium, prewalk: "off", advisor: "off" }
    reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
    security-reviewer: { model: anthropic/claude-opus-5-5, thinking: xhigh, prewalk: "off", advisor: "off" }
`;
const CUSTOM_YAML = `profiles:
  split:
    reviewer: { model: anthropic/claude-opus-5, account: "b@example.com", thinking: xhigh }
    scout: { model: anthropic/claude-opus-5, account: "#1", thinking: medium }
    sonic: { model: deepseek/deepseek-flash, thinking: off }
  knobs:
    reviewer: { model: anthropic/claude-opus-5, prewalk: "off", advisor: "anthropic/claude-sonnet-5", serviceTier: priority }
    scout: { prewalk: "on" }
    disabled: [sonic]
`;

let agentDir: string;

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

const handPath = () => join(agentDir, "ccw-agent-profiles.yml");

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-profile-hub-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(handPath(), CUSTOM_YAML);
	resetSettingsForTest();
	await Settings.init({ inMemory: true, agentDir });
});

afterEach(() => {
	resetSettingsForTest();
	rmSync(agentDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("H1-H6: /agents hub bindings", () => {
	it("H1: a fuzzy pattern resolves to one model and names both; a pattern resolving to nothing writes nothing", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", parentCtx);

		const h1 = (await parent.bindings!.save(
			{ agent: "task", property: "model", value: "sonnet" } as AgentBindingChange,
			parentCtx,
		)) as {
			ok: boolean;
			notice: string;
		};
		expect(h1.ok).toBe(true);
		expect(h1.notice).toContain('resolved from "sonnet"');
		const written = Bun.YAML.parse(readFileSync(handPath(), "utf8")) as {
			assign?: { profiles?: Record<string, Record<string, unknown>> };
		};
		expect((written.assign?.profiles?.tiered?.task as string) || "").toContain("anthropic/claude-sonnet-5");

		const before = readFileSync(handPath(), "utf8");
		const h1Nope = (await parent.bindings!.save(
			{ agent: "task", property: "model", value: "nope" } as AgentBindingChange,
			parentCtx,
		)) as {
			ok: boolean;
		};
		expect(h1Nope.ok).toBe(false);
		expect(readFileSync(handPath(), "utf8")).toBe(before);
	});

	it("H3: an /agents edit that the one-binding rule refuses is put back byte for byte", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);
		const before = readFileSync(handPath(), "utf8");

		const h3 = (await parent.bindings!.save(
			{ agent: "scout", property: "prewalk", value: "on" } as AgentBindingChange,
			parentCtx,
		)) as {
			ok: boolean;
			notice: string;
		};
		expect(h3.ok).toBe(false);
		expect(h3.notice).toContain("must be off");
		expect(readFileSync(handPath(), "utf8")).toBe(before);
		const scoutDescribed = parent.bindings!.describe("scout", parentCtx);
		expect(scoutDescribed).not.toContain("refused");
	});

	it("H4: the credential line names the mapping, the credential and the layer", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("split", parentCtx);
		const line = parent.bindings!.describe("reviewer", parentCtx) as string;
		expect(line.startsWith("split · anthropic: ")).toBe(true);
		expect(line).toContain("b@example.com");
		expect(line.endsWith(" · hand")).toBe(true);
	});

	it("H5: under off, /agents keeps this fork's own config.yml write, and the extension writes nothing", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("off", parentCtx);
		const before = readFileSync(handPath(), "utf8");
		const h5 = await parent.bindings!.save(
			{ agent: "scout", property: "model", value: "sonnet" } as AgentBindingChange,
			parentCtx,
		);
		expect(h5).toBeUndefined();
		expect(readFileSync(handPath(), "utf8")).toBe(before);
	});

	it("H6: enable and disable stay machine-wide in config.yml, and write no mapping file", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", parentCtx);
		const before = readFileSync(handPath(), "utf8");

		const h6 = (await parent.bindings!.save(
			{ agent: "sonic", property: "disabled", disabled: true } as AgentBindingChange,
			parentCtx,
		)) as {
			ok: boolean;
		};
		expect(h6.ok).toBe(true);
		expect(cfgTaskDisabledAgents.get(settings)).toEqual(["sonic"]);
		await parent.bindings!.save(
			{ agent: "sonic", property: "disabled", disabled: false } as AgentBindingChange,
			parentCtx,
		);
		expect(cfgTaskDisabledAgents.get(settings)).toEqual([]);
		expect(readFileSync(handPath(), "utf8")).toBe(before);
	});
});

describe("K1: the four knobs land from the profile alone", () => {
	it("prewalk, advisor, serviceTier and disabledAgents apply and off drops them", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("knobs", parentCtx);
		expect(cfgTaskDisabledAgents.get(settings)).toEqual(["sonic"]);
		const spawnResult = await spawn(parent, "sonic", parentCtx);
		expect(spawnResult).toBe("undefined"); // disabled: neither refused nor rewritten by this hook

		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("off", parentCtx);
		expect(cfgTaskDisabledAgents.get(settings)).toEqual([]);
	});
});

describe("M1: config.yml entries move into the applied mapping", () => {
	it("an entry that repeats the binding is dropped, and one that does not is moved", async () => {
		const factory = await freshExtension();
		const auth = makeAuthStorage();
		const notices: string[] = [];
		const parent = makePi(factory);
		const parentCtx = makeCtx("parent", null, auth, notices);
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", parentCtx);
		const tieredReviewer = cfgTaskAgentModelOverrides.get(settings).reviewer;

		// Simulate /agents having written directly into config.yml: scout gets a new model, and
		// reviewer repeats what tiered already binds. inMemory Settings never touch disk, so the
		// real file that migrateGenerated backs up is written by hand here.
		writeFileSync(join(agentDir, "config.yml"), "theme: dark\n");
		cfgTaskAgentModelOverrides.set(settings, { scout: "anthropic/claude-sonnet-5:high", reviewer: tieredReviewer });
		const noticesBefore = notices.length;
		await (parent.command!.handler as (a: string, c: ExtensionContext) => Promise<void>)("tiered", parentCtx);

		const migratedHand = Bun.YAML.parse(readFileSync(handPath(), "utf8")) as {
			assign?: { profiles?: Record<string, Record<string, unknown>> };
		};
		const migratedRows = migratedHand.assign?.profiles?.tiered ?? {};
		expect(migratedRows.scout).toEqual({ model: "anthropic/claude-sonnet-5", thinking: "high" });
		expect(migratedRows.reviewer).toBeUndefined();

		// config.yml's own record is empty afterward: both entries left it, dropped or moved.
		const globalTask =
			(settings.getGlobalSettings().task as { agentModelOverrides?: Record<string, unknown> } | undefined) ?? {};
		expect(Object.keys(globalTask.agentModelOverrides ?? {}).includes("scout")).toBe(false);
		// A backup of config.yml was written before the migration.
		const backups = readdirSync(agentDir).filter(name => name.startsWith("config.yml.bak-"));
		expect(backups.length).toBeGreaterThan(0);
		expect(notices.slice(noticesBefore).some(n => n.startsWith("info: moved "))).toBe(true);

		const migratedSpawn = (await spawn(parent, "scout", parentCtx)) as { model: string };
		expect(migratedSpawn.model).toBe("anthropic/claude-sonnet-5:high");
	});
});

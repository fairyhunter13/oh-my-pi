import * as os from "node:os";
import { beforeAll, describe, expect, it } from "bun:test";
import type { DailyActivityPoint } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildCredentialCard,
	buildHeatmapLayout,
	formatActivityErrorDetail,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests };
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	accountId: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${accountId}:${windowId}`,
		label,
		scope: { provider, accountId, windowId },
		window: { id: windowId, label: windowId, resetsAt },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

describe("buildHeatmapLayout", () => {
	// 2026-08-31 is a Monday; keeps week alignment deterministic.
	const monday = new Date(2026, 7, 31, 12);

	it("aligns days Monday-first and marks future days null", () => {
		const layout = buildHeatmapLayout([day("2026-08-31", 5)], 2, monday);
		// Monday row, last column = today's week.
		expect(layout.cells[0][1]).toBe(4);
		// Tuesday..Sunday of the current week are in the future.
		for (let row = 1; row < 7; row++) expect(layout.cells[row][1]).toBeNull();
		// Previous week is fully in range but has no activity.
		for (let row = 0; row < 7; row++) expect(layout.cells[row][0]).toBe(0);
	});

	it("scales intensity by magnitude against the busiest day, not by rank", () => {
		const points = [
			day("2026-08-24", 100), // max → level 4
			day("2026-08-25", 30), // sqrt(0.3)≈0.55 → level 3
			day("2026-08-26", 6), // sqrt(0.06)≈0.24 → level 1
			day("2026-08-27", 0), // untouched → level 0
		];
		const layout = buildHeatmapLayout(points, 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(3);
		expect(layout.cells[2][0]).toBe(1);
		expect(layout.cells[3][0]).toBe(0);
	});

	it("falls back to request counts when nothing in range is priced", () => {
		const layout = buildHeatmapLayout([day("2026-08-24", 0, 50), day("2026-08-25", 0, 3)], 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(1);
		expect(layout.totalRequests).toBe(53);
	});

	it("labels a column when its week starts a new month", () => {
		// 6 weeks back from 2026-08-31 spans the July→August boundary.
		const layout = buildHeatmapLayout([], 6, monday);
		expect(layout.monthLabels[0]).toBe("Jul");
		expect(layout.monthLabels.filter(Boolean)).toEqual(["Jul", "Aug"]);
	});
});

describe("buildCredentialCard", () => {
	const now = Date.now();

	it("keeps this credential's own fraction, status and reset for each window", () => {
		const exhausted = report("anthropic", "a@x.test", [
			limit("anthropic", "a", "7d", "Claude 7 Day", 1.0, "exhausted", now + 1000),
		]);
		const card = buildCredentialCard(exhausted, now);
		expect(card.windows).toHaveLength(1);
		expect(card.windows[0].fraction).toBe(1.0);
		expect(card.windows[0].status).toBe("exhausted");
		expect(card.windows[0].resetMs).toBe(1000);
	});

	it("collapses to a tick when every window is untouched", () => {
		const idle = report("anthropic", "a@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 0, "ok")]);
		expect(buildCredentialCard(idle, now).idle).toBe(true);

		const active = report("anthropic", "a@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 0.4, "ok")]);
		expect(buildCredentialCard(active, now).idle).toBe(false);
	});

	it("marks a credential with no limits as unlimited", () => {
		const unlimited = report("ollama-cloud", "l@x.test", []);
		const card = buildCredentialCard(unlimited, now);
		expect(card.unlimited).toBe(true);
		expect(card.idle).toBe(true);
	});

	it("reads this credential's own reset inventory", () => {
		const claude = report("anthropic", "claude@example.test", [
			limit("anthropic", "claude", "5h", "Claude 5 Hour", 0, "ok"),
		]);
		claude.resetCredits = {
			availableCount: 3,
			redeemableCount: 2,
			credits: [
				{ id: "cedar", remainingCount: 3, expiresAt: new Date(now + 2 * 86_400_000).toISOString() },
				{ id: "spent", remainingCount: 0, expiresAt: new Date(now + 3_600_000).toISOString() },
			],
		};

		const card = buildCredentialCard(claude, now);

		expect(card.resetCredits).toEqual({
			bankedCount: 3,
			redeemableCount: 2,
			soonestExpiryMs: 2 * 86_400_000,
			unavailableReasons: [],
		});
		expect(card.idle).toBe(false);
	});

	it("shows a prepaid balance on the card instead of falling back to no data", () => {
		// Balance-only limits carry no fraction, so the card used to render the
		// literal "no data" for providers that sell prepaid credits.
		const balance = report("charm-hyper", "a@x.test", [
			{
				id: "charm-hyper:credits",
				label: "Credit balance",
				scope: { provider: "charm-hyper", windowId: "balance", shared: true },
				amount: { remaining: 100, unit: "credits" },
			},
		]);
		const card = buildCredentialCard(balance, now);
		expect(card.windows[0].usedText).toBe("100 credits left");
		expect(card.windows[0].fraction).toBeUndefined();
		expect(card.idle).toBe(false);
	});

	it("shows each marked shared quota once without merging independent buckets", () => {
		const sharedLimit = (counter: "anthropic" | "openai", windowId: "5h" | "7d") => {
			const value = limit("google-antigravity", "account", windowId, "Claude & GPT (shared)", 0.25, "ok");
			return {
				...value,
				id: `google-antigravity:${counter}:default:3p-${windowId}`,
				scope: { ...value.scope, shared: true, sharedGroup: `3p-${windowId}` },
			};
		};
		const antigravity = report("google-antigravity", "user@example.test", [
			limit("google-antigravity", "account", "5h", "Gemini", 0.25, "ok"),
			limit("google-antigravity", "account", "7d", "Gemini", 0.25, "ok"),
			sharedLimit("anthropic", "5h"),
			sharedLimit("openai", "5h"),
			sharedLimit("anthropic", "7d"),
			sharedLimit("openai", "7d"),
		]);

		const windows = buildCredentialCard(antigravity, now).windows;

		expect(windows.map(window => `${window.label} — ${window.windowTag}`).sort()).toEqual([
			"Claude & GPT (shared) — 5h",
			"Claude & GPT (shared) — 7d",
			"Gemini — 5h",
			"Gemini — 7d",
		]);
	});
});
describe("UsageDashboardComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	function dashboard(usageReport: UsageReport): UsageDashboardComponent {
		return new UsageDashboardComponent({
			report: usageReport,
			credentialLabel: "Work (#1)",
			renderDetail: () => "",
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => {},
			onClose: () => {},
		});
	}

	it("keeps usable bars and matching label rows for the credential's windows", () => {
		const component = dashboard(
			report("anthropic", "a@test", [
				limit("anthropic", "a", "7d", "Claude 7 Day", 0.9, "warning"),
				limit("anthropic", "a", "fable", "Claude 7 Day (Fable)", 0.16, "ok"),
			]),
		);
		try {
			const lines = component.render(72).map(line => Bun.stripANSI(line));
			const labelLine = lines.find(line => line.includes("Claude 7 Day"))!;
			expect(labelLine).toBeDefined();
			const quotaLines = lines.filter(line => /[█░]/.test(line));
			expect(quotaLines).toHaveLength(2);
			expect(quotaLines[0]).toContain("10%");
			expect(quotaLines[1]).toContain("84%");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		} finally {
			component.dispose();
		}
	});

	it("shows the exhausted icon even when an absolute-only exhausted window sorts last (F8)", () => {
		const withHiddenExhaustion = report("anthropic", "a@test", [
			limit("anthropic", "a", "7d", "Claude 7 Day", 0.5, "ok"),
			{
				id: "anthropic:a:extra",
				label: "Claude Extra Usage",
				scope: { provider: "anthropic", accountId: "a", windowId: "extra" },
				amount: { used: 12.34, unit: "usd" },
				status: "exhausted",
			},
		]);
		const card = buildCredentialCard(withHiddenExhaustion, Date.now());
		// The absolute-only exhausted window has no fraction, so the
		// most-pressing-first sort puts it after the 50%-used fraction window.
		expect(card.windows[0].status).toBe("ok");
		expect(card.windows[1].status).toBe("exhausted");

		const component = dashboard(withHiddenExhaustion);
		try {
			const lines = component.render(72).map(line => Bun.stripANSI(line));
			expect(lines.some(line => line.includes(theme.status.error))).toBe(true);
			expect(lines.some(line => line.includes(theme.status.success))).toBe(false);
		} finally {
			component.dispose();
		}
	});

	it("sanitizes provider labels and duplicate-window tags before rendering", () => {
		const label = "Claude\t7 Day\x1b[2J\x07\r\n(Fable)";
		const component = dashboard(
			report("anthropic", "a@test", [
				limit("anthropic", "a", "5\th", label, 0.4, "ok"),
				limit("anthropic", "a", "7\nd", label, 0.2, "ok"),
			]),
		);
		try {
			const lines = component.render(100);
			for (const line of lines) {
				expect(line).not.toMatch(/[\t\r\n\x07]/);
				expect(line).not.toContain("\x1b[2J");
				expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			}
			const output = Bun.stripANSI(lines.join("\n"));
			expect(output).toMatch(/Claude +7 Day +\(Fable\)/);
			expect(output).toMatch(/5 +h/);
			expect(output).toMatch(/7 +d/);
		} finally {
			component.dispose();
		}
	});

	it("bounds long quota labels while retaining suffixes and sibling bar alignment", () => {
		const prefix = `Weekly ${"extended thinking ".repeat(1000)}`;
		const component = dashboard(
			report("anthropic", "a@test", [
				limit("anthropic", "a", "fable", `${prefix}(Fable)`, 0.9, "warning"),
				limit("anthropic", "a", "mythos", `${prefix}(Mythos)`, 0.16, "ok"),
			]),
		);
		try {
			const lines = component.render(72).map(line => Bun.stripANSI(line));
			for (const suffix of ["(Fable)", "(Mythos)"]) expect(lines.join("\n")).toContain(suffix);
			const starts = lines.flatMap((line, index) => (line.includes("Weekly extended") ? [index] : []));
			const bars = lines.flatMap((line, index) => (/[█░]/.test(line) ? [index] : []));
			expect(starts).toHaveLength(2);
			expect(bars).toHaveLength(2);
			for (let index = 0; index < bars.length; index++) {
				expect(bars[index] - starts[index]).toBeLessThanOrEqual(2);
			}
			expect(lines.join("\n")).toContain("…");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		} finally {
			component.dispose();
		}
	});

	it("keeps all label characters when they fit the two-line cell budget", () => {
		const label = "Claude 7 Day (Extended Thinking)";
		const component = dashboard(report("anthropic", "a@test", [limit("anthropic", "a", "7d", label, 0.4, "ok")]));
		try {
			const lines = component.render(24).map(line => Bun.stripANSI(line));
			const first = lines.findIndex(line => line.includes("Claude"));
			const bar = lines.findIndex(line => /[█░]/.test(line));
			expect(bar - first).toBeLessThanOrEqual(2);
			expect(
				lines
					.slice(first, bar)
					.join("")
					.replace(/[│\s]/g, ""),
			).toBe(label.replace(/\s/g, ""));
		} finally {
			component.dispose();
		}
	});

	it("keeps quota names distinguishable beside or above their bars", async () => {
		const now = Date.now();
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			report: report("anthropic", "user@example.test", [
				limit("anthropic", "account", "7d", "Claude 7 Day", 1, "exhausted", now + 3_600_000),
				limit("anthropic", "account", "fable", "Claude 7 Day (Fable)", 0.16, "ok", now + 3_600_000),
				limit("anthropic", "account", "extra", "Claude Extra Usage", 0.05, "ok"),
			]),
			credentialLabel: "Work (#1)",
			renderDetail: () => "",
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => markRendered(),
			onClose: () => {},
		});
		try {
			await rendered;
			for (const width of [36, 60]) {
				const lines = component.render(width);
				const output = Bun.stripANSI(lines.join("\n"));
				expect(output).toContain("Claude 7 Day (Fable)");
				expect(output).toContain("Claude Extra Usage");
				expect(output).toContain("84%");
				expect(output).toContain("95%");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});
	it("renders specific error reason when activity loading fails instead of generic DB read error", async () => {
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			report: report("anthropic", "user@example.test", []),
			credentialLabel: "Work (#1)",
			renderDetail: () => "",
			loadActivity: () => Promise.reject(new Error("worker spawn failed")),
			requestRender: () => markRendered(),
			onClose: () => {},
		});

		await rendered;
		const lines = component.render(80).join("\n");
		expect(lines).toContain("Usage history unavailable (worker spawn failed).");
		expect(lines).not.toContain("stats database could not be read");
	});
	it("sanitizes control sequences, collapses multiline errors, and shortens paths", async () => {
		const home = os.homedir();
		const rawError = `subprocess crashed at ${home}/.omp/stats.db:\n\tfailed to open\x1b[2J\r\nline 2\x1b[31m...`;
		const { promise: rendered, resolve: markRendered } = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			report: report("anthropic", "user@example.test", []),
			credentialLabel: "Work (#1)",
			renderDetail: () => "",
			loadActivity: () => Promise.reject(new Error(rawError)),
			requestRender: () => markRendered(),
			onClose: () => {},
		});

		await rendered;
		const renderedLines = component.render(140);
		const contentLine = renderedLines.find(l => l.includes("Usage history unavailable"));
		expect(contentLine).toBeDefined();
		expect(contentLine).not.toContain("\x1b[2J");
		expect(contentLine).not.toContain("\n");
		expect(contentLine).not.toContain("\t");
		expect(contentLine).not.toContain(home);
		expect(contentLine).toContain("~/.omp/stats.db");
		expect(contentLine).toContain(
			"Usage history unavailable (subprocess crashed at ~/.omp/stats.db: failed to open line 2).",
		);
	});
});

describe("formatActivityErrorDetail", () => {
	it("strips ANSI control sequences and collapses multiline error text to single line", () => {
		const input = "worker spawn failed\ntrace\x1b[2J\r\n\tsecond line";
		expect(formatActivityErrorDetail(input)).toBe("worker spawn failed trace second line");
	});

	it("shortens home directory paths to tilde and removes trailing dots", () => {
		const home = "/Users/testuser";
		const input = `Error: failed to open ${home}/.omp/stats.db...`;
		expect(formatActivityErrorDetail(input, home)).toBe("Error: failed to open ~/.omp/stats.db");
	});
});

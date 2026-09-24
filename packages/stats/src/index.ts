#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import { getDashboardStats, getTotalMessageCount, syncAllSessions } from "./aggregator";
import { closeDb, listStatsCredentials } from "./db";
import { formatStatsDashboardUrl, startServer } from "./server";
import { formatStatsCredential, parseStatsCredential, type StatsCredential } from "./shared-types";

export {
	getDashboardStats,
	getToolDashboardStats,
	getTotalMessageCount,
	type SyncOptions,
	type SyncProgress,
	smokeTestSyncWorker,
	syncAllSessions,
} from "./aggregator";
export { closeDb } from "./db";
export { getGainDashboardStats } from "./gain-aggregator";
export { formatStatsDashboardUrl, startServer } from "./server";
export type { GainDashboardStats, GainSource, GainSourceTotals, GainTimeSeriesPoint } from "./shared-types";
export { formatStatsCredential, parseStatsCredential } from "./shared-types";
export type { DailyActivityPoint, StatsCredential } from "./shared-types";
export type {
	AggregatedStats,
	DashboardStats,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
	ToolDashboardStats,
	ToolModelStats,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

/** Format an API-equivalent estimate in dollars, or N/A for unpriced usage. */
function formatCost(n: number, unpricedRequests = 0): string {
	if (n === 0 && unpricedRequests > 0) return "N/A";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the one credential the standalone CLI acts on: the `--credential`
 * flag when given, else the sole candidate `messages` holds. With more than
 * one candidate and no flag, print the choices and exit(2) rather than
 * silently merging them into one view.
 */
function resolveStandaloneCredential(credentialArg: string | undefined): StatsCredential {
	const parsed = parseStatsCredential(credentialArg);
	if (parsed) return parsed;
	if (credentialArg !== undefined) {
		console.error(`"${credentialArg}" is not "<provider>:<id>" or "<provider>:none".`);
		process.exit(2);
	}
	const candidates = listStatsCredentials();
	if (candidates.length === 1) return candidates[0];
	console.error("Pick a credential with --credential <provider>:<id|none>:");
	for (const candidate of candidates) {
		console.error(`  ${formatStatsCredential(candidate)}  (${candidate.requests} requests)`);
	}
	process.exit(2);
}

/**
 * Print stats summary to console.
 */
async function printStats(credential: StatsCredential): Promise<void> {
	const stats = await getDashboardStats(credential);
	const { overall, byModel, byFolder } = stats;

	console.log("\n=== AI Usage Statistics ===\n");

	console.log("Overall:");
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Cache Savings: ${formatPercent(overall.cacheSavings)}`);
	console.log(`  API-equivalent estimate: ${formatCost(overall.totalCost, overall.unpricedRequests)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log("\nBy Model (API-equivalent estimates):");
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost, m.unpricedRequests)}, ${formatPercent(m.cacheRate)} cache rate, ${formatPercent(m.cacheSavings)} cache savings`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log("\nBy Folder (API-equivalent estimates):");
		for (const f of byFolder.slice(0, 10)) {
			console.log(
				`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost, f.unpricedRequests)}`,
			);
		}
	}

	console.log("");
}

/** Parsed arguments for the standalone `omp-stats` entry point. */
export interface StandaloneStatsArgs {
	port: number;
	host: string;
	json: boolean;
	sync: boolean;
	help: boolean;
	credential?: string;
}

/** Parse the standalone `omp-stats` arguments used by the production entry point. */
export function parseStandaloneStatsArgs(args: string[]): StandaloneStatsArgs {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string", short: "p", default: "3847" },
			host: { type: "string", default: "127.0.0.1" },
			json: { type: "boolean", short: "j", default: false },
			sync: { type: "boolean", short: "s", default: false },
			help: { type: "boolean", short: "h", default: false },
			credential: { type: "string", short: "c" },
		},
		allowPositionals: true,
	});
	return {
		port: parseInt(values.port || "3847", 10),
		host: values.host || "127.0.0.1",
		json: values.json ?? false,
		sync: values.sync ?? false,
		help: values.help ?? false,
		credential: values.credential,
	};
}

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
	const values = parseStandaloneStatsArgs(process.argv.slice(2));

	if (values.help) {
		console.log(`
omp-stats - AI Usage Statistics Dashboard

Usage:
  omp-stats [options]

Options:
  -p, --port <port>  Port for the dashboard server (default: 3847)
  --host <host>       Host to bind (default: 127.0.0.1)
  -j, --json         Output stats as JSON and exit
  -s, --sync         Sync session files and show summary
  -h, --help         Show this help message

Examples:
  omp-stats              # Start dashboard server
  omp-stats --json       # Print stats as JSON
  omp-stats --host 0.0.0.0 # Explicitly expose on all IPv4 interfaces
  omp-stats --sync       # Sync and show summary
`);
		return;
	}

	try {
		// Sync first
		const tty = process.stderr.isTTY === true;
		process.stderr.write("Syncing session files...\n");
		let lastWidth = 0;
		let lastRender = 0;
		const { processed, files } = await syncAllSessions({
			onProgress: event => {
				if (!tty) return;
				const now = Date.now();
				if (event.current < event.total && now - lastRender < 33) return;
				lastRender = now;
				const marker = "/sessions/";
				const idx = event.sessionFile.indexOf(marker);
				const short = idx >= 0 ? event.sessionFile.slice(idx + marker.length) : event.sessionFile;
				const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
				const line = `[${event.current}/${event.total}] ${pct}%  ${short}`;
				const columns = process.stderr.columns ?? 120;
				const clipped = line.length > columns - 1 ? `${line.slice(0, columns - 2)}\u2026` : line;
				process.stderr.write(`\r${clipped.padEnd(lastWidth)}`);
				lastWidth = clipped.length;
			},
		});
		if (tty && lastWidth > 0) process.stderr.write(`\r${" ".repeat(lastWidth)}\r`);
		const total = await getTotalMessageCount();
		console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

		if (values.json) {
			const credential = resolveStandaloneCredential(values.credential);
			const stats = await getDashboardStats(credential);
			console.log(JSON.stringify(stats, null, 2));
			return;
		}

		if (values.sync) {
			const credential = resolveStandaloneCredential(values.credential);
			await printStats(credential);
			return;
		}

		// Start server
		const { port: actualPort } = await startServer(values.port, values.host);
		console.log(`Dashboard available at: ${formatStatsDashboardUrl(values.host, actualPort)}`);
		console.log("Press Ctrl+C to stop\n");

		// Keep process running
		process.on("SIGINT", () => {
			console.log("\nShutting down...");
			closeDb();
			process.exit(0);
		});
	} catch (error) {
		console.error("Error:", error);
		closeDb();
		process.exit(1);
	}
}

// Run if executed directly
if (import.meta.main) {
	main();
}

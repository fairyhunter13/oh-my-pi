/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-renderer";
import type { StatsCredential } from "@oh-my-pi/omp-stats";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
	/** `<provider>:<id|none>`; with no flag and one candidate, that candidate is used. */
	credential?: string;
}

/**
 * Resolve the one credential `--json`/`--summary` acts on: the `--credential`
 * flag when given, else the sole candidate `messages` holds. With more than
 * one candidate and no flag, print the choices to stderr and set exit 2
 * rather than silently merging them into one view.
 */
async function resolveStatsCredential(credentialArg: string | undefined): Promise<StatsCredential | undefined> {
	// Lazy import to avoid loading stats module when not needed (matches runStatsCommand below).
	const { formatStatsCredential, parseStatsCredential } = await import("@oh-my-pi/omp-stats");
	const parsed = parseStatsCredential(credentialArg);
	if (parsed) return parsed;
	if (credentialArg !== undefined) {
		process.stderr.write(chalk.yellow(`"${credentialArg}" is not "<provider>:<id>" or "<provider>:none".\n`));
		process.exitCode = 2;
		return undefined;
	}
	const { listStatsCredentials } = await import("@oh-my-pi/omp-stats/db");
	const candidates = listStatsCredentials();
	if (candidates.length === 1) return candidates[0];
	process.stderr.write(chalk.yellow("Pick a credential with --credential <provider>:<id|none>:\n"));
	for (const candidate of candidates) {
		process.stderr.write(chalk.yellow(`  ${formatStatsCredential(candidate)}  (${candidate.requests} requests)\n`));
	}
	process.exitCode = 2;
	return undefined;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { closeDb, formatStatsDashboardUrl, getDashboardStats, getTotalMessageCount, startServer, syncAllSessions } =
		await import("@oh-my-pi/omp-stats");

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json || cmd.summary) {
		const credential = await resolveStatsCredential(cmd.credential);
		if (!credential) return;
		if (cmd.json) {
			const stats = await getDashboardStats(credential);
			console.log(JSON.stringify(stats, null, 2));
			return;
		}
		await printStatsSummary(credential);
		return;
	}

	// Start the dashboard server
	const { hostname, port } = await startServer(cmd.port, cmd.host);
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`Dashboard available at: ${url}`));

	// Open browser
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(credential: StatsCredential): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats(credential);
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Cache Savings: ${formatPercent(overall.cacheSavings)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache rate, ${formatPercent(m.cacheSavings)} cache savings`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

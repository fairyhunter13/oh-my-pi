import type { CredentialSummary, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AuthCredential, OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";
import { collapseSharedUsageReports, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { credentialName } from "@oh-my-pi/pi-tui/setup/scenes/credential-format";
import type { SlashCommandRuntime } from "../types";
import { formatCodexUsageReportLabel, reportMatchesActiveAccount } from "./active-oauth-account";
import { formatCoarseDuration, formatProviderName, renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

/** The ACP "no such credential" text — the TUI shows the identical warning (F7). */
export function usageTargetNotFoundText(target: string): string {
	return `No stored credential matches "${target}". List choices with \`/usage\`.`;
}

/**
 * Resolve `<provider>/<credential id>` or `<provider>/active` against a row
 * list. Shared by the ACP `/usage show` text and the TUI `/usage show`
 * command (F7), so both surfaces resolve one target the same way.
 */
export function resolveUsageRowByTarget(
	rows: readonly CredentialSummary[],
	target: string,
): CredentialSummary | undefined {
	const slash = target.indexOf("/");
	if (slash <= 0) return undefined;
	const providerId = target.slice(0, slash);
	const idPart = target
		.slice(slash + 1)
		.trim()
		.toLowerCase();
	return rows.find(candidate => {
		if (candidate.provider !== providerId) return false;
		if (idPart === "active") return candidate.active;
		return /^\d+$/.test(idPart) && candidate.id === Number(idPart);
	});
}

function formatWindowSuffix(label: string, windowLabel: string | undefined): string {
	if (!windowLabel) return "";
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window" || normalizedLabel.includes(normalizedWindow)) return "";
	return ` — ${windowLabel}`;
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const used = amount.used ?? (amount.usedFraction !== undefined ? amount.usedFraction * 100 : undefined);
	const remainingFraction =
		amount.remainingFraction ??
		(amount.usedFraction !== undefined ? Math.max(0, 1 - amount.usedFraction) : undefined);
	const unit = amount.unit === "percent" ? "%" : ` ${amount.unit}`;
	const usedText = used === undefined ? "unknown used" : `${used.toFixed(2)}${unit} used`;
	const remainingText = remainingFraction === undefined ? "" : ` (${(remainingFraction * 100).toFixed(1)}% left)`;
	return `${usedText}${remainingText}`;
}

function formatUsageReportAccount(
	report: UsageReport,
	peers: readonly UsageReport[],
	limit: UsageLimit,
	index: number,
): string {
	const codex = report.provider === "openai-codex";
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
	const label = (identity: string, includeOrg: boolean): string => {
		if (codex) return formatCodexUsageReportLabel(report, peers, identity);
		return includeOrg && typeof org === "string" && org && org !== identity ? `${identity} (${org})` : identity;
	};
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return label(email, true);
	// Empty metadata must not hide a valid scoped identity.
	const metaAccountId = report.metadata?.accountId;
	const accountId = typeof metaAccountId === "string" && metaAccountId ? metaAccountId : limit.scope.accountId;
	if (typeof accountId === "string" && accountId) return label(accountId, true);
	const metaProjectId = report.metadata?.projectId;
	const projectId = typeof metaProjectId === "string" && metaProjectId ? metaProjectId : limit.scope.projectId;
	return label(typeof projectId === "string" && projectId ? projectId : `account ${index + 1}`, false);
}

function renderUsageReports(
	reports: UsageReport[],
	nowMs: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
): string {
	const displayReports = collapseSharedUsageReports(reports);
	const latestFetchedAt = Math.max(...displayReports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatCoarseDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", formatProviderName(provider));
		const reportingModels = usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`));
		if (reportingModels.length > 0) {
			lines.push("  Models with usage data");
			for (const selector of reportingModels) lines.push(`    ${sanitizeText(selector)}`);
		}
		const activeAccount = resolveActiveAccount?.(provider);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes)
			lines.push(`  ${sanitizeText(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))}`);
		for (const report of providerReports) {
			const inUse = reportMatchesActiveAccount(report, activeAccount);
			const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
			if (resets && resets.bankedCount > 0) {
				const resetIdentity =
					typeof report.metadata?.email === "string"
						? report.metadata.email
						: typeof report.metadata?.accountId === "string"
							? report.metadata.accountId
							: "account";
				let resetLabel: string;
				if (report.provider === "openai-codex") {
					resetLabel = formatCodexUsageReportLabel(report, providerReports, resetIdentity);
				} else {
					const orgName = report.metadata?.orgName;
					const orgId = report.metadata?.orgId;
					const org =
						typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
					const raw = org && org !== resetIdentity ? `${resetIdentity} (${org})` : resetIdentity;
					resetLabel = sanitizeText(raw.replace(/[\r\n\t]+/g, " "));
				}
				const availability =
					resets.redeemableCount === resets.bankedCount ? "available" : `${resets.redeemableCount} usable now`;
				lines.push(
					`- ${resetLabel}: ${resets.bankedCount} saved rate-limit reset${resets.bankedCount === 1 ? "" : "s"} — ${availability} — /usage reset to spend`,
				);
				if (resets.soonestExpiry) {
					const expiryMs = Date.parse(resets.soonestExpiry);
					const remaining = expiryMs - nowMs;
					if (remaining > 0) {
						lines.push(
							`  soonest expires in ${formatCoarseDuration(remaining)} (${resets.soonestExpiry.slice(0, 10)})`,
						);
					} else {
						lines.push(`  expired (${resets.soonestExpiry.slice(0, 10)})`);
					}
				}
				if (resets.redeemableCount === 0 && resets.unavailableReason) {
					const reason = sanitizeText(resets.unavailableReason.replace(/[\r\n\t]+/g, " "));
					lines.push(`  unavailable: ${reason}`);
				}
			}
			if (report.limits.length === 0) {
				const email = typeof report.metadata?.email === "string" ? report.metadata.email : "account";
				const label =
					report.provider === "openai-codex" ? formatCodexUsageReportLabel(report, providerReports, email) : email;
				lines.push(`- ${label}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const window = limit.window?.label ?? limit.scope.windowId;
				// Skip the tier suffix when the label already names it (e.g. Anthropic's
				// "Claude 7 Day (Fable)" with scope.tier "fable") — mirrors limitTitle in usage-cli.
				const tier =
					limit.scope.tier && !limit.label.toLowerCase().includes(limit.scope.tier.toLowerCase())
						? ` (${limit.scope.tier})`
						: "";
				lines.push(`- ${limit.label}${tier}${formatWindowSuffix(limit.label, window)}`);
				lines.push(
					`  ${formatUsageReportAccount(report, providerReports, limit, index)}: ${formatUsageAmount(limit)}${inUse ? "  ← in use by this session" : ""}`,
				);
				lines.push(`  ${renderAsciiBar(limit.amount.usedFraction)}`);
				if (limit.window?.resetsAt && limit.window.resetsAt > nowMs) {
					lines.push(
						`  ${limit.window.resetLabel ?? "resets"} in ${formatCoarseDuration(limit.window.resetsAt - nowMs)}`,
					);
				}
				if (limit.notes && limit.notes.length > 0)
					lines.push(
						`  ${limit.notes.map(n => sanitizeText(n.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))).join(" • ")}`,
					);
			}
		}
	}
	return ["```", ...lines, "```"].join("\n");
}

/** The `OAuthAccountIdentity` of a stored OAuth credential row, or `undefined` for an API key. */
function identityOfStoredCredential(
	row: CredentialSummary,
	stored: StoredAuthCredential | undefined,
): OAuthAccountIdentity | undefined {
	const credential: AuthCredential | undefined = stored?.credential;
	if (row.kind !== "oauth" || credential?.type !== "oauth") return undefined;
	const identity: OAuthAccountIdentity = {};
	if (credential.accountId) identity.accountId = credential.accountId;
	if (credential.email) identity.email = credential.email;
	if (credential.projectId) identity.projectId = credential.projectId;
	if (credential.orgId) identity.orgId = credential.orgId;
	if (credential.orgName) identity.orgName = credential.orgName;
	return Object.keys(identity).length > 0 ? identity : undefined;
}

/** Local session-manager tallies: the fallback for a session with no usage support. */
function sessionTallyText(runtime: SlashCommandRuntime): string {
	const stats = runtime.session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Total tokens: ${stats.totalTokens}`,
		...(orchestrationTokens > 0 ? [`Orchestration tokens: ${orchestrationTokens}`] : []),
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}

/**
 * Build the `/usage` ACP-mode text. With no `arg`, lists every stored
 * credential with a usage endpoint. With `<provider>/<id|active>`, renders
 * only that credential's report. Falls back to the local session-manager
 * tallies for a session with no usage support at all.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime, arg = ""): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
		getUsageReportingModelSelectors?: (reports: readonly UsageReport[]) => string[];
	};
	if (!provider.fetchUsageReports) return sessionTallyText(runtime);

	const authStorage = runtime.session.modelRegistry.authStorage;
	const sessionId = runtime.session.sessionId;
	const rows = authStorage
		.listCredentials(undefined, sessionId)
		.filter(row => row.disabled === null && authStorage.usage.providerFor(row.provider) !== undefined);

	const target = arg.trim();
	if (!target) {
		if (rows.length === 0) return sessionTallyText(runtime);
		const lines = rows.map(
			row => `- ${credentialName(row)} [${row.provider}/${row.id}]${row.active ? " (active)" : ""}`,
		);
		lines.push("", "Show one with `/usage show <provider>/<credential id>` or `/usage show <provider>/active`.");
		return lines.join("\n");
	}

	const notFound = usageTargetNotFoundText(target);
	const row = resolveUsageRowByTarget(rows, target);
	if (!row) return notFound;

	const stored = authStorage.credentials.list(row.provider).find(entry => entry.id === row.id);
	if (!stored) return notFound;

	let report: UsageReport | null;
	try {
		report = await authStorage.usage.report(row.provider, stored.credential, {
			baseUrl: runtime.session.modelRegistry.getProviderBaseUrl(row.provider),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		return `Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!report) return `No usage data for ${credentialName(row)} (#${row.id}).`;

	const usageModelSelectors = provider.getUsageReportingModelSelectors?.([report]) ?? [];
	const identity = identityOfStoredCredential(row, stored);
	return renderUsageReports([report], Date.now(), () => identity, usageModelSelectors);
}

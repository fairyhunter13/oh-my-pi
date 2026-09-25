/**
 * Get the API key or OAuth token for a provider.
 */

import { type CredentialSummary, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { resolveCredentialTarget } from "../auth/credential-selector";
import { tokenHelp as commandHelp } from "../cli/command-help";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { refreshStoredManagedMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthCredentialProfile } from "../mcp/oauth-flow";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage, OAuthAccountSummary } from "../session/auth-storage";
import { getAvailableAuthMethods } from "../web/search/providers/perplexity-auth";

async function resolveManagedMcpOAuthToken(
	authStorage: AuthStorage,
	provider: string,
	options: { credentialId?: number; forceRefresh?: boolean } = {},
): Promise<string | undefined> {
	const row = authStorage.credentials
		.list(provider)
		.find(
			entry =>
				entry.credential.type === "oauth" &&
				(options.credentialId === undefined || entry.id === options.credentialId),
		);
	if (row?.credential.type !== "oauth") return undefined;
	const before = row.credential;
	const result = await refreshStoredManagedMcpOAuthCredential(authStorage, provider, {
		...options,
		recoverServerUrlFromCredentialId: true,
	});
	const credential = result.credential;
	if (!credential || Date.now() >= credential.expires) return undefined;
	if (
		options.forceRefresh &&
		!result.refreshed &&
		credential.access === before.access &&
		credential.refresh === before.refresh &&
		credential.expires === before.expires
	) {
		return undefined;
	}
	return credential.access;
}

interface TokenEntry {
	id: number;
	kind: "oauth" | "api_key";
	/** Label, else OAuth identity or API-key hint. Never the key. */
	text: string;
	marks: string[];
}

/**
 * `--list` rows: enabled OAuth accounts first, in `oauth.accounts()` order, then
 * every other stored row (API keys, disabled OAuth) in id order. `--credential`
 * selects a row by its own durable id, `#id`, `active`, label or identity/email —
 * it never depends on this listing's order. A store without a credential catalog
 * lists OAuth only.
 */
function listTokenEntries(
	authStorage: AuthStorage,
	provider: string,
	accounts: OAuthAccountSummary[],
): TokenEntry[] {
	let summaries: CredentialSummary[] = [];
	try {
		summaries = authStorage.listCredentials(provider);
	} catch (error) {
		// No credential catalog (e.g. a remote broker store): OAuth accounts only.
		if (!(error instanceof AIError.ConfigurationError)) throw error;
	}
	const byId = new Map(summaries.map(summary => [summary.id, summary]));
	const marksOf = (summary: CredentialSummary | undefined): string[] => {
		if (!summary) return [];
		const marks: string[] = [];
		if (summary.isDefault) marks.push("default");
		if (summary.pinned) marks.push("pinned");
		if (summary.disabled) marks.push(`disabled: ${summary.disabled}`);
		return marks;
	};
	const entries: TokenEntry[] = accounts.map(acct => {
		const base =
			acct.email ?? acct.accountId ?? acct.projectId ?? acct.enterpriseUrl ?? `credential #${acct.credentialId}`;
		const org = acct.orgName ?? acct.orgId;
		const summary = byId.get(acct.credentialId);
		return {
			id: acct.credentialId,
			kind: "oauth",
			text: summary?.label ?? (org && org !== base ? `${base} (${org})` : base),
			marks: marksOf(summary),
		};
	});
	const listed = new Set(entries.map(entry => entry.id));
	for (const summary of summaries) {
		if (listed.has(summary.id)) continue;
		entries.push({
			id: summary.id,
			kind: summary.kind,
			text: summary.label ?? (summary.kind === "api_key" ? (summary.hint ?? "api key") : (summary.identity ?? "oauth")),
			marks: marksOf(summary),
		});
	}
	return entries;
}

export default class Token extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai)",
			required: true,
		}),
	};

	static flags = {
		raw: Flags.boolean({
			description: "Output the raw credential value without parsing nested JSON structures",
			default: false,
		}),
		"force-refresh": Flags.boolean({
			description: "Force refresh the OAuth token even if it has not expired",
			default: false,
		}),
		credential: Flags.string({
			char: "c",
			description:
				"Select one stored credential of this provider instead of the round-robin default: <id|active|#id|label|email>, or <provider>/<selector>. An OAuth row returns its access token, an API-key row its stored key",
		}),
		list: Flags.boolean({
			char: "l",
			description:
				"List the provider's stored credentials (OAuth accounts first, then API keys and disabled rows) and exit",
			default: false,
		}),
	};

	static examples = [
		"# Get API key for Anthropic\n  omp token anthropic",
		"# Get raw Copilot credential JSON\n  omp token github-copilot --raw",
		"# Force refresh and get Gemini CLI token\n  omp token google-gemini-cli --force-refresh",
		"# List Anthropic credentials (OAuth accounts and API keys)\n  omp token anthropic --list",
		"# Get one Anthropic credential's token by id\n  omp token anthropic --credential anthropic/6",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Token);
		const providerName = args.provider ?? "";
		const managedMcpOAuth = isManagedMCPOAuthCredentialId(args.provider);
		const provider = managedMcpOAuth ? providerName : providerName.toLowerCase();
		// Profile-scoped managed ids stay isolated per profile: a shared broker
		// snapshot carries `mcp_oauth:profile:*` rows for every profile, so refuse
		// to read/refresh another profile's row from this one (mirrors
		// removeManagedMcpOAuthCredential). Legacy unscoped ids have no profile.
		if (managedMcpOAuth) {
			const scopedProfile = mcpOAuthCredentialProfile(provider);
			if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) {
				process.stderr.write(
					`${chalk.red(`Managed MCP credential "${providerName}" belongs to profile "${scopedProfile}", not the active profile.`)}\n`,
				);
				process.exitCode = 1;
				return;
			}
		}

		const authStorage = await discoverAuthStorage();
		try {
			if (flags.list || flags.credential !== undefined) {
				const accounts = authStorage.oauth.accounts(provider);
				const entries = listTokenEntries(authStorage, provider, accounts);
				if (flags.list) {
					if (entries.length === 0) {
						process.stderr.write(`${chalk.red(`No stored credentials found for provider "${providerName}".`)}\n`);
						process.exitCode = 1;
						return;
					}
					for (const [index, entry] of entries.entries()) {
						const marks = entry.marks.length > 0 ? ` · ${entry.marks.join(", ")}` : "";
						process.stdout.write(`${index + 1}. #${entry.id} ${entry.text} · ${entry.kind}${marks}\n`);
					}
					return;
				}
				const summaries = authStorage.listCredentials(provider);
				const resolved = resolveCredentialTarget(summaries, flags.credential!, { provider });
				if (!resolved.ok) {
					process.stderr.write(`${chalk.red(resolved.message)}\n`);
					process.exitCode = 1;
					return;
				}
				if (resolved.selection.kind === "pool") {
					process.stderr.write(`${chalk.red(`'${flags.credential}' does not name one stored credential.`)}\n`);
					process.exitCode = 1;
					return;
				}
				const row = resolved.selection.row;
				if (row.disabled) {
					process.stderr.write(`${chalk.red(`#${row.id} is disabled: ${row.disabled}.`)}\n`);
					process.exitCode = 1;
					return;
				}
				if (row.kind === "api_key") {
					const stored = authStorage.credentials.list(provider).find(entry => entry.id === row.id);
					if (stored?.credential.type !== "api_key") {
						process.stderr.write(`${chalk.red(`#${row.id} has no stored API key.`)}\n`);
						process.exitCode = 1;
						return;
					}
					process.stdout.write(`${stored.credential.key}\n`);
					return;
				}
				const resolution = managedMcpOAuth
					? await resolveManagedMcpOAuthToken(authStorage, provider, {
							credentialId: row.id,
							forceRefresh: flags["force-refresh"],
						})
					: await authStorage.oauth.accessById(provider, row.id, {
							forceRefresh: flags["force-refresh"],
						});
				if (typeof resolution === "string") {
					process.stdout.write(`${resolution}\n`);
					return;
				}
				if (!resolution?.ok) {
					const reason = resolution && !resolution.ok ? resolution.error : "no OAuth credential available";
					process.stderr.write(`${chalk.red(`Could not get token for #${row.id} of "${providerName}": ${reason}`)}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${resolution.accessToken}\n`);
				return;
			}

			const modelRegistry = new ModelRegistry(authStorage);

			// Resolve the API key / token
			let apiKey: string | undefined;

			if (provider === "perplexity") {
				const methods = await getAvailableAuthMethods(authStorage, undefined, {
					forceRefresh: flags["force-refresh"],
				});
				const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
				if (printable) {
					apiKey = printable.type === "oauth" ? printable.access.accessToken : printable.apiKey;
				}
			}

			if (!apiKey && managedMcpOAuth) {
				apiKey = await resolveManagedMcpOAuthToken(authStorage, provider, {
					forceRefresh: flags["force-refresh"],
				});
			} else if (!apiKey) {
				apiKey = await modelRegistry.getApiKeyForProvider(provider, undefined, {
					forceRefresh: flags["force-refresh"],
				});
			}

			if (!isAuthenticated(apiKey)) {
				// Find all active/configured providers
				const activeProviders = new Set<string>();
				for (const p of PROVIDER_REGISTRY) {
					if (authStorage.keys.source(p.id) !== undefined) {
						activeProviders.add(p.id);
					}
				}
				const all = authStorage.credentials.all();
				for (const p in all) {
					if (authStorage.keys.source(p) !== undefined) {
						activeProviders.add(p);
					}
				}

				const msg = `No active credential found for provider "${providerName}".`;
				process.stderr.write(`${chalk.red(msg)}\n`);
				if (activeProviders.size > 0) {
					process.stderr.write(`Configured providers: ${Array.from(activeProviders).sort().join(", ")}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (!flags.raw) {
				try {
					const parsed = JSON.parse(apiKey);
					if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
						process.stdout.write(`${parsed.token}\n`);
						return;
					}
				} catch {
					// Not a JSON string, print as-is
				}
			}

			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}

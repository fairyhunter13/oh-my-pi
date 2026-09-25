import type { Model, WebSearchGrounding } from "@oh-my-pi/pi-catalog/types";
import { runProviderSetupWizard as runProviderWizard } from "@oh-my-pi/pi-tui/setup/lazy";
import type { SetupHost, SetupScene } from "@oh-my-pi/pi-tui/setup/scenes/types";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	runSetupWizard as runWizard,
	type RunSetupWizardOptions,
	selectSetupScenes as selectScenes,
	type SetupSceneSelectionOptions,
} from "@oh-my-pi/pi-tui/setup/wizard";
import { formatModelString, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getRoleInfo, roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { accountPolicyFor, forgetCredentialSettings, saveAccountPolicy } from "../auth/credential-settings";
import { usageReportLines } from "../slash-commands/helpers/usage-report";
import { credentialName } from "@oh-my-pi/pi-tui/setup/scenes/credential-format";
import { describeRedeemOutcome, toResetUsageAccounts } from "../slash-commands/helpers/reset-usage";
import {
	cfgClaudeResetsAutoRedeemByCredential,
	cfgCodexResetsAutoRedeemByCredential,
} from "../session/settings";
import { captureBrowserSession } from "../utils/browser-session";
import { copyToClipboard } from "../utils/clipboard";
import { getGroundedSearchProvider, getSearchProvider } from "../web/search/provider";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../web/search/types";
import { createModelBrowserSource } from "./model-browser-source";
import type { InteractiveModeContext } from "./types";

import {
	cfgColorBlindMode,
	cfgComposerShape,
	cfgSetupVersion,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
} from "./settings";
import { cfgDisabledProviders, cfgModelRoleStorage } from "../config/model-settings";

export { ALL_SCENES, CURRENT_SETUP_VERSION };
export type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
export { runStartupSplash } from "@oh-my-pi/pi-tui/setup/startup-splash";

const WEB_SEARCH_GROUNDINGS: Readonly<Record<WebSearchGrounding, true>> = {
	gemini: true,
	anthropic: true,
	codex: true,
	xai: true,
	openrouter: true,
};

function isWebSearchGrounding(id: SearchProviderId): id is WebSearchGrounding {
	return id in WEB_SEARCH_GROUNDINGS;
}

/**
 * Web-role candidate pools, lazily: the credentialed pool the runtime resolves
 * against first (#13023), then the full catalog so an unconfigured provider can
 * still be saved and highlighted as the preference.
 */
function* webRolePools(ctx: InteractiveModeContext): Generator<Model[]> {
	yield roleCandidatePool("web", ctx.settings, ctx.session.modelRegistry);
	yield ctx.session.modelRegistry.getAll("all").filter(getRoleInfo("web", ctx.settings).accepts);
}

function resolveWebSearchSelection(ctx: InteractiveModeContext, id: SearchProviderId) {
	for (const models of webRolePools(ctx)) {
		if (!isWebSearchGrounding(id)) {
			const selector = `web/${id}`;
			const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
			if (model) return { selector, model };
			continue;
		}

		for (const selector of rolePriorityDefaults("web")) {
			const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
			if (model?.webSearch === id) return { selector, model };
		}
		const model = models.find(candidate => candidate.webSearch === id);
		if (model) return { selector: formatModelString(model), model };
	}
	return undefined;
}

/** Bind application preferences and runtime effects to the setup presentation. */
export function createSetupHost(ctx: InteractiveModeContext): SetupHost {
	const modelSource = createModelBrowserSource(ctx.settings);
	return {
		ui: ctx.ui,
		get statusLine() {
			return ctx.statusLine;
		},
		get composerShape() {
			return cfgComposerShape.get(ctx.settings);
		},
		get symbolPreset() {
			return cfgSymbolPreset.get(ctx.settings);
		},
		get colorBlindMode() {
			return cfgColorBlindMode.get(ctx.settings);
		},
		get webSearchOrder() {
			const configured = ctx.settings.getModelRole("web")?.trim();
			if (!configured) return [];
			let model: Model | undefined;
			for (const models of webRolePools(ctx)) {
				model = resolveModelRoleValue(configured, models, { settings: ctx.settings }).model;
				if (model) break;
			}
			if (model?.provider === "web") {
				const option = SEARCH_PROVIDER_OPTIONS.find(candidate => candidate.value === model.id);
				if (option && option.value !== "auto" && option.value !== "none") return [option.value];
			}
			return model?.webSearch ? [model.webSearch] : [];
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(ctx.settings);
		},
		get authStorage() {
			return ctx.session.modelRegistry.authStorage;
		},
		get sessionId() {
			return ctx.session.sessionId;
		},
		modelSource,
		getModels: () => ({
			available: ctx.session.modelRegistry.getAvailable(),
			all: ctx.session.modelRegistry.getAll(),
			current: ctx.session.model,
		}),
		refreshModels: () => ctx.session.modelRegistry.refresh("online-if-uncached"),
		selectModel: async (model, selector) => {
			const projectScope = cfgModelRoleStorage.get(ctx.settings) === "project";
			await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope) ctx.settings.setProjectModelRole("default", selector);
			await ctx.settings.flush();
		},
		refreshProvider: provider => ctx.session.modelRegistry.refreshProvider(provider, "online"),
		saveComposerShape: async shape => {
			cfgComposerShape.set(ctx.settings, shape);
			await ctx.settings.flush();
		},
		saveSymbolPreset: preset => {
			cfgSymbolPreset.set(ctx.settings, preset);
		},
		saveColorBlindMode: enabled => {
			cfgColorBlindMode.set(ctx.settings, enabled);
		},
		saveTheme: (mode, name) => {
			(mode === "dark" ? cfgThemeDark : cfgThemeLight).set(ctx.settings, name);
		},
		isSearchProviderAvailable: async id => {
			const selection = resolveWebSearchSelection(ctx, id);
			if (!selection) return false;
			const provider = selection.model.webSearch
				? await getGroundedSearchProvider(selection.model.webSearch)
				: await getSearchProvider(selection.model.id);
			return provider.isExplicitlyAvailable(ctx.session.modelRegistry.authStorage, selection.model);
		},
		saveSearchProvider: id => {
			if (id === "auto") {
				ctx.settings.setModelRole("web", undefined);
				return;
			}
			const selection = resolveWebSearchSelection(ctx, id);
			if (selection) ctx.settings.setModelRole("web", selection.selector);
		},
		captureBrowserSession,
		copyToClipboard,
		openInBrowser: url => ctx.openInBrowser(url),
		markComplete: version => markSetupWizardComplete(ctx.settings, version),
		playWelcomeIntro: () => ctx.playWelcomeIntro(),
		showError: message => ctx.showError(message),
		usageLines: async (provider, id) => {
			const authStorage = ctx.session.modelRegistry.authStorage;
			const row = authStorage.listCredentials(provider, ctx.session.sessionId).find(candidate => candidate.id === id);
			if (!row) return [`No usage data for #${id}.`];
			const stored = authStorage.credentials.list(provider).find(entry => entry.id === id);
			if (!stored) return [`No usage data for ${credentialName(row)} (#${id}).`];
			let report;
			try {
				report = await authStorage.usage.report(provider, stored.credential, {
					baseUrl: ctx.session.modelRegistry.getProviderBaseUrl(provider),
					signal: AbortSignal.timeout(15_000),
				});
			} catch (error) {
				return [`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`];
			}
			return usageReportLines(row, report);
		},
		resetStatus: async (provider, id) => {
			const statuses = await ctx.session.listResetCredits(AbortSignal.timeout(10_000), provider);
			const account = toResetUsageAccounts(statuses).find(candidate => candidate.target.credentialId === id);
			if (!account) return undefined;
			const lines = [account.label, `${account.availableCount} saved, ${account.redeemableCount} usable now`];
			if (account.expiresAt) lines.push(`expires ${account.expiresAt}`);
			if (account.unavailableReason) lines.push(account.unavailableReason);
			if (account.error) lines.push(account.error);
			const setting = provider === "anthropic" ? cfgClaudeResetsAutoRedeemByCredential : cfgCodexResetsAutoRedeemByCredential;
			const raw = setting.get(ctx.settings)[String(id)];
			const autoRedeem: "unset" | "yes" | "no" = raw === "yes" ? "yes" : raw === "no" ? "no" : "unset";
			return { lines, redeemable: account.redeemableCount > 0, autoRedeem };
		},
		redeemReset: async (provider, id) => {
			const statuses = await ctx.session.listResetCredits(AbortSignal.timeout(10_000), provider);
			const account = toResetUsageAccounts(statuses).find(candidate => candidate.target.credentialId === id);
			if (!account) return `No saved reset found for #${id}.`;
			const outcome = await ctx.session.redeemResetCredit(account.target);
			return describeRedeemOutcome(outcome, account.label);
		},
		setAutoRedeem: (provider, id, value) => {
			const setting = provider === "anthropic" ? cfgClaudeResetsAutoRedeemByCredential : cfgCodexResetsAutoRedeemByCredential;
			const current = setting.get(ctx.settings);
			const key = String(id);
			if (value === "unset") {
				if (!(key in current)) return;
				const next = { ...current };
				delete next[key];
				setting.set(ctx.settings, next);
				return;
			}
			setting.set(ctx.settings, { ...current, [key]: value });
		},
		accountPolicy: (provider, id) => {
			const authStorage = ctx.session.modelRegistry.authStorage;
			const row = authStorage.listCredentials(provider, ctx.session.sessionId).find(candidate => candidate.id === id);
			return row ? accountPolicyFor(ctx.settings, authStorage, row) : undefined;
		},
		saveAccountPolicy: (provider, id, policy) => {
			const authStorage = ctx.session.modelRegistry.authStorage;
			const row = authStorage.listCredentials(provider, ctx.session.sessionId).find(candidate => candidate.id === id);
			if (!row) return `${provider} credential #${id} is no longer stored.`;
			return saveAccountPolicy(ctx.settings, authStorage, row, policy);
		},
		forgetCredential: (provider, id) => {
			const authStorage = ctx.session.modelRegistry.authStorage;
			const row = authStorage.listCredentials(provider, ctx.session.sessionId).find(candidate => candidate.id === id);
			if (row) forgetCredentialSettings(ctx.settings, authStorage, row);
		},
	};
}

/** Persist completion only after the setup overlay finishes. */
export async function markSetupWizardComplete(settings: Settings, version = CURRENT_SETUP_VERSION): Promise<void> {
	cfgSetupVersion.set(settings, version);
	await settings.flush();
}

/** Select eligible setup scenes using the application's live capabilities. */
export function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: InteractiveModeContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	return selectScenes(storedVersion, scenes, ctx ? createSetupHost(ctx) : undefined, options);
}

/** Run setup with application-owned persistence and provider effects. */
export function runSetupWizard(
	ctx: InteractiveModeContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	return runWizard(createSetupHost(ctx), scenes, options);
}

/** Open provider setup without advancing onboarding or replaying the welcome intro. */
export function runProviderSetupWizard(ctx: InteractiveModeContext): Promise<void> {
	return runProviderWizard(createSetupHost(ctx));
}

import type { AuthStorage, CredentialSummary } from "@oh-my-pi/pi-ai";
import { suggestCredentialLabel } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt, OAuthProvider, OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { formTheme } from "../../chrome/form-theme";
import { TextFormField } from "../../components/form";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { type SgrMouseEvent } from "../../mouse";
import { getSelectListTheme, theme } from "../../theme/theme";
import { type Component, Container } from "../../tui";
import { wrapTextWithAnsi } from "../../utils";
import { credentialItem, credentialName } from "./credential-format";
import type { SetupSceneHost, SetupTab } from "./types";

const MAX_VISIBLE = 10;

type View =
	| { kind: "providers" }
	| { kind: "credentials"; provider: string }
	| { kind: "actions"; provider: string; id: number }
	| { kind: "scope"; provider: string; id: number }
	| { kind: "newScope"; provider: string; id: number }
	| { kind: "remove"; provider: string; id: number }
	| { kind: "field"; provider: string; field: TextFormField }
	| { kind: "login"; provider: string; oauth: OAuthProviderInfo };

/**
 * "Credentials" panel: every stored credential per provider (each OAuth
 * subscription, each API key). Picks the one a session or new sessions use,
 * names, adds, disables and removes them.
 */
export class CredentialsTab implements SetupTab {
	readonly id = "credentials";
	readonly label = "Credentials";

	readonly #host: SetupSceneHost;
	readonly #authStorage: AuthStorage;
	#view: View = { kind: "providers" };
	#list: SelectList;
	#step: WizardStep | undefined;
	#status: string[] = [];
	#loginAbort: AbortController | undefined;
	#disposed = false;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#authStorage = host.ctx.authStorage;
		this.#list = this.#buildList();
	}

	/** Every view below the provider list owns the keys, so Esc steps back instead of leaving the scene. */
	get modal(): boolean {
		return this.#view.kind !== "providers";
	}

	onActivate(): void {
		this.#show(this.#view.kind === "providers" ? this.#view : { kind: "credentials", provider: this.#view.provider });
	}

	handleInput(data: string): void {
		if (this.#view.kind === "field") {
			this.#view.field.handleInput(data);
			this.#host.requestRender();
			return;
		}
		if (this.#view.kind === "login") return this.#loginInput(data);
		this.#list.handleInput(data);
		this.#host.requestRender();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#view.kind === "field" || this.#view.kind === "login") return;
		this.#step?.routeMouse(event, line, col);
	}

	invalidate(): void {
		this.#step?.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#loginAbort?.abort();
	}

	render(width: number, maxLines?: number): readonly string[] {
		const status = new Container();
		for (const line of this.#status) {
			for (const wrapped of wrapTextWithAnsi(line, width)) status.addChild(new Text(wrapped, 0, 0));
		}
		const content: Component = this.#view.kind === "field" ? this.#view.field : this.#list;
		const intro = new Text(theme.fg("muted", this.#heading()), 0, 0);
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				content,
				status,
				minContentLines: 1,
				fitContent: budget => {
					const visible = budget === undefined ? MAX_VISIBLE : budget - 1;
					this.#list.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE, visible)));
				},
			});
		} else {
			this.#step.setIntro(intro);
			this.#step.setContent(this.#view.kind === "login" ? new Container() : content);
			this.#step.setStatus(status);
		}
		this.#step.setKind(this.#view.kind === "field" ? "input" : this.#view.kind === "login" ? "async" : "choice");
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	#heading(): string {
		const view = this.#view;
		switch (view.kind) {
			case "providers":
				return "Pick a provider to see its credentials.";
			case "credentials":
				return `${view.provider}: pick a credential or an action. Esc goes back.`;
			case "actions":
			case "remove":
				return `${view.provider}: ${this.#describe(view.provider, view.id)}`;
			case "scope":
			case "newScope":
				return `Use ${this.#describe(view.provider, view.id)} for:`;
			case "field":
				return `${view.provider}: Enter saves, Esc cancels.`;
			case "login":
				return `Signing in to ${view.oauth.name} for ${view.provider}. Esc cancels.`;
		}
	}

	#rows(provider?: string): CredentialSummary[] {
		try {
			return this.#authStorage.listCredentials(provider, this.#host.ctx.sessionId);
		} catch (error) {
			this.#status = [theme.fg("error", error instanceof Error ? error.message : String(error))];
			return [];
		}
	}

	#describe(provider: string, id: number): string {
		const row = this.#rows(provider).find(candidate => candidate.id === id);
		return row ? `${credentialName(row)} (#${id})` : `#${id}`;
	}

	#oauthFor(provider: string): OAuthProviderInfo[] {
		return getOAuthProviders().filter(info => (info.storeCredentialsAs ?? info.id) === provider && info.available);
	}

	#show(view: View, status?: string[]): void {
		this.#view = view;
		if (status) this.#status = status;
		if (view.kind === "field") {
			this.#host.setFocus(view.field);
		} else {
			this.#list = this.#buildList();
			this.#host.restoreFocus();
		}
		this.#host.requestRender();
	}

	#buildList(): SelectList {
		const view = this.#view;
		const items = this.#items();
		const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), { emptyText: "Nothing here yet" });
		list.onSelect = item => this.#choose(item.value);
		list.onCancel = () => {
			if (view.kind === "providers") this.#host.finish("skipped");
			else if (view.kind === "credentials") this.#show({ kind: "providers" }, []);
			else this.#show({ kind: "credentials", provider: view.provider });
		};
		if (view.kind === "credentials" || view.kind === "providers") {
			// Keep the cursor on the provider or row just acted on.
			const previous = this.#list?.getSelectedItem?.()?.value;
			if (previous) list.setSelectedValue(previous);
		}
		return list;
	}

	#items(): SelectItem[] {
		const view = this.#view;
		switch (view.kind) {
			case "providers": {
				const rows = this.#rows();
				const counts = new Map<string, CredentialSummary[]>();
				for (const row of rows) counts.set(row.provider, [...(counts.get(row.provider) ?? []), row]);
				const known = new Set<string>(counts.keys());
				for (const model of this.#host.ctx.getModels().all) known.add(model.provider);
				for (const info of getOAuthProviders()) known.add(info.storeCredentialsAs ?? info.id);
				const disabledProviders = new Set(this.#host.ctx.disabledProviders);
				const items = [...known]
					.filter(provider => counts.has(provider) || !disabledProviders.has(provider))
					.sort((a, b) => Number(counts.has(b)) - Number(counts.has(a)) || a.localeCompare(b))
					.map(provider => {
						const own = counts.get(provider) ?? [];
						const oauth = own.filter(row => row.kind === "oauth").length;
						const keys = own.length - oauth;
						const parts = [
							oauth > 0 ? `${oauth} subscription${oauth === 1 ? "" : "s"}` : "",
							keys > 0 ? `${keys} API key${keys === 1 ? "" : "s"}` : "",
						].filter(Boolean);
						const fallback = own.find(row => row.isDefault);
						if (fallback) parts.push(`default: ${credentialName(fallback)}`);
						return {
							value: `provider:${provider}`,
							label: provider,
							description: parts.length > 0 ? parts.join(" · ") : "no stored credentials",
						};
					});
				if (rows.some(row => row.kind === "oauth")) {
					items.push({
						value: "refresh:all",
						label: "Refresh every subscription",
						description: "Force refresh, every provider",
					});
				}
				return items;
			}
			case "credentials": {
				const rows = this.#rows(view.provider);
				const items = rows.map(credentialItem);
				items.push({ value: "add:key", label: "+ Add API key", description: "Stored next to the other rows" });
				for (const info of this.#oauthFor(view.provider)) {
					items.push({ value: `add:oauth:${info.id}`, label: `+ Add subscription: ${info.name}` });
				}
				if (rows.some(row => row.pinned)) {
					items.push({
						value: "pin:clear",
						label: "Pick again at the next request",
						description: "Clears this session's choice",
					});
				}
				if (rows.some(row => row.isDefault)) {
					items.push({ value: "default:clear", label: "Clear the default for new sessions" });
				}
				if (rows.some(row => row.kind === "oauth")) {
					items.push({
						value: "refresh:provider",
						label: "Refresh subscriptions",
						description: "Force refresh this provider's OAuth rows",
					});
				}
				return items;
			}
			case "actions": {
				const row = this.#rows(view.provider).find(candidate => candidate.id === view.id);
				const items: SelectItem[] = [];
				if (row && !row.disabled) items.push({ value: "use", label: "Use this credential…" });
				items.push({ value: "rename", label: "Rename" });
				items.push(row?.disabled ? { value: "enable", label: "Enable" } : { value: "disable", label: "Disable" });
				items.push({ value: "remove", label: "Remove…" });
				return items;
			}
			case "scope":
				return [
					{
						value: "session",
						label: "This session only",
						description: this.#host.ctx.sessionId ? "Pins it; no rotation to other rows" : "No running session",
						disabled: !this.#host.ctx.sessionId,
					},
					{
						value: "default",
						label: "Default for new sessions",
						description: "Running sessions keep theirs.",
					},
				];
			case "newScope":
				return [
					{
						value: "session",
						label: "This session",
						description: this.#host.ctx.sessionId ? undefined : "No running session",
						disabled: !this.#host.ctx.sessionId,
					},
					{
						value: "default",
						label: "Default for new sessions",
						description: "Running sessions keep theirs.",
					},
					{ value: "store", label: "Just store it" },
				];
			case "remove":
				return [
					{ value: "no", label: "Keep it" },
					{ value: "yes", label: `Remove ${this.#describe(view.provider, view.id)}` },
				];
			default:
				return [];
		}
	}

	#choose(value: string): void {
		const view = this.#view;
		try {
			if (view.kind === "providers") {
				if (value === "refresh:all") {
					void this.#refreshCredentials(undefined);
				} else {
					this.#show({ kind: "credentials", provider: value.slice("provider:".length) }, []);
				}
			} else if (view.kind === "credentials") {
				this.#chooseInCredentials(view.provider, value);
			} else if (view.kind === "actions") {
				this.#chooseAction(view.provider, view.id, value);
			} else if (view.kind === "scope") {
				this.#chooseScope(view.provider, view.id, value);
			} else if (view.kind === "newScope") {
				this.#chooseNewScope(view.provider, view.id, value);
			} else if (view.kind === "remove") {
				if (value === "yes") void this.#remove(view.provider, view.id);
				else this.#show({ kind: "actions", provider: view.provider, id: view.id });
			}
		} catch (error) {
			this.#show(view, [theme.fg("error", error instanceof Error ? error.message : String(error))]);
		}
	}

	#chooseInCredentials(provider: string, value: string): void {
		if (value.startsWith("row:")) {
			this.#show({ kind: "actions", provider, id: Number(value.slice("row:".length)) }, []);
		} else if (value === "add:key") {
			this.#askApiKey(provider);
		} else if (value.startsWith("add:oauth:")) {
			const info = this.#oauthFor(provider).find(candidate => candidate.id === value.slice("add:oauth:".length));
			if (info) void this.#login(provider, info);
		} else if (value === "pin:clear" && this.#host.ctx.sessionId) {
			this.#authStorage.clearSessionCredential(provider, this.#host.ctx.sessionId);
			this.#show({ kind: "credentials", provider }, [theme.fg("success", "This session uses the pool again.")]);
		} else if (value === "default:clear") {
			this.#authStorage.setDefaultCredential(provider, null);
			this.#show({ kind: "credentials", provider }, [theme.fg("success", "No default for new sessions.")]);
		} else if (value === "refresh:provider") {
			void this.#refreshCredentials(provider);
		}
	}

	/** Force-refresh every OAuth row (`provider` scopes it), then report the result on the current view. */
	async #refreshCredentials(provider: string | undefined): Promise<void> {
		const view = this.#view;
		const nameById = new Map(this.#rows(provider).map(row => [row.id, credentialName(row)]));
		this.#show(view, [theme.fg("dim", "Refreshing…")]);
		try {
			const result = await this.#authStorage.oauth.refreshCredentials({ provider, force: true });
			if (this.#disposed) return;
			const detail = result.failed
				.map(entry => `${nameById.get(entry.id) ?? `#${entry.id}`}: ${entry.error}`)
				.join(", ");
			const summary = `Refreshed ${result.refreshed.length}, failed ${result.failed.length}${detail ? `: ${detail}` : ""}`;
			this.#show(view, [theme.fg(result.failed.length > 0 ? "warning" : "success", summary)]);
		} catch (error) {
			if (this.#disposed) return;
			this.#show(view, [theme.fg("error", error instanceof Error ? error.message : String(error))]);
		}
	}

	#chooseAction(provider: string, id: number, value: string): void {
		const name = this.#describe(provider, id);
		if (value === "use") {
			this.#show({ kind: "scope", provider, id }, []);
		} else if (value === "rename") {
			const row = this.#rows(provider).find(candidate => candidate.id === id);
			this.#askText(provider, {
				label: `Name for ${name} (empty clears it)`,
				initialValue: row?.label ?? "",
				onSubmit: text => {
					this.#authStorage.renameCredential(id, text.trim() || null);
					this.#show({ kind: "credentials", provider }, [theme.fg("success", `Renamed #${id}.`)]);
				},
			});
		} else if (value === "disable") {
			void this.#disable(provider, id);
		} else if (value === "enable") {
			this.#authStorage.enableCredential(id);
			this.#show({ kind: "credentials", provider }, [theme.fg("success", `Enabled ${name}.`)]);
		} else if (value === "remove") {
			this.#show({ kind: "remove", provider, id }, []);
		}
	}

	#chooseScope(provider: string, id: number, value: string): void {
		const name = this.#describe(provider, id);
		const sessionId = this.#host.ctx.sessionId;
		if (value === "session" && sessionId) {
			if (!this.#authStorage.pinSessionCredential(provider, sessionId, id)) {
				throw new Error(`${name} is missing or disabled.`);
			}
			this.#show({ kind: "credentials", provider }, [theme.fg("success", `This session now uses ${name} only.`)]);
		} else if (value === "default") {
			this.#authStorage.setDefaultCredential(provider, id);
			this.#show({ kind: "credentials", provider }, [theme.fg("success", `New sessions start with ${name}.`)]);
		}
	}

	#chooseNewScope(provider: string, id: number, value: string): void {
		const name = this.#describe(provider, id);
		const sessionId = this.#host.ctx.sessionId;
		if (value === "session" && sessionId) {
			if (!this.#authStorage.pinSessionCredential(provider, sessionId, id)) {
				throw new Error(`${name} is missing or disabled.`);
			}
			this.#show({ kind: "credentials", provider }, [
				theme.fg("success", `Added ${name}. This session uses it only.`),
			]);
		} else if (value === "default") {
			this.#authStorage.setDefaultCredential(provider, id);
			this.#show({ kind: "credentials", provider }, [
				theme.fg("success", `Added ${name}. New sessions start with it.`),
			]);
		} else if (value === "store") {
			this.#show({ kind: "credentials", provider }, [theme.fg("success", `Added ${name}.`)]);
		}
	}

	/**
	 * "Name this credential" then "Use it for:" for a row a login or add-API-key
	 * flow just stored. Esc while naming leaves the label unset and still moves
	 * on to the scope step; Esc while picking a scope leaves the row unpinned
	 * and not the default — either way the row itself stays.
	 */
	#nameAndScopeNewCredential(provider: string, id: number): void {
		const rows = this.#rows(provider);
		const row = rows.find(candidate => candidate.id === id);
		if (!row) return;
		const suggested = suggestCredentialLabel(rows, row);
		this.#askText(provider, {
			label: "Name this credential",
			initialValue: suggested,
			onSubmit: text => this.#submitNewCredentialName(provider, id, suggested, text),
			onCancel: () => this.#show({ kind: "newScope", provider, id }, []),
		});
	}

	#submitNewCredentialName(provider: string, id: number, suggested: string, text: string): void {
		const label = text.trim() || suggested;
		try {
			this.#authStorage.renameCredential(id, label);
		} catch (error) {
			this.#askText(provider, {
				label: "Name this credential",
				initialValue: suggested,
				onSubmit: retryText => this.#submitNewCredentialName(provider, id, suggested, retryText),
				onCancel: () => this.#show({ kind: "newScope", provider, id }, []),
			});
			this.#status = [theme.fg("error", error instanceof Error ? error.message : String(error))];
			return;
		}
		this.#show({ kind: "newScope", provider, id }, []);
	}

	async #remove(provider: string, id: number): Promise<void> {
		const row = this.#rows(provider).find(candidate => candidate.id === id);
		const name = this.#describe(provider, id);
		const removed = await this.#authStorage.removeCredential(provider, id, { sessionId: this.#host.ctx.sessionId });
		if (this.#disposed) return;
		const status = removed
			? [theme.fg("success", `Removed ${name}.`)]
			: [theme.fg("warning", `${name} was already gone.`)];
		if (removed && row?.pinned)
			status.push(theme.fg("warning", "This session was pinned to it; the pin is cleared."));
		this.#show({ kind: "credentials", provider }, status);
	}

	async #disable(provider: string, id: number): Promise<void> {
		const name = this.#describe(provider, id);
		let status: string;
		try {
			const disabled = await this.#authStorage.disableCredentialById(id, "disabled by user");
			status = disabled
				? theme.fg("success", `Disabled ${name}.`)
				: theme.fg("warning", `${name} was already disabled.`);
		} catch (error) {
			status = theme.fg("error", error instanceof Error ? error.message : String(error));
		}
		if (this.#disposed) return;
		this.#show({ kind: "credentials", provider }, [status]);
	}

	#askText(
		provider: string,
		options: {
			label: string;
			secret?: boolean;
			initialValue?: string;
			onSubmit: (value: string) => void;
			onCancel?: () => void;
		},
	): void {
		const back = this.#view;
		const field = new TextFormField({
			theme: formTheme,
			label: options.label,
			secret: options.secret,
			initialValue: options.initialValue,
			empty: options.secret ? "reject" : "submit",
			onSubmit: options.onSubmit,
			onCancel:
				options.onCancel ?? (() => this.#show(back.kind === "field" ? { kind: "credentials", provider } : back)),
			requestRender: () => this.#host.requestRender(),
		});
		this.#show({ kind: "field", provider, field }, []);
	}

	#askApiKey(provider: string): void {
		this.#askText(provider, {
			label: `API key for ${provider}`,
			secret: true,
			onSubmit: key => {
				const id = this.#authStorage.addApiKey(provider, key, null);
				void this.#host.ctx.refreshProvider(provider);
				this.#nameAndScopeNewCredential(provider, id);
			},
		});
	}

	#loginInput(data: string): void {
		if (data === "\x1b" || data === "\x03") this.#loginAbort?.abort();
	}

	/** Upstream login. AuthStorage.login re-enables the api_key rows this login alone disabled. */
	async #login(provider: string, oauth: OAuthProviderInfo): Promise<void> {
		if (this.#loginAbort) return;
		const abort = new AbortController();
		this.#loginAbort = abort;
		this.#show({ kind: "login", provider, oauth }, [theme.fg("dim", "Starting OAuth flow…")]);
		const prompt = (request: OAuthPrompt): Promise<string> => {
			const pending = Promise.withResolvers<string>();
			this.#askText(provider, {
				label: request.message,
				secret: request.secret === true,
				onCancel: () => abort.abort(),
				onSubmit: value => {
					this.#show({ kind: "login", provider, oauth });
					pending.resolve(value);
				},
			});
			abort.signal.addEventListener("abort", () => pending.reject(new Error("Login cancelled")), { once: true });
			return pending.promise;
		};
		try {
			const identity = await this.#authStorage.oauth.login(oauth.id as OAuthProvider, {
				signal: abort.signal,
				onBrowserSession: (request, signal) => this.#host.ctx.captureBrowserSession(request, signal),
				onAuth: info => {
					this.#status = [theme.fg("accent", "Open this URL to sign in:"), theme.fg("dim", info.url)];
					if (info.instructions) this.#status.push(theme.fg("warning", info.instructions));
					void this.#host.ctx.copyToClipboard(info.url).catch(() => undefined);
					this.#host.ctx.openInBrowser(info.url);
					this.#host.requestRender();
				},
				onPrompt: prompt,
				onProgress: message => {
					this.#status.push(theme.fg("dim", message));
					this.#host.requestRender();
				},
				onManualCodeInput: () => prompt({ message: "Paste the authorization code (or full redirect URL):" }),
			});
			await this.#host.ctx.refreshProvider(provider);
			if (this.#disposed) return;
			if (identity?.credentialId !== undefined) {
				this.#nameAndScopeNewCredential(provider, identity.credentialId);
			} else {
				this.#show({ kind: "credentials", provider }, [theme.fg("success", `Added a ${oauth.name} subscription.`)]);
			}
		} catch (error) {
			if (this.#disposed) return;
			const message = abort.signal.aborted
				? theme.fg("dim", "Login cancelled.")
				: theme.fg("error", `Login failed: ${error instanceof Error ? error.message : String(error)}`);
			this.#show({ kind: "credentials", provider }, [message]);
		} finally {
			this.#loginAbort = undefined;
		}
	}
}

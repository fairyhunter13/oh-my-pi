import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import { type SelectItem, SelectList } from "../components/select-list";
import { credentialItem, credentialName } from "../setup/scenes/credential-format";
import { getSelectListTheme } from "../theme/theme";
import type { SgrMouseEvent } from "../mouse";

const MAX_VISIBLE = 10;

/** One provider row in the top-level `/logout` provider list. */
export interface CredentialLogoutProvider {
	id: string;
	name: string;
	/** "2 subscriptions · 1 API key", or where env/config auth for this provider comes from. */
	summary: string;
	/** True when this provider has no stored credential to remove (env/config only). */
	disabled: boolean;
}

/** What `/logout` confirmed: one row, or every stored row of a provider. */
export type CredentialLogoutTarget =
	| { kind: "row"; provider: string; row: CredentialSummary }
	| { kind: "all"; provider: string; rows: readonly CredentialSummary[] };

type LogoutView =
	| { kind: "providers" }
	| { kind: "rows"; provider: string }
	| { kind: "confirm"; provider: string; row: CredentialSummary }
	| { kind: "confirmAll"; provider: string; rows: readonly CredentialSummary[] };

/**
 * `/logout` picker: every provider with stored credentials (or only an
 * env/config source, shown disabled), then that provider's rows, then a
 * keep/remove confirmation. Esc steps back one view; Esc on the provider
 * list cancels.
 */
export class CredentialLogoutComponent extends OverlayPanel {
	#providers: readonly CredentialLogoutProvider[];
	#rowsByProvider: ReadonlyMap<string, readonly CredentialSummary[]>;
	#onConfirm: (target: CredentialLogoutTarget) => void;
	#onCancel: () => void;
	#view: LogoutView;
	#list: SelectList;

	constructor(
		providers: readonly CredentialLogoutProvider[],
		rowsByProvider: ReadonlyMap<string, readonly CredentialSummary[]>,
		initialProvider: string | undefined,
		onConfirm: (target: CredentialLogoutTarget) => void,
		onCancel: () => void,
	) {
		super("");
		this.#providers = providers;
		this.#rowsByProvider = rowsByProvider;
		this.#onConfirm = onConfirm;
		this.#onCancel = onCancel;
		this.#view = initialProvider ? { kind: "rows", provider: initialProvider } : { kind: "providers" };
		this.#list = this.#buildList();
		this.addChild(this.#list);
		this.title = this.#heading();
	}

	/** Forward keyboard navigation to the active view's list. */
	handleInput(keyData: string): void {
		this.#list.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the active list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#list, event, line, col);
	}

	#heading(): string {
		const view = this.#view;
		switch (view.kind) {
			case "providers":
				return "Log out — pick a provider";
			case "rows":
				return `Log out from ${view.provider} — pick a credential`;
			case "confirm":
				return `Log out ${credentialName(view.row)} (#${view.row.id}) from ${view.provider}?`;
			case "confirmAll":
				return `Log out all ${view.rows.length} credentials of ${view.provider}?`;
		}
	}

	#items(): SelectItem[] {
		const view = this.#view;
		switch (view.kind) {
			case "providers":
				return this.#providers.map(provider => ({
					value: `provider:${provider.id}`,
					label: provider.name,
					description: provider.summary,
					disabled: provider.disabled,
				}));
			case "rows": {
				const rows = this.#rowsByProvider.get(view.provider) ?? [];
				const items = rows.map(credentialItem);
				if (rows.length >= 2) {
					items.push({
						value: "row:all",
						label: `All ${rows.length} credentials of ${view.provider}`,
						description: "Removes every stored credential for this provider",
					});
				}
				return items;
			}
			case "confirm":
				return [
					{ value: "keep", label: "Keep it" },
					{ value: "remove", label: `Remove ${credentialName(view.row)} (#${view.row.id})` },
				];
			case "confirmAll":
				return [
					{ value: "keep", label: "Keep it" },
					{ value: "remove", label: `Remove all ${view.rows.length}` },
				];
		}
	}

	#buildList(): SelectList {
		const view = this.#view;
		const items = this.#items();
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE), getSelectListTheme(), {
			emptyText: "Nothing here yet",
		});
		list.onSelect = item => this.#choose(item.value);
		list.onCancel = () => {
			if (view.kind === "providers") this.#onCancel();
			else if (view.kind === "rows") this.#show({ kind: "providers" });
			else this.#show({ kind: "rows", provider: view.provider });
		};
		return list;
	}

	#show(view: LogoutView): void {
		this.#view = view;
		this.clear();
		this.#list = this.#buildList();
		this.addChild(this.#list);
		this.title = this.#heading();
	}

	#choose(value: string): void {
		const view = this.#view;
		if (view.kind === "providers" && value.startsWith("provider:")) {
			this.#show({ kind: "rows", provider: value.slice("provider:".length) });
		} else if (view.kind === "rows") {
			if (value === "row:all") {
				this.#show({ kind: "confirmAll", provider: view.provider, rows: this.#rowsByProvider.get(view.provider) ?? [] });
			} else if (value.startsWith("row:")) {
				const id = Number(value.slice("row:".length));
				const row = (this.#rowsByProvider.get(view.provider) ?? []).find(candidate => candidate.id === id);
				if (row) this.#show({ kind: "confirm", provider: view.provider, row });
			}
		} else if (view.kind === "confirm") {
			if (value === "remove") this.#onConfirm({ kind: "row", provider: view.provider, row: view.row });
			else this.#show({ kind: "rows", provider: view.provider });
		} else if (view.kind === "confirmAll") {
			if (value === "remove") this.#onConfirm({ kind: "all", provider: view.provider, rows: view.rows });
			else this.#show({ kind: "rows", provider: view.provider });
		}
	}
}

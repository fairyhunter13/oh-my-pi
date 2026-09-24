import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import { type SelectItem, SelectList } from "../components/select-list";
import { credentialItem } from "../setup/scenes/credential-format";
import { getSelectListTheme } from "../theme/theme";
import type { SgrMouseEvent } from "../mouse";

const MAX_VISIBLE = 10;

/** One provider row in the top-level provider list. */
export interface CredentialPickerProvider {
	id: string;
	name: string;
	/** "2 subscriptions · 1 API key", or where env/config auth for this provider comes from. */
	summary: string;
	/** True when this provider has no stored credential to act on (env/config only). */
	disabled: boolean;
}

/** What the picker resolved to: one stored row, or a request to add a new one. */
export type CredentialPickerTarget =
	| { kind: "row"; provider: string; row: CredentialSummary }
	| { kind: "new"; provider: string };

type PickerView =
	| { kind: "providers" }
	| { kind: "rows"; provider: string }
	| { kind: "confirm"; provider: string; row: CredentialSummary };

export interface CredentialPickerOptions {
	/** Verb in the headings: "Log out", "Usage", "Log in", "Stats". */
	verb: string;
	providers: readonly CredentialPickerProvider[];
	rowsByProvider: ReadonlyMap<string, readonly CredentialSummary[]>;
	initialProvider?: string;
	/** Esc on the rows view cancels instead of returning to the provider list. */
	lockProvider?: boolean;
	/** First item of the rows view; picking it yields `{ kind: "new" }`. */
	newItem?: { label: string; description: string };
	/** When set, a picked row opens a keep/act confirmation first. */
	confirm?: {
		heading: (provider: string, row: CredentialSummary) => string;
		actLabel: (row: CredentialSummary) => string;
	};
	onPick: (target: CredentialPickerTarget) => void;
	onCancel: () => void;
}

/**
 * One credential picker shared by `/logout`, `/usage`, `/login` and `/stats`:
 * every provider with stored credentials (or only an env/config source, shown
 * disabled), then that provider's rows, then an optional keep/act
 * confirmation. Esc steps back one view; Esc on the provider list cancels
 * (or on the rows view too, when `lockProvider` is set).
 */
export class CredentialPickerComponent extends OverlayPanel {
	#verb: string;
	#providers: readonly CredentialPickerProvider[];
	#rowsByProvider: ReadonlyMap<string, readonly CredentialSummary[]>;
	#lockProvider: boolean;
	#newItem?: { label: string; description: string };
	#confirm?: {
		heading: (provider: string, row: CredentialSummary) => string;
		actLabel: (row: CredentialSummary) => string;
	};
	#onPick: (target: CredentialPickerTarget) => void;
	#onCancel: () => void;
	#view: PickerView;
	#list: SelectList;

	constructor(options: CredentialPickerOptions) {
		super("");
		this.#verb = options.verb;
		this.#providers = options.providers;
		this.#rowsByProvider = options.rowsByProvider;
		this.#lockProvider = options.lockProvider ?? false;
		this.#newItem = options.newItem;
		this.#confirm = options.confirm;
		this.#onPick = options.onPick;
		this.#onCancel = options.onCancel;
		this.#view = options.initialProvider
			? { kind: "rows", provider: options.initialProvider }
			: { kind: "providers" };
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
				return `${this.#verb} — pick a provider`;
			case "rows":
				return `${this.#verb}: ${view.provider} — pick a credential`;
			case "confirm":
				return this.#confirm!.heading(view.provider, view.row);
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
				const items: SelectItem[] = [];
				if (this.#newItem)
					items.push({ value: "row:new", label: this.#newItem.label, description: this.#newItem.description });
				items.push(...rows.map(credentialItem));
				return items;
			}
			case "confirm":
				return [
					{ value: "keep", label: "Keep it" },
					{ value: "act", label: this.#confirm!.actLabel(view.row) },
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
			else if (view.kind === "rows") {
				if (this.#lockProvider) this.#onCancel();
				else this.#show({ kind: "providers" });
			} else this.#show({ kind: "rows", provider: view.provider });
		};
		return list;
	}

	#show(view: PickerView): void {
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
			if (value === "row:new") {
				this.#onPick({ kind: "new", provider: view.provider });
			} else if (value.startsWith("row:")) {
				const id = Number(value.slice("row:".length));
				const row = (this.#rowsByProvider.get(view.provider) ?? []).find(candidate => candidate.id === id);
				if (!row) return;
				if (this.#confirm) this.#show({ kind: "confirm", provider: view.provider, row });
				else this.#onPick({ kind: "row", provider: view.provider, row });
			}
		} else if (view.kind === "confirm") {
			if (value === "act") this.#onPick({ kind: "row", provider: view.provider, row: view.row });
			else this.#show({ kind: "rows", provider: view.provider });
		}
	}
}

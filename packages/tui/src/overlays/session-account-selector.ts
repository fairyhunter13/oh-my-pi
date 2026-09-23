import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import { credentialItem } from "../setup/scenes/credential-format";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/** What `/session pin` picked: one stored row, or the pool (clears the session's pin). */
export type SessionPinSelection = { kind: "row"; row: CredentialSummary } | { kind: "pool" };

/** Credential picker opened by `/session pin` for the current model's provider. */
export class SessionAccountSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		providerName: string,
		rows: readonly CredentialSummary[],
		onSelect: (selection: SessionPinSelection) => void,
		onCancel: () => void,
	) {
		super(`Select a ${providerName} credential for this session`);
		const selectionByValue = new Map<string, SessionPinSelection>();
		const items: SelectItem[] = rows.map(row => {
			const item = credentialItem(row);
			selectionByValue.set(item.value, { kind: "row", row });
			return item;
		});
		if (rows.some(row => row.pinned)) {
			const value = "pool";
			selectionByValue.set(value, { kind: "pool" });
			items.push({ value, label: "Pick again at the next request", description: "Clears this session's choice" });
		}

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
		);
		const activeIndex = rows.findIndex(row => row.active);
		if (activeIndex >= 0) this.#selectList.setSelectedIndex(activeIndex);
		this.#selectList.onSelect = item => {
			const selection = selectionByValue.get(item.value);
			if (selection) onSelect(selection);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}

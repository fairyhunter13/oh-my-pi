import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

function ctxWith(credential: SegmentContext["credential"]): SegmentContext {
	return { credential, startupPlaceholder: false } as unknown as SegmentContext;
}

describe("credential status-line segment (Addendum 5 S-3)", () => {
	it("hides when the host reports no credential to disambiguate (one row or none)", () => {
		const rendered = renderSegment("credential", ctxWith(null));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("shows the label and id for an unpinned session", () => {
		const rendered = renderSegment("credential", ctxWith({ label: "Work", id: 5, pinned: false }));
		expect(rendered.visible).toBe(true);
		expect(plain(rendered.content)).toBe("Work #5");
	});

	it("marks a pinned session", () => {
		const rendered = renderSegment("credential", ctxWith({ label: "Work", id: 5, pinned: true }));
		expect(rendered.visible).toBe(true);
		expect(plain(rendered.content)).toContain("pinned");
		expect(plain(rendered.content)).toContain("Work #5");
	});
});

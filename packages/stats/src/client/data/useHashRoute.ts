import { useCallback, useEffect, useState } from "react";
import type { DashboardSection } from "../app/routes";
import type { TimeRange } from "../types";

const VALID_SECTIONS: DashboardSection[] = [
	"overview",
	"requests",
	"traces",
	"errors",
	"models",
	"providers",
	"tools",
	"costs",
	"behavior",
	"projects",
	"gain",
];

const VALID_RANGES: TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

interface ParsedRoute {
	section: DashboardSection;
	range: TimeRange;
	session: string | null;
	/** `<provider>:<id|none>`, formatted per `formatStatsCredential`. `null` until picked. */
	credential: string | null;
}

function parseHash(hash: string): ParsedRoute {
	const cleanHash = hash.replace(/^#\/?/, "");
	const [pathPart, queryPart] = cleanHash.split("?");

	const section: DashboardSection = (VALID_SECTIONS as string[]).includes(pathPart)
		? (pathPart as DashboardSection)
		: "overview";

	let range: TimeRange = "24h";
	let session: string | null = null;
	let credential: string | null = null;
	if (queryPart) {
		const params = new URLSearchParams(queryPart);
		const rangeParam = params.get("range") as TimeRange;
		if (VALID_RANGES.includes(rangeParam)) {
			range = rangeParam;
		}
		session = params.get("s");
		credential = params.get("cred");
	}

	return { section, range, session, credential };
}

function buildHash(section: string, range: TimeRange, session?: string | null, credential?: string | null): string {
	const sessionPart = session ? `&s=${encodeURIComponent(session)}` : "";
	const credentialPart = credential ? `&cred=${encodeURIComponent(credential)}` : "";
	return `/${section}?range=${range}${sessionPart}${credentialPart}`;
}

export function useHashRoute() {
	const [route, setRouteState] = useState(() => parseHash(window.location.hash));

	useEffect(() => {
		const handleHashChange = () => {
			setRouteState(parseHash(window.location.hash));
		};

		window.addEventListener("hashchange", handleHashChange);
		return () => {
			window.removeEventListener("hashchange", handleHashChange);
		};
	}, []);

	const updateHash = useCallback(
		(section: string, range: TimeRange, session?: string | null, credential?: string | null) => {
			window.location.hash = buildHash(section, range, session, credential);
		},
		[],
	);

	const setSection = useCallback(
		(newSection: DashboardSection) => {
			// The deep-linked session only applies to the traces view.
			updateHash(newSection, route.range, newSection === "traces" ? route.session : null, route.credential);
		},
		[route.range, route.session, route.credential, updateHash],
	);

	const setRange = useCallback(
		(newRange: string) => {
			const nextRange = VALID_RANGES.includes(newRange as TimeRange) ? (newRange as TimeRange) : "24h";
			updateHash(route.section, nextRange, route.session, route.credential);
		},
		[route.section, route.session, route.credential, updateHash],
	);

	const setSession = useCallback(
		(file: string | null) => {
			updateHash(route.section, route.range, file, route.credential);
		},
		[route.section, route.range, route.credential, updateHash],
	);

	const setCredential = useCallback(
		(credential: string | null) => {
			updateHash(route.section, route.range, route.session, credential);
		},
		[route.section, route.range, route.session, updateHash],
	);

	useEffect(() => {
		const currentHash = window.location.hash;
		const parsed = parseHash(currentHash);
		const expectedHash = `#${buildHash(parsed.section, parsed.range, parsed.session, parsed.credential)}`;
		if (currentHash !== expectedHash) {
			window.location.hash = buildHash(parsed.section, parsed.range, parsed.session, parsed.credential);
		}
	}, []);

	return {
		section: route.section,
		setSection,
		range: route.range,
		setRange,
		session: route.session,
		setSession,
		credential: route.credential,
		setCredential,
	};
}

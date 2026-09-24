import { useEffect, useState } from "react";
import { getCredentials } from "../api";

export interface CredentialControlProps {
	value: string | null;
	onChange: (value: string | null) => void;
	className?: string;
}

/**
 * Every route reads its numbers for one credential only, so this is not an
 * optional filter: the first option is a disabled placeholder, and every
 * other option is one stored `auth_credentials` row or a provider's
 * `<provider> · unattributed` bucket.
 */
export function CredentialControl({ value, onChange, className = "" }: CredentialControlProps) {
	const [options, setOptions] = useState<{ id: string; label: string }[]>([]);

	useEffect(() => {
		let cancelled = false;
		getCredentials()
			.then(rows => {
				if (cancelled) return;
				setOptions(rows.map(row => ({ id: row.id, label: row.label })));
			})
			.catch(() => {
				if (!cancelled) setOptions([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<select
			className={`stats-credential-control ${className}`}
			aria-label="Select credential"
			value={value ?? ""}
			onChange={e => onChange(e.target.value || null)}
		>
			<option value="" disabled>
				Pick a credential
			</option>
			{options.map(opt => (
				<option key={opt.id} value={opt.id}>
					{opt.label}
				</option>
			))}
		</select>
	);
}

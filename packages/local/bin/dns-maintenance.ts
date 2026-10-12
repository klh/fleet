/** A serialized reconciliation pass; disabled registrations stay disabled. */
export async function maintainDnsClaims(options: {
	registrations: { name: string; dns: { claimed: boolean } }[];
	reconcile: (name: string) => Promise<void>;
	onError: (name: string, error: unknown) => void;
}): Promise<void> {
	for (const registration of options.registrations) {
		if (!registration.dns.claimed) continue;
		try {
			await options.reconcile(registration.name);
		} catch (error) {
			options.onError(registration.name, error);
		}
	}
}

/** Never terminate a reused PID or a claim handed to another owner. */
export function releaseOwnedClaims(options: {
	owned: Map<string, { pid: number; argv: string[] }>;
	currentPid: (name: string) => number | undefined;
	matches: (pid: number, argv: string[]) => boolean;
	terminate: (pid: number) => void;
}): void {
	for (const [name, claim] of options.owned) {
		if (
			options.currentPid(name) === claim.pid &&
			options.matches(claim.pid, claim.argv)
		)
			options.terminate(claim.pid);
	}
}

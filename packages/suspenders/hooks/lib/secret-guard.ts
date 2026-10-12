// hooks/lib/secret-guard.ts — credential-material guard shared by every
// starter surface (W454 seed guard, W458.1 artifact validation): anything
// that lands in shared or cached history must pass it. One pattern, one home.
export const SECRET_PATTERN =
	/sk-[A-Za-z0-9_-]{8,}|bksk_[A-Za-z0-9_-]{8,}|gho_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xoxb-|BEGIN (RSA|OPENSSH) PRIVATE KEY/;

export const assertNoSecrets = (text: string): void => {
	const hits = text.match(SECRET_PATTERN);
	if (hits)
		throw new Error(
			`secret guard refused — credential material detected: ${hits[0].slice(0, 8)}…`,
		);
};

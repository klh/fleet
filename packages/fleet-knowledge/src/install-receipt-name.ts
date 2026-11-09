// src/install-receipt-name.ts — the install-receipt filename the --version face walks up for.
// Fleet installs drop harness-receipt.json at the prefix root; standalone checkouts report
// `unknown` honestly (repo/test contexts never carry one).
export const RECEIPT_FILE = "harness-receipt.json";

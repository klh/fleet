import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "*.e2e.ts", workers: 1 });

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@internship-agent\/(.*)$/, replacement: path.resolve(root, "packages/$1/src/index.ts") }
    ]
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/worktrees/**"
    ]
  }
});

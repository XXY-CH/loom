import { defineConfig } from "vitest/config";

export default defineConfig({
  // The React component tests under web/ rely on the automatic JSX runtime;
  // existing Node tests are unaffected by this transform setting.
  esbuild: { jsx: "automatic" },
  test: { include: ["tests/**/*.test.ts", "web/**/*.test.tsx"] },
});

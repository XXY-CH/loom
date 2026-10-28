import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Run as `vite build web --config web/vite.config.ts` from the repository
// root: the positional root is web/, and the build output lands in web/dist,
// which the service HTTP projection picks up automatically for same-origin
// serving. No dev-server proxy is needed in production because the workbench
// is served by the local service itself.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

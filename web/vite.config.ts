import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Multi-chunk build (routes code-split) emitted to dist/, served by FastAPI via
// StaticFiles with an SPA fallback. Dev proxies /api and /panel to the server.
export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": "http://localhost:5006",
      "/panel": { target: "http://localhost:5006", ws: true },
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
});

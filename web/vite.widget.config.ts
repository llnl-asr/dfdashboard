import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "../dfdashboard/widgets/static",
    emptyOutDir: false,
    target: "es2020",
    lib: {
      entry: { timeline: "src/widget/timeline.widget.tsx" },
      formats: ["es"],
    },
    rollupOptions: {
      output: { entryFileNames: "[name].js" },
    },
  },
});

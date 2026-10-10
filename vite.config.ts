import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // Keep shared React/translation code separate from application changes.
        // Each cacheable chunk stays within Vite's normal size budget.
        manualChunks(id) {
          if (id.replaceAll("\\", "/").includes("/node_modules/")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/apps/**"],
    },
  },
});

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: true,
    // `npm run dev`: UI from Vite, WebSocket from the running server (npm run serve)
    proxy: { "/ws": { target: "ws://localhost:8080", ws: true }, "/api": "http://localhost:8080" },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 600 },
});

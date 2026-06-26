import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard dev server. API + SSE are proxied to the server daemon (default :4317).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4318,
    proxy: {
      "/api": "http://localhost:4317",
      "/events": {
        target: "http://localhost:4317",
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    // Built assets are served statically by the Fastify server in production.
    outDir: "dist",
  },
});

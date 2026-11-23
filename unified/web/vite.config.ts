import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.VITE_API_BASE || "http://127.0.0.1:18080";
  return {
    plugins: [react()],
    build: { outDir: "dist", sourcemap: false },
    server: {
      proxy: { "/api": target, "/v1": target },
    },
  };
});

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig(({ mode }) => {
  // Vitest gets a plain node config: unit tests never boot workerd.
  if (mode === "test") {
    return {
      resolve: { alias },
      test: {
        environment: "node",
        include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
        restoreMocks: true,
        clearMocks: true,
      },
    };
  }
  return {
    resolve: { alias },
    plugins: [react(), tailwindcss(), cloudflare()],
  };
});

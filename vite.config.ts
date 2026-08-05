import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";

function normalizeBasePath(value: string): "" | `/${string}` {
  const basePath = value.trim().replace(/\/+$/, "");
  if (!basePath) return "";
  if (!basePath.startsWith("/")) {
    throw new Error("BASE_PATH must be empty or start with '/'.");
  }
  return basePath as `/${string}`;
}

export default defineConfig(({ mode }) => {
  // Load all prefixes so the deployment-only BASE_PATH environment variable is
  // available to the Vite config without relying on an undeclared Node global.
  const { BASE_PATH = "" } = loadEnv(mode, ".", "");
  const basePath = normalizeBasePath(BASE_PATH);

  return {
    plugins: [
      tailwindcss(),
      sveltekit({
        compilerOptions: {
          // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
          runes: ({ filename }) =>
            filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
        },

        // configuring the static adapter for all-time SSG
        adapter: adapter({
          pages: "build",
          assets: "build",
          fallback: undefined,
          precompress: false,
          strict: true,
        }),

        paths: {
          base: basePath,
        },
      }),
    ],
  };
});

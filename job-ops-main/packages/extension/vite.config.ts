import { resolve } from "node:path";
import { cpSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function copyStaticFiles() {
  return {
    name: "copy-static-files",
    closeBundle() {
      cpSync(
        resolve(__dirname, "manifest.json"),
        resolve(__dirname, "dist/manifest.json"),
      );
      cpSync(
        resolve(__dirname, "popup.html"),
        resolve(__dirname, "dist/popup.html"),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const isContentScript = mode === "content-script";

  if (isContentScript) {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: {
          input: {
            "content-script": resolve(__dirname, "src/content-script.ts"),
          },
          output: {
            entryFileNames: "[name].js",
            format: "iife",
          },
        },
      },
    };
  }

  return {
    plugins: [react(), copyStaticFiles()],
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          background: resolve(__dirname, "background.ts"),
          popup: resolve(__dirname, "src/popup/index.tsx"),
        },
        output: {
          entryFileNames: "[name].js",
          format: "es",
        },
      },
      emptyOutDir: true,
    },
  };
});

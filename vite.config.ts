import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";

// base "./" keeps every URL relative, so the same build works at
// https://heisenberg-vau.github.io/Visual-Library/ and on localhost.
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/*.png", "icons/*.svg"],
      manifest: {
        name: "Visual Library",
        short_name: "Visual Library",
        description: "Đọc và ghi chú tài liệu PDF trên Xiaomi Pad",
        lang: "vi",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "any",
        background_color: "#efe5cf",
        theme_color: "#3b2719",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,png,svg,wasm,bcmap,pfb,ttf,icc,gz,woff2}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});

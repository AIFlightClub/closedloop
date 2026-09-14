import { defineConfig } from "vite";
export default defineConfig({
  base: "/loopin/",
  server: {
    port: 5173,
    proxy: {
      "/loopin/api": "http://127.0.0.1:9798",
      "/loopin/ws": { target: "ws://127.0.0.1:9798", ws: true },
    },
  },
});

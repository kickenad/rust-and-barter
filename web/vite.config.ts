import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// GitHub Pages serves the app at /rust-and-barter/; set VITE_BASE there. Local dev/preview uses a relative base.
export default defineConfig({ plugins: [react()], base: process.env.VITE_BASE ?? "./" });

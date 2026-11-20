import { defineConfig } from 'vite';

// `base: './'` keeps every asset URL relative, so the built site works on
// GitHub Pages under any repository path (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
});

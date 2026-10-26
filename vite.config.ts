/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localFiles } from './vite-plugins/localFiles.js';
import { projectStore } from './vite-plugins/projectStore.js';
import { saveFiles } from './vite-plugins/saveFiles.js';
import { transcribe } from './vite-plugins/transcribe.js';

export default defineConfig({
  plugins: [react(), localFiles(), projectStore(), saveFiles(), transcribe()],
  build: { chunkSizeWarningLimit: 1500 },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

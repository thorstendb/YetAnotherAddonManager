// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
// Vitest config WITHOUT the electron/electron-renderer plugins: their node-API
// shims (fs → .vite-electron-renderer/fs.mjs) break plain Node test files.
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
  },
});

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    env: { DEVCONTINUITY_DATA_DIR: path.resolve(__dirname, 'data', 'tmp', 'test-data') },
  },
});

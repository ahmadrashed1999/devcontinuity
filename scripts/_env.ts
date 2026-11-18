// Loaded first by every script. Makes the CLI and MCP server work from any working directory:
// they always use this installation's data folder and .env files.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* unreadable env file: continue without it */
    }
  }
}
if (!process.env.DEVCONTINUITY_DATA_DIR) process.env.DEVCONTINUITY_DATA_DIR = path.join(root, 'data');

if (!process.env.DEVCONTINUITY_APP_ROOT) process.env.DEVCONTINUITY_APP_ROOT = root;

export const APP_ROOT = root;

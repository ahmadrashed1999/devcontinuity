// Loaded first by every script. Makes the CLI and MCP server work from any working directory:
// they always use this installation's data folder and .env files (see scripts/paths.mjs).
import { APP_ROOT, prepareEnv } from './paths.mjs';

prepareEnv();

export { APP_ROOT };

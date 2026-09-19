import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function dependency(name) {
  try { return require(name); } catch {
    if (!process.env.HISTORY_SWEEP_NODE_MODULES) throw new Error('Run npm install, or set HISTORY_SWEEP_NODE_MODULES to the bundled node_modules path.');
    return require(process.env.HISTORY_SWEEP_NODE_MODULES + '/' + name);
  }
}

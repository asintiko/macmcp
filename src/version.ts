import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolves from both src/ (tests) and dist/ (installed package).
const pkg = require('../package.json') as { name: string; version: string };

export const NAME: string = pkg.name;
export const VERSION: string = pkg.version;

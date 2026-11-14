#!/usr/bin/env node
import { main } from './app.js';

const argv = process.argv.slice(2);
main({ argv }).then(
  (code) => {
    process.exitCode = code;
    // The embedded tunnel agent can leave handles open; do not let them keep a finished command alive.
    setTimeout(() => process.exit(code), 500).unref();
  },
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

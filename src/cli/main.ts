#!/usr/bin/env node
import { NAME, VERSION } from '../version.js';

// Placeholder entry point for milestone M0; the full CLI arrives in M3.
const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  console.log(VERSION);
} else {
  console.log(`${NAME} ${VERSION}`);
}

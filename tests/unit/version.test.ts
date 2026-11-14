import { describe, expect, it } from 'vitest';
import { NAME, VERSION } from '../../src/version.js';

describe('version', () => {
  it('exposes the package name and a semver version', () => {
    expect(NAME).toBe('mcpclaude');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

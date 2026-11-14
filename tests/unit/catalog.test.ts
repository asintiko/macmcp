import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { assetPath } from '../../src/assets.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { GUIDE_TOPICS } from '../../src/tools/meta.js';
import { renderDescription, TOOL_GROUPS } from '../../src/tools/registry.js';

/**
 * Lint for the real tool catalogue: every tool must be documented well enough for an agent
 * to use it without guessing (brief requirement: schema, parameter definitions, usage
 * instructions, example calls).
 */
const registry = createToolRegistry();
const tools = registry.all();

type Schema = { type?: string; description?: string; properties?: Record<string, Schema>; items?: Schema; [key: string]: unknown };

function undescribed(schema: Schema, trail: string): string[] {
  const missing: string[] = [];
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const where = `${trail}.${key}`;
    if (!property.description || property.description.trim().length < 3) missing.push(where);
    missing.push(...undescribed(property, where));
    if (property.items) missing.push(...undescribed(property.items, `${where}[]`));
  }
  return missing;
}

function keywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((entry) => keywords(entry, found));
  else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      found.add(key);
      // Property names are data, not keywords.
      if (key === 'properties' && value && typeof value === 'object') Object.values(value).forEach((v) => keywords(v, found));
      else keywords(value, found);
    }
  }
  return found;
}

describe('tool catalogue', () => {
  it('has unique snake_case names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]+$/);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s has a title, usage notes and a known group', (_name, tool) => {
    expect(tool.title.trim().length).toBeGreaterThan(2);
    expect(tool.description.trim().length).toBeGreaterThanOrEqual(40);
    expect(TOOL_GROUPS[tool.group]).toBeDefined();
    expect(['any', 'full']).toContain(tool.access);
    // Clients truncate very long descriptions; keep the rendered text compact.
    expect(renderDescription(tool).length).toBeLessThanOrEqual(1400);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s describes every parameter', (_name, tool) => {
    const schema = z.toJSONSchema(tool.input) as Schema;
    expect(schema.type).toBe('object');
    expect(undescribed(schema, tool.name)).toEqual([]);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s uses only widely supported JSON Schema keywords', (_name, tool) => {
    const used = keywords(z.toJSONSchema(tool.input));
    for (const risky of ['$ref', '$defs', 'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties', 'if']) {
      expect(used.has(risky), `${tool.name} uses ${risky}`).toBe(false);
    }
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s has example calls that satisfy its schema', (_name, tool) => {
    expect(tool.examples.length).toBeGreaterThanOrEqual(1);
    const known = Object.keys((z.toJSONSchema(tool.input) as Schema).properties ?? {});
    for (const example of tool.examples) {
      const parsed = tool.input.safeParse(example.arguments);
      expect(parsed.success, `${tool.name} example ${JSON.stringify(example.arguments)}: ${parsed.error?.message}`).toBe(true);
      for (const key of Object.keys(example.arguments)) expect(known, `${tool.name} example uses unknown parameter ${key}`).toContain(key);
    }
  });

  it('ships a guide file for every usage_guide topic', async () => {
    for (const topic of GUIDE_TOPICS) {
      await expect(access(assetPath('guides', `${topic}.md`))).resolves.toBeUndefined();
    }
  });
});

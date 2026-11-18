import { describe, expect, it } from 'vitest';
import { demoAllows } from '../src/server/demo';

describe('read-only demo mode', () => {
  it('allows reads of the workspace and refuses every write', () => {
    expect(demoAllows('GET', ['sessions'])).toBe(true);
    expect(demoAllows('GET', ['search'])).toBe(true);
    expect(demoAllows('GET', ['sessions', 'abc', 'events'])).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(demoAllows(m, ['import'])).toBe(false);
      expect(demoAllows(m, ['live', 'connect'])).toBe(false);
      expect(demoAllows(m, ['launch'])).toBe(false);
      expect(demoAllows(m, ['ask'])).toBe(false);
    }
  });

  it('refuses reads that would describe the host machine or hand out files', () => {
    expect(demoAllows('GET', ['inventory'])).toBe(false);
    expect(demoAllows('GET', ['agents', 'detect'])).toBe(false);
    expect(demoAllows('GET', ['providers'])).toBe(false);
    expect(demoAllows('GET', ['providers', 'x', 'models'])).toBe(false);
    expect(demoAllows('GET', ['backups', 'b1', 'download'])).toBe(false);
    expect(demoAllows('GET', ['projects', 'p1', 'github'])).toBe(false);
  });
});

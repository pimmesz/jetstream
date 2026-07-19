import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { augmentedPath } from './exec-path';

// The 4 global-install dirs augmentedPath appends, in order.
const EXTRA_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.npm-global', 'bin'),
];

describe('augmentedPath', () => {
  it('appends the global-bin dirs after the caller PATH', () => {
    expect(augmentedPath({ PATH: '/my/bin' })).toBe(['/my/bin', ...EXTRA_DIRS].join(delimiter));
  });

  it('tolerates an absent or empty PATH without a leading empty segment', () => {
    const extrasOnly = EXTRA_DIRS.join(delimiter);
    expect(augmentedPath({})).toBe(extrasOnly);
    expect(augmentedPath({ PATH: '' })).toBe(extrasOnly);
  });
});

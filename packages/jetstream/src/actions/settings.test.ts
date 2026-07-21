import { describe, it, expect } from 'vitest';
import {
  fixId,
  isBuildLayout,
  isDiagnostics,
  isHealthCheck,
  isProfileSwitch,
  isToolDetail,
  hasWarnings,
} from './settings';
import type { CheckResult } from '../doctor';

// Each guard matches exactly one { key: 'value' } shape from the property inspector and
// must reject everything else — payloads arrive as untrusted unknown JSON.
const guards = [
  { guard: isHealthCheck, key: 'health', value: 'check' },
  { guard: isProfileSwitch, key: 'profile', value: 'switch' },
  { guard: isToolDetail, key: 'hooks', value: 'toolDetail' },
  { guard: isBuildLayout, key: 'build', value: 'layout' },
  { guard: isDiagnostics, key: 'diag', value: 'copy' },
] as const;

describe('property-inspector payload guards', () => {
  it('accept exactly their { key: value } shape', () => {
    for (const { guard, key, value } of guards) {
      expect(guard({ [key]: value })).toBe(true);
      expect(guard({ [key]: value, extra: 1 })).toBe(true); // extra keys are fine
    }
  });

  it('reject null, non-objects, and missing keys', () => {
    for (const { guard, value } of guards) {
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard(value)).toBe(false); // the bare string is not the shape
      expect(guard(42)).toBe(false);
      expect(guard({})).toBe(false);
    }
  });

  it('reject the right key with the wrong value or type', () => {
    for (const { guard, key } of guards) {
      expect(guard({ [key]: 'other' })).toBe(false);
      expect(guard({ [key]: true })).toBe(false);
      expect(guard({ [key]: null })).toBe(false);
    }
  });

  it('do not answer to each other\'s payloads', () => {
    for (const { guard, key } of guards) {
      for (const other of guards) {
        if (other.key === key) continue;
        expect(guard({ [other.key]: other.value })).toBe(false);
      }
    }
  });
});

// This is now purely about the FACE. The press is unconditional — it always opens doctor — because
// a press whose meaning depends on invisible health state is unpredictable: a permanently-warning
// check (the token grace period warns for two releases) used to hijack the key for that whole
// window, making its other action unreachable and a press look like it did nothing.
describe('hasWarnings', () => {
  const ok = (message: string): CheckResult => ({ status: 'ok', message });
  const warn = (message: string): CheckResult => ({ status: 'warn', message });

  it("is true while any check is failing (drives the amber 'setup N/M' face)", () => {
    expect(hasWarnings([ok('claude on PATH'), warn('9/10: update available')])).toBe(true);
    expect(hasWarnings([warn('no projects yet')])).toBe(true);
  });

  it('is false once every check passes, and for an empty checklist', () => {
    expect(hasWarnings([ok('claude on PATH'), ok('on the latest version')])).toBe(false);
    expect(hasWarnings([])).toBe(false);
  });
});

describe('fixId', () => {
  it('returns the fix id when it is a string', () => {
    expect(fixId({ fix: 'hooks' })).toBe('hooks');
    expect(fixId({ fix: 'fleet' })).toBe('fleet');
  });

  it('returns undefined for null, non-objects, missing, and non-string fix', () => {
    expect(fixId(null)).toBeUndefined();
    expect(fixId(undefined)).toBeUndefined();
    expect(fixId({})).toBeUndefined();
    expect(fixId({ fix: 7 })).toBeUndefined();
    expect(fixId({ fix: { id: 'hooks' } })).toBeUndefined();
    expect(fixId('hooks')).toBeUndefined(); // the bare string is not the shape
  });
});

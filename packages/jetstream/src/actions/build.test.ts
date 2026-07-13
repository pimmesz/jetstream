import { describe, it, expect } from 'vitest';
import { BUILD_ID } from './build';

describe('BUILD_ID', () => {
  it("is 'dev' when compiled without the build-time define (i.e. under vitest)", () => {
    // esbuild's `define` only runs in scripts/build.mjs; the typeof guard must keep an untooled
    // import (tests, tsx) from throwing a ReferenceError on the undeclared __BUILD_ID__.
    expect(BUILD_ID).toBe('dev');
  });
});

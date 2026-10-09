// Pure path helpers for scripts/build.mjs, kept apart so vitest can cover them without a build.
import { relative, sep } from 'node:path';

/** Stands in for the builder's checkout in every bundled path, so no home directory ships. */
export const NEUTRAL_PREFIX = 'jetstream/';

/** How esbuild spells the repo root in module keys and path comments: relative to its working
 * dir, with forward slashes and a trailing slash. Pass both paths through realpath first.
 * Empty when the working dir is the repo root or inside it: esbuild's paths then name no folder
 * above the repo, and a bare `../` prefix would also match runtime URLs like `../imgs/plugin.png`. */
export function repoPrefix(workingDir, repoRoot) {
  const segments = relative(workingDir, repoRoot).split(sep);
  if (segments.every((segment) => segment === '' || segment === '..')) return '';
  return `${segments.join('/')}/`;
}

/** Swap the repo prefix everywhere at once, so each `__commonJS` key and every other spelling of
 * the same module path change together and stay equal. An empty prefix has nothing to hide. */
export function neutralizeRepoPaths(code, prefix) {
  if (prefix === '') return code;
  return code.replaceAll(prefix, NEUTRAL_PREFIX);
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

// The helper is plain JS beside build.mjs and tsc does not type .mjs files, so its shape is named here.
interface BundlePaths {
  NEUTRAL_PREFIX: string;
  repoPrefix: (workingDir: string, repoRoot: string) => string;
  neutralizeRepoPaths: (code: string, prefix: string) => string;
}
const helper = new URL('../scripts/bundle-paths.mjs', import.meta.url).href;
const { NEUTRAL_PREFIX, neutralizeRepoPaths, repoPrefix } = (await import(helper)) as BundlePaths;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// A repo with one CommonJS dependency and an entry that also resolves a runtime relative URL,
// the same shape as the bundled logo lookup in slot-icon.ts.
function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jetstream-bundle-paths-')));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(
    join(repo, 'node_modules', 'dep', 'index.js'),
    'module.exports = { answer: 42 };\n',
  );
  writeFileSync(
    join(repo, 'entry.mjs'),
    "import dep from 'dep';\nconsole.log(dep.answer, new URL('../imgs/plugin.png', import.meta.url).href);\n",
  );
  return { root, repo };
}

// Bundles the entry from `work` the way build.mjs does from tmpdir(), into `<root>/out`.
async function bundleFrom(work: string, repo: string, root: string): Promise<string> {
  mkdirSync(work, { recursive: true });
  const bundle = await build({
    absWorkingDir: work,
    metafile: true,
    entryPoints: { entry: join(repo, 'entry.mjs') },
    outdir: join(root, 'out'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
  });
  return resolve(work, Object.keys(bundle.metafile.outputs)[0]!);
}

// What the bundle prints: the dependency's answer and the URL resolved from `<root>/out`.
function expectedRun(root: string): string {
  return `42 ${pathToFileURL(join(root, 'imgs', 'plugin.png')).href}`;
}

describe('bundle paths: no builder home directory ships in a bundle', () => {
  it('rewrites every module key and path comment under the repo to one neutral prefix', () => {
    // The shape esbuild emits when absWorkingDir is the macOS temp dir and the repo is under HOME.
    const prefix = repoPrefix('/private/var/folders/x/T', '/Users/me/Personal/jetstream');
    expect(prefix).toBe('../../../../../Users/me/Personal/jetstream/');
    const ws = `${prefix}node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js`;
    const emitted = [
      `// ${ws}`,
      `var require_constants = __commonJS({\n  "${ws}"(exports, module) {\n    module.exports = {};\n  }\n});`,
      `// ${prefix}packages/jetstream/src/plugin.ts`,
    ].join('\n');

    const out = neutralizeRepoPaths(emitted, prefix);

    expect(out).not.toContain('/Users/me');
    expect(out).toContain(
      `// ${NEUTRAL_PREFIX}node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js`,
    );
    expect(out).toContain(
      `"${NEUTRAL_PREFIX}node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js"(exports, module)`,
    );
    expect(out).toContain(`// ${NEUTRAL_PREFIX}packages/jetstream/src/plugin.ts`);
  });

  it('a real esbuild bundle loses the repo path and still runs its CommonJS dependency', async () => {
    const { root, repo } = makeRepo();
    // A working dir deeper than the repo, so esbuild walks up through `../` as it does from tmpdir().
    const work = join(root, 'a', 'b', 'work');
    const file = await bundleFrom(work, repo, root);
    const prefix = repoPrefix(work, repo);
    const before = readFileSync(file, 'utf8');
    expect(before).toContain(`${prefix}node_modules/dep/index.js`); // the shape the rewrite targets

    writeFileSync(file, neutralizeRepoPaths(before, prefix));

    const after = readFileSync(file, 'utf8');
    expect(after).not.toContain(repo);
    expect(after).not.toContain(prefix);
    expect(after).toContain(`"${NEUTRAL_PREFIX}node_modules/dep/index.js"`);
    expect(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim()).toBe(
      expectedRun(root),
    );
  });

  // A TMPDIR at or inside the checkout makes the prefix a bare `../` or `/`, which would also
  // rewrite runtime URLs such as the logo lookup in slot-icon.ts.
  it.each([
    ['inside the repo', ['.tmp']],
    ['at the repo root', []],
  ])(
    'a working dir %s rewrites nothing and keeps runtime relative URLs',
    async (_where, below) => {
      const { root, repo } = makeRepo();
      const work = join(repo, ...below);
      const file = await bundleFrom(work, repo, root);
      const prefix = repoPrefix(work, repo);
      expect(prefix).toBe('');
      const before = readFileSync(file, 'utf8');
      expect(before).not.toContain(repo); // esbuild's own paths stay inside the repo here

      writeFileSync(file, neutralizeRepoPaths(before, prefix));

      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim()).toBe(
        expectedRun(root),
      );
    },
  );
});

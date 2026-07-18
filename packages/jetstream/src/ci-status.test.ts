import { describe, it, expect } from 'vitest';
import {
  classifyChecks,
  worstCi,
  ciFace,
  readRepoCi,
  uniquePaths,
  pollFleetCi,
  isNewFailure,
  type CiExec,
  type CiState,
} from './ci-status';

describe('classifyChecks', () => {
  it('none for an empty rollup, unknown for a non-array', () => {
    expect(classifyChecks([])).toBe('none');
    expect(classifyChecks(null)).toBe('unknown');
    expect(classifyChecks('nope')).toBe('unknown');
  });

  it('passing only when every check succeeded (Checks-API + legacy shapes)', () => {
    expect(
      classifyChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
        { state: 'SUCCESS' },
      ]),
    ).toBe('passing');
  });

  it('failing wins over anything else', () => {
    expect(
      classifyChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failing');
    expect(classifyChecks([{ state: 'ERROR' }])).toBe('failing');
  });

  it('pending when a check is still running and none failed', () => {
    expect(
      classifyChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'QUEUED' }]),
    ).toBe('pending');
    expect(classifyChecks([{ state: 'PENDING' }])).toBe('pending');
  });

  it('fail-closed: an unreadable element downgrades passing to unknown', () => {
    expect(
      classifyChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'WAT' }, // unrecognized conclusion
      ]),
    ).toBe('unknown');
    expect(classifyChecks([{ nonsense: true }])).toBe('unknown');
    // ...but a real failure still wins over an unreadable one
    expect(
      classifyChecks([{ garbage: 1 }, { status: 'COMPLETED', conclusion: 'FAILURE' }]),
    ).toBe('failing');
  });
});

describe('worstCi', () => {
  it('rolls up worst-wins: failing > pending > unknown > passing > none', () => {
    expect(worstCi([])).toBe('none');
    expect(worstCi(['passing', 'none'])).toBe('passing');
    expect(worstCi(['passing', 'unknown'])).toBe('unknown');
    expect(worstCi(['unknown', 'pending'])).toBe('pending');
    expect(worstCi(['pending', 'failing', 'passing'])).toBe('failing');
  });
});

describe('ciFace', () => {
  it('maps each state to a distinct face', () => {
    expect(ciFace('failing').color).toBe('#e5484d');
    expect(ciFace('passing').color).toBe('#30a46c');
    expect(ciFace('pending').color).toBe('#0091ff');
    expect(ciFace('unknown').sub).toBe('no gh');
    expect(ciFace('none').sub).toBe('no PRs');
  });
});

describe('readRepoCi', () => {
  const out = (arr: unknown): Promise<{ stdout: string }> =>
    Promise.resolve({ stdout: JSON.stringify(arr) });

  it('rolls up open prefixed PRs, ignoring branches that do not match', async () => {
    const exec: CiExec = () =>
      out([
        {
          headRefName: 'afterburner/tests-abc',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
        },
        {
          headRefName: 'feature/mine',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ]);
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('failing');
  });

  it('none when no branch matches the prefix', async () => {
    const exec: CiExec = () => out([{ headRefName: 'feature/x', statusCheckRollup: [] }]);
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('none');
  });

  it('unknown when gh throws (missing / not authed)', async () => {
    const exec: CiExec = () => Promise.reject(new Error('gh: command not found'));
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('unknown');
  });

  it('unknown on non-JSON output', async () => {
    const exec: CiExec = () => Promise.resolve({ stdout: 'not json' });
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('unknown');
  });

  it('unknown when gh returns valid non-array JSON (never throws)', async () => {
    const exec: CiExec = () => Promise.resolve({ stdout: '{}' });
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('unknown');
  });

  it('skips a malformed PR record with no headRefName (never throws)', async () => {
    const exec: CiExec = () =>
      out([
        { statusCheckRollup: [] }, // no headRefName → skipped, not a crash
        {
          headRefName: 'afterburner/x',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      ]);
    expect(await readRepoCi('/repo', 'afterburner/', exec)).toBe('passing');
  });
});

describe('uniquePaths', () => {
  it('collects distinct non-empty paths (dedups seeded + placed)', () => {
    expect(
      uniquePaths([
        { id: 'a', name: 'A', path: '/a' },
        { id: 'b', name: 'B', path: '/a' }, // duplicate path
        { id: 'c', name: 'C', path: '' }, // empty path skipped
        { id: 'd', name: 'D', path: '/d' },
      ]),
    ).toEqual(['/a', '/d']);
  });
});

describe('pollFleetCi', () => {
  it('none for no paths, without calling gh', async () => {
    let calls = 0;
    const read = (): Promise<CiState> => {
      calls += 1;
      return Promise.resolve('passing');
    };
    expect(await pollFleetCi([], 'afterburner/', read)).toBe('none');
    expect(calls).toBe(0);
  });

  it('rolls up the worst CI state across repos', async () => {
    const read = (cwd: string): Promise<CiState> =>
      Promise.resolve(cwd === '/bad' ? 'failing' : 'passing');
    expect(await pollFleetCi(['/ok', '/bad'], 'afterburner/', read)).toBe('failing');
  });

  it('bounds gh fan-out — never more than 5 repos polled at once', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/repo${i}`);
    let inFlight = 0;
    let peak = 0;
    const read = async (): Promise<CiState> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      inFlight -= 1;
      return 'passing';
    };
    expect(await pollFleetCi(paths, 'afterburner/', read)).toBe('passing');
    expect(peak).toBe(5); // 12 repos > pool of 5 → it fills the pool but never exceeds it
  });
});

describe('isNewFailure', () => {
  it('true only on the transition into failing', () => {
    expect(isNewFailure('passing', 'failing')).toBe(true);
    expect(isNewFailure('none', 'failing')).toBe(true);
    expect(isNewFailure('failing', 'failing')).toBe(false); // stays red → no re-flash
    expect(isNewFailure('failing', 'passing')).toBe(false);
  });
});

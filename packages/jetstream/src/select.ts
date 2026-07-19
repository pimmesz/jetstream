import { emitKeypressEvents } from 'node:readline';

/**
 * A zero-dependency single-choice picker: arrow keys (↑/↓ + ⏎) on a real terminal, a numbered list
 * read through the injected `rl` otherwise (piped input, tests). Mirrors the CLI's
 * `selectOne` feel. ALWAYS restores the terminal (raw mode off, readline's own keypress listeners
 * reattached) on every exit path — a stuck terminal is the one unforgivable bug.
 */

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

/** The bits of a readline interface we use: a question-asker, optionally pausable (the real one is). */
interface Rl {
  question: (query: string) => Promise<string>;
  pause?: () => void;
  resume?: () => void;
}

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr('1');
const dim = sgr('2');
const cyan = sgr('36');

type NavKey = 'up' | 'down' | 'enter' | 'cancel' | null;
function normalizeKey(key: { name?: string; ctrl?: boolean } | undefined): NavKey {
  if (!key) return null;
  if (key.ctrl && key.name === 'c') return 'cancel';
  switch (key.name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'return':
    case 'enter':
      return 'enter';
    case 'escape':
      return 'cancel';
    default:
      return null;
  }
}

function isInteractive(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    typeof process.stdin.setRawMode === 'function'
  );
}

const abortError = (): NodeJS.ErrnoException => Object.assign(new Error('Aborted.'), { code: 'ABORT_ERR' });
const clamp = (i: number, count: number): number => Math.min(Math.max(i, 0), count - 1);

/** Numbered-list fallback (also the off-TTY / test path). Re-asks on invalid input; empty = default. */
async function numbered<T>(rl: Rl, prompt: string, choices: Choice<T>[], defaultIndex: number): Promise<T> {
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  for (;;) {
    const answer = (await rl.question(`${prompt} [${defaultIndex + 1}]: `)).trim();
    const index = answer === '' ? defaultIndex : Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index]!.value;
    console.log(`Enter a number from 1 to ${choices.length}.`);
  }
}

export async function selectOne<T>(
  rl: Rl,
  prompt: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (choices.length === 0) throw new Error('selectOne: no choices');
  if (!isInteractive()) return numbered(rl, prompt, choices, clamp(defaultIndex, choices.length));

  const stdin = process.stdin;
  // eslint-disable-next-line no-control-regex -- stripping SGR colour codes to measure real width
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const physicalRows = (lines: string[]): number => {
    const cols = process.stdout.columns || 80;
    return lines.reduce((n, line) => n + Math.max(1, Math.ceil(stripAnsi(line).length / cols)), 0);
  };

  return new Promise<T>((resolve, reject) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    let index = clamp(defaultIndex, choices.length);
    let prevRows = 0;
    // Readline keeps its OWN keypress listener; if it stays attached it double-handles every key and
    // buffers them into the next question(). Detach while we drive; restore in cleanup.
    const savedKeypress = stdin.listeners('keypress') as ((...a: unknown[]) => void)[];

    const draw = (first: boolean): void => {
      const lines = choices.map((c, i) => {
        const active = i === index;
        const ptr = active ? cyan('▸') : ' ';
        const label = active ? bold(c.label) : c.label;
        return `  ${ptr} ${label}${c.hint ? dim(` — ${c.hint}`) : ''}`;
      });
      lines.push(dim(`  ${prompt}  ·  ↑/↓ move · ⏎ select`));
      const reset = first ? '' : `\x1b[${prevRows}A\x1b[J`;
      process.stdout.write(reset + lines.map((l) => `${l}\n`).join(''));
      prevRows = physicalRows(lines);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      for (const listener of savedKeypress) stdin.on('keypress', listener);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      rl.resume?.();
      process.stdout.write(`\x1b[${prevRows}A\x1b[J`); // erase the menu; the caller prints the outcome
    };

    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }): void => {
      const k = normalizeKey(key);
      if (!k) return;
      if (k === 'cancel') {
        cleanup();
        reject(abortError());
        return;
      }
      if (k === 'enter') {
        cleanup();
        resolve(choices[index]!.value);
        return;
      }
      if (k === 'up') index = (index - 1 + choices.length) % choices.length;
      else if (k === 'down') index = (index + 1) % choices.length;
      draw(false);
    };

    rl.pause?.();
    for (const listener of savedKeypress) stdin.removeListener('keypress', listener);
    stdin.setRawMode(true);
    stdin.resume();
    draw(true);
    stdin.on('keypress', onKey);
  });
}

/** Numbered multi-select fallback (off-TTY / tests): lists the choices, reads a pick through
 * `rl.question`, returns values IN PICK ORDER. Empty = none; 'all' = everything; numbers like
 * "3,1,5" select those in the order typed (so the caller controls order without a TTY). */
async function numberedMany<T>(rl: Rl, prompt: string, choices: Choice<T>[]): Promise<T[]> {
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  const answer = (await rl.question(`${prompt} (numbers in order e.g. 3,1,5; 'all'; Enter for none): `))
    .trim()
    .toLowerCase();
  if (answer === '') return [];
  if (answer === 'all') return choices.map((c) => c.value);
  const seen = new Set<number>();
  const out: T[] = [];
  for (const part of answer.split(/[\s,]+/)) {
    if (!/^\d+$/.test(part)) continue;
    const n = Number.parseInt(part, 10);
    if (n < 1 || n > choices.length || seen.has(n)) continue;
    seen.add(n);
    out.push(choices[n - 1]!.value);
  }
  return out;
}

/**
 * A zero-dependency multi-select: arrow keys move, Space toggles, 'a' selects all, ⏎ confirms
 * (on a real terminal); a numbered typed pick otherwise. Selection is PICK-ORDERED — the order
 * you check items is the order they come back, shown as [1], [2], … so the caller can turn it
 * into an ordered layout. Restores the terminal on every exit path, like `selectOne`.
 */
export async function selectMany<T>(
  rl: Rl,
  prompt: string,
  choices: Choice<T>[],
  hint = 'Space toggle · a all · ↑/↓ move · ⏎ confirm',
): Promise<T[]> {
  if (choices.length === 0) return [];
  if (!isInteractive()) return numberedMany(rl, prompt, choices);

  const stdin = process.stdin;
  // eslint-disable-next-line no-control-regex -- stripping SGR colour codes to measure real width
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const physicalRows = (lines: string[]): number => {
    const cols = process.stdout.columns || 80;
    return lines.reduce((n, line) => n + Math.max(1, Math.ceil(stripAnsi(line).length / cols)), 0);
  };

  return new Promise<T[]>((resolve, reject) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    let cursor = clamp(0, choices.length);
    const picked: number[] = []; // choice indices, in the order they were checked
    let prevRows = 0;
    const savedKeypress = stdin.listeners('keypress') as ((...a: unknown[]) => void)[];

    const draw = (first: boolean): void => {
      const lines = choices.map((c, i) => {
        const active = i === cursor;
        const ptr = active ? cyan('▸') : ' ';
        const order = picked.indexOf(i);
        const box = order >= 0 ? cyan(`[${order + 1}]`) : dim('[ ]');
        const label = active ? bold(c.label) : c.label;
        return `  ${ptr} ${box} ${label}${c.hint ? dim(` — ${c.hint}`) : ''}`;
      });
      lines.push(dim(`  ${prompt}  ·  ${hint}`));
      const reset = first ? '' : `\x1b[${prevRows}A\x1b[J`;
      process.stdout.write(reset + lines.map((l) => `${l}\n`).join(''));
      prevRows = physicalRows(lines);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      for (const listener of savedKeypress) stdin.on('keypress', listener);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      rl.resume?.();
      process.stdout.write(`\x1b[${prevRows}A\x1b[J`); // erase the menu; the caller prints the outcome
    };

    const toggle = (i: number): void => {
      const at = picked.indexOf(i);
      if (at >= 0) picked.splice(at, 1);
      else picked.push(i);
    };

    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(abortError());
        return;
      }
      switch (key?.name) {
        case 'up':
        case 'k':
          cursor = (cursor - 1 + choices.length) % choices.length;
          break;
        case 'down':
        case 'j':
          cursor = (cursor + 1) % choices.length;
          break;
        case 'space':
          toggle(cursor);
          break;
        case 'a':
          choices.forEach((_, i) => {
            if (!picked.includes(i)) picked.push(i);
          });
          break;
        case 'return':
        case 'enter':
          cleanup();
          resolve(picked.map((i) => choices[i]!.value));
          return;
        case 'escape':
          cleanup();
          reject(abortError());
          return;
        default:
          return;
      }
      draw(false);
    };

    rl.pause?.();
    for (const listener of savedKeypress) stdin.removeListener('keypress', listener);
    stdin.setRawMode(true);
    stdin.resume();
    draw(true);
    stdin.on('keypress', onKey);
  });
}

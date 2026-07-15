/** Minimal ANSI terminal helpers — colours, a row-keyed coordinate painter, and a spinner. Every
 * one is a no-op (plain text) when stdout isn't a colour TTY (piped output, CI, tests), so nothing
 * leaks escape codes into a redirect. */

const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

const sgr = (code: string) => (s: string): string => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = sgr('1');
export const dim = sgr('2');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');
export const blue = sgr('34');
export const magenta = sgr('35');
export const cyan = sgr('36');

/** Colour a coordinate label by its row, so each row of the board map reads as its own colour band —
 * "the a's are cyan, the b's green…" makes a coordinate easy to spot at a glance. */
const ROW_COLORS = [cyan, green, yellow, magenta];
export function paintCoordByRow(coord: string, row: number): string {
  return ROW_COLORS[row % ROW_COLORS.length]!(coord);
}

/** Cycle a list line through a muted palette so a long numbered list is easy to scan — each line a
 * slightly different colour than the one above it, so the eye can track a row across a wide terminal.
 * No-op off a colour TTY (piped output, tests) so nothing leaks escape codes. */
const LINE_COLORS = [cyan, green, yellow, blue, magenta];
export function paintLine(text: string, i: number): string {
  return LINE_COLORS[i % LINE_COLORS.length]!(text);
}

/**
 * A braille spinner on a status line while an async op runs; returns a stop fn that erases it (so the
 * caller can print the result on the freed line). Off a colour TTY it prints the label once and the
 * stop fn is a no-op — piped output and tests stay clean and un-animated.
 */
export function spinner(label: string): () => void {
  if (!useColor()) {
    process.stdout.write(`  ${label}\n`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i++ % frames.length]!)} ${dim(label)}`);
  }, 80);
  timer.unref?.(); // never keep the process alive just for the animation
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[K'); // carriage-return + erase-to-end: wipe the spinner line
  };
}

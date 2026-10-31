/**
 * Оформление вывода: цвета, секции с выровненными полями, шаги со спиннером.
 * Цвета и спиннер только в терминале; NO_COLOR отключает цвета.
 */

const tty = Deno.stdout.isTerminal();
const colored = tty && !Deno.env.get("NO_COLOR");
const paint = (code: string) => (s: string) => colored ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

// deno-lint-ignore no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Размер терминала; 80×24, если его не удалось узнать. */
export function terminalSize() {
  try {
    const { columns, rows } = Deno.consoleSize();
    return { columns: columns || 80, rows: rows || 24 };
  } catch {
    return { columns: 80, rows: 24 };
  }
}

export function write(s: string) {
  let bytes = new TextEncoder().encode(s);
  while (bytes.length) bytes = bytes.subarray(Deno.stdout.writeSync(bytes));
}

let spinner: ReturnType<typeof setInterval> | undefined;

function stopSpinner() {
  if (spinner === undefined) return;
  clearInterval(spinner);
  spinner = undefined;
  write("\r\x1b[2K");
}

export function die(msg: string): never {
  stopSpinner();
  console.error(`${red("✖")} ${msg}`);
  Deno.exit(1);
}

export function cancel(): never {
  stopSpinner();
  console.log(dim("Cancelled."));
  Deno.exit(1);
}

/** Выполнить шаг: спиннер, пока идёт, затем «✔ label detail 1.2s». */
export async function step<T>(label: string, fn: () => Promise<T>, detail?: (result: T) => string): Promise<T> {
  const start = performance.now();
  if (tty) {
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    let i = 0;
    // Строка спиннера не должна переноситься, иначе \r затрёт только её последнюю часть.
    const plain = stripAnsi(label);
    const width = terminalSize().columns - 3;
    const shown = plain.length > width ? [...plain].slice(0, width - 1).join("") + "…" : label;
    write(`${cyan(frames[0])} ${shown}`);
    spinner = setInterval(() => write(`\r\x1b[2K${cyan(frames[++i % frames.length])} ${shown}`), 80);
  }
  try {
    const result = await fn();
    stopSpinner();
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    const extra = detail?.(result);
    console.log(`${green("✔")} ${label}${extra ? ` ${extra}` : ""} ${dim(`${seconds}s`)}`);
    return result;
  } finally {
    stopSpinner();
  }
}

const LABEL_WIDTH = 14;

export function header(title: string) {
  console.log(`\n${bold(cyan(title))}`);
}

export function field(label: string, value: string) {
  console.log(`  ${dim(label.padEnd(LABEL_WIDTH))}${value}`);
}

/** Строки-продолжения под полем, обрезанные до limit. */
export function list(items: string[], limit: number) {
  const pad = " ".repeat(LABEL_WIDTH + 2);
  for (const item of items.slice(0, limit)) console.log(pad + item);
  if (items.length > limit) console.log(pad + dim(`… ${items.length - limit} more (--verbose to show all)`));
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

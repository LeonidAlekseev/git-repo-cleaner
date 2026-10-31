/** Интерактивные вопросы в терминале: списки с чекбоксами и текстовый ввод. */

import { bold, cancel, cyan, dim, green, terminalSize, write } from "./ui.ts";

/** Список в терминале: чекбоксы (multi) или выбор одного. Возвращает индексы. */
export async function menu(
  title: string,
  options: string[],
  multi: boolean,
  selected: number[] = [],
  /** Короткая подпись выбранного пункта для строки-итога (по умолчанию сам пункт). */
  summary: (i: number) => string = (i) => options[i],
) {
  const chosen = new Set(selected);
  const hint = multi
    ? "↑↓ move · Space toggle · a all/none · Enter confirm · q quit"
    : "↑↓ move · Enter select · q quit";
  const buf = new Uint8Array(64);
  let cur = 0, top = 0, drawn = 0, done = false, result: number[] | null = null;

  const fit = (s: string, width: number) => [...s].slice(0, Math.max(1, width - 6)).join("");
  const draw = () => {
    const { columns, rows } = terminalSize();
    const height = Math.max(1, Math.min(options.length, rows - 4));
    top = Math.min(Math.max(top, cur - height + 1), cur);
    const lines = [`${cyan("?")} ${bold(fit(title, columns))}`, `  ${dim(fit(hint, columns))}`];
    for (let i = top; i < top + height; i++) {
      const mark = multi ? (chosen.has(i) ? green("◉") : dim("◯")) : i === cur ? cyan("●") : dim("○");
      const text = fit(options[i], columns);
      lines.push(`${i === cur ? cyan("❯") : " "} ${mark} ${i === cur ? cyan(text) : text}`);
    }
    if (options.length > height) lines.push(`  ${dim(`${cur + 1}/${options.length}`)}`);
    write((drawn ? `\x1b[${drawn}F` : "") + "\x1b[J" + lines.join("\r\n") + "\r\n");
    drawn = lines.length;
  };

  Deno.stdin.setRaw(true);
  write("\x1b[?25l");
  try {
    draw();
    while (!done) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      // Одно чтение может содержать несколько нажатий; стрелки — escape-последовательности.
      // deno-lint-ignore no-control-regex
      const keys = new TextDecoder().decode(buf.subarray(0, n)).match(/\x1b(?:\[|O)[A-Z]|[\s\S]/g) ?? [];
      for (const key of keys) {
        if (key === "\x1b[A" || key === "\x1bOA" || key === "k") cur = (cur - 1 + options.length) % options.length;
        else if (key === "\x1b[B" || key === "\x1bOB" || key === "j") cur = (cur + 1) % options.length;
        else if (multi && key === " ") chosen.has(cur) ? chosen.delete(cur) : chosen.add(cur);
        else if (multi && key === "a") {
          if (chosen.size === options.length) chosen.clear();
          else options.forEach((_, i) => chosen.add(i));
        } else if (key === "\r" || key === "\n") {
          if (!multi) result = [cur];
          else if (chosen.size) result = [...chosen].sort((a, b) => a - b);
          else write("\x07");
        } else if (key === "q" || key === "\x03") done = true;
        if (result) done = true;
        if (done) break;
      }
      if (!done) draw();
    }
  } finally {
    write(`\x1b[${drawn}F\x1b[J\x1b[?25h`);
    Deno.stdin.setRaw(false);
  }
  if (result === null) cancel();
  console.log(`${green("✔")} ${bold(title)} ${cyan(result.map(summary).join(", "))}`);
  return result;
}

export function ask(question: string, fallback = ""): string {
  const answer = prompt(`${cyan("?")} ${bold(question)}${fallback ? dim(` (${fallback})`) : ""}`);
  if (answer === null) cancel();
  return answer.trim() || fallback;
}

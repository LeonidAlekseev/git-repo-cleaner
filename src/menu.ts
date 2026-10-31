/** Интерактивные вопросы в терминале: списки с чекбоксами и текстовый ввод. */

export function cancel(): never {
  console.log("Отменено.");
  Deno.exit(1);
}

function write(s: string) {
  let bytes = new TextEncoder().encode(s);
  while (bytes.length) bytes = bytes.subarray(Deno.stdout.writeSync(bytes));
}

/** Список в терминале: чекбоксы (multi) или выбор одного. Возвращает индексы. */
export async function menu(title: string, options: string[], multi: boolean, selected: number[] = []) {
  const chosen = new Set(selected);
  const hint = multi
    ? "↑↓ перемещение · Пробел отметить · a все/ничего · Enter готово · q выход"
    : "↑↓ перемещение · Enter выбрать · q выход";
  const buf = new Uint8Array(64);
  let cur = 0, top = 0, drawn = 0, done = false, result: number[] | null = null;

  const fit = (s: string, width: number) => [...s].slice(0, Math.max(1, width - 4)).join("");
  const draw = () => {
    const { columns, rows } = Deno.consoleSize();
    const height = Math.max(1, Math.min(options.length, rows - 4));
    top = Math.min(Math.max(top, cur - height + 1), cur);
    const lines = [`\x1b[1m${fit(title, columns)}\x1b[0m`, `\x1b[2m${fit(hint, columns)}\x1b[0m`];
    for (let i = top; i < top + height; i++) {
      const mark = multi ? (chosen.has(i) ? "[x] " : "[ ] ") : i === cur ? "(•) " : "( ) ";
      const text = fit(mark + options[i], columns);
      lines.push(i === cur ? `\x1b[7m${text}\x1b[0m` : text);
    }
    if (options.length > height) lines.push(`\x1b[2m${cur + 1}/${options.length}\x1b[0m`);
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
  console.log(`${title}: ${result.map((i) => options[i]).join(", ")}`);
  return result;
}

export function ask(question: string, fallback = ""): string {
  const answer = prompt(question + (fallback ? ` [${fallback}]` : "") + ":");
  if (answer === null) cancel();
  return answer.trim() || fallback;
}

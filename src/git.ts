/** Запуск git и мелкие помощники для путей и URL. */

import { die } from "./ui.ts";

export interface GitOptions {
  cwd?: string;
  check?: boolean;
  input?: string;
}

/**
 * Запустить git с захватом вывода. Возвращает stdout без концевых пробелов.
 * При ошибке (check) завершает программу с выводом git — шум успешных команд не показывается.
 */
export async function git(args: string[], opts: GitOptions = {}): Promise<string> {
  const { cwd, check = true, input } = opts;
  const child = new Deno.Command("git", {
    args,
    cwd,
    stdin: input !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const out = await child.output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  if (check && !out.success) {
    die(`git ${args[0]} failed:\n${(decode(out.stderr) || decode(out.stdout)).trim()}`);
  }
  return decode(out.stdout).trimEnd();
}

export function isUrl(spec: string): boolean {
  return spec.includes("://") || /^[\w.-]+@[\w.-]+:/.test(spec);
}

export function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

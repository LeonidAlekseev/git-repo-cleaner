/** Запуск git и мелкие помощники для путей и URL. */

export function die(msg: string): never {
  console.error(`❌ ${msg}`);
  Deno.exit(1);
}

export interface GitOptions {
  cwd?: string;
  check?: boolean;
  /** Выводить прогресс в терминал вместо захвата вывода. */
  show?: boolean;
  input?: string;
}

/** Запустить git. Возвращает stdout без концевых пробелов ("" при show). */
export async function git(args: string[], opts: GitOptions = {}): Promise<string> {
  const { cwd, check = true, show = false, input } = opts;
  const child = new Deno.Command("git", {
    args,
    cwd,
    stdin: input !== undefined ? "piped" : show ? "inherit" : "null",
    stdout: show ? "inherit" : "piped",
    stderr: show ? "inherit" : "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const out = await child.output();
  if (show) {
    if (check && !out.success) die(`git ${args.join(" ")}`);
    return "";
  }
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  if (check && !out.success) die(`git ${args.join(" ")}\n${decode(out.stderr).trim()}`);
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

#!/usr/bin/env -S deno run --allow-run=git --allow-read --allow-write --allow-env
/**
 * git-repo-cleaner — очистка git-репозитория от артефактов AI-инструментов.
 *
 * Удаляет файлы (CLAUDE.md, .claude/, AGENTS.md, openspec/ ...), трейлеры-атрибуции
 * в сообщениях коммитов, переписывает авторов-ботов. Работает на временной mirror-копии
 * через git-filter-repo, цель меняется только на последнем шаге.
 *
 * Без флагов спрашивает всё интерактивно (чекбоксы в терминале). Любой вопрос можно
 * закрыть флагом, см. --help.
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, join, resolve } from "@std/path";
import denoJson from "../deno.json" with { type: "json" };
import { ACTIONS, ARTIFACTS, buildRules, isEmpty, type Rules } from "./artifacts.ts";
import { die, exists, git, isUrl } from "./git.ts";
import { commitCallback, type CommitPlan, matchingPaths, planCommits, readCommits } from "./history.ts";
import { ask, cancel, menu } from "./menu.ts";

const DEFAULT_SUFFIX = "-clean";

const HELP = `git-repo-cleaner ${denoJson.version} — очистка git-репозитория от артефактов AI-инструментов.

Использование: git-repo-cleaner [источник] [флаги]
  источник                путь или URL репозитория (по умолчанию текущий)

Ветки:
  -b, --branch NAME       очищаемая ветка (можно несколько раз)
  --all                   все ветки
Куда класть ветки:
  --in-place              те же имена веток (перезапись истории)
  --suffix=SUFFIX         новые ветки <ветка><суффикс> (по умолчанию ${DEFAULT_SUFFIX})
  --to NAME               имя новой ветки (только для одной ветки)
Куда класть репозиторий:
  --same-repo             в исходный репозиторий
  --target URL|PATH       в другой репозиторий (путь создаётся, если нет)
Что чистить:
  --only KEYS             артефакты через запятую (по умолчанию: ${
  ARTIFACTS.filter((a) => a.default).map((a) => a.key)
})
  --actions KEYS          действия через запятую (по умолчанию: ${ACTIONS.filter((a) => a.default).map((a) => a.key)})
  --word REGEX            доп. regex упоминания (для mentions/content, можно несколько раз)
  --path REGEX            доп. regex пути файла (можно несколько раз)
  --author-name NAME      имя для переписанных коммитов (по умолчанию git config user.name)
  --author-email EMAIL    почта для переписанных коммитов (по умолчанию git config user.email)
Прочее:
  --no-tags               не переносить теги
  --prune                 удалить в цели ветки, которых нет в источнике (только с --all)
  --dry-run               пробный запуск: показать, что изменится, и очистить временную копию; цель не менять
  --no-backup             не сохранять бэкап перезаписываемых веток и тегов цели (по умолчанию сохраняется)
  -v, --verbose           показывать списки целиком
  -y, --yes               без подтверждения
  -V, --version           версия
  -h, --help              эта справка

Артефакты: ${ARTIFACTS.map((a) => a.key).join(", ")}.
Действия:  ${ACTIONS.map((a) => a.key).join(", ")}.`;

function need(interactive: boolean, flag: string) {
  if (!interactive) die(`Нет терминала для вопроса — укажите ${flag}`);
}

function pickKeys(spec: string, known: string[], flag: string) {
  const keys = spec.split(",").map((k) => k.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !known.includes(k));
  if (unknown.length) die(`${flag}: неизвестные ключи ${unknown.join(", ")}`);
  return keys;
}

const splitList = (s: string) => s.split(",").map((w) => w.trim()).filter(Boolean);

function timestamp() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cacheDir() {
  const env = (name: string) => Deno.env.get(name);
  const base = env("XDG_CACHE_HOME") || (env("HOME") && join(env("HOME")!, ".cache")) || env("LOCALAPPDATA") ||
    Deno.cwd();
  return join(base, "git-repo-cleaner");
}

/** Источник: [location, localDir]. localDir = undefined для удалённого репозитория. */
async function resolveSource(spec: string): Promise<[string, string | undefined]> {
  if (isUrl(spec)) return [spec, undefined];
  const path = resolve(spec);
  if (!exists(path) || !(await git(["rev-parse", "--git-dir"], { cwd: path, check: false }))) {
    die(`${spec}: не git-репозиторий`);
  }
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: path, check: false });
  return [path, top || path];
}

/** Скопировать ветки и теги цели в refs/backup/* копии. Вернуть {ref цели: ref в копии}. */
async function snapshotTarget(mirror: string, target: string, sameRepo: boolean) {
  const result: Record<string, string> = {};
  if (!sameRepo && !isUrl(target) && !exists(target)) return result; // новый локальный репозиторий
  const out = await new Deno.Command("git", {
    args: [
      "fetch",
      "--quiet",
      "--no-tags",
      sameRepo ? "." : target,
      "+refs/heads/*:refs/backup/heads/*",
      "+refs/tags/*:refs/backup/tags/*",
    ],
    cwd: mirror,
    stdin: "null",
  }).output();
  if (!out.success) die(`Не удалось прочитать цель ${target}:\n${new TextDecoder().decode(out.stderr).trim()}`);
  const refs = await git(["for-each-ref", "--format=%(refname)", "refs/backup"], { cwd: mirror });
  for (const ref of refs.split("\n").filter(Boolean)) result["refs/" + ref.slice("refs/backup/".length)] = ref;
  return result;
}

/** {ветка: путь worktree} для локального репозитория. */
async function checkedOut(repo: string) {
  const result: Record<string, string> = {};
  let path = "";
  for (const line of (await git(["worktree", "list", "--porcelain"], { cwd: repo })).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) result[line.slice("branch refs/heads/".length)] = path;
  }
  return result;
}

async function deliverLocal(mirror: string, target: string, dst: Set<string>, tags: boolean, prune: boolean) {
  if (!exists(target)) await git(["init", "--quiet", target]);
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: target, check: false });
  let resetHere = false;
  for (const [branch, path] of Object.entries(await checkedOut(target))) {
    if (!dst.has(branch)) continue;
    if (top && Deno.realPathSync(path) === Deno.realPathSync(top)) {
      if (await git(["status", "--porcelain", "--untracked-files=no"], { cwd: top })) {
        die(`Ветка ${branch} открыта в ${top} с незакоммиченными изменениями — закоммитьте или уберите их`);
      }
      resetHere = true;
    } else {
      die(`Ветка ${branch} открыта в другом worktree: ${path} — переключите его на другую ветку`);
    }
  }
  const refspecs = ["+refs/heads/*:refs/heads/*", ...(tags ? ["+refs/tags/*:refs/tags/*"] : [])];
  await git([
    "fetch",
    ...(prune ? ["--prune"] : []),
    ...(resetHere ? ["--update-head-ok"] : []),
    mirror,
    ...refspecs,
  ], { cwd: target, show: true });
  if (resetHere) await git(["reset", "--hard", "--quiet"], { cwd: top });
}

async function deliverRemote(mirror: string, target: string, tags: boolean, prune: boolean) {
  const refspecs = ["+refs/heads/*:refs/heads/*", ...(tags ? ["+refs/tags/*:refs/tags/*"] : [])];
  await git(["push", "--force", ...(prune ? ["--prune"] : []), target, ...refspecs], { cwd: mirror, show: true });
}

function printPreview(total: number, paths: string[], plan: CommitPlan, rules: Rules, verbose: boolean) {
  const limit = verbose ? Infinity : 15;
  const list = (items: string[]) => {
    for (const item of items.slice(0, limit)) console.log(`      ${item}`);
    if (items.length > limit) console.log(`      … ещё ${items.length - limit} (--verbose — все)`);
  };
  console.log(`\n🔎 Найдено в истории (коммитов: ${total}):`);
  if (rules.paths.length) {
    console.log(`   файлы к удалению: ${paths.length}`);
    list(paths);
  }
  if (rules.trailers.length) {
    const lines = [...plan.trailers].sort((a, b) => b[1] - a[1]);
    console.log(`   трейлеры к удалению: ${lines.reduce((n, [, c]) => n + c, 0)}`);
    list(lines.map(([line, count]) => `${line}  ×${count}`));
  }
  if (rules.messageWords.length) console.log(`   сообщения с упоминаниями: ${plan.scrubbed}`);
  if (rules.authors.length) {
    console.log(`   авторы к замене: ${plan.authors.size}`);
    list([...plan.authors].sort());
  }
  if (rules.fileWords.length) {
    console.log(`   содержимое файлов: вырезается ${rules.fileWords.join(", ")} (без предпросмотра)`);
  }
  console.log(`   коммитов с новым сообщением или автором: ${plan.changes.size}`);
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: [
      "all",
      "in-place",
      "same-repo",
      "no-tags",
      "prune",
      "dry-run",
      "no-backup",
      "verbose",
      "yes",
      "help",
      "version",
    ],
    string: ["branch", "suffix", "to", "target", "only", "actions", "word", "path", "author-name", "author-email"],
    collect: ["branch", "word", "path"],
    alias: { b: "branch", y: "yes", h: "help", v: "verbose", V: "version" },
    unknown: (arg) => !arg.startsWith("-") || die(`Неизвестный флаг ${arg}, см. --help`),
  });
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(denoJson.version);
  if (args._.length > 1) die("Укажите один источник");
  const interactive = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  if (!(await git(["filter-repo", "--version"], { check: false }))) {
    die("Нужен git-filter-repo: pip install git-filter-repo (или brew/apt install git-filter-repo)");
  }
  if (args.branch.length && args.all) die("--branch и --all несовместимы");
  if ([args["in-place"], args.suffix, args.to].filter(Boolean).length > 1) {
    die("--in-place, --suffix и --to несовместимы");
  }
  if (args["same-repo"] && args.target) die("--same-repo и --target несовместимы");
  let dryRun = args["dry-run"];

  // Источник
  let sourceSpec = args._.length ? String(args._[0]) : "";
  if (!sourceSpec) {
    if (await git(["rev-parse", "--git-dir"], { check: false })) sourceSpec = ".";
    else {
      need(interactive, "путь или URL репозитория");
      sourceSpec = ask("Репозиторий (путь или URL)");
    }
  }
  const [source, sourceDir] = await resolveSource(sourceSpec);

  const tmp = await Deno.makeTempDir({ prefix: "git-repo-cleaner-" });
  const mirror = join(tmp, "repo.git");
  console.log(`🔄 Копируем ${source} ...`);
  await git(["clone", "--mirror", "--quiet", source, mirror], { show: true });
  const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: mirror }))
    .split("\n").filter(Boolean);
  if (!branches.length) die("В репозитории нет веток");
  const head = await git(["symbolic-ref", "--short", "HEAD"], { cwd: mirror, check: false });

  // Ветки
  let selected: string[];
  if (args.all) selected = branches;
  else if (args.branch.length) {
    const missing = args.branch.filter((b) => !branches.includes(b));
    if (missing.length) die(`Нет веток: ${missing.join(", ")}`);
    selected = args.branch;
  } else {
    need(interactive, "--branch или --all");
    const pre = branches.includes(head) ? [branches.indexOf(head)] : [];
    selected = (await menu("Какие ветки очистить?", branches, true, pre)).map((i) => branches[i]);
  }
  const allBranches = branches.every((b) => selected.includes(b));

  // Имена веток
  const rename = new Map<string, string>();
  if (args["in-place"]) selected.forEach((b) => rename.set(b, b));
  else if (args.to) {
    if (selected.length !== 1) die("--to работает только для одной ветки");
    rename.set(selected[0], args.to);
  } else if (args.suffix) selected.forEach((b) => rename.set(b, b + args.suffix));
  else {
    need(interactive, "--in-place, --suffix или --to");
    const one = selected.length === 1;
    const newLabel = one
      ? `В новую ветку (${selected[0]}${DEFAULT_SUFFIX} или своё имя)`
      : `В новые ветки с суффиксом (${DEFAULT_SUFFIX} или свой)`;
    const [choice] = await menu("Куда положить очищенную историю?", [
      newLabel,
      "В те же ветки (перезаписать историю)",
    ], false);
    if (choice === 1) selected.forEach((b) => rename.set(b, b));
    else if (one) rename.set(selected[0], ask("Имя новой ветки", selected[0] + DEFAULT_SUFFIX));
    else {
      const suffix = ask("Суффикс", DEFAULT_SUFFIX);
      selected.forEach((b) => rename.set(b, b + suffix));
    }
  }
  const dst = new Set(rename.values());
  const inPlace = [...rename].every(([s, d]) => s === d);
  if (dst.size !== rename.size) die("Имена новых веток совпадают");

  // Целевой репозиторий
  let target: string;
  if (args["same-repo"]) target = source;
  else if (args.target) target = args.target;
  else {
    need(interactive, "--same-repo или --target");
    const options = [`Текущий репозиторий (${source})`], targets = [source];
    const origin = sourceDir ? await git(["remote", "get-url", "origin"], { cwd: sourceDir, check: false }) : "";
    if (origin) {
      options.push(`Его origin (${origin})`);
      targets.push(origin);
    }
    options.push("Другой репозиторий (URL или путь)");
    const [choice] = await menu("В какой репозиторий отправить результат?", options, false);
    target = choice < targets.length ? targets[choice] : ask("URL или путь");
  }
  if (!isUrl(target)) target = resolve(target);
  const sameRepo = target === source;

  // Что чистить
  const asking = interactive && !args.yes;
  let picked: string[];
  if (args.only) picked = pickKeys(args.only, ARTIFACTS.map((a) => a.key), "--only");
  else if (asking) {
    const idx = await menu(
      "Какие артефакты чистить?",
      ARTIFACTS.map((a) => a.label),
      true,
      ARTIFACTS.flatMap((a, i) => a.default ? [i] : []),
    );
    picked = idx.map((i) => ARTIFACTS[i].key);
  } else picked = ARTIFACTS.filter((a) => a.default).map((a) => a.key);
  let actions: Set<string>;
  if (args.actions) actions = new Set(pickKeys(args.actions, ACTIONS.map((a) => a.key), "--actions"));
  else if (asking) {
    const idx = await menu(
      "Что делать с найденным?",
      ACTIONS.map((a) => a.label),
      true,
      ACTIONS.flatMap((a, i) => a.default ? [i] : []),
    );
    actions = new Set(idx.map((i) => ACTIONS[i].key));
  } else actions = new Set(ACTIONS.filter((a) => a.default).map((a) => a.key));
  const extra = { words: [...args.word], paths: [...args.path] };
  if (asking && !(extra.words.length || extra.paths.length || args.only)) {
    if (actions.has("mentions") || actions.has("content")) {
      extra.words.push(...splitList(ask("Доп. слова-regex через запятую (Enter — нет)")));
    }
    extra.paths.push(...splitList(ask("Доп. пути-regex через запятую (Enter — нет)")));
  }
  for (const pattern of [...extra.words, ...extra.paths]) {
    try {
      new RegExp(pattern, "i");
    } catch (e) {
      die(`Неверный regex ${JSON.stringify(pattern)}: ${(e as Error).message}`);
    }
  }
  const rules = buildRules(ARTIFACTS.filter((a) => picked.includes(a.key)), actions, extra);
  if (isEmpty(rules)) die("Нечего чистить: не выбраны артефакты или действия");

  const name = args["author-name"] || await git(["config", "user.name"], { cwd: sourceDir, check: false });
  const email = args["author-email"] || await git(["config", "user.email"], { cwd: sourceDir, check: false });
  if (rules.authors.length && !(name && email)) {
    die("Не задан автор: укажите --author-name и --author-email или git config user.name/user.email");
  }

  const tags = allBranches && (inPlace || !sameRepo) && !args["no-tags"];
  if (args.prune && !allBranches) die("--prune допустим только при очистке всех веток");

  // Что в цели будет перезаписано или удалено
  const current = await snapshotTarget(mirror, target, sameRepo);
  const targetHeads = new Set(
    Object.keys(current).filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length)),
  );
  const pruned = args.prune ? [...targetHeads].filter((b) => !dst.has(b)).sort() : [];
  const lost = [...[...targetHeads].filter((b) => dst.has(b)).sort(), ...pruned].map((b) => `refs/heads/${b}`);
  if (tags) lost.push(...Object.keys(current).filter((r) => r.startsWith("refs/tags/")));

  // Оставляем в копии только выбранные ветки под новыми именами (и снимок цели для бэкапа)
  const wanted = new Map<string, string>();
  for (const [s, d] of rename) {
    wanted.set(`refs/heads/${d}`, await git(["rev-parse", `refs/heads/${s}`], { cwd: mirror }));
  }
  const keep = (ref: string) =>
    wanted.has(ref) || ref.startsWith("refs/backup/") || (tags && ref.startsWith("refs/tags/"));
  const refs = (await git(["for-each-ref", "--format=%(refname)"], { cwd: mirror })).split("\n").filter(Boolean);
  await git(["update-ref", "--stdin"], {
    cwd: mirror,
    input: [
      ...refs.filter((r) => !keep(r)).map((r) => `delete ${r}`),
      ...[...wanted].map(([r, sha]) => `update ${r} ${sha}`),
    ].join("\n") + "\n",
  });
  await git(["symbolic-ref", "HEAD", `refs/heads/${rename.get(selected[0])}`], { cwd: mirror });

  // Предпросмотр
  const revs = ["--branches", "--tags"];
  const commits = await readCommits(mirror, revs);
  const plan = planCommits(commits, rules);
  const paths = await matchingPaths(mirror, revs, rules.paths);
  printPreview(commits.length, paths, plan, rules, args.verbose);

  // Сводка
  console.log("\n📋 План:");
  console.log(`   источник: ${source}`);
  console.log(`   цель:     ${target}${sameRepo ? " (тот же репозиторий)" : ""}`);
  for (const [s, d] of rename) console.log(`   ${s} → ${d}${targetHeads.has(d) ? " ⚠️  ПЕРЕЗАПИСЬ" : ""}`);
  if (pruned.length) console.log(`   удалятся: ${pruned.join(", ")} ⚠️  PRUNE`);
  console.log(`   теги:     ${tags ? "да" : "нет"}`);
  const extras = [...extra.words, ...extra.paths];
  console.log(`   артефакты: ${picked.join(", ") || "—"}${extras.length ? ` + ${extras.join(", ")}` : ""}`);
  console.log(`   действия:  ${ACTIONS.filter((a) => actions.has(a.key)).map((a) => a.key).join(", ")}`);
  if (rules.authors.length) console.log(`   автор:     ${name} <${email}>`);
  console.log(
    "   бэкап:    " +
      (args["no-backup"]
        ? "выключен (--no-backup)"
        : lost.length
        ? `да (ссылок: ${lost.length})`
        : "не нужен, ничего не перезаписывается"),
  );
  if (!args.yes && !dryRun) {
    need(interactive, "--yes или --dry-run");
    const answer = ask("Продолжить? y — да, d — пробный запуск (dry-run), N — отмена").toLowerCase();
    if (["d", "dry", "dry-run", "п"].includes(answer)) dryRun = true;
    else if (!["y", "yes", "д", "да"].includes(answer)) cancel();
  }
  if (dryRun) console.log("🧪 Пробный запуск: чистим временную копию, цель и бэкапы не трогаем");

  // Бэкап всего, что в цели будет перезаписано или удалено
  if (lost.length && !args["no-backup"] && !dryRun) {
    const dir = cacheDir();
    Deno.mkdirSync(dir, { recursive: true });
    const repoName = basename(target.replace(/[/\\]+$/, "")).replace(/\.git$/, "") || "repo";
    const bundle = join(dir, `${repoName}-${timestamp()}.bundle`);
    await git(["bundle", "create", "--quiet", bundle, ...lost.map((r) => current[r])], { cwd: mirror });
    console.log(`💾 Бэкап: ${bundle}`);
  }
  const backupRefs = Object.values(current);
  if (backupRefs.length) {
    await git(["update-ref", "--stdin"], { cwd: mirror, input: backupRefs.map((r) => `delete ${r}\n`).join("") });
  }

  // Очистка
  if (paths.length || plan.changes.size || rules.fileWords.length) {
    console.log("🧹 Очищаем историю ...");
    const fr = ["filter-repo", "--force"];
    for (const p of rules.paths) fr.push("--path-regex", `(?i)${p}`);
    if (rules.paths.length) fr.push("--invert-paths");
    if (rules.fileWords.length) {
      const replacements = join(tmp, "replacements.txt");
      Deno.writeTextFileSync(replacements, rules.fileWords.map((w) => `regex:(?i)${w}==>\n`).join(""));
      fr.push("--replace-text", replacements);
    }
    if (plan.changes.size) {
      const changesFile = join(tmp, "changes.json");
      Deno.writeTextFileSync(changesFile, JSON.stringify(Object.fromEntries(plan.changes)));
      fr.push("--commit-callback", commitCallback(changesFile, name, email));
    }
    await git(fr, { cwd: mirror, show: true });

    console.log("🔍 Проверяем чистоту ...");
    const leftCommits = await readCommits(mirror, ["--all"]);
    const left = planCommits(leftCommits, rules);
    const leftPaths = await matchingPaths(mirror, ["--all"], rules.paths);
    if (left.changes.size || leftPaths.length) {
      die(
        "Найдены остатки, отправка отменена:\n   " +
          [...[...left.changes.keys()].map((sha) => `коммит ${sha}`), ...leftPaths.map((p) => `файл ${p}`)]
            .slice(0, 50).join("\n   ") +
          `\nКопия для разбора: ${mirror}`,
      );
    }
  } else {
    console.log("✨ Артефактов не найдено — ветки переносятся как есть");
  }

  if (dryRun) return console.log(`✅ Dry-run: очищенная копия в ${mirror}`);
  console.log(`🚀 Отправляем в ${target} ...`);
  if (isUrl(target)) await deliverRemote(mirror, target, tags, args.prune);
  else await deliverLocal(mirror, target, dst, tags, args.prune);
  await Deno.remove(tmp, { recursive: true });
  console.log(`✅ Готово: ${[...dst].sort().join(", ")}`);
}

if (import.meta.main) await main();

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
import { exists, git, isUrl } from "./git.ts";
import { commitCallback, type CommitPlan, matchingPaths, planCommits, readCommits } from "./history.ts";
import { ask, menu } from "./menu.ts";
import { bold, cancel, cyan, die, dim, field, green, header, list, plural, step, yellow } from "./ui.ts";

const DEFAULT_SUFFIX = "-clean";
const defaults = (items: { key: string; default?: boolean }[]) => items.filter((i) => i.default).map((i) => i.key);

const HELP = `${bold("git-repo-cleaner")} ${denoJson.version} — remove AI-assistant artifacts from git history.

Usage: git-repo-cleaner [source] [options]
  source                  repository path or URL (default: current repository)

Branches:
  -b, --branch NAME       branch to clean (repeatable)
  --all                   all branches
Branch names:
  --in-place              keep branch names (rewrite history)
  --suffix=SUFFIX         new branches named <branch><suffix> (default: ${DEFAULT_SUFFIX})
  --to NAME               new branch name (single branch only)
Destination:
  --same-repo             push to the source repository
  --target URL|PATH       push to another repository (a missing path is created)
What to clean:
  --only KEYS             comma-separated artifacts (default: ${defaults(ARTIFACTS)})
  --actions KEYS          comma-separated actions (default: ${defaults(ACTIONS)})
  --word REGEX            extra mention regex for mentions/content (repeatable)
  --path REGEX            extra file path regex (repeatable)
  --author-name NAME      name for rewritten commits (default: git config user.name)
  --author-email EMAIL    email for rewritten commits (default: git config user.email)
Other:
  --no-tags               do not transfer tags
  --prune                 delete target branches missing from the source (requires --all)
  --dry-run               preview and clean a temporary copy; leave the target untouched
  --no-backup             skip the backup of overwritten target refs (backup is on by default)
  -v, --verbose           show full lists
  -y, --yes               do not ask for confirmation
  -V, --version           print version
  -h, --help              show this help

Artifacts: ${ARTIFACTS.map((a) => a.key).join(", ")}
Actions:   ${ACTIONS.map((a) => a.key).join(", ")}`;

function need(interactive: boolean, flag: string) {
  if (!interactive) die(`No terminal to ask — pass ${flag}`);
}

function pickKeys(spec: string, known: string[], flag: string) {
  const keys = spec.split(",").map((k) => k.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !known.includes(k));
  if (unknown.length) die(`${flag}: unknown keys ${unknown.join(", ")} (known: ${known.join(", ")})`);
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

/** Путь с ~ вместо домашнего каталога — для вывода. */
function tilde(path: string) {
  const home = Deno.env.get("HOME");
  return home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** Источник: [location, localDir]. localDir = undefined для удалённого репозитория. */
async function resolveSource(spec: string): Promise<[string, string | undefined]> {
  if (isUrl(spec)) return [spec, undefined];
  const path = resolve(spec);
  if (!exists(path) || !(await git(["rev-parse", "--git-dir"], { cwd: path, check: false }))) {
    die(`${spec}: not a git repository`);
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
  if (!out.success) die(`Cannot read target ${target}:\n${new TextDecoder().decode(out.stderr).trim()}`);
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
        die(`Branch ${branch} is checked out in ${top} with uncommitted changes — commit or stash them first`);
      }
      resetHere = true;
    } else {
      die(`Branch ${branch} is checked out in another worktree: ${path} — switch it to another branch first`);
    }
  }
  const refspecs = ["+refs/heads/*:refs/heads/*", ...(tags ? ["+refs/tags/*:refs/tags/*"] : [])];
  await git([
    "fetch",
    "--quiet",
    ...(prune ? ["--prune"] : []),
    ...(resetHere ? ["--update-head-ok"] : []),
    mirror,
    ...refspecs,
  ], { cwd: target });
  if (resetHere) await git(["reset", "--hard", "--quiet"], { cwd: top });
}

async function deliverRemote(mirror: string, target: string, tags: boolean, prune: boolean) {
  const refspecs = ["+refs/heads/*:refs/heads/*", ...(tags ? ["+refs/tags/*:refs/tags/*"] : [])];
  await git(["push", "--quiet", "--force", ...(prune ? ["--prune"] : []), target, ...refspecs], { cwd: mirror });
}

function printFindings(total: number, paths: string[], plan: CommitPlan, rules: Rules, verbose: boolean) {
  const limit = verbose ? Infinity : 15;
  const count = (n: number) => n ? bold(String(n)) : dim("none");
  header(`Found in history ${dim(`· ${plural(total, "commit")}`)}`);
  if (rules.paths.length) {
    field("Files", count(paths.length));
    list(paths.map((p) => yellow(p)), limit);
  }
  if (rules.trailers.length) {
    const lines = [...plan.trailers].sort((a, b) => b[1] - a[1]);
    field("Trailers", count(lines.reduce((n, [, c]) => n + c, 0)));
    list(lines.map(([line, n]) => `${yellow(line)}  ${dim(`×${n}`)}`), limit);
  }
  if (rules.messageWords.length) field("Mentions", `${count(plan.scrubbed)} ${dim("commit messages")}`);
  if (rules.authors.length) {
    field("Authors", count(plan.authors.size));
    list([...plan.authors].sort().map((a) => yellow(a)), limit);
  }
  if (rules.fileWords.length) field("Contents", `${rules.fileWords.join(", ")} ${dim("(no preview)")}`);
  field(
    "Commits",
    plan.changes.size
      ? `${bold(String(plan.changes.size))} ${dim("with a new message or author")}`
      : dim("no message or author changes"),
  );
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
    unknown: (arg) => !arg.startsWith("-") || die(`Unknown option ${arg}, see --help`),
  });
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(denoJson.version);
  if (args._.length > 1) die("Pass a single source repository");
  const interactive = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  if (!(await git(["filter-repo", "--version"], { check: false }))) {
    die("git-filter-repo is required: pipx install git-filter-repo (or brew/apt install git-filter-repo)");
  }
  if (args.branch.length && args.all) die("--branch and --all are mutually exclusive");
  if ([args["in-place"], args.suffix, args.to].filter(Boolean).length > 1) {
    die("--in-place, --suffix and --to are mutually exclusive");
  }
  if (args["same-repo"] && args.target) die("--same-repo and --target are mutually exclusive");
  let dryRun = args["dry-run"];

  console.log(`${bold("git-repo-cleaner")} ${dim(`v${denoJson.version}`)}\n`);

  // Источник
  let sourceSpec = args._.length ? String(args._[0]) : "";
  if (!sourceSpec) {
    if (await git(["rev-parse", "--git-dir"], { check: false })) sourceSpec = ".";
    else {
      need(interactive, "a repository path or URL");
      sourceSpec = ask("Repository (path or URL)");
    }
  }
  const [source, sourceDir] = await resolveSource(sourceSpec);

  const tmp = await Deno.makeTempDir({ prefix: "git-repo-cleaner-" });
  const mirror = join(tmp, "repo.git");
  const branches = await step(`Cloned ${cyan(source)}`, async () => {
    await git(["clone", "--mirror", "--quiet", source, mirror]);
    return (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: mirror }))
      .split("\n").filter(Boolean);
  }, (found) => dim(`· ${plural(found.length, "branch", "branches")}`));
  if (!branches.length) die("The repository has no branches");
  const head = await git(["symbolic-ref", "--short", "HEAD"], { cwd: mirror, check: false });

  // Ветки
  let selected: string[];
  if (args.all) selected = branches;
  else if (args.branch.length) {
    const missing = args.branch.filter((b) => !branches.includes(b));
    if (missing.length) die(`No such branches: ${missing.join(", ")}`);
    selected = args.branch;
  } else {
    need(interactive, "--branch or --all");
    const pre = branches.includes(head) ? [branches.indexOf(head)] : [];
    selected = (await menu("Which branches to clean?", branches, true, pre)).map((i) => branches[i]);
  }
  const allBranches = branches.every((b) => selected.includes(b));

  // Имена веток
  const rename = new Map<string, string>();
  if (args["in-place"]) selected.forEach((b) => rename.set(b, b));
  else if (args.to) {
    if (selected.length !== 1) die("--to works with a single branch only");
    rename.set(selected[0], args.to);
  } else if (args.suffix) selected.forEach((b) => rename.set(b, b + args.suffix));
  else {
    need(interactive, "--in-place, --suffix or --to");
    const one = selected.length === 1;
    const newLabel = one
      ? `New branch (${selected[0]}${DEFAULT_SUFFIX} or a custom name)`
      : `New branches with a suffix (${DEFAULT_SUFFIX} or custom)`;
    const [choice] = await menu("Where to put the cleaned history?", [
      newLabel,
      "Same branches (rewrite history)",
    ], false);
    if (choice === 1) selected.forEach((b) => rename.set(b, b));
    else if (one) rename.set(selected[0], ask("New branch name", selected[0] + DEFAULT_SUFFIX));
    else {
      const suffix = ask("Suffix", DEFAULT_SUFFIX);
      selected.forEach((b) => rename.set(b, b + suffix));
    }
  }
  const dst = new Set(rename.values());
  const inPlace = [...rename].every(([s, d]) => s === d);
  if (dst.size !== rename.size) die("New branch names collide");

  // Целевой репозиторий
  let target: string;
  if (args["same-repo"]) target = source;
  else if (args.target) target = args.target;
  else {
    need(interactive, "--same-repo or --target");
    const options = [`This repository (${source})`], targets = [source];
    const origin = sourceDir ? await git(["remote", "get-url", "origin"], { cwd: sourceDir, check: false }) : "";
    if (origin) {
      options.push(`Its origin (${origin})`);
      targets.push(origin);
    }
    options.push("Another repository (URL or path)");
    const [choice] = await menu("Where to push the result?", options, false);
    target = choice < targets.length ? targets[choice] : ask("URL or path");
  }
  if (!isUrl(target)) target = resolve(target);
  const sameRepo = target === source;

  // Что чистить
  const asking = interactive && !args.yes;
  let picked: string[];
  if (args.only) picked = pickKeys(args.only, ARTIFACTS.map((a) => a.key), "--only");
  else if (asking) {
    const idx = await menu(
      "Which artifacts to clean?",
      ARTIFACTS.map((a) => a.label),
      true,
      ARTIFACTS.flatMap((a, i) => a.default ? [i] : []),
      (i) => ARTIFACTS[i].key,
    );
    picked = idx.map((i) => ARTIFACTS[i].key);
  } else picked = defaults(ARTIFACTS);
  let actions: Set<string>;
  if (args.actions) actions = new Set(pickKeys(args.actions, ACTIONS.map((a) => a.key), "--actions"));
  else if (asking) {
    const idx = await menu(
      "What to do with them?",
      ACTIONS.map((a) => a.label),
      true,
      ACTIONS.flatMap((a, i) => a.default ? [i] : []),
      (i) => ACTIONS[i].key,
    );
    actions = new Set(idx.map((i) => ACTIONS[i].key));
  } else actions = new Set(defaults(ACTIONS));
  const extra = { words: [...args.word], paths: [...args.path] };
  if (asking && !(extra.words.length || extra.paths.length || args.only)) {
    if (actions.has("mentions") || actions.has("content")) {
      extra.words.push(...splitList(ask("Extra mention regexes, comma-separated (Enter to skip)")));
    }
    extra.paths.push(...splitList(ask("Extra path regexes, comma-separated (Enter to skip)")));
  }
  for (const pattern of [...extra.words, ...extra.paths]) {
    try {
      new RegExp(pattern, "i");
    } catch (e) {
      die(`Invalid regex ${JSON.stringify(pattern)}: ${(e as Error).message}`);
    }
  }
  const rules = buildRules(ARTIFACTS.filter((a) => picked.includes(a.key)), actions, extra);
  if (isEmpty(rules)) die("Nothing to clean: no artifacts or actions selected");

  const name = args["author-name"] || await git(["config", "user.name"], { cwd: sourceDir, check: false });
  const email = args["author-email"] || await git(["config", "user.email"], { cwd: sourceDir, check: false });
  if (rules.authors.length && !(name && email)) {
    die("Author is not set: pass --author-name and --author-email or set git config user.name/user.email");
  }

  const tags = allBranches && (inPlace || !sameRepo) && !args["no-tags"];
  if (args.prune && !allBranches) die("--prune requires --all");

  // Что в цели будет перезаписано или удалено
  const current = await step(
    sameRepo ? "Inspected target refs" : `Inspected ${cyan(target)}`,
    () => snapshotTarget(mirror, target, sameRepo),
  );
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
  const { commits, plan, paths } = await step("Analyzed history", async () => {
    const commits = await readCommits(mirror, revs);
    return { commits, plan: planCommits(commits, rules), paths: await matchingPaths(mirror, revs, rules.paths) };
  });
  printFindings(commits.length, paths, plan, rules, args.verbose);

  // Сводка
  header("Plan");
  field("Source", source);
  field("Target", sameRepo ? dim("same repository") : target);
  const renames = [...rename].map(([s, d]) =>
    `${s} ${dim("→")} ${d}${targetHeads.has(d) ? `  ${yellow("⚠ overwrite")}` : ""}`
  );
  field("Branches", renames[0]);
  list(renames.slice(1), args.verbose ? Infinity : 15);
  if (pruned.length) field("Prune", `${pruned.join(", ")}  ${yellow("⚠ will be deleted")}`);
  field("Tags", tags ? "yes" : dim("no"));
  const extras = [...extra.words, ...extra.paths];
  field("Artifacts", `${picked.join(", ") || dim("none")}${extras.length ? ` ${dim("+")} ${extras.join(", ")}` : ""}`);
  field("Actions", ACTIONS.filter((a) => actions.has(a.key)).map((a) => a.key).join(", "));
  if (rules.authors.length) field("Author", `${name} <${email}>`);
  field(
    "Backup",
    args["no-backup"]
      ? yellow("disabled (--no-backup)")
      : lost.length
      ? `${plural(lost.length, "ref")} ${dim(`→ ${tilde(cacheDir())}/`)}`
      : dim("not needed, nothing is overwritten"),
  );
  if (dryRun) field("Mode", cyan("dry run — the target stays untouched"));
  console.log();
  if (!args.yes && !dryRun) {
    need(interactive, "--yes or --dry-run");
    const answer = ask(`Proceed? ${dim("[y]es / [d]ry run / [N]o")}`).toLowerCase();
    if (["d", "dry", "dry-run"].includes(answer)) dryRun = true;
    else if (!["y", "yes"].includes(answer)) cancel();
  }

  // Бэкап всего, что в цели будет перезаписано или удалено
  if (lost.length && !args["no-backup"] && !dryRun) {
    const dir = cacheDir();
    Deno.mkdirSync(dir, { recursive: true });
    const repoName = basename(target.replace(/[/\\]+$/, "")).replace(/\.git$/, "") || "repo";
    const bundle = join(dir, `${repoName}-${timestamp()}.bundle`);
    await step(
      `Backed up ${plural(lost.length, "ref")}`,
      () => git(["bundle", "create", "--quiet", bundle, ...lost.map((r) => current[r])], { cwd: mirror }),
      () => dim(`→ ${tilde(bundle)}`),
    );
  }
  const backupRefs = Object.values(current);
  if (backupRefs.length) {
    await git(["update-ref", "--stdin"], { cwd: mirror, input: backupRefs.map((r) => `delete ${r}\n`).join("") });
  }

  // Очистка
  if (paths.length || plan.changes.size || rules.fileWords.length) {
    const fr = ["filter-repo", "--force", "--quiet"];
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
    await step("Rewrote history", () => git(fr, { cwd: mirror }));

    const left = await step("Verified the result", async () => {
      const commits = planCommits(await readCommits(mirror, ["--all"]), rules);
      const files = await matchingPaths(mirror, ["--all"], rules.paths);
      return [...[...commits.changes.keys()].map((sha) => `commit ${sha}`), ...files.map((p) => `file ${p}`)];
    }, (found) => found.length ? "" : dim("· no artifacts left"));
    if (left.length) {
      die(
        "Artifacts are still present, nothing was pushed:\n  " + left.slice(0, 50).join("\n  ") +
          `\nCleaned copy for inspection: ${mirror}`,
      );
    }
  } else {
    console.log(`${green("✔")} Nothing to clean ${dim("· branches are copied as is")}`);
  }

  if (dryRun) {
    console.log(`\n${cyan("◆")} ${bold("Dry run complete")} ${dim("— the target was not changed")}`);
    field("Cleaned copy", mirror);
    field("Inspect", `git -C ${mirror} log --all --stat`);
    return;
  }
  await step(
    isUrl(target) ? `Pushed to ${cyan(target)}` : `Updated ${cyan(target)}`,
    () =>
      isUrl(target)
        ? deliverRemote(mirror, target, tags, args.prune)
        : deliverLocal(mirror, target, dst, tags, args.prune),
  );
  await Deno.remove(tmp, { recursive: true });
  console.log(`\n${green("◆")} ${bold("Done")} ${dim("·")} ${[...dst].sort().join(", ")}`);
}

if (import.meta.main) await main();

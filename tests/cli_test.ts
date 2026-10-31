/** Сквозные тесты CLI на временных репозиториях. Нужны git и git-filter-repo. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const hasFilterRepo = new Deno.Command("git", { args: ["filter-repo", "--version"], stdout: "null", stderr: "null" })
  .outputSync().success;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Me",
  GIT_AUTHOR_EMAIL: "me@example.com",
  GIT_COMMITTER_NAME: "Me",
  GIT_COMMITTER_EMAIL: "me@example.com",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const out = new Deno.Command("git", { args, cwd, env: { ...IDENTITY, ...env }, stdin: "null" }).outputSync();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${text(out.stderr)}`);
  return text(out.stdout).trim();
}

function commit(repo: string, files: Record<string, string>, message: string, env: Record<string, string> = {}) {
  for (const [path, content] of Object.entries(files)) {
    Deno.mkdirSync(join(repo, path, ".."), { recursive: true });
    Deno.writeTextFileSync(join(repo, path), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message], env);
}

const CLAUDE = { GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "noreply@anthropic.com" };

/** Репозиторий: чистый корневой коммит, коммит Claude с артефактами, ветка feat и тег. */
function fixture(): { dir: string; repo: string; cache: string; root: string } {
  const dir = Deno.makeTempDirSync({ prefix: "git-repo-cleaner-test-" });
  const repo = join(dir, "src");
  git(dir, ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Me"]);
  git(repo, ["config", "user.email", "me@example.com"]);
  commit(repo, { "README.md": "hello\n" }, "Initial commit");
  const root = git(repo, ["rev-parse", "HEAD"]);
  commit(
    repo,
    {
      "CLAUDE.md": "rules\n",
      ".claude/settings.json": "{}\n",
      "src/claude_client.ts": "export const model = 'claude';\n",
      "notes.md": "made with claude\n",
    },
    "Add client via Claude Code\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n" +
      "Co-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Bob <bob@example.com>",
    CLAUDE,
  );
  git(repo, ["checkout", "-q", "-b", "feat"]);
  commit(repo, { "AGENTS.md": "agents\n", "feat.txt": "f\n" }, "Feature");
  git(repo, ["tag", "v1"]);
  git(repo, ["checkout", "-q", "main"]);
  return { dir, repo, cache: join(dir, "cache"), root };
}

async function run(cwd: string, cache: string, args: string[]) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-run=git", "--allow-read", "--allow-write", "--allow-env", MAIN, ...args],
    cwd,
    env: { XDG_CACHE_HOME: cache, NO_COLOR: "1" },
    stdin: "null",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, output: text(out.stdout) + text(out.stderr) };
}

const files = (repo: string, ref: string) => git(repo, ["ls-tree", "-r", "--name-only", ref]).split("\n");
const bundles = (cache: string) => {
  try {
    return [...Deno.readDirSync(join(cache, "git-repo-cleaner"))].map((e) => join(cache, "git-repo-cleaner", e.name));
  } catch {
    return [];
  }
};

Deno.test({
  name: "новая ветка: точная очистка по умолчанию, чистые коммиты сохраняют SHA",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache, root } = fixture();
    const { code, output } = await run(repo, cache, ["-b", "main", "--suffix=-clean", "--same-repo", "-y"]);
    assertEquals(code, 0, output);
    assertStringIncludes(output, "CLAUDE.md");
    assertStringIncludes(output, "Co-Authored-By: Claude <noreply@anthropic.com>  ×1");

    assertEquals(files(repo, "main-clean"), ["README.md", "notes.md", "src/claude_client.ts"]);
    assertEquals(git(repo, ["show", "main-clean:notes.md"]), "made with claude"); // content выключен
    assertEquals(
      git(repo, ["log", "-1", "--format=%an <%ae>%n%B", "main-clean"]),
      "Me <me@example.com>\nAdd client via Claude Code\n\nCo-authored-by: Bob <bob@example.com>",
    );
    assertEquals(git(repo, ["rev-list", "--max-parents=0", "main-clean"]), root);
    assertEquals(git(repo, ["log", "-1", "--format=%an", "main"]), "Claude"); // исходная ветка не тронута
    assertEquals(bundles(cache), []); // перезаписывать нечего
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test({
  name: "dry-run показывает план и ничего не меняет",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache } = fixture();
    const before = git(repo, ["for-each-ref"]);
    const { code, output } = await run(repo, cache, ["--all", "--in-place", "--same-repo", "--dry-run"]);
    assertEquals(code, 0, output);
    assertStringIncludes(output, "файлы к удалению: 3");
    assertStringIncludes(output, "Claude <noreply@anthropic.com>");
    assertStringIncludes(output, "✅ Dry-run");
    assertEquals(git(repo, ["for-each-ref"]), before);
    assertEquals(bundles(cache), []);
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test({
  name: "все ветки на месте: открытая ветка обновляется, теги переносятся, бэкап создаётся",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache } = fixture();
    const oldMain = git(repo, ["rev-parse", "main"]);
    const { code, output } = await run(repo, cache, ["--all", "--in-place", "--same-repo", "-y"]);
    assertEquals(code, 0, output);
    assertEquals(files(repo, "feat"), ["README.md", "feat.txt", "notes.md", "src/claude_client.ts"]);
    assertEquals(git(repo, ["rev-parse", "v1^{commit}"]), git(repo, ["rev-parse", "feat"]));
    assert(!Deno.statSync(join(repo, "README.md")).isDirectory);
    assertEquals(git(repo, ["status", "--porcelain"]), ""); // рабочая копия синхронизирована
    const [bundle] = bundles(cache);
    assertStringIncludes(git(repo, ["bundle", "list-heads", bundle]), `${oldMain} refs/backup/heads/main`);
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test({
  name: "другой репозиторий с --prune: лишние ветки удаляются и попадают в бэкап",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache } = fixture();
    const pub = join(dir, "pub.git");
    git(dir, ["init", "-q", "--bare", pub]);
    git(repo, ["push", "-q", pub, "main:old"]);
    const { code, output } = await run(repo, cache, [
      "--all",
      "--in-place",
      "--target",
      `file://${pub}`,
      "--prune",
      "-y",
    ]);
    assertEquals(code, 0, output);
    assertStringIncludes(output, "удалятся: old");
    assertEquals(git(pub, ["for-each-ref", "--format=%(refname)"]), "refs/heads/feat\nrefs/heads/main\nrefs/tags/v1");
    assertStringIncludes(git(repo, ["bundle", "list-heads", bundles(cache)[0]]), "refs/backup/heads/old");
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test({
  name: "mentions и content вырезают упоминания по запросу",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache } = fixture();
    const target = join(dir, "fresh");
    const { code, output } = await run(repo, cache, [
      "-b",
      "main",
      "--in-place",
      "--target",
      target,
      "--only",
      "claude",
      "--actions",
      "files,trailers,mentions,content",
      "-y",
    ]);
    assertEquals(code, 0, output);
    assertEquals(git(target, ["show", "main:notes.md"]), "made with");
    assertEquals(git(target, ["log", "-1", "--format=%s", "main"]), "Add client via");
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test({
  name: "без терминала и без --yes не запускается",
  ignore: !hasFilterRepo,
  async fn() {
    const { dir, repo, cache } = fixture();
    const { code, output } = await run(repo, cache, ["--all", "--in-place", "--same-repo"]);
    assertEquals(code, 1);
    assertStringIncludes(output, "--yes или --dry-run");
    Deno.removeSync(dir, { recursive: true });
  },
});

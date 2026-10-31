import { assert, assertEquals } from "@std/assert";
import { ARTIFACTS, buildRules, isEmpty, matcher } from "../src/artifacts.ts";

const byKey = (key: string) => ARTIFACTS.filter((a) => a.key === key);
const pathsOf = (key: string, actions: string[]) =>
  matcher(buildRules(byKey(key), new Set(actions), { words: [], paths: [] }).paths);

function check(isArtifact: (path: string) => boolean, yes: string[], no: string[]) {
  for (const path of yes) assert(isArtifact(path), `должен совпасть: ${path}`);
  for (const path of no) assert(!isArtifact(path), `не должен совпасть: ${path}`);
}

Deno.test("claude: точные имена", () => {
  check(
    pathsOf("claude", ["files"]),
    [
      ".claude/settings.json",
      "app/.claude/commands/x.md",
      "CLAUDE.md",
      "docs/CLAUDE.md",
      "CLAUDE.local.md",
      "claudedocs/notes.md",
      ".vscode/claude.json",
      ".clauderc",
      "claude-session.log",
    ],
    ["src/claude_client.ts", ".claude2/x", "my.claude/x", "MY-CLAUDE.md", "CLAUDE.md.backup", "docs/claude-guide.md"],
  );
});

Deno.test("claude: расширенные шаблоны", () => {
  check(
    pathsOf("claude", ["extended"]),
    [
      "src/claude_client.ts",
      "claude-session-1.json",
      "claude.json",
      ".vscode/claude-settings.json",
      ".claude2/x",
      ".mcp.json",
    ],
    ["src/main.ts", "session-claude.json", "README.md"],
  );
});

Deno.test("agents, openspec, serena, cursor, copilot, gemini, aider, windsurf, codex", () => {
  check(pathsOf("agents", ["files"]), ["AGENTS.md", "sub/AGENT.md", "AGENTS.override.md"], [
    "MY-AGENTS.md",
    "agents/x.ts",
  ]);
  check(pathsOf("openspec", ["files"]), ["openspec/specs/a.md"], ["docs/openspec-notes.md"]);
  check(pathsOf("serena", ["files"]), [".serena/memories/x.md"], ["serena.md"]);
  check(pathsOf("cursor", ["files"]), [".cursor/rules/a.mdc", ".cursorrules", ".cursorignore"], ["cursor.ts"]);
  check(
    pathsOf("copilot", ["files"]),
    [".github/copilot-instructions.md", ".github/prompts/review.prompt.md"],
    [".github/workflows/ci.yml"],
  );
  check(pathsOf("gemini", ["files"]), ["GEMINI.md", ".gemini/settings.json"], ["gemini.ts"]);
  check(pathsOf("aider", ["files"]), [".aider.chat.history.md", ".aider.tags.cache.v3/x"], ["aider.md"]);
  check(pathsOf("windsurf", ["files"]), [".windsurf/rules.md", ".windsurfrules"], ["windsurf.ts"]);
  check(pathsOf("codex", ["files"]), [".codex/config.toml"], ["codex.ts"]);
});

Deno.test("авторы-боты точные, люди не задеваются", () => {
  const isBot = matcher(buildRules(ARTIFACTS, new Set(["authors"]), { words: [], paths: [] }).authors);
  assert(isBot("Claude", "noreply@anthropic.com"));
  assert(isBot("someone", "bot@anthropic.com"));
  assert(isBot("Copilot", "175728472+Copilot@users.noreply.github.com"));
  assert(isBot("Cursor Agent", "cursoragent@cursor.com"));
  assert(isBot("Jane (aider)", "jane@example.com"));
  assert(!isBot("Claude Monet", "claude@monet.fr"));
  assert(!isBot("Jane", "jane@example.com"));
});

Deno.test("действия включают только свои правила", () => {
  const extra = { words: ["secret"], paths: ["^tmp/"] };
  const rules = buildRules(ARTIFACTS, new Set(["trailers"]), extra);
  assertEquals(rules.paths, []);
  assertEquals(rules.fileWords, []);
  assertEquals(rules.messageWords, []);
  assert(rules.trailers.length > 0);
  assert(isEmpty(buildRules(byKey("windsurf"), new Set(["trailers", "authors"]), { words: [], paths: [] })));
  assert(buildRules([], new Set(["files"]), extra).paths.includes("^tmp/"));
  assert(buildRules([], new Set(["content"]), extra).fileWords.includes("secret"));
});

Deno.test("шаблоны путей и слов совместимы с Python re (их исполняет git-filter-repo)", async () => {
  const patterns = ARTIFACTS.flatMap((a) => [...(a.paths ?? []), ...(a.extended ?? []), ...(a.words ?? [])]);
  const out = await new Deno.Command("python3", {
    args: ["-I", "-c", "import json,re,sys\nfor p in json.load(sys.stdin): re.compile('(?i)' + p)"],
    stdin: "piped",
    stderr: "piped",
  }).spawn();
  const writer = out.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(patterns)));
  await writer.close();
  const result = await out.output();
  assert(result.success, new TextDecoder().decode(result.stderr));
});

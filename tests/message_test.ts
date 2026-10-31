import { assertEquals } from "@std/assert";
import { ARTIFACTS, buildRules } from "../src/artifacts.ts";
import { cleanMessage, compileMessageRules, FALLBACK_MESSAGE } from "../src/message.ts";

const all = ARTIFACTS;
const trailerRules = buildRules(all, new Set(["trailers"]), { words: [], paths: [] });
const trailersOnly = compileMessageRules(trailerRules.trailers, []);
const withMentions = compileMessageRules(
  trailerRules.trailers,
  buildRules(all.filter((a) => a.key === "claude"), new Set(["mentions"]), { words: [], paths: [] }).messageWords,
);

Deno.test("удаляет атрибуции Claude из блока трейлеров, чужие трейлеры остаются", () => {
  const message = [
    "Add parser",
    "",
    "Body text.",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "",
    "Signed-off-by: Jane <jane@example.com>",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Co-authored-by: Bob <bob@example.com>",
    "",
  ].join("\n");
  const result = cleanMessage(message, trailersOnly);
  assertEquals(
    result.message,
    "Add parser\n\nBody text.\n\nSigned-off-by: Jane <jane@example.com>\nCo-authored-by: Bob <bob@example.com>\n",
  );
  assertEquals(result.removed, [
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ]);
});

Deno.test("текст коммита с упоминанием Claude не трогается без mentions", () => {
  const message = "Fix banner\n\nGenerated with Claude Code is the banner text.\n🤖 emoji in prose\n\nRefs: 12\n";
  const result = cleanMessage(message, trailersOnly);
  assertEquals(result, { message, changed: false, removed: [], scrubbed: false });
});

Deno.test("атрибуция посреди текста (не в хвосте) остаётся", () => {
  const message = "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nmore prose here\n";
  assertEquals(cleanMessage(message, trailersOnly).changed, false);
});

Deno.test("сообщение без изменений возвращается байт в байт", () => {
  const message = "Subject  \n\n\n\nbody with   spaces\n\n\n";
  assertEquals(cleanMessage(message, withMentions).message, message);
});

Deno.test("сообщение только из атрибуций заменяется заглушкой", () => {
  const result = cleanMessage(
    "🤖 Generated with Claude Code\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
    trailersOnly,
  );
  assertEquals(result.message, FALLBACK_MESSAGE + "\n");
});

Deno.test("после удаления пустые строки схлопываются", () => {
  const result = cleanMessage(
    "Subject\n\nBody\n\n\n🤖 Generated with [Claude Code](https://x)\n\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n",
    trailersOnly,
  );
  assertEquals(result.message, "Subject\n\nBody\n");
});

Deno.test("атрибуции других инструментов", () => {
  for (
    const line of [
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
      "Co-authored-by: aider (gpt-4o) <noreply@aider.chat>",
      "Co-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>",
    ]
  ) {
    assertEquals(cleanMessage(`Subject\n\n${line}\n`, trailersOnly).message, "Subject\n", line);
  }
});

Deno.test("mentions вырезает упоминания и лишние пробелы", () => {
  const result = cleanMessage("Add via Claude Code tool\n\nAsk claude later\n", withMentions);
  assertEquals(result.message, "Add via tool\n\nAsk later\n");
  assertEquals(result.scrubbed, true);
});

Deno.test("mentions, вырезавший весь заголовок, не оставляет пустое сообщение", () => {
  assertEquals(cleanMessage("Claude\n", withMentions).message, FALLBACK_MESSAGE + "\n");
});

Deno.test("CRLF в трейлерах распознаётся", () => {
  assertEquals(
    cleanMessage("Subject\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\n", trailersOnly).message,
    "Subject\r\n",
  );
});

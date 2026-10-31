/**
 * Очистка сообщения коммита. Единственная реализация: ею строится план изменений
 * (предпросмотр), её результат применяет git-filter-repo, ею же проверяется итог.
 *
 * - Трейлеры-атрибуции удаляются только из блока трейлеров в конце сообщения и только
 *   при полном совпадении строки с шаблоном. Текст выше блока и чужие трейлеры
 *   (Signed-off-by, Co-authored-by людей) остаются.
 * - Упоминания (words) вырезаются из всех строк, только если это явно включено.
 * - Сообщение без изменений возвращается байт в байт; изменённое нормализуется.
 * - Пустым сообщение не становится: вместо него FALLBACK_MESSAGE.
 */

export const FALLBACK_MESSAGE = "Update files";

/** Строка вида `Token: value` — граница блока трейлеров определяется по ним. */
const GENERIC_TRAILER = /^[A-Za-z][A-Za-z0-9-]*:(?:[ \t]|$)/;

export interface MessageRules {
  /** Атрибуции: строка удаляется, если целиком совпала (^…$). */
  trailers: RegExp[];
  /** Упоминания: вырезаются из строк. */
  words: RegExp[];
}

export function compileMessageRules(trailers: string[], words: string[]): MessageRules {
  return {
    trailers: trailers.map((p) => new RegExp(`^(?:${p})$`, "i")),
    words: words.map((p) => new RegExp(p, "gi")),
  };
}

export interface CleanedMessage {
  message: string;
  changed: boolean;
  /** Удалённые строки-атрибуции, по одной на физическую строку. */
  removed: string[];
  /** Были ли вырезаны упоминания. */
  scrubbed: boolean;
}

const isBlank = (line: string) => line.trim() === "";

export function cleanMessage(message: string, rules: MessageRules): CleanedMessage {
  const lines = message.split("\n");
  const isAttribution = (line: string) => rules.trailers.some((re) => re.test(line.trim()));

  // Блок трейлеров — максимальный хвост из пустых строк, атрибуций и `Token: value`.
  let blockStart = lines.length;
  while (blockStart > 0) {
    const line = lines[blockStart - 1];
    if (!(isBlank(line) || isAttribution(line) || GENERIC_TRAILER.test(line))) break;
    blockStart--;
  }

  const removed: string[] = [];
  let scrubbed = false;
  const kept: string[] = [];
  lines.forEach((line, i) => {
    if (i >= blockStart && isAttribution(line)) {
      removed.push(line.trim());
      return;
    }
    let cleaned = line;
    for (const re of rules.words) cleaned = cleaned.replace(re, "");
    if (cleaned !== line) {
      scrubbed = true;
      cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trimEnd();
    }
    kept.push(cleaned);
  });
  if (!removed.length && !scrubbed) return { message, changed: false, removed, scrubbed };

  // Нормализация только изменённых сообщений: без пустых строк по краям и без повторов.
  const normalized: string[] = [];
  for (const line of kept) {
    if (isBlank(line) && (!normalized.length || isBlank(normalized[normalized.length - 1]))) continue;
    normalized.push(isBlank(line) ? "" : line);
  }
  while (normalized.length && isBlank(normalized[normalized.length - 1])) normalized.pop();
  const result = (normalized.length ? normalized.join("\n") : FALLBACK_MESSAGE) + "\n";
  return { message: result, changed: result !== message, removed, scrubbed };
}

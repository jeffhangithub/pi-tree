/**
 * Reply language preference — global default + session override.
 *
 * Two levels, resolved in order:
 *   1. Session-level override (SessionContext.replyLanguage, stored on the
 *      session DB row via PUT /api/sessions/:userId/:sourceId/:sessionId)
 *   2. Global default ($DATA_PATH/models.json `replyLanguage`, managed by
 *      GET/PUT /api/settings)
 *
 * The resolved language is turned into an instruction line that the server
 * injects into the session systemContext (at creation) and, for session-level
 * overrides, into every user turn (see TreeManager). "follow" means "answer
 * in the same language as the user's question".
 */

import { loadModelsJson, saveModelsJsonPreferences } from "./models-json.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export const REPLY_LANGUAGES = ["follow", "zh", "en", "ja", "de", "fr"] as const;

export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

/** Human-readable labels — the canonical UI option list. */
export const REPLY_LANGUAGE_LABELS: Record<ReplyLanguage, string> = {
  follow: "跟随提问",
  zh: "中文",
  en: "English",
  ja: "日本語",
  de: "Deutsch",
  fr: "Français",
};

/** Language names used inside the injected instruction line. */
const REPLY_LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  follow: "the same language as the user's question",
  zh: "Chinese (中文)",
  en: "English",
  ja: "Japanese (日本語)",
  de: "German (Deutsch)",
  fr: "French (Français)",
};

export function isReplyLanguage(value: unknown): value is ReplyLanguage {
  return (
    typeof value === "string" &&
    (REPLY_LANGUAGES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Global preference (models.json)
// ---------------------------------------------------------------------------

/** Read the global reply language default; invalid/missing → "follow". */
export function getGlobalReplyLanguage(): ReplyLanguage {
  const lang = loadModelsJson()?.replyLanguage;
  return isReplyLanguage(lang) ? lang : "follow";
}

/** Persist the global reply language default to models.json. */
export function saveGlobalReplyLanguage(lang: ReplyLanguage): void {
  saveModelsJsonPreferences({ replyLanguage: lang });
}

// ---------------------------------------------------------------------------
// Instruction building
// ---------------------------------------------------------------------------

/**
 * The language policy line injected into the model.
 *
 * - "follow" → answer in the same language as the user's question
 * - otherwise → "Always answer in <lang> unless the user explicitly asks
 *   otherwise." (the user's explicit in-message request always wins)
 */
export function buildReplyLanguageInstruction(
  language: string | undefined,
): string {
  const resolved: ReplyLanguage = isReplyLanguage(language) ? language : "follow";
  if (resolved === "follow") {
    return "Answer in the same language as the user's question.";
  }
  return `Always answer in ${REPLY_LANGUAGE_NAMES[resolved]} unless the user explicitly asks otherwise.`;
}

/**
 * Wrap a user message with the transient per-turn reply-language block.
 * Uses the `[SYSTEM CONTEXT …]` + `\n\n---\n\n` marker convention that the
 * SDK's content-map and label inference already strip, so the injected block
 * never surfaces in the chat UI, tree labels, or exported records.
 */
export function prependReplyLanguageInstruction(
  message: string,
  instruction: string,
): string {
  if (!instruction) return message;
  return `[SYSTEM CONTEXT — Reply Language]\n${instruction}\n\n---\n\n${message}`;
}

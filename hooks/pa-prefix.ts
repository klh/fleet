#!/usr/bin/env bun
/** UserPromptSubmit: a prompt starting with "PA:" or "PA " is a personal-assistant
 *  request — inject assistant rules so it's handled per ~/assistant/CLAUDE.md. */
import { context } from "./lib/hookio.ts";

const input = JSON.parse(await Bun.stdin.text()) as { prompt?: string };
const prompt = (input.prompt ?? "").trimStart();
if (/^PA[:\s]/.test(prompt)) {
  context(
    [
      "PA-MODE — this message is a personal-assistant request. Read ~/assistant/CLAUDE.md and follow it:",
      "level A autonomy (drafts only, never send/accept/delete — sole exception: owner-requested self-delivery via `bun ~/assistant/lib/mail.ts send-self`),",
      "cite sources, 'I could not find' beats guessing, max one clarifying question, Danish/English matching the message.",
      "Mail: `bun ~/assistant/lib/mail.ts unread|find <text>|draft|send-self` · Calendar: `~/assistant/lib/cal <days>` · Memory: ~/assistant/memory/.",
    ].join(" "),
    "UserPromptSubmit",
  );
}

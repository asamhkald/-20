import type { SupportedAiLanguage } from "../modules/ai";

type BrowserSpeechSynthesis = { cancel(): void; speak(utterance: SpeechSynthesisUtterance): void };

export function speakResultAloud(text: string, language: SupportedAiLanguage): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const win = typeof globalThis !== "undefined"
    ? (globalThis as { speechSynthesis?: BrowserSpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
    : undefined;
  if (!win?.speechSynthesis || typeof win.SpeechSynthesisUtterance !== "function") return false;

  win.speechSynthesis.cancel();
  const utterance = new win.SpeechSynthesisUtterance(clean);
  utterance.lang = language === "ar" ? "ar-SA" : "en-US";
  utterance.rate = 1.0;
  win.speechSynthesis.speak(utterance);
  return true;
}

import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import { en } from "@/locales/en";
import { id } from "@/locales/id";
import type { Translations } from "@/locales/en";
import { updateProfile } from "@workspace/api-client-react";

export type { Translations } from "@/locales/en";
export type Language = "en" | "id";

const translations: Record<Language, Translations> = { en, id };

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  setLang: () => {},
  t: en,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    try {
      const stored = localStorage.getItem("app_lang");
      if (stored === "en" || stored === "id") return stored;
    } catch {}
    return "en";
  });

  const syncing = useRef(false);
  const setLang = (l: Language) => {
    setLangState(l);
    try {
      localStorage.setItem("app_lang", l);
    } catch {}
    // Best-effort sync to the server so background dispatchers
    // (weekly trader-mirror report, etc.) localise pushes correctly.
    // Anonymous visitors will get a 401 — silently swallowed.
    if (!syncing.current) {
      syncing.current = true;
      updateProfile({ lang: l })
        .catch(() => {})
        .finally(() => {
          syncing.current = false;
        });
    }
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t: translations[lang] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}

const CANONICAL_SECURITY_QUESTIONS = id.profile.security_questions;

export function getSecurityQuestionOptions(
  lang: Language,
): Array<{ value: string; label: string }> {
  const labels = translations[lang].profile.security_questions;
  return CANONICAL_SECURITY_QUESTIONS.map((value, idx) => ({
    value,
    label: labels[idx] ?? value,
  }));
}

export function fromCanonicalSecurityQuestion(
  canonical: string,
  lang: Language,
): string {
  const idx = CANONICAL_SECURITY_QUESTIONS.indexOf(canonical);
  const arr = translations[lang].profile.security_questions;
  if (idx >= 0 && idx < arr.length) {
    return arr[idx]!;
  }
  return canonical;
}

import { useTranslation, type Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function FlagIcon({ lang }: { lang: Language }) {
  if (lang === "id") {
    return (
      <svg
        viewBox="0 0 24 16"
        aria-hidden="true"
        className="block h-3.5 w-5 overflow-hidden rounded-sm ring-1 ring-black/10"
      >
        <rect width="24" height="8" fill="#E70011" />
        <rect y="8" width="24" height="8" fill="#FFFFFF" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      className="block h-3.5 w-5 overflow-hidden rounded-sm ring-1 ring-black/10"
    >
      <rect width="24" height="16" fill="#B22234" />
      <path d="M0 2h24v2H0zm0 4h24v2H0zm0 4h24v2H0zm0 4h24v2H0z" fill="#FFFFFF" />
      <rect width="10.5" height="8.8" fill="#3C3B6E" />
    </svg>
  );
}

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang } = useTranslation();
  const nextLang = lang === "en" ? "id" : "en";

  return (
    <button
      type="button"
      onClick={() => setLang(nextLang)}
      aria-label={lang === "en" ? "Switch to Indonesian" : "Beralih ke Bahasa Inggris"}
      title={lang === "en" ? "Switch to Indonesian" : "Beralih ke Bahasa Inggris"}
      data-testid="button-language-toggle"
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-muted/50 text-foreground transition-all hover:bg-muted",
        className,
      )}
    >
      <FlagIcon lang={lang} />
    </button>
  );
}

import { useTranslation } from "@/lib/i18n";

/** "──── or ────" separator between <SocialSignInMenu> and the email form. */
export function AuthDivider() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 my-5" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {t.auth.or_divider}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

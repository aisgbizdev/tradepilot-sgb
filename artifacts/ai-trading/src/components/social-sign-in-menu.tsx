import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/lib/i18n";

function GoogleIcon() {
  return (
    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
      />
    </svg>
  );
}

function TiktokIcon() {
  return (
    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0 1 15.54 3h-3.09v12.4a2.592 2.592 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z"
      />
    </svg>
  );
}

/**
 * Consolidates the Google/Facebook/TikTok "continue with" buttons (used on
 * both login.tsx and register.tsx — the OAuth flow is identical for
 * sign-in vs. sign-up, the server tells returning users from new ones)
 * into a single dropdown trigger instead of three stacked full-width
 * buttons. Each item kicks off the same server-side OAuth redirect the
 * individual buttons used to — a plain top-level navigation, so there's
 * nothing to await here.
 */
export function SocialSignInMenu({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();

  const providers = [
    {
      id: "google",
      href: "/api/auth/google",
      testId: "button-google-signin",
      icon: <GoogleIcon />,
      label: t.auth.continue_with_google,
    },
    {
      id: "facebook",
      href: "/api/auth/facebook",
      testId: "button-facebook-signin",
      icon: <FacebookIcon />,
      label: t.auth.continue_with_facebook,
    },
    {
      id: "tiktok",
      href: "/api/auth/tiktok",
      testId: "button-tiktok-signin",
      icon: <TiktokIcon />,
      label: t.auth.continue_with_tiktok,
    },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="button-social-signin-menu"
          className="w-full h-12 rounded-xl border border-border bg-card font-semibold text-foreground flex items-center justify-center gap-2 hover:bg-muted transition-colors disabled:opacity-60"
        >
          {t.auth.social_signin_cta}
          <ChevronDown className="w-4 h-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56"
      >
        {providers.map((provider) => (
          <DropdownMenuItem
            key={provider.id}
            onClick={() => {
              window.location.href = provider.href;
            }}
            disabled={disabled}
            data-testid={provider.testId}
            className="gap-2.5 py-2.5 cursor-pointer"
          >
            {provider.icon}
            {provider.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

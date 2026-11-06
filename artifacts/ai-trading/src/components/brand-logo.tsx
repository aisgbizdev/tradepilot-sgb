import { type HTMLAttributes, type ImgHTMLAttributes } from "react";

type BrandLogoProps = {
  variant?: "horizontal" | "compact";
} & HTMLAttributes<HTMLDivElement> & ImgHTMLAttributes<HTMLImageElement>;

export function BrandLogo({
  className,
  variant = "compact",
  ...props
}: BrandLogoProps) {
  if (variant === "horizontal") {
    return (
      <div className="flex items-center gap-2 md:gap-2.5" data-testid="brand-logo">
        <img src="/logo-compact.png" alt="" className={`object-contain shrink-0 ${className || ""}`} />
        <div className="flex flex-col justify-center">
          <span className="text-lg md:text-xl font-extrabold tracking-tight leading-none text-inherit">
            TradePilot<span className="text-primary">.id</span>
          </span>
          <span className="text-[6px] md:text-[7px] font-semibold text-primary uppercase tracking-[0.22em] leading-none mt-1">
            UNIVERSE COMES TO US
          </span>
        </div>
      </div>
    );
  }

  return (
    <img
      src="/logo-compact.png"
      alt="TradePilot.id"
      className={`object-contain ${className || ""}`}
      data-testid="brand-logo"
      {...props}
    />
  );
}

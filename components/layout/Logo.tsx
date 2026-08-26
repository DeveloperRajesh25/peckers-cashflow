import { cn } from "@/lib/utils";

export function Logo({
  className,
  compact = false,
  tagline = "Cash flow",
  variant = "default",
}: {
  className?: string;
  compact?: boolean;
  tagline?: string;
  variant?: "default" | "auth";
}) {
  const isAuth = variant === "auth";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      
      {!compact && (
        <div className={cn("flex flex-col leading-tight", isAuth && "items-center text-center gap-1")}>
          <span className={cn("text-text-primary font-semibold tracking-wide text-sm", isAuth && "uppercase")}>
            Peckers
          </span>
          <span className="text-text-muted text-[10px] uppercase tracking-[0.18em]">
            {tagline}
          </span>
        </div>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "@/components/ui/icons";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string | null;
  prefix?: React.ReactNode;
  containerClassName?: string;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, prefix, className, containerClassName, id, type, onWheel, ...props },
  ref,
) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  // A focused number input answers the mouse wheel, so scrolling a page with
  // the cursor over one silently retypes it — on these screens that is someone's
  // hours, deliveries or cash. Blur instead and let the page scroll.
  const handleWheel =
    type === "number"
      ? (e: React.WheelEvent<HTMLInputElement>) => {
          onWheel?.(e);
          e.currentTarget.blur();
        }
      : onWheel;
  return (
    <div className={cn("flex flex-col gap-1.5 min-w-0", containerClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-subtle break-words">
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl bg-surface border border-border px-3 h-11 min-w-0 transition-colors",
          "focus-within:border-gold/60 focus-within:ring-2 focus-within:ring-gold/30",
          error && "border-danger/60 focus-within:ring-danger/30",
        )}
      >
        {prefix && <span className="text-text-muted text-sm shrink-0">{prefix}</span>}
        <input
          id={inputId}
          ref={ref}
          type={type}
          onWheel={handleWheel}
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none text-text-primary placeholder:text-text-muted text-sm w-full",
            className,
          )}
          {...props}
        />
      </div>
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string | null;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...props },
  ref,
) {
  const autoId = React.useId();
  const textareaId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {label && (
        <label htmlFor={textareaId} className="text-sm font-medium text-text-subtle break-words">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        ref={ref}
        className={cn(
          "w-full min-w-0 rounded-xl bg-surface border border-border px-3 py-3 text-sm outline-none placeholder:text-text-muted",
          "focus:border-gold/60 focus:ring-2 focus:ring-gold/30",
          error && "border-danger/60 focus:ring-danger/30",
          className,
        )}
        {...props}
      />
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

type SelectOption = { value: string; label: string; disabled?: boolean };

function parseOptions(children: React.ReactNode): SelectOption[] {
  const opts: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === "option") {
      const p = child.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean };
      opts.push({
        value: String(p.value ?? ""),
        label: String(p.children ?? ""),
        disabled: p.disabled,
      });
    }
  });
  return opts;
}

type SelectProps = {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  label?: string;
  error?: string | null;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  id?: string;
};

export function Select({ label, error, disabled, className, children, id, value, onChange }: SelectProps) {
  const autoId = React.useId();
  const selectId = id ?? autoId;

  const [open, setOpen] = React.useState(false);
  const [flipUp, setFlipUp] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const options = parseOptions(children);
  const selected = options.find((o) => String(o.value) === String(value ?? ""));

  React.useEffect(() => {
    if (open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setFlipUp(window.innerHeight - rect.bottom < options.length * 40 + 16);
    }
  }, [open, options.length]);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(val: string) {
    onChange?.({ target: { value: val } });
    setOpen(false);
  }

  return (
    <div className={cn("flex flex-col gap-1.5 min-w-0", className)}>
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-text-subtle break-words">
          {label}
        </label>
      )}
      <div ref={wrapRef} className="relative">
        <button
          id={selectId}
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "flex items-center gap-2 w-full min-w-0 rounded-xl bg-surface border border-border px-3 h-11 transition-colors text-left",
            "hover:bg-surface-hover focus:outline-none focus-visible:border-gold/60 focus-visible:ring-2 focus-visible:ring-gold/30",
            open && "border-gold/60 ring-2 ring-gold/30",
            error && "border-danger/60",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <span className={cn("flex-1 text-sm truncate", selected ? "text-text-primary" : "text-text-muted")}>
            {selected?.label ?? ""}
          </span>
          <ChevronDownIcon
            size={16}
            className={cn("text-text-muted shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>

        {open && (
          <ul
            role="listbox"
            className={cn(
              "absolute left-0 right-0 z-50 rounded-2xl border border-border bg-surface shadow-xl py-1.5 overflow-y-auto max-h-64 animate-fade-in",
              flipUp ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            {options.map((opt) => {
              const isSelected = String(opt.value) === String(value ?? "");
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => !opt.disabled && pick(opt.value)}
                  className={cn(
                    "px-3 py-2.5 text-sm cursor-pointer transition-colors select-none break-words",
                    isSelected
                      ? "bg-gold/15 text-text-primary font-medium"
                      : opt.disabled
                        ? "text-text-muted/40 cursor-not-allowed"
                        : "text-text-primary hover:bg-surface-hover",
                  )}
                >
                  {opt.label}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

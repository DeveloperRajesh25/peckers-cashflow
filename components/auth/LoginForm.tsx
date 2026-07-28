"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { buildLoginEmail } from "@/lib/credentials";
import { PORTAL_HOME, type Portal } from "@/lib/types";

const PORTAL_LABEL: Record<Portal, string> = {
  admin: "Admin",
  manager: "Manager",
  employee: "Crew",
  cover_driver: "Cover Driver",
};

export function LoginForm({ portal }: { portal: Portal }) {
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);
  const usernameMode = portal !== "admin";

  const [identifier, setIdentifier] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!identifier.trim())
      return setError(usernameMode ? "Username is required" : "Email is required");
    if (!password) return setError("Password is required");

    const email = usernameMode
      ? buildLoginEmail(identifier.trim().toLowerCase())
      : identifier.trim();

    setLoading(true);
    try {
      const { data, error: signErr } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signErr) {
        setError(
          usernameMode
            ? "Incorrect username or password"
            : signErr.message,
        );
        setLoading(false);
        return;
      }
      if (!data.user?.email) {
        setError("Sign in failed");
        setLoading(false);
        return;
      }

      // Confirm the account is whitelisted AND belongs to this portal.
      const { data: allowed, error: chkErr } = await supabase
        .from("allowed_users")
        .select("role")
        .ilike("email", data.user.email)
        .maybeSingle();

      if (chkErr || !allowed) {
        await supabase.auth.signOut();
        router.replace("/access-denied");
        return;
      }

      if (allowed.role !== portal) {
        await supabase.auth.signOut();
        setError(
          `These credentials are for the ${PORTAL_LABEL[allowed.role as Portal] ?? "another"} portal, not the ${PORTAL_LABEL[portal]} portal.`,
        );
        setLoading(false);
        return;
      }

      router.replace(PORTAL_HOME[portal]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {usernameMode ? (
        <Input
          type="text"
          label="Username"
          autoComplete="username"
          placeholder="e.g. pavan.kumar"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          autoFocus
        />
      ) : (
        <Input
          type="email"
          label="Email"
          autoComplete="email"
          placeholder="you@example.com"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          autoFocus
        />
      )}
      <Input
        type="password"
        label="Password"
        autoComplete="current-password"
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      {error && (
        <div className="text-sm text-danger bg-danger/10 border border-danger/30 rounded-xl px-3 py-2.5">
          {error}
        </div>
      )}

      <Button type="submit" loading={loading} className="w-full mt-2 h-12">
        Sign In
      </Button>
    </form>
  );
}

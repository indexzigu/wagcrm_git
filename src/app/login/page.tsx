import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { LandingLogin } from "@/components/auth/landing-login";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; error?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (data.user) {
    redirect("/");
  }

  const { denied, error } = await searchParams;

  return (
    <LandingLogin deniedAccess={denied === "1"} authError={error === "auth"} />
  );
}

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const DEV_AUTH_COOKIE = "wag_crm_dev_auth";

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    await supabase.auth.signOut();
  }

  // 로그아웃 후 로그인 페이지로 리다이렉트
  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 302,
  });
  response.cookies.set(DEV_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
  return response;
}

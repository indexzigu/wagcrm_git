import { NextResponse } from "next/server";

const DEV_AUTH_COOKIE = "wag_crm_dev_auth";

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const response = NextResponse.redirect(new URL("/", request.url), {
    status: 302,
  });
  response.cookies.set(DEV_AUTH_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return response;
}

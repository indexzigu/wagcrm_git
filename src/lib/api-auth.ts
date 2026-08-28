import { NextResponse } from "next/server";
import { getAuthContext, type AuthContext } from "@/lib/auth-context";

/**
 * Require authentication for an API route handler.
 * Returns the AuthContext if authenticated, or a 401 JSON response.
 */
export async function requireAuth(): Promise<
  | { authenticated: true; context: AuthContext }
  | { authenticated: false; response: NextResponse }
> {
  const authContext = await getAuthContext();
  if (!authContext) {
    return {
      authenticated: false,
      response: NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }
  return { authenticated: true, context: authContext };
}

/**
 * Require a specific role for an API route handler.
 */
export async function requireRole(role: "admin" | "operator"): Promise<
  | { authenticated: true; context: AuthContext }
  | { authenticated: false; response: NextResponse }
> {
  const result = await requireAuth();
  if (!result.authenticated) return result;

  if (result.context.role !== role) {
    return {
      authenticated: false,
      response: NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      ),
    };
  }
  return result;
}

import { NextResponse } from "next/server";
import { getCrmUsers, filterUsers } from "@/lib/user-registry";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json([]);
  }

  try {
    const users = await getCrmUsers();
    const filtered = filterUsers(users, query);
    const limited = filtered.slice(0, 10);

    return NextResponse.json(
      limited.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      })),
    );
  } catch (error) {
    console.error("[api/users] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

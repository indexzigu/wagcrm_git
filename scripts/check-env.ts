import "dotenv/config";

type CheckResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function hasValue(name: string) {
  const value = process.env[name];
  return Boolean(value && value.trim().length > 0);
}

function equalEnv(a: string, b: string) {
  return (process.env[a] ?? "").trim() === (process.env[b] ?? "").trim();
}

function addIfMissing(result: CheckResult, name: string, reason: string) {
  if (!hasValue(name)) {
    result.errors.push(`${name}: ${reason}`);
  }
}

function sameLocalhostFamily(a: string, b: string) {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  try {
    const left = new URL(a);
    const right = new URL(b);
    return hosts.has(left.hostname) && hosts.has(right.hostname);
  } catch {
    return false;
  }
}

function main() {
  const result: CheckResult = { ok: true, errors: [], warnings: [] };

  addIfMissing(result, "DATABASE_URL", "required for Prisma and app data access");
  addIfMissing(result, "NEXT_PUBLIC_APP_URL", "required for auth and Google callback redirects");
  // 이 변수가 없으면 예전에는 소스에 박힌 기본 키로 조용히 암호화됐다(공개된 키).
  // 이제는 런타임이 던지므로, 배포 전에 여기서 먼저 잡는다.
  addIfMissing(result, "ENCRYPTION_KEY", "required to encrypt seller resident numbers (no fallback key exists)");

  if (hasValue("ENCRYPTION_KEY_PREVIOUS")) {
    result.warnings.push(
      "ENCRYPTION_KEY_PREVIOUS is set. This is a key-rotation transition state — run scripts/reencrypt-resident-numbers.ts --apply, then remove it.",
    );
  }

  if (!hasValue("NEXT_PUBLIC_SITE_URL")) {
    result.warnings.push("NEXT_PUBLIC_SITE_URL is not set. Login OAuth redirect will fall back to localhost unless the app code is adjusted.");
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  const usesSQLite = databaseUrl.startsWith("file:");

  if (!usesSQLite) {
    addIfMissing(result, "DIRECT_URL", "required for remote Postgres direct access");
    addIfMissing(result, "NEXT_PUBLIC_SUPABASE_URL", "required for browser Supabase client");
    addIfMissing(result, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "required for browser Supabase client");
    addIfMissing(result, "SUPABASE_SERVICE_ROLE_KEY", "required for server storage and admin access");

    if (hasValue("SUPABASE_URL") && hasValue("NEXT_PUBLIC_SUPABASE_URL") && !equalEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")) {
      result.errors.push("SUPABASE_URL: must match NEXT_PUBLIC_SUPABASE_URL when both are set");
    }
  } else {
    result.warnings.push("DATABASE_URL points to SQLite. Remote Supabase checks are skipped.");
  }

  const driveKeysPresent =
    hasValue("GOOGLE_DRIVE_CLIENT_ID") ||
    hasValue("GOOGLE_DRIVE_CLIENT_SECRET") ||
    hasValue("GOOGLE_DRIVE_REDIRECT_URI") ||
    hasValue("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  if (driveKeysPresent) {
    addIfMissing(result, "GOOGLE_DRIVE_CLIENT_ID", "required for Drive OAuth");
    addIfMissing(result, "GOOGLE_DRIVE_CLIENT_SECRET", "required for Drive OAuth");
    addIfMissing(result, "ASSET_TOKEN_ENCRYPTION_KEY", "required to store Drive refresh tokens safely");
    addIfMissing(result, "GOOGLE_DRIVE_REDIRECT_URI", "required for Drive OAuth callback");
  } else {
    result.warnings.push("Google Drive OAuth env is not configured. Drive upload remains unavailable until consent setup is completed.");
  }

  if (!hasValue("SUPABASE_ASSET_BUCKET")) {
    result.warnings.push("SUPABASE_ASSET_BUCKET is empty. The app will fall back to 'crm-assets'.");
  }

  if (
    hasValue("WAG_CRM_BASE_URL") &&
    hasValue("NEXT_PUBLIC_APP_URL") &&
    !equalEnv("WAG_CRM_BASE_URL", "NEXT_PUBLIC_APP_URL") &&
    !sameLocalhostFamily(
      process.env.WAG_CRM_BASE_URL ?? "",
      process.env.NEXT_PUBLIC_APP_URL ?? "",
    )
  ) {
    result.warnings.push(
      "WAG_CRM_BASE_URL and NEXT_PUBLIC_APP_URL use different origins. Local smoke, dev auth, and OAuth redirects are easier to verify when they match.",
    );
  }

  if (result.errors.length > 0) {
    result.ok = false;
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main();

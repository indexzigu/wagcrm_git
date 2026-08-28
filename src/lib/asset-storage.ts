import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getPrisma } from "./prisma";
import type {
  AssetEntityType,
  AssetProvider,
  AssetSection,
  StorageIntegrationStatus,
} from "./crm-types";

export const SUPABASE_FREE_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const SUPABASE_STORAGE_WARNING_BYTES = 800 * 1024 * 1024;
export const SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const GOOGLE_DRIVE_PROVIDER = "GOOGLE_DRIVE";
export const SUPABASE_PROVIDER = "SUPABASE";
export const ASSET_BUCKET = process.env.SUPABASE_ASSET_BUCKET ?? "crm-assets";
export const LOCAL_ASSET_ROOT = join(process.cwd(), ".asset-storage");

export type AssetUploadInput = {
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  bytes: Uint8Array;
  section: AssetSection;
  entityType: AssetEntityType;
  entityId: string;
  entityName: string;
};

export type StoredAssetObject = {
  provider: AssetProvider;
  storagePath?: string;
  externalFileId?: string;
  externalUrl?: string;
  thumbnailUrl?: string;
};

export type AssetStorageProvider = {
  upload(input: AssetUploadInput): Promise<StoredAssetObject>;
  getDownloadUrl(asset: {
    storagePath?: string | null;
    externalUrl?: string | null;
    externalFileId?: string | null;
  }): Promise<string | null>;
  delete(asset: {
    storagePath?: string | null;
    externalFileId?: string | null;
  }): Promise<void>;
  createFolderForEntity(input: {
    entityType: AssetEntityType;
    entityId: string;
    entityName: string;
    section: AssetSection;
  }): Promise<string | null>;
};

export function chooseAssetProvider(input: {
  sizeBytes: number;
  longTermArchive?: boolean;
  currentSupabaseBytes?: number;
  googleDriveConnected?: boolean;
}): AssetProvider {
  if (input.longTermArchive) return "GOOGLE_DRIVE";
  if (input.sizeBytes > SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES) {
    return input.googleDriveConnected ? "GOOGLE_DRIVE" : "SUPABASE";
  }
  if (
    input.currentSupabaseBytes != null &&
    input.currentSupabaseBytes >= SUPABASE_STORAGE_WARNING_BYTES
  ) {
    return input.googleDriveConnected ? "GOOGLE_DRIVE" : "SUPABASE";
  }
  return "SUPABASE";
}

export function normalizeAssetFileName(fileName: string) {
  return fileName.replace(/[^\w.\-가-힣\s()[\]]+/g, "_").replace(/\s+/g, " ").trim();
}

export function normalizeAssetStorageSegment(value: string, fallback: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^A-Za-z0-9._()-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
}

export function buildAssetPath(input: {
  entityType: AssetEntityType;
  entityId: string;
  entityName: string;
  section: AssetSection;
  fileName: string;
}) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const cleanEntity = normalizeAssetStorageSegment(input.entityName, input.entityId).slice(0, 60);
  const cleanFile = normalizeAssetStorageSegment(input.fileName, "asset");
  return `${input.entityType}/${cleanEntity}-${input.entityId}/${input.section}/${date}_${cleanEntity}_${input.section}_${cleanFile}`;
}

function env(name: string) {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

function supabaseBaseUrl() {
  return env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
}

function supabaseServiceKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY") ?? env("SUPABASE_ANON_KEY");
}

export function isSupabaseStorageConfigured() {
  return Boolean(
    supabaseBaseUrl() &&
      supabaseServiceKey(),
  );
}

export function localAssetPath(storagePath: string) {
  const normalized = normalize(storagePath).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(LOCAL_ASSET_ROOT, normalized);
}

export async function readLocalAsset(storagePath: string) {
  return readFile(localAssetPath(storagePath));
}

/**
 * 자산 파일 바이트를 provider별로 서버에서 읽는다. (F4 Phase 2 §3: 발주서 양식 분석)
 * - GOOGLE_DRIVE: files/{id}?alt=media (기존 googleDriveRequest 인증 재사용)
 * - SUPABASE(설정됨): service key로 오브젝트 직접 GET
 * - SUPABASE(미설정=로컬 폴백)·기타 storagePath 보유: 로컬 파일
 * EXTERNAL_LINK처럼 바이트 소스가 없는 자산은 명확한 에러로 실패한다(조용한 폴백 금지).
 */
export async function readAssetBytes(asset: {
  provider: string;
  storagePath?: string | null;
  externalFileId?: string | null;
}): Promise<Buffer> {
  if (asset.provider === GOOGLE_DRIVE_PROVIDER) {
    if (!asset.externalFileId) {
      throw new Error("Google Drive 자산에 externalFileId가 없어 파일을 읽을 수 없습니다.");
    }
    const { response } = await googleDriveRequest(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.externalFileId)}?alt=media`,
    );
    return Buffer.from(await response.arrayBuffer());
  }
  if (!asset.storagePath) {
    throw new Error(`이 자산(provider=${asset.provider})은 저장 경로가 없어 파일 바이트를 읽을 수 없습니다.`);
  }
  if (!isSupabaseStorageConfigured()) {
    return readLocalAsset(asset.storagePath);
  }
  const objectPath = asset.storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await supabaseRequest(
    `/storage/v1/object/${encodeURIComponent(ASSET_BUCKET)}/${objectPath}`,
  );
  return Buffer.from(await response.arrayBuffer());
}

// F4 Phase 2 (설계 D4): 열 매핑 규칙 확정 시 발주서 양식 바이트를 거래처별 고정 경로로
// 스냅샷 복사한다. 생성 경로가 자산 레코드 수명(삭제/교체)·provider 비결정성과 분리되고,
// 스냅샷은 항상 Supabase(또는 로컬 폴백)에 있어 readAssetBytes 없이도 결정적으로 읽힌다.
export const ORDER_TEMPLATE_SNAPSHOT_PREFIX = "order-template-snapshots";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function storeOrderTemplateSnapshot(partnerId: string, bytes: Buffer): Promise<string> {
  // x-upsert: 재확정 시 덮어쓰기 (거래처당 고정 경로)
  return storeRawObject(`${ORDER_TEMPLATE_SNAPSHOT_PREFIX}/${partnerId}.xlsx`, bytes, XLSX_MIME);
}

/**
 * storagePath 규약으로 원시 바이트를 저장한다 — Supabase 설정 시 버킷 업로드(업서트),
 * 미설정(로컬 dev)일 때만 `.asset-storage` 파일 폴백. Vercel 서버리스는 `/var/task`가
 * 읽기 전용이라 prod에서 무조건 로컬에 쓰는 코드는 ENOENT로 죽는다(가격표 업로드 실사고)
 * — 새 저장 경로는 반드시 이 함수(또는 provider)를 경유한다.
 */
export async function storeRawObject(
  storagePath: string,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  if (!isSupabaseStorageConfigured()) {
    const path = localAssetPath(storagePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return storagePath;
  }
  const objectPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const uploadInit = {
    method: "POST",
    body: Buffer.from(bytes),
    headers: { "Content-Type": mimeType, "x-upsert": "true" },
  } satisfies RequestInit;
  try {
    await supabaseRequest(`/storage/v1/object/${encodeURIComponent(ASSET_BUCKET)}/${objectPath}`, uploadInit);
  } catch (error) {
    if (error instanceof Error && /Bucket not found/i.test(error.message)) {
      await ensureSupabaseBucketExists();
      await supabaseRequest(`/storage/v1/object/${encodeURIComponent(ASSET_BUCKET)}/${objectPath}`, uploadInit);
    } else {
      throw error;
    }
  }
  return storagePath;
}

export async function readOrderTemplateSnapshot(storagePath: string): Promise<Buffer> {
  // 스냅샷은 SUPABASE(또는 로컬 폴백) 경로 규약 — readAssetBytes의 storagePath 분기를 재사용
  return readAssetBytes({ provider: SUPABASE_PROVIDER, storagePath });
}

function encryptionKey() {
  // 폴백 리터럴을 두지 않는다 — 소스에 박힌 기본 키는 공개된 키와 같아서, 변수를
  // 빠뜨린 환경이 조용히 "암호화된 것처럼 보이지만 누구나 풀 수 있는" 상태가 된다.
  // 이 변수는 check-env·release-config 가 이미 필수로 요구하고 prod·로컬 모두
  // 설정돼 있으므로, 없는 환경은 설정 누락이지 정상 동작 대상이 아니다.
  const secret = env("ASSET_TOKEN_ENCRYPTION_KEY");
  if (!secret) throw new Error("ASSET_TOKEN_ENCRYPTION_KEY 환경 변수가 누락되었습니다.");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const baseUrl = supabaseBaseUrl();
  const key = supabaseServiceKey();
  if (!baseUrl || !key) throw new Error("Supabase storage env is not configured");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase storage request failed: ${response.status} ${text}`);
  }
  return response;
}

async function ensureSupabaseBucketExists() {
  const baseUrl = supabaseBaseUrl();
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) {
    throw new Error("Supabase service role key is required to create storage buckets");
  }

  const supabase = createClient(baseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.storage.createBucket(ASSET_BUCKET, {
    public: false,
  });

  if (
    error &&
    !/already exists|duplicate|conflict/i.test(error.message)
  ) {
    throw error;
  }
}

export const supabaseStorageProvider: AssetStorageProvider = {
  async upload(input) {
    const storagePath = buildAssetPath(input);
    if (!isSupabaseStorageConfigured()) {
      const path = localAssetPath(storagePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(input.bytes));
      return { provider: "SUPABASE", storagePath };
    }
    const uploadPath = `/storage/v1/object/${encodeURIComponent(ASSET_BUCKET)}/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const uploadInit = {
      method: "POST",
      body: Buffer.from(input.bytes),
      headers: {
        "Content-Type": input.mimeType ?? "application/octet-stream",
        "x-upsert": "false",
      },
    } satisfies RequestInit;

    try {
      await supabaseRequest(uploadPath, uploadInit);
    } catch (error) {
      if (
        error instanceof Error &&
        /Bucket not found/i.test(error.message)
      ) {
        await ensureSupabaseBucketExists();
        await supabaseRequest(uploadPath, uploadInit);
      } else {
        throw error;
      }
    }
    return { provider: "SUPABASE", storagePath };
  },
  async getDownloadUrl(asset) {
    if (!asset.storagePath || !isSupabaseStorageConfigured()) {
      return asset.externalUrl ?? null;
    }
    const response = await supabaseRequest(
      `/storage/v1/object/sign/${encodeURIComponent(ASSET_BUCKET)}/${asset.storagePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "POST",
        body: JSON.stringify({ expiresIn: 60 * 10 }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const data = (await response.json()) as { signedURL?: string; signedUrl?: string };
    let signedPath = data.signedURL ?? data.signedUrl;
    if (!signedPath) return null;
    
    if (signedPath.startsWith("/object/sign/") && !signedPath.includes("/storage/v1/")) {
      signedPath = `/storage/v1${signedPath}`;
    }
    
    const baseUrl = supabaseBaseUrl();
    return signedPath.startsWith("http") ? signedPath : `${baseUrl}${signedPath}`;
  },
  async delete(asset) {
    if (!asset.storagePath) return;
    if (!isSupabaseStorageConfigured()) {
      await rm(localAssetPath(asset.storagePath), { force: true });
      return;
    }
    await supabaseRequest(`/storage/v1/object/${encodeURIComponent(ASSET_BUCKET)}`, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: [asset.storagePath] }),
      headers: { "Content-Type": "application/json" },
    });
  },
  async createFolderForEntity() {
    return null;
  },
};

function googleConfig() {
  return {
    clientId: env("GOOGLE_DRIVE_CLIENT_ID"),
    clientSecret: env("GOOGLE_DRIVE_CLIENT_SECRET"),
    redirectUri:
      env("GOOGLE_DRIVE_REDIRECT_URI") ??
      `${env("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000"}/api/integrations/google-drive/callback`,
  };
}

export function buildGoogleDriveAuthUrl() {
  const config = googleConfig();
  if (!config.clientId) throw new Error("GOOGLE_DRIVE_CLIENT_ID is not configured");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeGoogleDriveCode(code: string) {
  const config = googleConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google Drive OAuth env is not configured");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`);
  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

async function refreshGoogleAccessToken() {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_DRIVE_PROVIDER },
  });
  if (!integration?.encryptedRefreshToken) {
    throw new Error("Google Drive is not connected");
  }
  const config = googleConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google Drive OAuth env is not configured");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: decryptSecret(integration.encryptedRefreshToken),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(`Google token refresh failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string; expires_in?: number };
  return {
    accessToken: data.access_token,
    rootFolderId: integration.rootFolderId,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}

async function googleDriveRequest(path: string, init: RequestInit = {}) {
  const token = await refreshGoogleAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Drive request failed: ${response.status} ${text}`);
  }
  return { response, rootFolderId: token.rootFolderId };
}

/**
 * 같은 이름의 폴더가 이미 있으면 기존 ID를 반환하고, 없으면 새로 생성하여 ID를 반환합니다.
 * Google Drive는 동일 부모 하위에 같은 이름의 폴더가 중복 생성될 수 있으므로 항상 이 함수를 사용합니다.
 */
async function findOrCreateDriveFolder(name: string, parentId?: string | null): Promise<string> {
  // 1. 기존 폴더 조회
  if (parentId) {
    const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}'  and '${parentId}' in parents and trashed = false`;
    const { response: listResp } = await googleDriveRequest(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    );
    const listData = (await listResp.json()) as { files?: { id: string }[] };
    if (listData.files && listData.files.length > 0 && listData.files[0]) {
      return listData.files[0].id;
    }
  }
  // 2. 존재하지 않으면 생성
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];
  const { response } = await googleDriveRequest("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    body: JSON.stringify(metadata),
    headers: { "Content-Type": "application/json" },
  });
  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * 특정 부모 폴더 하위에 바로가기(Shortcut) 파일을 생성합니다.
 * 실제 파일 복사 없이 원본 파일을 링크합니다.
 */
export async function createDriveShortcut({
  targetFileId,
  name,
  parentFolderId,
}: {
  targetFileId: string;
  name: string;
  parentFolderId: string;
}): Promise<string> {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.shortcut",
    parents: [parentFolderId],
    shortcutDetails: { targetId: targetFileId },
  };
  const { response } = await googleDriveRequest("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    body: JSON.stringify(metadata),
    headers: { "Content-Type": "application/json" },
  });
  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * 원본 파일 ID를 타겟으로 하는 모든 바로가기 파일을 드라이브에서 조회 후 일괄 삭제합니다.
 * 원본 파일 영구 삭제 시 깨진 바로가기가 남지 않도록 연쇄 정리합니다.
 */
export async function deleteDriveShortcutByTarget(targetFileId: string): Promise<void> {
  const q = `mimeType = 'application/vnd.google-apps.shortcut' and shortcutDetails.targetId = '${targetFileId}' and trashed = false`;
  let pageToken: string | undefined;
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id)&pageSize=100${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
    }`;
    const { response } = await googleDriveRequest(url);
    const data = (await response.json()) as { nextPageToken?: string; files?: { id: string }[] };
    const shortcuts = data.files ?? [];
    await Promise.all(
      shortcuts.map((sc) =>
        googleDriveRequest(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sc.id)}`,
          { method: "DELETE" },
        ).catch(() => undefined), // 이미 삭제된 경우 무시
      ),
    );
    pageToken = data.nextPageToken;
  } while (pageToken);
}

/**
 * 바로가기 파일을 새로운 부모 폴더로 이동합니다 (addParents / removeParents API 활용).
 */
export async function moveDriveShortcut({
  shortcutFileId,
  newParentFolderId,
  oldParentFolderId,
}: {
  shortcutFileId: string;
  newParentFolderId: string;
  oldParentFolderId?: string;
}): Promise<void> {
  const params = new URLSearchParams({
    addParents: newParentFolderId,
    fields: "id,parents",
  });
  if (oldParentFolderId) params.set("removeParents", oldParentFolderId);
  await googleDriveRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(shortcutFileId)}?${params.toString()}`,
    { method: "PATCH", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } },
  );
}

export async function ensureGoogleDriveRootFolder(accessToken: string) {
  const configured = env("GOOGLE_DRIVE_ROOT_FOLDER_ID");
  if (configured) return configured;
  const response = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "WAG CRM Assets",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!response.ok) throw new Error(`Google root folder creation failed: ${response.status}`);
  const data = (await response.json()) as { id: string };
  return data.id;
}

export const googleDriveProvider: AssetStorageProvider = {
  async upload(input) {
    const folderId = await googleDriveProvider.createFolderForEntity(input);
    const cleanName = buildAssetPath(input).split("/").at(-1) ?? input.fileName;
    const metadata = {
      name: cleanName,
      parents: folderId ? [folderId] : undefined,
    };
    const { response } = await googleDriveRequest(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink,thumbnailLink",
      {
        method: "POST",
        body: JSON.stringify(metadata),
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": input.mimeType ?? "application/octet-stream",
          "X-Upload-Content-Length": String(input.sizeBytes),
        },
      },
    );
    const uploadUrl = response.headers.get("location");
    if (!uploadUrl) throw new Error("Google Drive resumable upload URL is missing");
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: Buffer.from(input.bytes),
      headers: {
        "Content-Type": input.mimeType ?? "application/octet-stream",
        "Content-Length": String(input.sizeBytes),
      },
    });
    if (!uploadResponse.ok) {
      throw new Error(`Google Drive upload failed: ${uploadResponse.status}`);
    }
    const data = (await uploadResponse.json()) as {
      id: string;
      webViewLink?: string;
      thumbnailLink?: string;
    };
    return {
      provider: "GOOGLE_DRIVE",
      externalFileId: data.id,
      externalUrl: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view`,
      thumbnailUrl: data.thumbnailLink,
    };
  },
  async getDownloadUrl(asset) {
    return asset.externalUrl ?? null;
  },
  async delete(asset) {
    if (!asset.externalFileId) return;
    try {
      console.log(`[googleDriveProvider] Initiating permanent cascade delete for file: ${asset.externalFileId}`);
      // 1. 원본 파일을 바라보던 모든 바로가기 파일 연쇄 삭제 (깨진 링크 방지)
      await deleteDriveShortcutByTarget(asset.externalFileId).catch((err) => {
        console.warn(`[googleDriveProvider] Failed to delete some shortcuts for target ${asset.externalFileId}:`, err);
      });
      // 2. 원본 파일 삭제
      await googleDriveRequest(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.externalFileId)}`,
        { method: "DELETE" },
      ).catch((err) => {
        console.warn(`[googleDriveProvider] Target file deletion skipped or failed (may already be deleted):`, err);
      });
      console.log(`[googleDriveProvider] Successfully cleaned up asset from Google Drive`);
    } catch (e) {
      console.error(`[googleDriveProvider] Error during asset deletion process:`, e);
    }
  },
  async createFolderForEntity(input) {
    const prisma = getPrisma();
    const integration = await prisma.storageIntegration.findUnique({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
    });
    if (!integration?.rootFolderId) throw new Error("Google Drive root folder is missing");
    const rootId = integration.rootFolderId;

    // 계층 구조: WAG CRM Assets / [entityType] / [entityName-entityId] / [section]
    // entityType별 폴더 (PARTNER, DEAL, SELLER, CAMPAIGN, OUTREACH)
    const typeFolderId = await findOrCreateDriveFolder(input.entityType, rootId);

    // 개별 항목 폴더 (중복 생성 방지)
    const entityFolderName = `${normalizeAssetFileName(input.entityName)}-${input.entityId}`;
    const itemFolderId = await findOrCreateDriveFolder(entityFolderName, typeFolderId);

    // 섹션 폴더 (PRODUCT_INTRO, CONTRACT 등)
    return findOrCreateDriveFolder(input.section, itemFolderId);
  },
};

export const externalLinkProvider: AssetStorageProvider = {
  async upload() {
    throw new Error("External link assets do not upload file bytes");
  },
  async getDownloadUrl(asset) {
    return asset.externalUrl ?? null;
  },
  async delete() {},
  async createFolderForEntity() {
    return null;
  },
};

export function getStorageProvider(provider: AssetProvider): AssetStorageProvider {
  if (provider === "GOOGLE_DRIVE") return googleDriveProvider;
  if (provider === "EXTERNAL_LINK") return externalLinkProvider;
  return supabaseStorageProvider;
}

// multipart/simple-media 업로드는 Google이 5MB로 못박은 소용량 경로다(그 이상은 resumable 필요).
// 코퍼스가 커지면 조용히 잘리지 않고 명확히 실패하게 상한을 둔다(초과 시 resumable 도입이 후속 과제).
const DRIVE_SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export async function putDriveJsonFile(input: {
  fileName: string;
  data: unknown;
  existingFileId?: string | null;
}): Promise<{ fileId: string }> {
  const body = Buffer.from(JSON.stringify(input.data), "utf-8");
  if (body.length > DRIVE_SIMPLE_UPLOAD_MAX_BYTES) {
    throw new Error(
      `Drive JSON 업로드 상한(5MB) 초과: ${body.length} bytes. 코퍼스 분할 또는 resumable 업로드 도입이 필요합니다.`,
    );
  }

  if (input.existingFileId) {
    const { response } = await googleDriveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(input.existingFileId)}?uploadType=media&fields=id`,
      { method: "PATCH", body, headers: { "Content-Type": "application/json; charset=UTF-8" } },
    );
    const data = (await response.json()) as { id: string };
    return { fileId: data.id };
  }

  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_DRIVE_PROVIDER },
  });
  if (!integration?.rootFolderId) throw new Error("Google Drive root folder is missing");
  const vocFolderId = await findOrCreateDriveFolder("voc", integration.rootFolderId);

  // boundary는 본문에 등장하면 안 된다. 본문 해시 기반이라 어떤 JSON 포맷(들여쓰기·replacer)에도
  // 충돌 확률이 사실상 0이다(Date/Random 미사용 — 결정론 유지).
  const boundary = `voc_${createHash("sha256").update(body).digest("hex").slice(0, 24)}`;
  const metadata = JSON.stringify({ name: input.fileName, parents: [vocFolderId] });
  const multipart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      "utf-8",
    ),
    body,
    Buffer.from(`\r\n--${boundary}--`, "utf-8"),
  ]);
  const { response } = await googleDriveRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", body: multipart, headers: { "Content-Type": `multipart/related; boundary=${boundary}` } },
  );
  const data = (await response.json()) as { id: string };
  return { fileId: data.id };
}

/** Google Drive 파일(JSON) 본문을 읽어 파싱한다. putDriveJsonFile의 짝. */
export async function getDriveJsonFile<T = unknown>(fileId: string): Promise<T> {
  const { response } = await googleDriveRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
  );
  return (await response.json()) as T;
}

export async function getGoogleDriveConnectionStatus() {
  const prisma = getPrisma();
  const integration = await prisma.storageIntegration.findUnique({
    where: { provider: GOOGLE_DRIVE_PROVIDER },
  });
  const hasConnectionMaterial = Boolean(
    integration?.rootFolderId || integration?.encryptedRefreshToken || integration?.accountEmail,
  );
  const treatAsDisconnected =
    integration?.lastError === "Missing OAuth code" && !hasConnectionMaterial;

  return {
    connected: integration?.status === "CONNECTED" && hasConnectionMaterial,
    status: (
      treatAsDisconnected ? "DISCONNECTED" : (integration?.status ?? "DISCONNECTED")
    ) as StorageIntegrationStatus,
    accountEmail: integration?.accountEmail ?? null,
    rootFolderId: integration?.rootFolderId ?? null,
    lastError: treatAsDisconnected ? null : (integration?.lastError ?? null),
  };
}

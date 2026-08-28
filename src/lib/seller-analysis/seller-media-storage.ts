// 셀러 미디어(피드 썸네일·프로필 사진)의 공용 Supabase Storage 어댑터.
//
// 인스타 CDN 서명 URL은 만료되므로(당일에도 일부 403), URL 참조 방식은 이미지를 수일 내
// 전멸시킨다. 그래서 이미지를 자체 공개 버킷으로 옮기고 만료되지 않는 우리 URL만 저장한다.
// 이 저수준 원시함수(버킷 생성·업로드·공개 URL)를 mediaRehost(피드 썸네일)와
// seller-profile-image(프로필 사진)가 공유해, 셀러 이미지의 스토리지 백엔드를 하나로 통일한다.

const BUCKET = process.env.SELLER_MEDIA_BUCKET ?? "seller-media";

/** 공용 버킷 이름 (기본 seller-media). */
export function sellerMediaBucket(): string {
  return BUCKET;
}

function baseUrl(): string | null {
  const v = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  return v && v.length > 0 ? v.replace(/\/$/, "") : null;
}

function serviceKey(): string | null {
  // 버킷 생성·업로드는 service role 필수 (anon으로는 스토리지 쓰기 불가)
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return v && v.length > 0 ? v : null;
}

/** Supabase Storage 쓰기가 가능한 환경인지 (URL + service role key). */
export function isSellerMediaStorageConfigured(): boolean {
  return Boolean(baseUrl() && serviceKey());
}

/** 버킷 내 경로 → 공개 접근 URL. */
export function publicMediaUrl(path: string): string {
  return `${baseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** 이미 이 공용 버킷으로 재호스팅된 URL인지 판별. */
export function isRehostedUrl(url: unknown): boolean {
  return typeof url === "string" && url.includes(`/storage/v1/object/public/${BUCKET}/`);
}

export function extFromContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "jpg";
}

async function sbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = serviceKey();
  const base = baseUrl();
  if (!key || !base) throw new Error("Supabase storage env is not configured");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
  return res;
}

export async function ensureBucket(): Promise<void> {
  const res = await sbFetch(`/storage/v1/bucket`, {
    method: "POST",
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    if (!/already exists|duplicate|conflict/i.test(text)) {
      throw new Error(`seller-media 버킷 생성 실패: ${res.status} ${text}`);
    }
  }
}

/** 바이트를 공용 버킷의 path에 업로드(upsert). 버킷 부재 시 생성 후 1회 재시도. */
export async function uploadBytes(path: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  const doUpload = () =>
    sbFetch(`/storage/v1/object/${encodeURIComponent(BUCKET)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      body: Buffer.from(bytes),
      headers: { "Content-Type": contentType, "x-upsert": "true" },
    });
  let res = await doUpload();
  if (!res.ok) {
    const text = await res.text();
    if (/Bucket not found/i.test(text)) {
      await ensureBucket();
      res = await doUpload();
      if (!res.ok) throw new Error(`업로드 재시도 실패: ${res.status} ${await res.text()}`);
    } else {
      throw new Error(`업로드 실패: ${res.status} ${text}`);
    }
  }
}

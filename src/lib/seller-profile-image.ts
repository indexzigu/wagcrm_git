import {
  extFromContentType,
  isRehostedUrl,
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";

/**
 * 셀러 프로필 사진 영구 미러링.
 *
 * 인스타그램 등 외부 CDN이 내려주는 프로필 이미지 URL은 서명부(signed) 쿼리에
 * 만료시각이 박혀 있어 며칠 내로 죽는다. DB에 그 URL 문자열만 저장하면 시간이
 * 지나면서 전부 깨진다. 그래서 수집 시점에 이미지 바이트를 내려받아, 피드 썸네일
 * 재호스팅(mediaRehost)과 동일한 Supabase 공용 버킷(seller-media)에 올리고,
 * 만료되지 않는 우리 자체 URL만 저장한다. 스토리지 백엔드를 하나로 통일한다.
 *
 * 경로는 셀러당 고정(`sellers/{id}/profile.webp`)이라 매 수집마다 같은 자리에 덮어써
 * (x-upsert) 파일이 무한 증식하지 않고, 저장 URL도 셀러별로 안정적으로 유지된다.
 *
 * 업로드 전 sharp로 256px WebP로 리사이즈·재인코딩해 용량을 줄이고 EXIF를 제거한다.
 */

// 인스타 HD 프로필이 320px이므로 그 이상으로 확대하지 않는다(withoutEnlargement).
// 프로필 썸네일 용도로는 256px WebP면 충분하다.
const MAX_DIMENSION = 256;
const WEBP_QUALITY = 80;

// 인스타 CDN 핫링크 회피용 브라우저 UA. 서버 fetch는 referrer가 없어 대체로 통과한다.
// 미러링(실제 다운로드)과 생존 확인(probe)이 **같은 헤더**를 써야 "예행은 되는데 실행은
// 막히는" 괴리가 생기지 않는다 — 그래서 상수로 공유한다.
const SOURCE_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** 이미 우리 공용 버킷에 미러링된 URL인지 판별한다. */
export function isMirroredProfileImage(url: string | null | undefined): boolean {
  return isRehostedUrl(url);
}

type PreparedImage = { data: Buffer; contentType: string; ext: string };

/**
 * 프로필 이미지를 256px WebP로 리사이즈·재인코딩해 용량을 줄이고 EXIF를 제거한다.
 * sharp는 Node 전용이라 동적 import(edge 번들 오염 방지). 실패 시 원본 바이트로 폴백한다.
 */
async function prepareProfileImage(
  input: Buffer,
  sourceContentType: string,
  sellerId: string,
): Promise<PreparedImage> {
  try {
    const { default: sharp } = await import("sharp");
    const data = await sharp(input)
      .rotate() // EXIF 방향 보정
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "cover", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return { data, contentType: "image/webp", ext: "webp" };
  } catch (err) {
    console.warn(
      `[sellerProfileImage] 이미지 최적화 실패 — 원본 바이트로 폴백 (seller=${sellerId}):`,
      err,
    );
    return { data: input, contentType: sourceContentType, ext: extFromContentType(sourceContentType) };
  }
}

/**
 * 외부 프로필 이미지 URL을 Supabase 공용 버킷에 미러링하고 안정적인 자체 URL을 반환한다.
 *
 * 반환 규약(호출부의 upsert 보존 로직을 깨지 않기 위해 입력 시그널을 그대로 통과):
 *  - `undefined` → `undefined` ("이 필드는 건드리지 마라")
 *  - `null`/빈 문자열 → 그대로 반환 (명시적 초기화)
 *  - 이미 미러링된 URL → 그대로 반환 (재업로드 안 함, 멱등)
 *  - 미러링 실패(스토리지 미설정·다운로드 실패·업로드 실패) → 원본 URL 반환(디그레이드).
 *    실패를 삼키지 않고 로그로 남기되, 이미지 하나 때문에 팔로워 스냅샷 전체가
 *    실패하지는 않도록 원본이라도 유지한다.
 */
export async function mirrorSellerProfileImage(
  sellerId: string,
  sourceUrl: string | null | undefined,
): Promise<string | null | undefined> {
  if (sourceUrl === undefined) return undefined;
  if (!sourceUrl) return sourceUrl;
  if (isMirroredProfileImage(sourceUrl)) return sourceUrl;

  if (!isSellerMediaStorageConfigured()) {
    console.warn(
      `[sellerProfileImage] Supabase 스토리지 미설정(SUPABASE_URL/SERVICE_ROLE_KEY) — 미러링 생략, 원본 URL 유지 (seller=${sellerId})`,
    );
    return sourceUrl;
  }

  try {
    const res = await fetch(sourceUrl, { headers: SOURCE_FETCH_HEADERS });
    if (!res.ok) {
      console.error(
        `[sellerProfileImage] 원본 이미지 다운로드 실패 status=${res.status} (seller=${sellerId}) — 원본 URL 유지`,
      );
      return sourceUrl;
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      console.error(
        `[sellerProfileImage] 이미지가 아닌 응답 content-type=${contentType} (seller=${sellerId}) — 원본 URL 유지`,
      );
      return sourceUrl;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const prepared = await prepareProfileImage(buffer, contentType, sellerId);
    const path = `sellers/${sellerId}/profile.${prepared.ext}`;
    // uploadBytes는 ArrayBuffer를 받는다 — Buffer의 정확한 뷰를 잘라 넘긴다.
    const bytes = prepared.data.buffer.slice(
      prepared.data.byteOffset,
      prepared.data.byteOffset + prepared.data.byteLength,
    ) as ArrayBuffer;
    await uploadBytes(path, bytes, prepared.contentType);
    return publicMediaUrl(path);
  } catch (err) {
    console.error(
      `[sellerProfileImage] 미러링 실패 (seller=${sellerId}) — 원본 URL 유지:`,
      err,
    );
    return sourceUrl;
  }
}

/** `probeSellerProfileImage`의 판정 결과. */
export type ProfileImageProbe =
  | { mirrorable: true; contentType: string }
  | { mirrorable: false; reason: string };

/**
 * 원본 이미지가 아직 살아 있는지 **아무것도 쓰지 않고** 확인한다(예행 전용).
 *
 * 백필 스크립트의 dry-run이 `mirrorSellerProfileImage()`를 부르면, DB만 안 쓸 뿐
 * 다운로드·리사이즈·스토리지 업로드는 전부 실행돼 프로덕션 버킷에 파일이 남고
 * DB는 옛 URL을 가리키는 불일치가 만들어진다. 예행은 "몇 건이 미러링 가능한가"만
 * 알면 되므로, 그 판정에 필요한 신호(응답 상태 + content-type)만 읽는다.
 *
 * 요청 헤더는 미러링 경로와 공유(`SOURCE_FETCH_HEADERS`)하고, `Range: bytes=0-0`로
 * 본문을 1바이트만 받는다 — 실제 다운로드가 통과할지를 같은 조건에서 재는 대신
 * 이미지 전체를 내려받지는 않는다. Range를 무시하고 전체를 보내는 CDN을 대비해
 * 남은 본문은 즉시 취소한다.
 */
export async function probeSellerProfileImage(sourceUrl: string): Promise<ProfileImageProbe> {
  try {
    const res = await fetch(sourceUrl, {
      headers: { ...SOURCE_FETCH_HEADERS, Range: "bytes=0-0" },
    });
    // 헤더를 다 읽은 뒤 남은 본문을 버린다(소켓이 열린 채 남지 않도록).
    await res.body?.cancel().catch(() => {});

    if (!res.ok) return { mirrorable: false, reason: `다운로드 실패 status=${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return {
        mirrorable: false,
        reason: `이미지가 아닌 응답 content-type=${contentType || "(없음)"}`,
      };
    }
    return { mirrorable: true, contentType };
  } catch (err) {
    return { mirrorable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

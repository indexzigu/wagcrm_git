#!/usr/bin/env node
/**
 * 브랜드 아이콘 세트 생성기 — 아트 파라미터의 SSOT.
 *
 * 실행: `node scripts/generate-brand-icons.mjs`
 *
 * ⚠️ sharp 를 package.json 에 선언하지 않은 것은 누락이 아니라 의도다 — 추가하지 말 것.
 *    sharp 는 lockfile 에 next 의 전이 의존성으로만, 그것도 "optional": true 로 들어있다
 *    (선언 없음은 `git show origin/main:package.json | grep sharp` 로 확인 가능).
 *    package.json 에 선언하면서 lockfile 을 갱신하지 않으면 `npm ci` 가 즉시 깨지고
 *    ("lock file does not satisfy package.json"), 갱신하려고 `npm install` 을 돌리는 것도
 *    막혀 있다 — 이 레포의 워크트리들이 node_modules 를 공유해서, 한 브랜치의 lockfile 로
 *    reconcile 하면 타 브랜치 의존성이 prune 된다.
 *    이 스크립트는 배포 경로가 아니라 개발자가 아트를 다시 만들 때만 손으로 돌리는 도구라,
 *    설치된 sharp 에 얹혀가는 편이 CI 를 깨는 것보다 낫다. 코드리뷰에서 반복해서
 *    "의존성 미선언" 으로 지적되는 자리이므로 근거를 여기 남긴다.
 *    sharp 가 없다는 에러가 나면: 선언하지 말고, 메인 레포 node_modules 가 성한지 볼 것.
 *
 * 왜 스크립트인가: #179 는 PNG 6종을 손으로 만들고 스크립트를 안 남겼다. 그래서 오너가
 * "홈스크린이 뿌옇다"고 지적했을 때 전 세트를 다시 손으로 만들어야 했다. 아트를 한 번이라도
 * 더 만질 거라면(만지게 된다) 파라미터 한 줄 고치고 재생성하는 게 맞다.
 *
 * 생성물(전부 이 파일에서 파생 — 개별 편집 금지, 여기 고치고 재생성할 것):
 *   src/app/icon.svg                 브라우저 탭(벡터)
 *   src/app/favicon.ico              16/32/48 (PNG 임베드 ICO)
 *   src/app/apple-icon.png           180 — iOS 홈스크린(마스크 없음, 여백을 아트가 가짐)
 *   public/icon-192.png              192 — PWA any
 *   public/icon-512.png              512 — PWA any
 *   public/icon-maskable-512.png     512 — PWA maskable(Android 가 바깥 20% 를 잘라냄)
 *
 * ⚠️ maskable 은 any 의 복사본이 아니다. Android 가 바깥 20% 를 크롭하므로 같은 배율을 쓰면
 *    잘린 창 안에서 심볼이 더 크게 보인다. SAFE_ZONE_RATIO 로 배율을 낮춰 광학 크기를 맞춘다.
 *    "같은 그림 두 개"로 보고 통합하면 조용히 깨진다.
 *
 * ⚠️ 꼬리 밑변 비율: 아래 path 의 꼬리 밑변(244~316 = 72)이 본체 폭(140~372 = 232)의 31.0% 다.
 *    31% 미만이면 말풍선이 아니라 지도핀으로 읽힌다 — path 를 만지면 이 비율부터 확인할 것.
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 아트 파라미터 (여기만 고친다) ────────────────────────────────────────────
/**
 * 오너 확정 2026-07-15 "C · 네이비 반전".
 *
 * 이전(#179)은 오프화이트 배경 + ink 심볼이었다. 실기기에서 "뿌옇게 보인다"는 지적이 나왔고
 * 실측으로 원인이 확인됐다: 타일의 83% 가 거의 흰 빈 면이라 **밝은 배경화면 위에서 타일 경계가
 * 사라진다**(파일 자체는 선명했다 — 엣지 전이폭 2.00px, 알파 완전 불투명). 심볼만 키우는 안(B)은
 * 잉크 부족만 고치고 창백한 배경은 그대로라 근본 해결이 아니었다. 배경을 브랜드 네이비로
 * 반전해 타일이 배경과 분리되게 한다.
 *
 * 부수 효과(의도): 다크 탭에서 흰 블록이 번쩍이던 기존 트레이드오프(오너가 고지받고 채택했던 것)가
 * 같이 해소된다 — 이제 다크 탭에선 네이비 블록이 가라앉고 밝은 심볼이 형태를 만든다.
 */
const BG = "#0A3D62"; // --primary (브랜드 네이비)
const INK = "#F2F1ED"; // 오프화이트 — 레퍼런스 로고의 그 색을 심볼로 이전
const SCALE = 1.35; // any 계열 심볼 배율 (#179 는 1.25 — 잉크 17% 로 존재감 부족)
/** maskable 배율 보정 = 크롭 후 광학 크기를 any 와 맞추는 계수 (안전영역 지름 410/512). */
const SAFE_ZONE_RATIO = 410 / 512;

/** 말풍선 + 눈 2 + 꼬리. viewBox 512, translate(-256 -265) 는 광학 중심 보정(기하 중심 아님). */
const symbol = (scale, ink) => `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -265)">
    <path d="M 196 152 H 316 A 56 56 0 0 1 372 208 V 256 A 56 56 0 0 1 316 312 L 298 384 L 244 312 H 196 A 56 56 0 0 1 140 256 V 208 A 56 56 0 0 1 196 152 Z" fill="none" stroke="${ink}" stroke-width="32" stroke-linejoin="miter" stroke-miterlimit="4"/>
    <circle cx="214" cy="224" r="22" fill="${ink}"/>
    <circle cx="298" cy="224" r="22" fill="${ink}"/>
  </g>`;

const svgFor = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${BG}"/>${symbol(scale, INK)}
</svg>
`;

// ── ICO 컨테이너 (PNG 임베드) ────────────────────────────────────────────────
/**
 * sharp 는 .ico 를 못 쓴다. ICO 포맷은 헤더 6B + 엔트리 16B×n + 페이로드라 직접 조립한다.
 * Vista+ 는 엔트리 페이로드로 PNG 를 그대로 허용한다(BMP 로 풀 필요 없음).
 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + 16 * pngs.length;
  const entries = [];
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

// ── 생성 ─────────────────────────────────────────────────────────────────────
const raster = (scale, size) =>
  sharp(Buffer.from(svgFor(scale))).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const out = [];
async function emit(relPath, buf) {
  writeFileSync(join(ROOT, relPath), buf);
  const m = await sharp(buf).metadata().catch(() => null);
  out.push(`  ${relPath.padEnd(32)} ${String(buf.length).padStart(6)}B` + (m ? `  ${m.width}x${m.height}` : ""));
}

const anySvg = svgFor(SCALE);
writeFileSync(join(ROOT, "src/app/icon.svg"), anySvg);
out.push(`  src/app/icon.svg${" ".repeat(17)}${String(Buffer.byteLength(anySvg)).padStart(6)}B  vector`);

await emit("src/app/apple-icon.png", await raster(SCALE, 180));
await emit("public/icon-192.png", await raster(SCALE, 192));
await emit("public/icon-512.png", await raster(SCALE, 512));
await emit("public/icon-maskable-512.png", await raster(SCALE * SAFE_ZONE_RATIO, 512));

const icoSizes = [16, 32, 48];
const icoPngs = [];
for (const size of icoSizes) icoPngs.push({ size, buf: await raster(SCALE, size) });
await emit("src/app/favicon.ico", buildIco(icoPngs));

console.log(`브랜드 아이콘 생성 완료 — bg=${BG} ink=${INK} scale=${SCALE} (maskable ${(SCALE * SAFE_ZONE_RATIO).toFixed(3)})`);
console.log(out.join("\n"));

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
 * 마크 도형 = 말풍선 + 막대 3개. 현행 마크는 2026-07-22 로고 교체로 정해졌다
 * (`docs/agents/design-system.md` §7). 도형 path 는 `src/components/brand/brand-mark.tsx` 와
 * 글자 단위로 같아야 한다 — `brand-mark-contract.test.ts` 는 brand-mark.tsx 와 생성물
 * src/app/icon.svg 만 비교한다(이 스크립트의 path 는 보지 않는다). 그래서 여기 도형을 바꾸면
 * 스크립트를 돌려 icon.svg 를 재생성해야 계약이 드리프트를 잡는다.
 */
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 아트 파라미터 (여기만 고친다) ────────────────────────────────────────────
/**
 * 청록 앵커 타일 + 흰 마크·굵은 선 (Apple UI 갱신 번들 0, 오너 선택 2026-10-17 — 연청록 마크는 대비 4.90 이라 작은 크기에서 흐렸다).
 *
 * 타일 색은 `globals.css` `--primary`(청록 앵커)와 같고, manifest `background_color` 와도
 * 같아야 한다(두 곳이 어긋나면 PWA 스플래시 솔기가 생긴다). 마크 색은 `--brand-mark` 토큰과
 * 같은 값이다. 값을 바꾸면 세 곳(이 파일 · manifest.ts · globals.css)을 함께 맞출 것.
 */
const BG = "#0F5F67"; // --primary (청록 앵커)
const INK = "#FFFFFF"; // --brand-mark (흰 마크 — 타일 위 7.36:1)
/** 말풍선 선 굵기(viewBox 100 기준). brand-mark.tsx 의 strokeWidth 와 같아야 한다 — 16px 탭 아이콘 가독성 때문에 6.5 → 8. */
const STROKE = 8;
const SCALE = 1; // any 계열 심볼 배율 (1 = 현행 마크 크기 그대로)
/** maskable 배율 보정 = 크롭 후 광학 크기를 any 와 맞추는 계수 (안전영역 지름 410/512). */
const SAFE_ZONE_RATIO = 410 / 512;
const CORNER_RX = 22; // any 타일 모서리 (viewBox 100 기준). maskable 은 전면 채움이라 0.

/** 말풍선 + 막대 3개. brand-mark.tsx 와 같은 path 문자열이어야 한다(계약 테스트). */
const BUBBLE =
  "M28 20 H72 A12 12 0 0 1 84 32 V52 A12 12 0 0 1 72 64 H42 L26 78 V64 A12 12 0 0 1 16 52 V32 A12 12 0 0 1 28 20 Z";

const symbol = (scale, ink) => `
  <g transform="translate(50 50) scale(${scale}) translate(-50 -50)">
    <g transform="translate(5 6) scale(0.9)">
      <path d="${BUBBLE}" fill="none" stroke="${ink}" stroke-width="${STROKE}" stroke-linejoin="round"/>
      <g fill="${ink}">
        <rect x="35" y="44" width="7" height="10" rx="2"/>
        <rect x="46" y="37" width="7" height="17" rx="2"/>
        <rect x="57" y="30" width="7" height="24" rx="2"/>
      </g>
    </g>
  </g>`;

const svgFor = (scale, rx = CORNER_RX) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${rx}" fill="${BG}"/>${symbol(scale, INK)}
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
const raster = (scale, size, rx) =>
  sharp(Buffer.from(svgFor(scale, rx))).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

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
await emit("public/icon-maskable-512.png", await raster(SCALE * SAFE_ZONE_RATIO, 512, 0));

const icoSizes = [16, 32, 48];
const icoPngs = [];
for (const size of icoSizes) icoPngs.push({ size, buf: await raster(SCALE, size) });
await emit("src/app/favicon.ico", buildIco(icoPngs));

console.log(`브랜드 아이콘 생성 완료 — bg=${BG} ink=${INK} scale=${SCALE} (maskable ${(SCALE * SAFE_ZONE_RATIO).toFixed(3)})`);
console.log(out.join("\n"));

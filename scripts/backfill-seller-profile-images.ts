// 셀러 프로필 이미지 Vercel Blob 백필 스크립트.
//
// 배경: 과거 수집분은 인스타 CDN의 만료성 URL을 그대로 DB에 저장해 두어, 시간이
// 지나면 프로필 이미지 링크가 전부 깨진다. 이 스크립트는 아직 Blob으로 미러링되지
// 않은 셀러의 프로필 이미지를 내려받아 Vercel Blob에 올리고, 만료되지 않는 자체
// URL로 profilePicUrl을 교체한다.
//
// 한계: 원본 URL이 이미 만료된 셀러는 다운로드 자체가 실패한다(복구 불가). 이런
// 셀러는 다음 정상 수집(크론/채널정보 조회) 시점에 새 URL로 자동 미러링된다.
//
// 안전 규칙:
// - 기본 dry-run은 **읽기 전용**이다. 원본 URL의 생존 여부만 확인(probe)하고, 다운로드·
//   스토리지 업로드·DB write는 전부 `--apply`에서만 일어난다. 예행이 미러링 함수를
//   그대로 부르면 DB만 안 쓸 뿐 프로덕션 버킷에는 파일이 남아, "스토리지엔 있는데 DB는
//   옛 URL" 불일치가 만들어진다.
// - 이미 공용 버킷 URL인 셀러는 건너뛴다(재업로드 없음).
// - SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 및 DATABASE_URL 환경변수를 그대로 사용한다.
//
// 실행:
//   source .env && npx tsx scripts/backfill-seller-profile-images.ts          (dry-run)
//   source .env && npx tsx scripts/backfill-seller-profile-images.ts --apply  (실제 적용)

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import {
  isMirroredProfileImage,
  mirrorSellerProfileImage,
  probeSellerProfileImage,
} from "../src/lib/seller-profile-image";
import { isSellerMediaStorageConfigured } from "../src/lib/seller-analysis/seller-media-storage";

async function main() {
  const apply = process.argv.includes("--apply");

  if (!isSellerMediaStorageConfigured()) {
    console.error(
      "Supabase 스토리지 미설정(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — 미러링 불가. .env를 로드했는지 확인하세요.",
    );
    process.exit(1);
  }

  const prisma = getPrisma();
  const sellers = await prisma.seller.findMany({
    where: { profilePicUrl: { not: null } },
    select: { id: true, name: true, alias: true, snsHandle: true, profilePicUrl: true },
  });

  const targets = sellers.filter((s) => !isMirroredProfileImage(s.profilePicUrl));
  console.log(
    `대상 셀러: 전체 ${sellers.length}명 중 미러링 필요 ${targets.length}명 ` +
      `(이미 Blob: ${sellers.length - targets.length}명) — mode=${apply ? "APPLY" : "DRY-RUN"}`,
  );

  let ok = 0;
  let failed = 0;

  for (const seller of targets) {
    const label = seller.alias || seller.name || seller.snsHandle;
    const sourceUrl = seller.profilePicUrl;
    if (!sourceUrl) continue; // where 절이 이미 걸렀지만 타입을 좁힌다.

    if (!apply) {
      // 예행: 원본이 살아있는지만 확인한다(다운로드·업로드 없음).
      const probe = await probeSellerProfileImage(sourceUrl);
      if (probe.mirrorable) {
        ok++;
        console.log(`  ✓ ${label} (${seller.snsHandle}) — 미러링 가능 (${probe.contentType})`);
      } else {
        failed++;
        console.log(`  ✗ ${label} (${seller.snsHandle}) — ${probe.reason}`);
      }
      continue;
    }

    const result = await mirrorSellerProfileImage(seller.id, sourceUrl);

    if (isMirroredProfileImage(result)) {
      ok++;
      await prisma.seller.update({
        where: { id: seller.id },
        data: { profilePicUrl: result },
      });
      console.log(`  ✓ ${label} (${seller.snsHandle}) → ${result}`);
    } else {
      // 미러링 실패 = 원본이 만료/불가. 원본을 그대로 두고 다음 수집을 기다린다.
      failed++;
      console.log(`  ✗ ${label} (${seller.snsHandle}) — 원본 다운로드 실패(만료 추정), 변경 없음`);
    }
  }

  console.log(
    apply
      ? `\n완료: 미러링 ${ok}명 / 실패 ${failed}명 (DB 반영됨)`
      : `\n완료: 미러링 가능 ${ok}명 / 원본 만료·불가 ${failed}명 ` +
          "(dry-run — 다운로드·업로드·DB write 없음, --apply 로 실제 미러링)",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

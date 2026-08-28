-- 죽은 알림 설정 컬럼 제거.
--
-- 이 5개 컬럼은 Next 앱 안에 있던 알림 발송기(디스코드 웹훅 + SMTP 알림 메일)의
-- 설정 저장소였다. 그 발송기는 실제 이벤트에서 부르는 곳이 0곳이었고, 새 알림
-- 경로의 발화 주체가 메뉴바 앱과 Cloudflare Worker 로 둘 다 Next 앱 밖이라
-- 흡수가 아니라 제거로 처분됐다(코드·화면·라우트는 선행 PR 에서 제거).
-- 설계 정본: docs/superpowers/specs/2026-08-19-external-alert-channel-design.md
--
-- 드롭 전 프로덕션 실측: SystemSettings 1행, 5개 컬럼 전부 NULL(비어 있음).
-- smtpPassword 는 평문 비밀번호를 담을 수 있는 컬럼이라 제거가 노출면 축소다.
ALTER TABLE "SystemSettings" DROP COLUMN "alertEmails",
DROP COLUMN "discordWebhookUrl",
DROP COLUMN "notificationPreferences",
DROP COLUMN "smtpEmail",
DROP COLUMN "smtpPassword";

import { getPrisma } from '@/lib/prisma'

// 앱 공용 Prisma 팩토리에 위임한다. 과거에는 여기서 @prisma/client(postgres)를 직접
// 생성해 sqlite 모드(dev:local·데모 배포)에서 order-converter 라우트만 실DB 클라이언트로
// 갈라지는 문제(postgres-lock)가 있었다 — 클라이언트 선택 규칙은 lib/prisma-client 한 곳만
// 갖는다. import 경로(@/lib/order-converter/prisma)는 기존 소비자·테스트 목을 위해 유지한다.
export const prisma = getPrisma()

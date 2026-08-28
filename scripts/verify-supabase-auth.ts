import { spawn, ChildProcess } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";

// 1. 환경변수 로드
loadEnvConfig(process.cwd());

// 없을 수 있는 값이다 — 조용히 빈 문자열로 때우지 않고, 무엇이 없는지 명시한 뒤 중단한다.
// (검증 대상 자체가 불명확해지므로 실행을 이어가지 않는다.) process.exit(1)의 반환형이
// `never`라 이 함수 안에서는 이후 흐름에서 string으로 좁혀진다 — 호출부 const는 함수
// 경계 밖의 좁히기라 TS가 이어받지 못해(TS2345) 이 헬퍼로 옮겼다.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ 필수 Supabase 환경 변수가 누락되었습니다: ${name}. .env 파일을 확인해 주세요.`);
    process.exit(1);
  }
  return value;
}

const NEXT_PUBLIC_SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const NEXT_PUBLIC_SUPABASE_ANON_KEY = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const TARGET_PORT = 3000;
const TARGET_URL = `http://localhost:${TARGET_PORT}`;

// 2. 헬퍼 함수 정의
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 로컬 dev 서버가 실행 중인지 확인
async function isServerOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${TARGET_URL}/login`, { method: "HEAD", signal: AbortSignal.timeout(1000) });
    return res.status === 200 || res.status === 302 || res.status === 307;
  } catch {
    return false;
  }
}

async function main() {
  let devProcess: ChildProcess | null = null;
  let tempUserId: string | null = null;

  // Supabase 클라이언트 초기화
  const supabaseAdmin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const supabaseAnon = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
  });

  try {
    // A. 로컬 개발 서버 기동 상태 검사 및 기동
    const serverAlreadyOnline = await isServerOnline();
    if (!serverAlreadyOnline) {
      console.log(`[🚀] 로컬 개발 서버가 오프라인입니다. Next.js 개발 서버를 백그라운드에서 기동합니다 (Port: ${TARGET_PORT})...`);
      devProcess = spawn("npm", ["run", "dev"], {
        stdio: "inherit",
        shell: true,
        env: { ...process.env, PORT: String(TARGET_PORT) },
      });

      // 서버가 온라인이 될 때까지 대기 (최대 20초)
      let retries = 20;
      let online = false;
      while (retries > 0) {
        console.log(`[⏳] 개발 서버 응답 대기 중... (남은 시도: ${retries})`);
        await delay(1500);
        if (await isServerOnline()) {
          online = true;
          break;
        }
        retries--;
      }

      if (!online) {
        throw new Error("Next.js 개발 서버 기동 실패 또는 타임아웃이 발생했습니다.");
      }
      console.log("[✅] 개발 서버가 성공적으로 기동되었습니다.");
    } else {
      console.log("[✅] 로컬 개발 서버가 이미 온라인 상태입니다.");
    }

    // B. 임시 사용자 생성
    const tempEmail = `test-auth-${Date.now()}@yground.co`;
    const tempPassword = `TempPassword123!@#_${Date.now()}`;
    console.log(`[👤] 임시 검증 사용자 생성 시도: ${tempEmail}`);

    const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: tempEmail,
      password: tempPassword,
      email_confirm: true,
    });

    if (createError || !createData.user) {
      throw new Error(`임시 사용자 생성 실패: ${createError?.message}`);
    }

    tempUserId = createData.user.id;
    console.log(`[✅] 임시 사용자 생성 완료 (ID: ${tempUserId})`);

    // C. 로그인 시도 및 세션 토큰 획득
    console.log("[🔐] 임시 사용자 로그인 및 세션 획득 시도...");
    const { data: authData, error: loginError } = await supabaseAnon.auth.signInWithPassword({
      email: tempEmail,
      password: tempPassword,
    });

    if (loginError || !authData.session) {
      throw new Error(`로그인 실패: ${loginError?.message}`);
    }

    const session = authData.session;
    console.log("[✅] 세션 획득 성공 (Access Token 발급 완료)");

    // D. `@supabase/ssr` 쿠키 포맷 모사 (base64url 직렬화)
    const projectRef = new URL(NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    
    // session 객체를 JSON 문자열로 만든 후 base64url 인코딩 진행
    const serializedSession = JSON.stringify(session);
    const encodedSession = Buffer.from(serializedSession, "utf-8").toString("base64url");
    const cookieValue = `base64-${encodedSession}`;
    const cookieHeader = `${cookieName}=${cookieValue}`;

    console.log(`[🍪] SSR 쿠키 조립 완료 (쿠키명: ${cookieName})`);

    // E. 로컬 미들웨어 세션 검증 API 호출 및 HTTP 200 검증
    console.log(`[🌐] 보호된 경로 (/pipeline)로 세션 검증 요청 전송...`);
    
    const res = await fetch(`${TARGET_URL}/pipeline`, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
      },
      redirect: "manual",
    });

    console.log(`[📡] 응답 수신 - 상태 코드: ${res.status}`);
    
    if (res.status === 200) {
      console.log("🎉 [SUCCESS] Supabase Auth 세션 기반 미들웨어 인증이 성공적으로 통과되었습니다 (HTTP 200 OK).");
    } else if (res.status === 302 || res.status === 307) {
      const location = res.headers.get("location");
      console.error(`❌ [FAILURE] 미들웨어 인증에 실패하여 리다이렉트되었습니다. (Location: ${location})`);
      throw new Error(`미들웨어 검증 실패: ${res.status} Redirect to ${location}`);
    } else {
      console.error(`❌ [FAILURE] 예상치 못한 응답 상태 코드입니다: ${res.status}`);
      throw new Error(`예상치 못한 상태 코드: ${res.status}`);
    }

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("❌ 검증 과정 중 오류 발생:", errorMessage);
    process.exitCode = 1;
  } finally {
    // F. Clean-up 단계
    if (tempUserId) {
      console.log(`[🧹] 테스트 사용자 삭제 중: ${tempUserId}`);
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(tempUserId);
      if (deleteError) {
        console.error(`⚠️ 테스트 사용자 삭제 중 오류 발생: ${deleteError.message}`);
      } else {
        console.log("[✅] 테스트 사용자 삭제 완료.");
      }
    }

    if (devProcess) {
      console.log("[🧹] 스폰한 Next.js 개발 서버 프로세스를 종료합니다...");
      const killed = devProcess.kill("SIGTERM");
      console.log(`[✅] 프로세스 종료 신호 전송 완료 (결과: ${killed})`);
    }
  }
}

main();

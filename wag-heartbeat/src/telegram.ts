/**
 * 발송 1함수. 반환값(boolean)만으로 성공/실패를 알린다 — throw 하지 않는다.
 * 호출부(apply.ts 의 applyDecision)가 이 반환값으로 상태 저장을 분기하므로,
 * 네트워크 단절 등으로 fetch 자체가 거부돼도 예외가 밖으로 새면 상태 저장까지
 * 통째로 건너뛴다. 실패는 Worker 로그(observability)로 본다.
 */
export async function sendTelegram(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

import { handleBeat, handleTick, type Sender, type StateStore } from "./apply";
import { sendTelegram } from "./telegram";

interface Env {
  BEAT_KV: KVNamespace;
  BEAT_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

const STATE_KEY = "state";

function kvStore(env: Env): StateStore {
  return {
    get: () => env.BEAT_KV.get(STATE_KEY),
    put: (value: string) => env.BEAT_KV.put(STATE_KEY, value),
  };
}

function telegramSender(env: Env): Sender {
  return (text: string) => sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/beat") {
      return new Response("not found", { status: 404 });
    }
    // 무인증이면 누구나 가짜 생존 신호를 넣어 침묵 판정을 영원히 막을 수 있다.
    if (request.headers.get("authorization") !== `Bearer ${env.BEAT_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    await handleBeat(kvStore(env), telegramSender(env), Date.now());
    return new Response("ok");
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await handleTick(kvStore(env), telegramSender(env), Date.now());
  },
};

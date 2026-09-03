// Peer-credential bridge for the WAG agent worker UDS (task-5 brief addendum).
//
// getPeerCredentials(fd: number): { uid: number; gid: number }
//
// Wraps getpeereid(2) from macOS libc. Any libc failure or invalid argument throws;
// the addon never returns a default uid. Built only by `npm run agent-worker:build-native`.
#include <napi.h>

#include <cerrno>
#include <cmath>
#include <cstring>
#include <string>

#include <sys/types.h>
#include <unistd.h>

namespace {

Napi::Value GetPeerCredentials(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "fd must be a number").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double raw = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(raw) || raw < 0 || raw != std::floor(raw) || raw > 2147483647.0) {
    Napi::TypeError::New(env, "fd must be a finite non-negative integer").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int fd = static_cast<int>(raw);

  uid_t uid = 0;
  gid_t gid = 0;
  if (getpeereid(fd, &uid, &gid) != 0) {
    const int saved = errno;
    Napi::Error::New(env, std::string("getpeereid failed: ") + std::strerror(saved))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("uid", Napi::Number::New(env, static_cast<double>(uid)));
  result.Set("gid", Napi::Number::New(env, static_cast<double>(gid)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getPeerCredentials", Napi::Function::New(env, GetPeerCredentials));
  return exports;
}

}  // namespace

NODE_API_MODULE(peer_cred, Init)

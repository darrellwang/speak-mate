"""
SpeakMate 发音评测服务（stdlib 实现，零第三方 web 依赖）

POST /pronounce?text=Hello%20world&lang=en
  body: 原始音频字节（wav/mp3 均可，librosa+soundfile 读取）
  返回: {code:0, data:{score, transcribe, differences, prosody...}}

GET /health → {ok:true}

模型在进程内 lru_cache，首次请求加载一次（~10s），之后单次评估 <1s。
"""
import json
import os
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from openpronounce import load_audio, compare_audio_with_text

PORT = int(os.environ.get("PRON_PORT", "8600"))
MAX_BODY = 20 * 1024 * 1024  # 20MB 上限

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[pron] {args[0]} {args[1]} {args[2]}", flush=True)

    def _json(self, code, payload, status=200):
        body = json.dumps({"code": code, "data": payload, "message": "ok" if code == 0 else "error"}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._json(0, {"ok": True})
        else:
            self._json(404, None, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/pronounce":
            self._json(404, None, 404)
            return
        qs = parse_qs(parsed.query)
        text = (qs.get("text", [""])[0] or "").strip()
        lang = qs.get("lang", ["en"])[0] or "en"
        if not text:
            self._json(4001, {"reason": "text required"}, 400)
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(4002, {"reason": "audio body required (<=20MB)"}, 400)
            return
        audio_bytes = self.rfile.read(length)

        # 按魔数给临时文件加正确后缀（librosa 依赖扩展名嗅探的兜底）
        ext = ".mp3"
        if audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE":
            ext = ".wav"
        fd, path = tempfile.mkstemp(suffix=ext)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(audio_bytes)
            t0 = time.time()
            sound = load_audio(path)
            result = compare_audio_with_text(sound, text, lang=lang)
            result["elapsed_ms"] = int((time.time() - t0) * 1000)
            self._json(0, result)
        except Exception as e:
            self._json(5001, {"reason": str(e)[:200]}, 500)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

if __name__ == "__main__":
    print(f"[pron] server on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

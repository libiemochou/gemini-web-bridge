# -*- coding: utf-8 -*-
"""
Gemini 网页版桥接 —— 本地桥接程序
把浏览器插件从 Gemini 网页抓到的回答，包装成 Anthropic Messages API，
供 Claude Code 及各类兼容客户端使用。只用 Python 标准库。

启动：双击 start-bridge.bat（排障用；平时由生图工具自动拉起）
状态：浏览器打开 http://127.0.0.1:8080/x/status
"""
import base64
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 8080
TASK_TIMEOUT = 300          # 等网页回答的最长秒数（超过就报错）
POLL_HOLD = 25              # 插件长轮询挂起秒数
MAX_PROMPT_CHARS = 120000   # 拼给网页的对话文本上限（超了砍开头）

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BASE_DIR, "bridge.log")

PROMPT_PRE = (
    "[规则] 下面给你一段对话记录。请你以助手的身份，直接续写对最后一条“用户”消息的回答。"
    "要求：只输出回答本身；不要写任何前言（如“好的”“以下是”）；不要复述对话记录；不要加角色标签。\n\n"
)

# 生图任务的提示词（让 Gemini 直接画出来，而不是只给文字描述）
PROMPT_IMG_PRE = (
    "请直接用你的图像生成能力画一张图片（不要只给文字描述，不要反问）。画面要求：\n"
)


def build_image_prompt(desc):
    return PROMPT_IMG_PRE + (desc or "").strip()

LOCK = threading.Lock()
PENDING = []                # [{id, prompt, created}]，等插件来取
WAITERS = {}                # id -> {"event": Event, "result": None}
DL_PATHS = {}               # id -> 下载完成的文件路径（"下载完整尺寸"通道用）
INFLIGHT = {}               # id -> {"t": 取走时间, "acked": 是否签收, "task": 原任务}
                            # 防止任务被"已经死掉的旧轮询线"接走没人干活
STATE = {
    "started": time.time(),
    "last_poll": 0,         # 插件最后一次来取任务的时间
    "last_error": None,
    "diag": None,           # 插件上报的页面自检数据
    "tasks_done": 0,
    "tasks_error": 0,
}


def log(*args):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _diag_summary(body):
    """把页面自检数据压成一行短日志（完整数据在 /x/status 里看）"""
    try:
        data = body or {}
        hits = data.get("hits") or {}
        parts = []
        for grp, ss in hits.items():
            best = max(list((ss or {}).values()) or [0])
            parts.append("%s=%d" % (grp, best))
        return "%s [%s]" % (data.get("url", "?"), ", ".join(parts))
    except Exception:
        return "?"


DOWNLOAD_DIR = os.path.join(os.path.expanduser("~"), "Downloads")


def save_image(im):
    """把插件抓来的 {mime, b64} 预览图存到"下载"文件夹，返回路径（失败返回 None）"""
    try:
        mime = (im or {}).get("mime") or "image/png"
        b64 = (im or {}).get("b64") or ""
        if not b64:
            return None
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        name = "gemini-web-" + time.strftime("%Y%m%d-%H%M%S") + uuid.uuid4().hex[:3] + ext
        path = os.path.join(DOWNLOAD_DIR, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        log("预览图已存到下载夹：", path)
        return path
    except Exception as e:
        log("保存图片失败：", e)
        return None


# ---------------------------------------------------------------- 对话文本拼装

def _blocks_to_text(content):
    """把 Anthropic 的 content（字符串或块列表）压成纯文本"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return "" if content is None else str(content)
    out = []
    for b in content:
        if not isinstance(b, dict):
            out.append(str(b))
            continue
        t = b.get("type")
        if t == "text":
            out.append(b.get("text", ""))
        elif t == "tool_use":
            out.append("[助手调用了工具 %s]" % b.get("name", "?"))
        elif t == "tool_result":
            inner = b.get("content")
            txt = _blocks_to_text(inner) if inner is not None else ""
            out.append("[工具返回结果]\n" + txt[:800])
        elif t == "image":
            out.append("[图片]")
        elif t == "thinking":
            continue
        else:
            out.append("[%s]" % t)
    return "\n".join(x for x in out if x)


def build_prompt(body):
    parts = []
    sysp = body.get("system")
    if sysp:
        st = _blocks_to_text(sysp).strip()
        if st:
            parts.append("[系统设定]\n" + st)
    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        txt = _blocks_to_text(m.get("content")).strip()
        if not txt:
            continue
        who = "用户" if m.get("role") == "user" else "助手"
        parts.append("%s：%s" % (who, txt))
    text = "\n\n".join(parts)
    if len(text) > MAX_PROMPT_CHARS:
        text = "（前文过长，已省略开头部分）\n\n" + text[-MAX_PROMPT_CHARS:]
    return PROMPT_PRE + text


# ---------------------------------------------------------------- 任务队列

def new_task(prompt, want=None, action=None):
    tid = uuid.uuid4().hex[:12]
    ev = threading.Event()
    with LOCK:
        PENDING.append({"id": tid, "prompt": prompt, "created": time.time(),
                        "want": want, "action": action})
        WAITERS[tid] = {"event": ev, "result": None}
    log("排队新任务 %s（%d 字%s%s）" % (tid, len(prompt),
                                     "，生图" if want == "image" else "",
                                     "，只下载" if action == "download-last" else ""))
    return tid, ev


def take_task():
    now = time.time()
    with LOCK:
        _requeue_stale_locked(now)
        # 丢掉放太久的旧任务（对应的请求早就超时了）
        PENDING[:] = [t for t in PENDING if now - t["created"] < TASK_TIMEOUT + 60]
        if PENDING:
            t = PENDING.pop(0)
            INFLIGHT[t["id"]] = {"t": now, "acked": False, "task": t}
            return t
    return None


def _requeue_stale_locked(now):
    """被取走 12 秒还没等到插件签收的任务，放回队列重发（那条轮询线多半早就死了）"""
    for tid in list(INFLIGHT.keys()):
        info = INFLIGHT[tid]
        if info.get("acked"):
            continue
        if now - info["t"] > 12:
            del INFLIGHT[tid]
            if tid in WAITERS:
                t = dict(info.get("task") or {})
                t["created"] = time.time()
                PENDING.insert(0, t)
                log("任务 %s 没等到签收，放回队列重发" % tid)


def complete_task(payload):
    tid = str(payload.get("id") or "")
    with LOCK:
        w = WAITERS.get(tid)
        if w is None:
            return False
        w["result"] = payload
        w["event"].set()
        INFLIGHT.pop(tid, None)
    if payload.get("error"):
        STATE["last_error"] = payload.get("error")
        STATE["tasks_error"] += 1
        log("任务 %s 失败：%s" % (tid, payload.get("error")))
    else:
        STATE["tasks_done"] += 1
        log("任务 %s 完成（%d 字回答）" % (tid, len(payload.get("text") or "")))
    return True


# ---------------------------------------------------------------- HTTP 服务

class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GeminiWebBridge/0.1"

    def log_message(self, fmt, *args):
        pass  # 静音默认访问日志，用我们自己的 log()

    # ---------- 小工具 ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._send_json(200, {
                "ok": True, "name": "Gemini 网页桥接",
                "hint": "把客户端的供应商地址指向 http://127.0.0.1:%d" % PORT,
            })
        elif path == "/x/poll":
            self._handle_poll()
        elif path == "/x/status":
            self._handle_status()
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/v1/messages":
            self._handle_messages()
        elif path == "/v1/messages/count_tokens":
            body = self._read_body()
            text = build_prompt(body)
            self._send_json(200, {"input_tokens": max(1, len(text) // 3)})
        elif path == "/x/result":
            body = self._read_body()
            ok = complete_task(body)
            self._send_json(200 if ok else 404, {"ok": ok})
        elif path == "/x/diag":
            body = self._read_body()
            STATE["diag"] = {"t": time.time(), "data": body}
            log("页面自检：", _diag_summary(body))
            self._send_json(200, {"ok": True})
        elif path == "/x/dl":
            body = self._read_body()
            tid = str(body.get("id") or "")
            f = str(body.get("file") or "")
            with LOCK:
                DL_PATHS[tid] = f
            log("下载落地：", tid, f)
            self._send_json(200, {"ok": True})
        elif path == "/x/ack":
            body = self._read_body()
            tid = str(body.get("id") or "")
            with LOCK:
                info = INFLIGHT.get(tid)
                if info:
                    info["acked"] = True
            self._send_json(200, {"ok": True})
        elif path == "/x/gen-image":
            self._handle_gen_image()
        elif path == "/x/grab-last":
            self._handle_grab_last()
        else:
            self._send_json(404, {"error": "not found"})

    # ---------- 各路由实现 ----------
    def _handle_gen_image(self):
        """生图专用：收一个描述，等网页画出图，原图落在"下载"文件夹里（不搬不动不弹窗）"""
        body = self._read_body()
        desc = (body.get("prompt") or "").strip()
        if not desc:
            self._send_json(400, {"ok": False, "error": "缺少 prompt"})
            return
        tid, ev = new_task(build_image_prompt(desc), want="image")
        ev.wait(TASK_TIMEOUT)
        with LOCK:
            w = WAITERS.pop(tid, None)
        result = (w or {}).get("result") or {}
        err = self._result_error(result)
        if err:
            log("生图失败：", err)
            self._send_json(502, {"ok": False, "error": err})
            return
        # 优先报"下载完整尺寸"通道落地的原图（就让它待在下载文件夹里）
        if result.get("downloaded"):
            path = self._wait_download(tid)
            if path and os.path.isfile(path):
                log("原图已下载：", path, "（%.1f MB）" % (os.path.getsize(path) / 1048576.0))
                self._send_json(200, {"ok": True, "files": [path],
                                      "text": (result.get("text") or "").strip()})
                return
        # 兜底：下载没等到的话，把抓到的预览图也存进下载文件夹
        saved = []
        for im in (result.get("images") or []):
            p = save_image(im)
            if p:
                saved.append(p)
        if not saved:
            hint = (result.get("text") or "").strip()[:80]
            self._send_json(502, {"ok": False,
                                  "error": "网页回答了，但没抓到图片" + (("。它说：" + hint) if hint else "")})
            return
        self._send_json(200, {"ok": True, "files": saved,
                              "text": (result.get("text") or "").strip()})

    def _wait_download(self, tid, timeout=60):
        """等浏览器那边传来"下载完成"的通知"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with LOCK:
                p = DL_PATHS.pop(tid, None)
            if p:
                return p
            time.sleep(0.5)
        return None

    def _handle_grab_last(self):
        """只下载不生成：把当前页面最后一条回答里的图按"下载完整尺寸"拿下来"""
        tid, ev = new_task("", action="download-last")
        ev.wait(TASK_TIMEOUT)
        with LOCK:
            w = WAITERS.pop(tid, None)
        result = (w or {}).get("result") or {}
        if not result:
            self._send_json(502, {"ok": False, "error": "任务超时（插件没响应）"})
            return
        if result.get("error"):
            self._send_json(502, {"ok": False, "error": result["error"]})
            return
        path = self._wait_download(tid) if result.get("downloaded") else None
        if not path or not os.path.isfile(path):
            self._send_json(502, {"ok": False, "error": "没等到下载完成的文件（下载按钮可能没点到）"})
            return
        self._send_json(200, {"ok": True, "files": [path]})

    def _handle_poll(self):
        STATE["last_poll"] = time.time()
        deadline = time.time() + POLL_HOLD
        while True:
            with LOCK:
                _requeue_stale_locked(time.time())
            task = take_task()
            if task:
                self._send_json(200, task)
                return
            if time.time() >= deadline:
                self.send_response(204)
                self._cors()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            time.sleep(0.25)

    def _handle_status(self):
        with LOCK:
            n_pending = len(PENDING)
        last_poll = STATE["last_poll"]
        age = (time.time() - last_poll) if last_poll else None
        self._send_json(200, {
            "ok": True,
            "uptime_sec": int(time.time() - STATE["started"]),
            "extension_connected": bool(age is not None and age < POLL_HOLD + 15),
            "extension_last_poll_sec_ago": round(age, 1) if age is not None else None,
            "pending": n_pending,
            "tasks_done": STATE["tasks_done"],
            "tasks_error": STATE["tasks_error"],
            "last_error": STATE["last_error"],
            "diag": STATE["diag"],
        })

    def _handle_messages(self):
        body = self._read_body()
        prompt = build_prompt(body)
        tid, ev = new_task(prompt)
        if body.get("stream"):
            self._stream_messages(tid, ev)
            return
        ev.wait(TASK_TIMEOUT)
        with LOCK:
            w = WAITERS.pop(tid, None)
        result = (w or {}).get("result") or {}
        err = self._result_error(result)
        if err:
            log("请求失败：", err)
            self._send_json(502, {"type": "error",
                                  "error": {"type": "api_error", "message": err}})
            return
        text, _images = self._result_text(result)
        self._send_json(200, self._message_obj(tid, text))

    @staticmethod
    def _result_error(result):
        if result.get("error"):
            return result["error"]
        text = (result.get("text") or "").strip()
        images = result.get("images") or []
        if not text and not images:
            if not result:
                return ("等网页回答超时（%d 秒）。检查：Gemini 页面是否开着并已登录？梯子是否正常？"
                        % TASK_TIMEOUT)
            return "网页没有返回文字（页面结构可能变了，看 /x/status 里的自检数据）"
        return None

    @staticmethod
    def _result_text(result):
        text = (result.get("text") or "").strip()
        images = result.get("images") or []
        if images and not text:
            paths = []
            for im in images:
                p = save_image(im)
                if p:
                    paths.append(p)
            if paths:
                text = "（这次回答是图片，已存到下载文件夹：%s）" % "、".join(paths)
            else:
                text = "（这次回答是图片，但保存失败了）"
        return text, images

    @staticmethod
    def _message_obj(tid, text):
        return {
            "id": "msg_" + tid,
            "type": "message",
            "role": "assistant",
            "model": "gemini-web",
            "content": [{"type": "text", "text": text}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": max(1, len(text) // 2)},
        }

    def _stream_messages(self, tid, ev):
        """流式：先把响应头发出去，等网页回答期间发 ping 保活，拿到结果再逐段发"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self._cors()
        self.end_headers()

        def chunk(s):
            data = s.encode("utf-8")
            self.wfile.write(("%X\r\n" % len(data)).encode("ascii") + data + b"\r\n")
            self.wfile.flush()

        def evt(name, obj):
            chunk("event: %s\ndata: %s\n\n" % (name, json.dumps(obj, ensure_ascii=False)))

        try:
            evt("message_start", {"type": "message_start", "message": {
                "id": "msg_" + tid, "type": "message", "role": "assistant",
                "model": "gemini-web", "content": [], "stop_reason": None,
                "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}})
            # 等网页回答；期间每 10 秒发个 ping，防止客户端等得不耐烦
            deadline = time.time() + TASK_TIMEOUT
            while not ev.wait(10):
                if time.time() >= deadline:
                    break
                evt("ping", {"type": "ping"})
            with LOCK:
                w = WAITERS.pop(tid, None)
            result = (w or {}).get("result") or {}
            err = self._result_error(result)
            if err:
                log("请求失败（流式）：", err)
                evt("error", {"type": "error",
                              "error": {"type": "api_error", "message": err}})
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                return
            text, _images = self._result_text(result)
            evt("content_block_start", {"type": "content_block_start", "index": 0,
                                        "content_block": {"type": "text", "text": ""}})
            step = 160
            for i in range(0, len(text), step):
                evt("content_block_delta", {
                    "type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": text[i:i + step]}})
                time.sleep(0.01)
            evt("content_block_stop", {"type": "content_block_stop", "index": 0})
            evt("message_delta", {"type": "message_delta",
                                  "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                  "usage": {"output_tokens": max(1, len(text) // 2)}})
            evt("message_stop", {"type": "message_stop"})
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("客户端提前断开（任务 %s）" % tid)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    log("=" * 56)
    log("Gemini 网页桥接启动：http://%s:%d" % (HOST, PORT))
    log("状态查看：浏览器打开 http://%s:%d/x/status" % (HOST, PORT))
    log("=" * 56)
    srv = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt):
        import traceback
        log("服务崩溃：\n" + traceback.format_exc())
        raise

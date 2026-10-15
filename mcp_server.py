# -*- coding: utf-8 -*-
"""
Gemini 生图 —— MCP 工具（stdio）
给 cc-haha / Claude Code 暴露一个 generate_image 工具：
模型收到"生图"需求时调用它，内部转发给本地桥接程序 127.0.0.1:8080/x/gen-image。
桥接程序没在跑的话，会自动把它拉起来。只用 Python 标准库。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8080"
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.py")
_PYTHONW = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
PYTHONW = _PYTHONW if os.path.exists(_PYTHONW) else sys.executable

PROTOCOL = "2024-11-05"

# 不走系统代理（本机回环地址直连）
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _post(path, payload, timeout):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"})
    with OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _bridge_up():
    try:
        with OPENER.open(BASE + "/", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _ensure_bridge():
    if _bridge_up():
        return
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [PYTHONW, SERVER], cwd=HERE, creationflags=flags,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        time.sleep(0.5)
        if _bridge_up():
            return
    raise RuntimeError("桥接程序启动失败，请双击本文件夹里的 start-bridge.bat 看看报什么错")


def generate_image(prompt):
    prompt = (prompt or "").strip()
    if not prompt:
        return "生图失败：没有给图片描述"
    _ensure_bridge()
    r = _post("/x/gen-image", {"prompt": prompt}, timeout=320)
    if r.get("ok"):
        files = r.get("files") or []
        return ("图片已生成并下载好，文件路径：\n" + "\n".join(files) +
                "\n（就在电脑的「下载」文件夹里。把路径原样告诉用户即可，不要编造图片内容之外的信息。）")
    return "生图失败：" + str(r.get("error") or "未知错误")


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if method == "initialize":
            ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
            reply({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": ver,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "gemini-image", "version": "1.0.0"},
            }})
        elif method == "notifications/initialized":
            pass
        elif method == "ping":
            reply({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            reply({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
                "name": "generate_image",
                "description": (
                    "用 Gemini 生成一张图片，自动下载到电脑的「下载」文件夹。"
                    "当用户要求画图 / 生图 / 生成图片 / 配图时使用。"
                    "生成通常需要 30~120 秒，属于正常速度，耐心等结果。"),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "图片内容描述，尽量具体（主体、场景、风格、光线、比例等）",
                        }
                    },
                    "required": ["prompt"],
                },
            }]}})
        elif method == "tools/call":
            params = msg.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "generate_image":
                try:
                    text = generate_image(str(args.get("prompt") or ""))
                    reply({"jsonrpc": "2.0", "id": mid, "result": {
                        "content": [{"type": "text", "text": text}], "isError": False}})
                except Exception as e:
                    reply({"jsonrpc": "2.0", "id": mid, "result": {
                        "content": [{"type": "text", "text": "生图失败：%s" % e}],
                        "isError": True}})
            else:
                reply({"jsonrpc": "2.0", "id": mid,
                       "error": {"code": -32602, "message": "未知工具：%s" % name}})
        elif mid is not None:
            reply({"jsonrpc": "2.0", "id": mid,
                   "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    main()

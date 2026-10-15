# -*- coding: utf-8 -*-
"""
Gemini 网页桥接 —— 安装 / 修复「生图工具」

运行方式：
    python install_mcp.py

作用：把 gemini-image 这个 MCP 工具注册进 Claude Code 系的配置文件（~/.claude.json），
     让任意会话都能对模型说"帮我生成一张图片"。
重复运行无害（幂等）—— Claude Code（或你的客户端）更新后如果工具消失，重跑一次即可。
"""
import json
import os
import shutil
import sys
import time

CLAUDE_JSON = os.path.join(os.path.expanduser("~"), ".claude.json")
HERE = os.path.dirname(os.path.abspath(__file__))
MCP_SCRIPT = os.path.join(HERE, "mcp_server.py")

# 用当前正在运行本脚本的 Python，保证路径永远是对的
# （如果是 pythonw 启动的，换回同目录的 python.exe，MCP 走标准输入输出更稳）
PYTHON = sys.executable
if PYTHON.lower().endswith("pythonw.exe"):
    _cand = PYTHON[: -len("pythonw.exe")] + "python.exe"
    if os.path.exists(_cand):
        PYTHON = _cand

ENTRY = {
    "type": "stdio",
    "command": PYTHON,
    "args": [MCP_SCRIPT],
    "env": {},
}


def main():
    if not os.path.isfile(MCP_SCRIPT):
        print("[X] 找不到 mcp_server.py —— 请把本脚本和 mcp_server.py 放在同一个文件夹里运行。")
        return 1
    if not os.path.isfile(CLAUDE_JSON):
        print("[X] 找不到 %s —— 请先安装并运行过一次 Claude Code（或兼容客户端）。" % CLAUDE_JSON)
        return 1

    try:
        with open(CLAUDE_JSON, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print("[X] 配置文件读不出来：%s" % e)
        return 1

    servers = data.setdefault("mcpServers", {})
    cur = servers.get("gemini-image")
    if cur and cur.get("command") == ENTRY["command"] and cur.get("args") == ENTRY["args"]:
        print("[OK] 生图工具已经挂好了，不需要修。")
    else:
        bak = CLAUDE_JSON + ".bak-gemini-mcp-" + time.strftime("%Y%m%d%H%M%S")
        shutil.copy2(CLAUDE_JSON, bak)
        servers["gemini-image"] = ENTRY
        with open(CLAUDE_JSON, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("[OK] 生图工具已注册（旧配置已备份：%s）" % os.path.basename(bak))

    print()
    print("下一步：")
    print("  1. 重启一次 Claude Code（或你的客户端），让工具生效")
    print("  2. 确保 Chrome 里已经加载了 extension 文件夹（chrome://extensions → 加载已解压的扩展程序）")
    print("  3. 在浏览器里登录你的 Gemini 账号（建议用小号）")
    print("  4. 随便找个会话，说：帮我生成一张柴犬戴墨镜的图片")
    return 0


if __name__ == "__main__":
    sys.exit(main())

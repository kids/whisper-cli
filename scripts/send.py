"""通过飞书自建应用发送消息。用法: python scripts/send.py [--post] [--title T] "消息内容" """

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = Path(os.environ.get("FEISHU_ENV", ROOT / ".env"))
TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
SEND_URL = "https://open.feishu.cn/open-apis/im/v1/messages"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def get_tenant_access_token(app_id: str, app_secret: str) -> str:
    resp = httpx.post(
        TOKEN_URL,
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"获取 tenant_access_token 失败: {data.get('msg')}")
    return data["tenant_access_token"]


def _split_paragraphs(text: str) -> list[str]:
    parts: list[str] = []
    buf = ""
    in_fence = False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and line.strip() == "" and buf.strip():
            parts.append(buf.strip())
            buf = ""
            continue
        buf += ("\n" if buf else "") + line
    if buf.strip():
        parts.append(buf.strip())
    return parts or [text]


def markdown_to_post_body(text: str, title: str = "") -> dict:
    """飞书 post 富文本：content 内用 tag=md 节点渲染 Markdown。"""
    trimmed = text.strip() or "(空)"
    paragraphs = _split_paragraphs(trimmed)
    return {
        "zh_cn": {
            "title": title[:200],
            "content": [[{"tag": "md", "text": p}] for p in paragraphs],
        }
    }


def _looks_like_markdown(text: str) -> bool:
    return bool(re.search(r"(^|\n)\s*#|\*\*.+\*\*|__.+__|(^|\n)\s*[-*]\s+", text))


def send_message(
    *,
    app_id: str,
    app_secret: str,
    receive_id: str,
    text: str,
    receive_id_type: str = "chat_id",
    as_post: bool = False,
    title: str = "",
) -> dict:
    token = get_tenant_access_token(app_id, app_secret)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    use_post = as_post or _looks_like_markdown(text)
    if use_post:
        body = {
            "receive_id": receive_id,
            "msg_type": "post",
            "content": json.dumps(markdown_to_post_body(text, title), ensure_ascii=False),
        }
    else:
        body = {
            "receive_id": receive_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
    resp = httpx.post(
        SEND_URL,
        headers=headers,
        params={"receive_id_type": receive_id_type},
        json=body,
        timeout=30,
    )
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(json.dumps(data, ensure_ascii=False))
    return data


def send_text(
    *,
    app_id: str,
    app_secret: str,
    receive_id: str,
    text: str,
    receive_id_type: str = "chat_id",
) -> dict:
    return send_message(
        app_id=app_id,
        app_secret=app_secret,
        receive_id=receive_id,
        text=text,
        receive_id_type=receive_id_type,
        as_post=False,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="飞书 IM 发消息")
    parser.add_argument("text", nargs="?", default="hello from cursor")
    parser.add_argument("--post", action="store_true", help="强制 post+md 富文本")
    parser.add_argument("--text", action="store_true", help="强制纯文本（不渲染 Markdown）")
    parser.add_argument("--title", default="", help="post 标题")
    args = parser.parse_args(argv[1:])

    receive_id = os.environ.get("FEISHU_CHAT_ID") or os.environ.get("FEISHU_RECEIVE_ID")
    receive_id_type = os.environ.get("FEISHU_RECEIVE_ID_TYPE", "chat_id")

    if not ENV_PATH.exists():
        print(f"未找到配置文件: {ENV_PATH}", file=sys.stderr)
        return 1

    env = load_env(ENV_PATH)
    app_id = env.get("AGENT_1_FEISHU_APP_ID") or env.get("FEISHU_APP_ID", "")
    app_secret = env.get("AGENT_1_FEISHU_APP_SECRET") or env.get("FEISHU_APP_SECRET", "")
    if not app_id or not app_secret:
        print("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置", file=sys.stderr)
        return 1

    if not receive_id:
        receive_id = (
            env.get("AGENT_1_FEISHU_CHAT_ID")
            or env.get("FEISHU_CHAT_ID")
            or env.get("FEISHU_RECEIVE_ID", "")
        )
    if not receive_id:
        print(
            "缺少接收方 ID。请设置 FEISHU_CHAT_ID 环境变量，或在 .env 中配置。",
            file=sys.stderr,
        )
        return 1

    as_post = args.post and not args.text
    if args.text:
        as_post = False
    elif args.post:
        as_post = True
    else:
        as_post = _looks_like_markdown(args.text)

    try:
        result = send_message(
            app_id=app_id,
            app_secret=app_secret,
            receive_id=receive_id,
            text=args.text,
            receive_id_type=receive_id_type,
            as_post=as_post,
            title=args.title,
        )
    except Exception as exc:
        print(f"发送失败: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

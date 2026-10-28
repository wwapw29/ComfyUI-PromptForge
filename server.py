"""PromptForge 预设管理接口。

放到独立文件里，节点端口跑起来就算路由注册失败也不会连累生图。
"""

from __future__ import annotations

import json
import os
import re

from aiohttp import web

try:
    from server import PromptServer
    ROUTES = PromptServer.instance.routes
except Exception as exc:  # pragma: no cover
    print(f"[PromptForge] 无法注册 HTTP 路由：{exc}")
    ROUTES = None

PRESET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets")
ALLOWED = re.compile(r"^[\w\-\u4e00-\u9fa5 .]{1,64}$")


def _ensure_dir():
    os.makedirs(PRESET_DIR, exist_ok=True)


def _preset_path(name: str) -> str:
    name = (name or "").strip()
    if not ALLOWED.match(name):
        raise web.HTTPBadRequest(text="预设名只能包含中英文、数字、空格、下划线、短横线和点")
    return os.path.join(PRESET_DIR, f"{name}.json")


def _list():
    _ensure_dir()
    out = []
    for fn in sorted(os.listdir(PRESET_DIR)):
        if fn.lower().endswith(".json"):
            out.append(os.path.splitext(fn)[0])
    return out


if ROUTES is not None:

    @ROUTES.get("/prompt_forge/presets")
    async def pf_list_presets(request):
        return web.json_response({"presets": _list(), "dir": PRESET_DIR})

    @ROUTES.get("/prompt_forge/preset")
    async def pf_get_preset(request):
        name = request.query.get("name", "")
        path = _preset_path(name)
        if not os.path.isfile(path):
            raise web.HTTPNotFound(text=f"预设不存在：{name}")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response({"name": name, "data": data})

    @ROUTES.post("/prompt_forge/preset")
    async def pf_save_preset(request):
        body = await request.json()
        name = body.get("name", "")
        data = body.get("data", {})
        path = _preset_path(name)
        _ensure_dir()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return web.json_response({"ok": True, "name": name, "presets": _list()})

    @ROUTES.post("/prompt_forge/preset/delete")
    async def pf_delete_preset(request):
        body = await request.json()
        name = body.get("name", "")
        path = _preset_path(name)
        if os.path.isfile(path):
            os.remove(path)
        return web.json_response({"ok": True, "presets": _list()})

    @ROUTES.get("/prompt_forge/loras")
    async def pf_list_loras(request):
        try:
            import folder_paths
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        return web.json_response({"loras": names})

    @ROUTES.get("/prompt_forge/info")
    async def pf_info(request):
        return web.json_response({"version": "1.0.0", "preset_dir": PRESET_DIR})

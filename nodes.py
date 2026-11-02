"""
PromptForge — 全能提示词组装节点（MOSS-Image Layout 版）

输出 MOSS 官方 layout JSON：
  bbox_format     = "yxyx"            -> [y_min, x_min, y_max, x_max]
  bbox_coord_space= "abs_centralized" -> 以画布中心为原点，y 向下
内部（前端 & 预设）统一使用左上加原点像素 [x1, y1, x2, y2]，本文件负责换算。

同时内置多 LoRA 加载，可选输入 MODEL/CLIP，直接输出加载后的 MODEL/CLIP。
"""

from __future__ import annotations

import json
import math
import os
import re

import folder_paths

try:
    import comfy.sd
    import comfy.utils
except Exception:  # pragma: no cover
    comfy = None

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(NODE_DIR, "presets")

DEFAULT_STATE = {
    "summary": {"caption": "", "meta": "poster", "canvas": "single"},
    "items": [],
    "loras": [],
    "preset": "",
}


def _safe_json_loads(raw, fallback):
    if not raw or not str(raw).strip():
        return fallback
    try:
        val = json.loads(raw)
        return val if isinstance(val, type(fallback)) else fallback
    except Exception:
        return fallback


def parse_state(raw: str) -> dict:
    """把前端那份 JSON 收拾成可信结构。任何字段坏了都退回默认值，别让整张图炸掉。"""
    data = _safe_json_loads(raw, {})
    if not isinstance(data, dict):
        data = {}

    summary_raw = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    summary = {
        "caption": str(summary_raw.get("caption", "") or ""),
        "meta": summary_raw.get("meta", "poster"),
        "canvas": str(summary_raw.get("canvas", "single") or ""),
    }

    items = []
    for it in data.get("items", []) or []:
        if not isinstance(it, dict):
            continue
        bbox = it.get("bbox") or [0, 0, 0, 0]
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            bbox = [0, 0, 0, 0]
        try:
            bbox = [float(v) for v in bbox]
        except Exception:
            bbox = [0.0, 0.0, 0.0, 0.0]
        item = {
            "label": str(it.get("label", "object") or "object"),
            "caption": str(it.get("caption", "") or ""),
            "text": str(it.get("text", "") or ""),
            "name": str(it.get("name", "") or ""),
            "bbox": bbox,
        }
        # 完全没有内容又没有面积的区域没有意义，丢掉
        if not item["caption"] and not item["text"] and abs(bbox[2] - bbox[0]) < 2 and abs(bbox[3] - bbox[1]) < 2:
            continue
        items.append(item)

    loras = []
    for lo in data.get("loras", []) or []:
        if not isinstance(lo, dict):
            continue
        name = str(lo.get("name", "") or "").strip()
        if not name:
            continue
        try:
            sm = float(lo.get("strength_model", lo.get("sm", 1.0)))
        except Exception:
            sm = 1.0
        try:
            sc = float(lo.get("strength_clip", lo.get("sc", 1.0)))
        except Exception:
            sc = 1.0
        loras.append({"name": name, "strength_model": sm, "strength_clip": sc, "enabled": bool(lo.get("enabled", True))})

    return {"summary": summary, "items": items, "loras": loras, "preset": data.get("preset", "")}


def _align(v: int, align16: bool) -> int:
    v = int(max(16, v))
    if align16:
        v = int(round(v / 16.0)) * 16
        v = max(16, v)
    return v


def _central_bbox(bbox, width: int, height: int):
    """左上原点像素 [x1,y1,x2,y2] -> MOSS [y_min, x_min, y_max, x_max]（中心原点、整数）。"""
    x1, y1, x2, y2 = bbox
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    x1 = max(0.0, min(float(width), x1))
    x2 = max(0.0, min(float(width), x2))
    y1 = max(0.0, min(float(height), y1))
    y2 = max(0.0, min(float(height), y2))
    return [
        int(round(y1 - height / 2.0)),
        int(round(x1 - width / 2.0)),
        int(round(y2 - height / 2.0)),
        int(round(x2 - width / 2.0)),
    ]


# ---------------- 词库占位符展开 ----------------
# 输入框里存的是 <tag:别名>，真正喂给模型的提示词在这里展开。
# 这样前端增删只针对 token，不会和相邻文本互相误伤；词条改了，引用它的格子也会自动跟上。

TAG_PATTERN = re.compile(r"<tag:([^<>]+)>")
_TAG_CACHE = {"mtime": 0.0, "map": {}}


def _find_tag_data():
    """定位 Danbooru-Gallery 的 PromptSelector 数据文件。"""
    try:
        base = folder_paths.base_path
    except Exception:
        base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    direct = os.path.join(
        base, "custom_nodes", "ComfyUI-Danbooru-Gallery", "py", "prompt_selector", "data.json"
    )
    if os.path.isfile(direct):
        return direct
    nodes_dir = os.path.join(base, "custom_nodes")
    if os.path.isdir(nodes_dir):
        for name in sorted(os.listdir(nodes_dir)):
            cand = os.path.join(nodes_dir, name, "py", "prompt_selector", "data.json")
            if os.path.isfile(cand):
                return cand
    return None


def _load_tag_map():
    """别名 / id -> 提示词正文。按文件 mtime 缓存，改词库不用重启。"""
    path = _find_tag_data()
    if not path:
        return {}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return _TAG_CACHE["map"]
    if mtime == _TAG_CACHE["mtime"]:
        return _TAG_CACHE["map"]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return _TAG_CACHE["map"]

    mapping = {}
    for cat in data.get("categories", []) or []:
        for item in cat.get("prompts", []) or []:
            body = str(item.get("prompt") or "").strip()
            if not body:
                continue
            alias = str(item.get("alias") or "").strip()
            if alias:
                mapping[alias] = body
            pid = str(item.get("id") or "").strip()
            if pid:
                mapping[pid] = body

    _TAG_CACHE["mtime"] = mtime
    _TAG_CACHE["map"] = mapping
    return mapping


def expand_tags(text: str) -> str:
    """把 <tag:别名> 换成真实提示词。查不到就退化成裸词，别让尖括号跑进模型输入。"""
    if not text or "<tag:" not in text:
        return text
    mapping = _load_tag_map()
    if not mapping:
        return TAG_PATTERN.sub(lambda m: m.group(1).strip(), text)

    def _rep(m):
        key = m.group(1).strip()
        return mapping.get(key, key)

    return TAG_PATTERN.sub(_rep, text)


class PromptForge:
    CATEGORY = "PromptForge"
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", "STRING", "INT", "INT", "STRING", "MODEL", "CLIP")
    RETURN_NAMES = ("layout_json", "caption", "width", "height", "lora_stack", "model", "clip")
    OUTPUT_TOOLTIPS = (
        "MOSS 官方 layout JSON（含 summary.caption / items / bbox_format=yxyx）",
        "纯文本描述（summary 与各区域描述拼接，不含坐标）",
        "对齐后的画布宽度",
        "对齐后的画布高度",
        "已应用的 LoRA 列表（name:model:clip 每行一条）",
        "应用 LoRA 后的 MODEL",
        "应用 LoRA 后的 CLIP",
    )
    DESCRIPTION = (
        "全能提示词工坊：可视化画 bbox、逐区域写提示词、保存/加载预设、内置多 LoRA 加载，"
        "一键输出 MOSS-Image 官方 layout JSON。"
    )

    def __init__(self):
        self._lora_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 8192, "step": 16}),
                "align16": ("BOOLEAN", {"default": True, "label_on": "尺寸对齐16", "label_off": "自由尺寸"}),
                "output_mode": (
                    ["layout", "layout_pretty", "caption_only"],
                    {"default": "layout", "tooltip": "layout=紧凑JSON（喂给 MOSS） / pretty=缩进美化 / caption_only=纯文本"},
                ),
                # 注意：这里必须是单行 STRING。multiline 的 STRING 在新版前端会被渲染成
                # 真 DOM textarea 浮层，canvas 的 draw 重写盖不住它，会露在节点上。
                "forge_data": ("STRING", {"default": json.dumps(DEFAULT_STATE, ensure_ascii=False)}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "可选。接入后会应用下方 LoRA 列表"}),
                "clip": ("CLIP", {"tooltip": "可选。接入后会应用下方 LoRA 列表"}),
                "extra_caption": ("STRING", {"default": "", "multiline": False, "tooltip": "可选：追加到 summary.caption 后面的补充描述"}),
            },
        }

    # ---------------- LoRA ----------------

    def _load_lora(self, lora_name: str):
        path = folder_paths.get_full_path("loras", lora_name)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"[PromptForge] 找不到 LoRA：{lora_name}")
        cached = self._lora_cache.get(path)
        if cached is not None:
            return cached
        lora, meta = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
        self._lora_cache[path] = (lora, meta)
        return lora, meta

    def _apply_loras(self, model, clip, loras):
        applied = []
        if comfy is None:
            return model, clip, applied
        for lo in loras:
            if not lo.get("enabled", True) or not lo.get("name"):
                continue
            sm, sc = lo.get("strength_model", 1.0), lo.get("strength_clip", 1.0)
            if sm == 0 and sc == 0:
                applied.append(f"{lo['name']}:{sm}:{sc}")
                continue
            if model is None and clip is None:
                raise ValueError(
                    "[PromptForge] 列表里有 LoRA，但 MODEL/CLIP 都没接。"
                    "要么把模型接进来，要么把 LoRA 行删掉。"
                )
            lora, meta = self._load_lora(lo["name"])
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, sm, sc, lora_metadata=meta)
            applied.append(f"{lo['name']}:{sm}:{sc}")
        return model, clip, applied

    # ---------------- 组装 ----------------

    def build(self, width, height, align16, output_mode, forge_data,
              model=None, clip=None, extra_caption=""):
        w = _align(width, align16)
        h = _align(height, align16)

        state = parse_state(forge_data)
        summary = state["summary"]
        items_raw = state["items"]

        caption = summary["caption"].strip()
        extra = (extra_caption or "").strip()
        if extra:
            caption = f"{caption}, {extra}" if caption else extra
        caption = expand_tags(caption)

        # meta 支持 "poster, 复古" 这种逗号串
        meta_raw = summary.get("meta", "")
        if isinstance(meta_raw, str):
            meta = [m.strip() for m in re.split(r"[,，]", meta_raw) if m.strip()]
        elif isinstance(meta_raw, (list, tuple)):
            meta = [str(m).strip() for m in meta_raw if str(m).strip()]
        else:
            meta = []

        items_out = []
        plain_parts = []
        for it in items_raw:
            item_caption = expand_tags(it["caption"])
            item_text = expand_tags(it["text"])
            entry = {"label": it["label"], "caption": item_caption}
            if it["label"] == "text" and item_text:
                entry["text"] = item_text
            entry["bbox"] = _central_bbox(it["bbox"], w, h)
            items_out.append(entry)

            tag = it["name"] or it["label"]
            desc = item_caption or item_text
            if desc:
                plain_parts.append(f"{tag}: {desc}")

        layout = {"summary": {}}
        if meta:
            layout["summary"]["meta"] = meta
        if summary.get("canvas"):
            layout["summary"]["canvas"] = summary["canvas"]
        layout["summary"]["caption"] = caption
        layout["items"] = items_out
        layout["bbox_coord_space"] = "abs_centralized"
        layout["bbox_format"] = "yxyx"

        if output_mode == "layout_pretty":
            layout_str = json.dumps(layout, ensure_ascii=False, indent=2)
        else:
            layout_str = json.dumps(layout, ensure_ascii=False, separators=(",", ":"))

        plain_caption = " | ".join([p for p in [caption] + plain_parts if p])

        if output_mode == "caption_only":
            layout_str = plain_caption

        model_out, clip_out, applied = self._apply_loras(model, clip, state["loras"])
        lora_stack = "\n".join(applied)

        return (layout_str, plain_caption, w, h, lora_stack, model_out, clip_out)


NODE_CLASS_MAPPINGS = {"PromptForge": PromptForge}
NODE_DISPLAY_NAME_MAPPINGS = {"PromptForge": "PromptForge 提示词工坊"}

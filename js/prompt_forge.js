/**
 * PromptForge — 前端面板
 *
 * 一个节点里塞下：等比画布（框选新建 / 拖动 / 8点缩放）、逐区域提示词、
 * LoRA 堆栈、预设保存加载、MOSS layout JSON 实时预览。
 *
 * 所有状态序列化进隐藏 widget `forge_data`，工作流存盘即保存。
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "PromptForge";
const PALETTE = ["#4ea1ff", "#ff7a90", "#5ad1a5", "#ffc857", "#b98bff", "#ff9f45", "#41d3d3", "#ff6fb5"];
const HANDLE_R = 7;
const MIN_PANEL = 340;   // 面板能被压到的最小高度（也决定节点最小高度）
const PANEL_DEFAULT = 660;

const uid = () => "r" + Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function rgba(hex, a) {
  let h = String(hex || "#4ea1ff").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(78,161,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// 从文本里撤掉一段已插入的词，连带处理相邻的逗号分隔符
function cutText(text, piece) {
  if (!text || !piece) return null;
  const i = text.indexOf(piece);
  if (i < 0) return null;
  let s = i;
  let e = i + piece.length;
  const after = text.slice(e);
  const before = text.slice(0, s);
  const mAfter = after.match(/^\s*[,，、]\s*/);
  const mBefore = before.match(/[,，、]\s*$/);
  if (mAfter) {
    e += mAfter[0].length;
  } else if (mBefore) {
    s -= mBefore[0].length;
  }
  return (text.slice(0, s) + text.slice(e)).trim();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function defaultState() {
  return {
    summary: { caption: "", meta: "poster", canvas: "single", chips: [] },
    items: [],
    loras: [],
    preset: "",
    // 词库弹层的记忆：上次的分类、位置、尺寸
    lib: { cat: "", x: null, y: null, w: 470, h: 440 },
  };
}

// chips 记录「这一格里插过哪些词条（哪几份）」，用于二次点击移除
function normChips(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const text = String(c.text || "");
    if (!text) continue;
    out.push({ id: String(c.id || ""), text });
  }
  return out;
}

function normalize(raw) {
  const st = defaultState();
  if (!raw || typeof raw !== "object") return st;
  const s = raw.summary || {};
  st.summary.caption = String(s.caption || "");
  st.summary.meta = typeof s.meta === "string" ? s.meta : "";
  st.summary.canvas = String(s.canvas || "single");
  st.summary.chips = normChips(s.chips);
  st.preset = String(raw.preset || "");
  if (raw.lib && typeof raw.lib === "object") {
    st.lib = {
      cat: String(raw.lib.cat || ""),
      x: Number.isFinite(raw.lib.x) ? raw.lib.x : null,
      y: Number.isFinite(raw.lib.y) ? raw.lib.y : null,
      w: Math.max(300, Number(raw.lib.w) || 470),
      h: Math.max(260, Number(raw.lib.h) || 440),
    };
  }
  (Array.isArray(raw.items) ? raw.items : []).forEach((it, i) => {
    const bb = Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map(Number) : [0, 0, 0, 0];
    st.items.push({
      id: it.id || uid(),
      label: it.label === "text" ? "text" : "object",
      name: String(it.name || ""),
      caption: String(it.caption || ""),
      text: String(it.text || ""),
      color: it.color || PALETTE[i % PALETTE.length],
      bbox: bb.map((v) => (Number.isFinite(v) ? v : 0)),
      chips: normChips(it.chips),
    });
  });
  (Array.isArray(raw.loras) ? raw.loras : []).forEach((lo) => {
    if (!lo || !lo.name) return;
    st.loras.push({
      name: String(lo.name),
      strength_model: Number(lo.strength_model ?? lo.sm ?? 1) || 0,
      strength_clip: Number(lo.strength_clip ?? lo.sc ?? 1) || 0,
      enabled: lo.enabled !== false,
    });
  });
  return st;
}

const STYLE_ID = "pf-style";
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.pf-root{display:flex;flex-direction:column;gap:5px;padding:6px 6px 6px 16px;box-sizing:border-box;
  background:var(--comfy-menu-bg,#202020);color:var(--input-text,#ddd);
  font:11px/1.35 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;
  border-radius:6px;overflow:hidden;
  /* 根部不吃鼠标：底部那 14px 要能穿透，否则用户抓不到节点右下角的缩放手柄 */
  pointer-events:none;}
.pf-root > *{pointer-events:auto;}
.pf-root *{box-sizing:border-box;}
.pf-toolbar{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;}
.pf-grow{flex:1;}
.pf-btn{background:#333;color:#ddd;border:1px solid #4a4a4a;border-radius:4px;
  padding:2px 7px;font-size:11px;cursor:pointer;white-space:nowrap;}
.pf-btn:hover{background:#414141;border-color:#5f5f5f;}
.pf-btn:active{background:#2a2a2a;}
.pf-btn.danger:hover{background:#5a2630;border-color:#a04350;}
.pf-sel{background:#2a2a2a;color:#ddd;border:1px solid #4a4a4a;border-radius:4px;
  padding:2px 4px;font-size:11px;max-width:130px;}
.pf-caption{width:100%;resize:none;height:44px;background:#2a2a2a;color:#ddd;
  border:1px solid #4a4a4a;border-radius:4px;padding:4px 6px;font-size:11px;
  font-family:inherit;outline:none;}
.pf-caption:focus{border-color:#4ea1ff;}
.pf-metarow{display:flex;gap:6px;align-items:center;}
.pf-metarow label{display:flex;gap:3px;align-items:center;color:#999;font-size:10px;}
.pf-metarow input{background:#2a2a2a;color:#ddd;border:1px solid #4a4a4a;border-radius:3px;
  padding:1px 4px;font-size:10px;width:62px;outline:none;}
.pf-metarow input.pf-extra{flex:1;min-width:80px;width:auto;max-width:220px;
  border-color:#3d3d3d;color:#c9c9c9;}
.pf-metarow input.pf-extra:focus{border-color:#4ea1ff;}
.pf-body{display:flex;gap:5px;flex:1;min-height:0;}
.pf-root[data-json="1"] .pf-body{flex:0 1 380px;min-height:120px;}
.pf-canvas-wrap{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;
  background:#0d0d0d;border:1px solid #3a3a3a;border-radius:5px;overflow:hidden;padding:4px;}
.pf-canvas{display:block;cursor:crosshair;touch-action:none;max-width:100%;max-height:100%;margin:auto;}
.pf-list{width:286px;flex:none;overflow-y:auto;display:flex;flex-direction:column;gap:4px;
  padding-right:2px;}
.pf-list::-webkit-scrollbar{width:7px;}
.pf-list::-webkit-scrollbar-thumb{background:#4a4a4a;border-radius:4px;}
.pf-item{border:1px solid #3d3d3d;border-radius:5px;padding:4px;background:#262626;
  display:flex;flex-direction:column;gap:3px;}
.pf-item.sel{border-color:#4ea1ff;background:#2b3442;}
.pf-item-head{display:flex;gap:4px;align-items:center;}
.pf-dot{width:9px;height:9px;border-radius:2px;flex:none;display:inline-block;}
.pf-item-head select{background:#1f1f1f;color:#ccc;border:1px solid #454545;border-radius:3px;
  font-size:10px;padding:1px 2px;outline:none;}
.pf-item-head input.pf-name{flex:1;min-width:0;background:#1f1f1f;color:#ddd;
  border:1px solid #454545;border-radius:3px;font-size:10px;padding:1px 4px;outline:none;}
.pf-idx{color:#5f5f5f;font-size:9px;}
.pf-del{background:transparent;border:none;color:#888;cursor:pointer;font-size:14px;
  line-height:1;padding:0 2px;}
.pf-del:hover{color:#ff6b6b;}
.pf-item textarea{background:#1f1f1f;color:#ddd;border:1px solid #454545;border-radius:3px;
  font-size:10px;padding:3px 4px;resize:none;height:46px;font-family:inherit;outline:none;
  width:100%;}
.pf-item textarea:focus{border-color:#4ea1ff;}
.pf-item input.pf-textin{background:#1f1f1f;color:#ffd479;border:1px solid #454545;
  border-radius:3px;font-size:10px;padding:1px 4px;width:100%;outline:none;}
.pf-nums{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:3px;}
.pf-nums label{display:flex;align-items:center;gap:2px;color:#777;font-size:9px;}
.pf-nums input{width:100%;min-width:0;background:#1a1a1a;color:#bbb;border:1px solid #3d3d3d;
  border-radius:3px;font-size:9px;padding:0 2px;outline:none;-moz-appearance:textfield;}
.pf-nums input::-webkit-outer-spin-button,.pf-nums input::-webkit-inner-spin-button{
  -webkit-appearance:none;margin:0;}
.pf-lora-box{border-top:1px solid #3a3a3a;padding-top:4px;display:flex;flex-direction:column;gap:3px;}
.pf-lora-head{display:flex;align-items:center;gap:6px;color:#888;font-size:10px;}
.pf-lora-list{display:flex;flex-direction:column;gap:3px;max-height:74px;overflow-y:auto;}
.pf-lora-row{display:flex;gap:3px;align-items:center;}
.pf-lora-row select{flex:1;min-width:0;background:#1f1f1f;color:#ccc;border:1px solid #454545;
  border-radius:3px;font-size:10px;padding:1px 2px;outline:none;}
.pf-lora-row input[type=number]{width:48px;background:#1a1a1a;color:#bbb;border:1px solid #3d3d3d;
  border-radius:3px;font-size:10px;padding:0 2px;outline:none;}
.pf-json{border-top:1px solid #3a3a3a;padding-top:3px;flex:none;min-height:0;}
.pf-json-sum{cursor:pointer;color:#888;font-size:10px;user-select:none;padding:1px 0;line-height:16px;}
.pf-json-sum:hover{color:#c0c0c0;}
.pf-json-sum::before{content:"▸";font-size:9px;margin-right:4px;}
.pf-root[data-json="1"] .pf-json-sum::before{content:"▾";}
.pf-root[data-json="1"] .pf-json{flex:1;display:flex;flex-direction:column;min-height:90px;}
.pf-root[data-json="1"] .pf-json-pre{flex:1;max-height:none;min-height:0;margin:3px 0 0;}

.pf-json pre{margin:3px 0 0;max-height:110px;overflow:auto;background:#141414;color:#9ecbff;
  padding:4px;border-radius:4px;font:10px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;
  word-break:break-all;}
.pf-lib{background:#2c3a4a;color:#8fc2ff;border:1px solid #3f5a77;border-radius:3px;
  font-size:10px;line-height:15px;padding:0 3px;cursor:pointer;flex:none;}
.pf-lib:hover{background:#3a4d63;color:#d6e8ff;}
.pf-lib-pop{position:fixed;z-index:99999;min-width:320px;min-height:280px;background:#1b1b1b;
  border:1px solid #4a4a4a;border-radius:7px;box-shadow:0 14px 40px rgba(0,0,0,.65);
  display:flex;flex-direction:column;
  font:11px/1.35 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;color:#ddd;overflow:hidden;}
.pf-lib-pop *{box-sizing:border-box;}
.pf-lib-title{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#262626;
  border-bottom:1px solid #3a3a3a;cursor:move;user-select:none;flex:none;}
.pf-lib-titletext{color:#cfcfcf;font-size:11px;font-weight:600;}
.pf-lib-target{color:#7d9bb8;font-size:10px;border:1px solid #3a4a5a;border-radius:3px;padding:0 4px;
  max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pf-lib-close{background:transparent;border:none;color:#999;font-size:15px;line-height:1;
  cursor:pointer;padding:0 2px;}
.pf-lib-close:hover{color:#ff6b6b;}
.pf-lib-view{flex:1;min-height:0;display:flex;flex-direction:column;}
.pf-lib-head{display:flex;gap:4px;padding:6px;border-bottom:1px solid #333;align-items:center;flex:none;}
.pf-lib-search{flex:1;min-width:0;background:#262626;color:#ddd;border:1px solid #4a4a4a;
  border-radius:4px;padding:3px 6px;font-size:11px;outline:none;}
.pf-lib-search:focus{border-color:#4ea1ff;}
.pf-lib-cat{background:#262626;color:#ccc;border:1px solid #4a4a4a;border-radius:4px;
  font-size:11px;padding:2px 3px;outline:none;flex:0 0 150px;width:150px;min-width:0;}
.pf-lib-refresh,.pf-lib-addbtn{background:#333;color:#bbb;border:1px solid #4a4a4a;border-radius:4px;
  cursor:pointer;padding:2px 6px;font-size:12px;line-height:1;flex:none;}
.pf-lib-refresh:hover,.pf-lib-addbtn:hover{background:#414141;color:#fff;}
.pf-lib-addbtn{color:#8fd0a0;border-color:#3f6a4d;}
.pf-lib-addbtn:hover{background:#2e5b3a;color:#d8ffe4;}
.pf-lib-list{flex:1;min-height:0;overflow-y:auto;padding:4px;}
.pf-lib-list::-webkit-scrollbar{width:8px;}
.pf-lib-list::-webkit-scrollbar-thumb{background:#4a4a4a;border-radius:4px;}
.pf-lib-item{display:flex;gap:6px;align-items:center;padding:4px 5px;border-radius:4px;
  cursor:pointer;border:1px solid transparent;}
.pf-lib-item:hover{background:#2b3442;border-color:#3f5a77;}
.pf-lib-item.on{background:#22331f;border-color:#3f6a4d;}
.pf-lib-item.on:hover{background:#2a3f26;}
.pf-lib-thumb{width:38px;height:38px;flex:none;border-radius:3px;object-fit:cover;
  background:#111;border:1px solid #3a3a3a;cursor:zoom-in;}
.pf-lib-thumb--none{display:block;background:#242424;border:1px dashed #3a3a3a;cursor:default;}
.pf-lib-main{flex:1;min-width:0;}
.pf-lib-alias{color:#e6e6e6;font-size:11px;display:flex;gap:5px;align-items:center;}
.pf-lib-star{color:#ffc857;font-size:9px;}
.pf-lib-tag{color:#6f6f6f;font-size:9px;border:1px solid #3a3a3a;border-radius:3px;padding:0 3px;
  flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pf-lib-prompt{color:#8a8a8a;font-size:10px;margin-top:1px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.pf-lib-check{flex:none;width:22px;text-align:center;color:#6fd08a;font-size:11px;}
.pf-lib-foot{display:flex;align-items:center;gap:6px;padding:5px 6px;border-top:1px solid #333;
  color:#777;font-size:10px;flex:none;}
.pf-lib-hint{color:#5f5f5f;}
.pf-lib-empty{color:#666;font-size:10px;text-align:center;padding:24px 8px;}
.pf-lib-form{flex:1;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:7px;}
.pf-lib-form label{display:flex;flex-direction:column;gap:3px;color:#9a9a9a;font-size:10px;}
.pf-lib-form input,.pf-lib-form textarea{background:#262626;color:#ddd;border:1px solid #4a4a4a;
  border-radius:4px;padding:4px 6px;font-size:11px;outline:none;font-family:inherit;}
.pf-lib-form input:focus,.pf-lib-form textarea:focus{border-color:#4ea1ff;}
.pf-lib-form textarea{resize:vertical;min-height:90px;line-height:1.4;}
.pf-new-imgrow{display:flex;gap:8px;align-items:flex-start;}
.pf-new-imglabel{flex:none;color:#9a9a9a;font-size:10px;}
.pf-new-imglabel input[type=file]{border:none;padding:0;font-size:10px;color:#888;max-width:150px;}
.pf-new-thumb{max-width:74px;max-height:74px;border-radius:3px;border:1px solid #3a3a3a;object-fit:cover;}
.pf-lib-formfoot{display:flex;align-items:center;gap:6px;padding:6px;border-top:1px solid #333;flex:none;}
.pf-new-msg{color:#e0a050;font-size:10px;max-width:220px;}
.pf-new-cancel,.pf-new-save{background:#333;color:#ccc;border:1px solid #4a4a4a;border-radius:4px;
  padding:3px 10px;font-size:11px;cursor:pointer;}
.pf-new-cancel:hover{background:#414141;}
.pf-new-save{background:#2e5b3a;border-color:#4c9a63;color:#dcffe6;}
.pf-new-save:hover{background:#37704a;}
.pf-new-save:disabled{opacity:.5;cursor:default;}
.pf-lib-edit{flex:none;width:18px;background:transparent;border:none;color:#7f8fa0;
  cursor:pointer;font-size:11px;padding:0;opacity:0;transition:opacity .12s;}
.pf-lib-item:hover .pf-lib-edit{opacity:1;}
.pf-lib-edit:hover{color:#8fd0ff;}
.pf-form-tip{color:#7d9bb8;font-size:10px;line-height:1.5;background:#1e2833;
  border:1px solid #2f4052;border-radius:4px;padding:4px 7px;}
.pf-form-tip:empty{display:none;}
.pf-new-imgclear{background:#3a2a2a;color:#e0a0a0;border:1px solid #5a3a3a;border-radius:4px;
  font-size:10px;padding:2px 8px;cursor:pointer;flex:none;align-self:center;}
.pf-new-imgclear:hover{background:#5a2a2a;color:#ffd0d0;}

.pf-lib-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 48%,#5a5a5a 48%,#5a5a5a 62%,transparent 62%);}
.pf-hover{position:fixed;z-index:100001;pointer-events:none;max-width:360px;
  background:#141414;border:1px solid #4a4a4a;border-radius:7px;overflow:hidden;
  box-shadow:0 12px 36px rgba(0,0,0,.75);
  font:11px/1.4 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;color:#ddd;}
.pf-hover-img{display:block;margin:0 auto;max-width:360px;max-height:250px;
  background:#0b0b0b;object-fit:contain;}
.pf-hover-body{padding:6px 9px 8px;}
.pf-hover-alias{color:#f0f0f0;font-size:11.5px;display:flex;gap:5px;align-items:center;
  flex-wrap:wrap;margin-bottom:3px;}
.pf-hover-cat{color:#7fa3c4;font-size:9px;border:1px solid #37475a;border-radius:3px;padding:0 3px;}
.pf-hover-text{color:#bdbdbd;font-size:10.5px;line-height:1.5;white-space:pre-wrap;
  word-break:break-word;max-height:280px;overflow:hidden;}
.pf-reserve{flex:none;height:22px;pointer-events:none;}
.pf-lightbox{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);display:flex;
  flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:zoom-out;}
.pf-lightbox img{max-width:88vw;max-height:84vh;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.8);}
.pf-lightbox-cap{color:#ddd;font-size:12px;}
.pf-empty{color:#5a5a5a;font-size:10px;text-align:center;padding:14px 0;}
`;
  document.head.appendChild(el);
}

class ForgeUI {
  constructor(node) {
    injectStyle();
    this.node = node;
    this.state = defaultState();
    this.sel = null;
    this.drag = null;
    this.disp = null;
    this.lorasAll = [];
    this.presets = [];
    this.canvas = null;

    this.dataWidget = node.widgets?.find((w) => w.name === "forge_data");
    this.wWidget = node.widgets?.find((w) => w.name === "width");
    this.hWidget = node.widgets?.find((w) => w.name === "height");

    if (this.dataWidget) {
      this.dataWidget.computeSize = () => [0, -4];
      this.dataWidget.draw = () => {};
      this.dataWidget.type = "hidden";
    }

    // extra_caption 本来是给「连线补充」留的口子，摆在节点上又丑又占地方，
    // 直接藏掉，改由面板底部那行输入框代理。
    this.extraWidget = node.widgets?.find((w) => w.name === "extra_caption");
    if (this.extraWidget) {
      this.extraWidget.computeSize = () => [0, -4];
      this.extraWidget.draw = () => {};
      this.extraWidget.type = "hidden";
    }

    this.build();
    this.wireWidgets();
    this.reloadFromWidget();
    this.fetchLoras();
    this.fetchPresets();
  }

  /* ---------------- DOM ---------------- */

  build() {
    const root = document.createElement("div");
    root.className = "pf-root";
    root.innerHTML = `
      <div class="pf-toolbar">
        <select class="pf-sel pf-preset"><option value="">— 预设 —</option></select>
        <button class="pf-btn" data-act="save">保存</button>
        <button class="pf-btn" data-act="saveas">另存</button>
        <button class="pf-btn danger" data-act="delpreset">删除</button>
        <span class="pf-grow"></span>
        <button class="pf-btn" data-act="add">＋ 区域</button>
      </div>
      <textarea class="pf-caption pf-summary" placeholder="整图描述 summary.caption —— 画面是什么、什么风格"></textarea>
      <div class="pf-metarow">
        <label>meta<input class="pf-meta" placeholder="poster"></label>
        <label>canvas<input class="pf-canvasname" value="single"></label>
        <span class="pf-grow"></span>
        <input class="pf-extra" placeholder="补充描述（可选，接到 extra_caption）">
        <button class="pf-lib pf-lib-summary" title="从词库插入到整图描述">词</button>
        <button class="pf-btn" data-act="clear" title="清空所有区域">清空</button>
      </div>
      <div class="pf-body">
        <div class="pf-canvas-wrap"><canvas class="pf-canvas"></canvas></div>
        <div class="pf-list"></div>
      </div>
      <div class="pf-lora-box">
        <div class="pf-lora-head"><span>LoRA 堆栈</span><button class="pf-btn" data-act="addlora">＋</button>
          <span class="pf-grow"></span><span class="pf-lora-hint" style="color:#5a5a5a;"></span></div>
        <div class="pf-lora-list"></div>
      </div>
      <div class="pf-json">
        <div class="pf-json-sum">MOSS layout JSON 预览</div>
        <pre class="pf-json-pre" style="display:none"></pre>
      </div>
      <div class="pf-reserve"></div>
    `;
    this.root = root;
    this.el = {
      preset: root.querySelector(".pf-preset"),
      summary: root.querySelector(".pf-summary"),
      meta: root.querySelector(".pf-meta"),
      canvasName: root.querySelector(".pf-canvasname"),
      extra: root.querySelector(".pf-extra"),
      body: root.querySelector(".pf-body"),
      canvasWrap: root.querySelector(".pf-canvas-wrap"),
      list: root.querySelector(".pf-list"),
      loraList: root.querySelector(".pf-lora-list"),
      loraHint: root.querySelector(".pf-lora-hint"),
      jsonPre: root.querySelector(".pf-json-pre"),
    };
    this.canvas = root.querySelector(".pf-canvas");

    const PANEL_H = 660;
    this._panelH = PANEL_H;
    this._offset = 0;
    root.style.height = PANEL_H + "px";
    root.dataset.json = "0";

    const widget = this.node.addDOMWidget("pf_ui", "div", root, {
      serialize: false,
      hideOnZoom: false,
    });
    // ⚠️ 这里必须返回一个「固定最小值」，不能返回当前面板高度。
    // LiteGraph 缩节点时会拿 computeSize 做 Math.max 下限，返回当前高度就等于「只能放大不能缩小」。
    // 容器本身 overflow:visible，面板实际高度靠 root.style.height 撑出去，不受这个值限制。
    widget.computeSize = () => [this.node.size?.[0] || 620, MIN_PANEL];
    this.uiWidget = widget;

    // JSON 预览展开/收起时，剩余空间在两块之间换手
    this.jsonOpen = false;
    root.querySelector(".pf-json-sum").addEventListener("click", () => {
      this.jsonOpen = !this.jsonOpen;
      root.dataset.json = this.jsonOpen ? "1" : "0";
      this.el.jsonPre.style.display = this.jsonOpen ? "block" : "none";
      requestAnimationFrame(() => this.resizeCanvas());
      // 布局落定后再算：只靠 rAF 有时拿到的还是切换前的尺寸
      setTimeout(() => this.resizeCanvas(), 60);
      setTimeout(() => this.resizeCanvas(), 220);
    });

    // ComfyUI 给 DOM widget 套的容器默认吃鼠标，节点右下角的缩放手柄就抓不到了。
    // 挂载是异步的，得等 DOM 真正插进去再把包装层的指针事件关掉（只关本节点这几层）。
    setTimeout(() => {
      let el = this.root.parentElement;
      let depth = 0;
      while (el && depth < 3) {
        if (el.classList && (el.classList.contains("graph-canvas-container") || el.classList.contains("litegraph"))) break;
        el.style.pointerEvents = "none";
        el = el.parentElement;
        depth += 1;
      }
    }, 150);

    this.node.setSize?.([Math.max(this.node.size?.[0] ?? 0, 620), Math.max(this.node.size?.[1] ?? 0, 740)]);
    setTimeout(() => this.calibratePanel(), 90);
  }

  // 量一次「节点总高 - 面板高」，这个差值（标题栏 + 顶部几个 widget + 输出槽）之后是常数。
  // 拿到它，才能把用户拖出来的额外高度准确地还给面板，而不会和 LiteGraph 互相喂饭。
  calibratePanel() {
    const cs = this.node.computeSize?.();
    const minTotal = Array.isArray(cs) ? cs[1] : 0;
    // computeSize 现在固定是 MIN_PANEL，减去它就是「标题 + 顶部控件 + 输出槽」的固定占用
    this._offset = minTotal > MIN_PANEL + 40 ? minTotal - MIN_PANEL : 130;

    const wantH = PANEL_DEFAULT;
    this._panelH = wantH;
    this.root.style.height = wantH + "px";
    this.node.setSize?.([this.node.size?.[0] ?? 620, wantH + this._offset]);
    requestAnimationFrame(() => this.resizeCanvas());
  }

  applyPanelHeight() {
    const total = this.node.size?.[1] ?? 0;
    if (!this._offset) return;
    const h = clamp(total - this._offset, MIN_PANEL, 3000);
    if (Math.abs(h - this._panelH) < 2) return;
    this._panelH = h;
    this.root.style.height = h + "px";
    requestAnimationFrame(() => this.resizeCanvas());
    setTimeout(() => this.resizeCanvas(), 60);
  }

  wireWidgets() {
    const r = this.root;

    r.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "add") this.addItem();
      else if (act === "addlora") this.addLora();
      else if (act === "save") this.savePreset(false);
      else if (act === "saveas") this.savePreset(true);
      else if (act === "delpreset") this.deletePreset();
      else if (act === "clear") this.clearAll();
    });

    this.el.preset.addEventListener("change", () => {
      const name = this.el.preset.value;
      if (name) this.loadPreset(name);
    });

    this.el.summary.addEventListener("input", () => {
      this.state.summary.caption = this.el.summary.value;
      this.sync();
    });
    this.el.meta.addEventListener("input", () => {
      this.state.summary.meta = this.el.meta.value;
      this.sync();
    });
    this.el.canvasName.addEventListener("input", () => {
      this.state.summary.canvas = this.el.canvasName.value;
      this.sync();
    });
    this.el.extra.addEventListener("input", () => {
      if (this.extraWidget) this.extraWidget.value = this.el.extra.value;
    });
    this.el.summaryLib = this.root.querySelector(".pf-lib-summary");
    this.el.summaryLib.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openLibrary(e.currentTarget, this.el.summary, null);
    });

    // 画布事件
    const cv = this.canvas;
    cv.addEventListener("pointerdown", (e) => this.onDown(e));
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    cv.addEventListener("pointerup", (e) => this.onUp(e));
    cv.addEventListener("pointercancel", (e) => this.onUp(e));
    cv.addEventListener("dblclick", (e) => {
      const p = this.toImg(this.eventPos(e));
      const hit = this.hitScreen(this.eventPos(e));
      if (!hit) this.addItem(p);
    });

    this.ro = new ResizeObserver(() => this.resizeCanvas());
    this.ro.observe(this.el.canvasWrap);
  }

  wireGraphWidgets() {
    ["width", "height"].forEach((n) => {
      const w = this.node.widgets?.find((x) => x.name === n);
      if (!w || w.__pfWrapped) return;
      const orig = w.callback;
      w.callback = (...args) => {
        const r = orig?.apply(w, args);
        this.resizeCanvas();
        return r;
      };
      w.__pfWrapped = true;
    });
  }

  /* ---------------- 数据 ---------------- */

  getW() {
    return Math.max(16, Math.round(this.wWidget?.value || 1024));
  }

  getH() {
    return Math.max(16, Math.round(this.hWidget?.value || 1024));
  }

  alignW() {
    const align = this.node.widgets?.find((w) => w.name === "align16");
    const on = align ? !!align.value : true;
    const a = (v) => (on ? Math.round(v / 16) * 16 : Math.round(v));
    return [Math.max(16, a(this.getW())), Math.max(16, a(this.getH()))];
  }

  reloadFromWidget() {
    let raw = {};
    try {
      raw = JSON.parse(this.dataWidget?.value || "{}");
    } catch {
      raw = {};
    }
    this.state = normalize(raw);
    this.sel = null;
    this.el.summary.value = this.state.summary.caption;
    this.el.meta.value = this.state.summary.meta;
    this.el.canvasName.value = this.state.summary.canvas;
    this.el.extra.value = this.extraWidget?.value || "";
    this.renderList();
    this.renderLoras();
    this.wireGraphWidgets();
    requestAnimationFrame(() => this.resizeCanvas());
    this.updatePreview();
  }

  sync() {
    if (this.dataWidget) this.dataWidget.value = JSON.stringify(this.state);
    this.updatePreview();
  }

  updatePreview() {
    if (!this.el.jsonPre) return;
    const layout = this.buildLayout();
    this.el.jsonPre.textContent = JSON.stringify(layout, null, 1);
  }

  buildLayout() {
    const [W, H] = this.alignW();
    const metaRaw = String(this.state.summary.meta || "");
    const meta = metaRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const items = this.state.items.map((it) => {
      const [x1, y1, x2, y2] = it.bbox;
      const ax1 = clamp(Math.min(x1, x2), 0, W);
      const ax2 = clamp(Math.max(x1, x2), 0, W);
      const ay1 = clamp(Math.min(y1, y2), 0, H);
      const ay2 = clamp(Math.max(y1, y2), 0, H);
      const o = { label: it.label, caption: it.caption };
      if (it.label === "text" && it.text) o.text = it.text;
      o.bbox = [
        Math.round(ay1 - H / 2),
        Math.round(ax1 - W / 2),
        Math.round(ay2 - H / 2),
        Math.round(ax2 - W / 2),
      ];
      return o;
    });
    const summary = {};
    if (meta.length) summary.meta = meta;
    if (this.state.summary.canvas) summary.canvas = this.state.summary.canvas;
    summary.caption = this.state.summary.caption;
    return { summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" };
  }

  /* ---------------- 区域列表 ---------------- */

  getSel() {
    return this.state.items.find((i) => i.id === this.sel) || null;
  }

  select(id) {
    this.sel = id;
    [...this.el.list.children].forEach((row) => {
      row.classList.toggle("sel", row.dataset.id === id);
    });
    const row = this.el.list.querySelector(`[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
    this.draw();
  }

  addItem(at) {
    const [W, H] = this.alignW();
    const base = at || { x: W * 0.3, y: H * 0.3 };
    const size = { w: W * 0.28, h: H * 0.28 };
    const item = {
      id: uid(),
      label: "object",
      name: "",
      caption: "",
      text: "",
      color: PALETTE[this.state.items.length % PALETTE.length],
      bbox: [
        Math.round(clamp(base.x - size.w / 2, 0, W - size.w)),
        Math.round(clamp(base.y - size.h / 2, 0, H - size.h)),
        Math.round(clamp(base.x + size.w / 2, size.w, W)),
        Math.round(clamp(base.y + size.h / 2, size.h, H)),
      ],
      chips: [],
    };
    this.state.items.push(item);
    this.sel = item.id;
    this.renderList();
    this.draw();
    this.sync();
  }

  removeItem(id) {
    this.state.items = this.state.items.filter((i) => i.id !== id);
    if (this.sel === id) this.sel = null;
    this.renderList();
    this.draw();
    this.sync();
  }

  clearAll() {
    if (!this.state.items.length) return;
    if (!confirm("清空画布上所有区域？")) return;
    this.state.items = [];
    this.sel = null;
    this.renderList();
    this.draw();
    this.sync();
  }

  renderList() {
    const box = this.el.list;
    box.innerHTML = "";
    if (!this.state.items.length) {
      const empty = document.createElement("div");
      empty.className = "pf-empty";
      empty.textContent = "画布上拖一个框，或在右上角点 ＋区域";
      box.appendChild(empty);
      return;
    }
    this.state.items.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "pf-item" + (it.id === this.sel ? " sel" : "");
      row.dataset.id = it.id;
      row.innerHTML = `
        <div class="pf-item-head">
          <span class="pf-dot" style="background:${it.color}"></span>
          <select class="pf-label">
            <option value="object">object</option>
            <option value="text">text</option>
          </select>
          <input class="pf-name" placeholder="区域名">
          <button class="pf-lib" title="从提示词词库插入">词</button>
          <button class="pf-del" title="删除">×</button>
        </div>
        <textarea placeholder="这块画什么（caption）"></textarea>
        <input class="pf-textin" placeholder="渲染文字（label=text 生效）">
        <div class="pf-nums">
          <label>x<input type="number" data-k="0"></label>
          <label>y<input type="number" data-k="1"></label>
          <label>w<input type="number" data-k="2"></label>
          <label>h<input type="number" data-k="3"></label>
        </div>
      `;
      const sel = row.querySelector(".pf-label");
      sel.value = it.label;
      row.querySelector(".pf-name").value = it.name;
      row.querySelector("textarea").value = it.caption;
      row.querySelector(".pf-textin").value = it.text;
      row.dataset.color = it.color;

      sel.addEventListener("change", () => {
        it.label = sel.value;
        this.sync();
      });
      row.querySelector(".pf-name").addEventListener("input", (e) => {
        it.name = e.target.value;
        this.sync();
      });
      row.querySelector("textarea").addEventListener("input", (e) => {
        it.caption = e.target.value;
        this.sync();
      });
      row.querySelector(".pf-textin").addEventListener("input", (e) => {
        it.text = e.target.value;
        this.sync();
      });
      row.querySelector(".pf-del").addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeItem(it.id);
      });
      row.querySelector(".pf-lib").addEventListener("click", (e) => {
        e.stopPropagation();
        this.openLibrary(e.currentTarget, row.querySelector("textarea"), it);
      });
      row.addEventListener("pointerdown", () => this.select(it.id));

      row.querySelectorAll(".pf-nums input").forEach((inp) => {
        inp.addEventListener("input", () => {
          const [x1, y1, x2, y2] = it.bbox;
          const w = Math.abs(x2 - x1);
          const h = Math.abs(y2 - y1);
          const baseX = Math.min(x1, x2);
          const baseY = Math.min(y1, y2);
          const v = Number(inp.value) || 0;
          const k = inp.dataset.k;
          if (k === "0") it.bbox = [v, baseY, v + w, baseY + h];
          else if (k === "1") it.bbox = [baseX, v, baseX + w, v + h];
          else if (k === "2") it.bbox = [baseX, baseY, baseX + Math.max(2, v), baseY + h];
          else it.bbox = [baseX, baseY, baseX + w, baseY + Math.max(2, v)];
          this.sync();
          this.draw();
        });
      });

      box.appendChild(row);
      this.fillNumbers(row, it);
    });
  }

  fillNumbers(row, it) {
    const [x1, y1, x2, y2] = it.bbox;
    const vals = [
      Math.round(Math.min(x1, x2)),
      Math.round(Math.min(y1, y2)),
      Math.round(Math.abs(x2 - x1)),
      Math.round(Math.abs(y2 - y1)),
    ];
    row.querySelectorAll(".pf-nums input").forEach((inp, i) => {
      if (document.activeElement === inp) return;
      inp.value = vals[i];
    });
  }

  syncNumbers() {
    for (const it of this.state.items) {
      const row = this.el.list.querySelector(`[data-id="${it.id}"]`);
      if (row) this.fillNumbers(row, it);
    }
  }

  /* ---------------- LoRA ---------------- */

  async fetchLoras() {
    try {
      const res = await api.fetchApi("/prompt_forge/loras");
      const j = await res.json();
      this.lorasAll = j.loras || [];
    } catch {
      this.lorasAll = [];
    }
    this.renderLoras();
    this.el.loraHint.textContent = this.lorasAll.length ? `${this.lorasAll.length} 个可用` : "没找到 LoRA";
  }

  addLora() {
    this.state.loras.push({ name: "", strength_model: 1.0, strength_clip: 1.0, enabled: true });
    this.renderLoras();
    this.sync();
  }

  renderLoras() {
    const box = this.el.loraList;
    box.innerHTML = "";
    if (!this.state.loras.length) {
      const d = document.createElement("div");
      d.className = "pf-empty";
      d.style.padding = "4px 0";
      d.textContent = "未加载 LoRA（可选，接了 MODEL/CLIP 才生效）";
      box.appendChild(d);
      return;
    }
    this.state.loras.forEach((lo, idx) => {
      const row = document.createElement("div");
      row.className = "pf-lora-row";
      const opts = ['<option value="">— 选择 LoRA —</option>']
        .concat(this.lorasAll.map((n) => `<option value="${n}">${n}</option>`))
        .join("");
      row.innerHTML = `
        <input type="checkbox" ${lo.enabled ? "checked" : ""} title="启用">
        <select>${opts}</select>
        <input type="number" step="0.05" value="${lo.strength_model}" title="model 强度">
        <input type="number" step="0.05" value="${lo.strength_clip}" title="clip 强度">
        <button class="pf-del" title="移除">×</button>
      `;
      const cb = row.querySelector("input[type=checkbox]");
      const se = row.querySelector("select");
      const [mIn, cIn] = row.querySelectorAll("input[type=number]");
      se.value = lo.name;
      se.addEventListener("change", () => {
        lo.name = se.value;
        this.sync();
      });
      cb.addEventListener("change", () => {
        lo.enabled = cb.checked;
        this.sync();
      });
      mIn.addEventListener("input", () => {
        lo.strength_model = Number(mIn.value) || 0;
        this.sync();
      });
      cIn.addEventListener("input", () => {
        lo.strength_clip = Number(cIn.value) || 0;
        this.sync();
      });
      row.querySelector(".pf-del").addEventListener("click", () => {
        this.state.loras.splice(idx, 1);
        this.renderLoras();
        this.sync();
      });
      box.appendChild(row);
    });
  }

  /* ---------------- 词库（直接读写 Danbooru-Gallery 的 PromptSelector） ---------------- */

  async loadLibrary(force) {
    if (this.libData && !force) return this.libData;
    const res = await api.fetchApi("/prompt_selector/data");
    if (!res.ok) {
      throw new Error("拿不到词库：没装 ComfyUI-Danbooru-Gallery，或它的接口没起来");
    }
    let d;
    try {
      d = await res.json();
    } catch {
      throw new Error("词库接口返回的不是 JSON —— Danbooru-Gallery 在位但接口没注册成功");
    }
    const cats = Array.isArray(d.categories) ? d.categories : [];
    this.libData = cats.map((c) => ({
      name: String(c.name || ""),
      prompts: Array.isArray(c.prompts) ? c.prompts : [],
    }));
    return this.libData;
  }

  async openLibrary(anchor, textarea, item) {
    if (this.libPop) {
      this.closeLibrary();
      return;
    }
    this.libTarget = textarea;
    this.libItem = item || null;
    this.libNewFile = null;

    const lib = this.state.lib;
    const pop = document.createElement("div");
    pop.className = "pf-lib-pop";
    pop.innerHTML = `
      <div class="pf-lib-title">
        <span class="pf-lib-titletext">提示词词库</span>
        <span class="pf-lib-target"></span>
        <span class="pf-grow"></span>
        <button class="pf-lib-close" title="关闭">×</button>
      </div>
      <div class="pf-lib-view pf-lib-view-list">
        <div class="pf-lib-head">
          <input class="pf-lib-search" placeholder="搜别名或内容…">
          <select class="pf-lib-cat"></select>
          <button class="pf-lib-refresh" title="重新拉取词库">↻</button>
          <button class="pf-lib-addbtn" title="新增词条">＋</button>
        </div>
        <div class="pf-lib-list"><div class="pf-lib-empty">加载词库…</div></div>
        <div class="pf-lib-foot">
          <span class="pf-lib-count"></span>
          <span class="pf-grow"></span>
          <span class="pf-lib-hint">点一下插入，再点一下撤掉</span>
        </div>
      </div>
      <div class="pf-lib-view pf-lib-view-add" style="display:none">
        <div class="pf-lib-form">
          <div class="pf-form-tip"></div>
          <label>分类<input class="pf-new-cat" list="pf-catlist" placeholder="选已有分类，或直接输新的"></label>
          <datalist class="pf-catlist"></datalist>
          <label>别名<input class="pf-new-alias" placeholder="显示名，比如「厚涂风」"></label>
          <label>内容<textarea class="pf-new-prompt" placeholder="真正插进提示词的内容"></textarea></label>
          <div class="pf-new-imgrow">
            <label class="pf-new-imglabel">示意图<input type="file" class="pf-new-img" accept="image/*"></label>
            <img class="pf-new-thumb" style="display:none">
            <button class="pf-new-imgclear" style="display:none" title="移除示意图">清除</button>
          </div>
        </div>
        <div class="pf-lib-formfoot">
          <span class="pf-new-msg"></span>
          <span class="pf-grow"></span>
          <button class="pf-new-cancel">取消</button>
          <button class="pf-new-save">存进词库</button>
        </div>
      </div>
      <div class="pf-lib-resize" title="拖动缩放"></div>
    `;
    document.body.appendChild(pop);
    this.libPop = pop;

    this.el.pop = pop;
    this.libList = pop.querySelector(".pf-lib-list");
    this.libCount = pop.querySelector(".pf-lib-count");
    this.libSearch = pop.querySelector(".pf-lib-search");
    this.libCatSel = pop.querySelector(".pf-lib-cat");
    this.libViewList = pop.querySelector(".pf-lib-view-list");
    this.libViewAdd = pop.querySelector(".pf-lib-view-add");

    pop.querySelector(".pf-lib-target").textContent = item
      ? item.name || item.caption.slice(0, 10) || "当前区域"
      : "整图描述";

    // 尺寸与位置：优先用上次记住的
    pop.style.width = lib.w + "px";
    pop.style.height = lib.h + "px";
    if (Number.isFinite(lib.x) && Number.isFinite(lib.y)) {
      pop.style.left = Math.min(Math.max(0, lib.x), Math.max(0, window.innerWidth - 120)) + "px";
      pop.style.top = Math.min(Math.max(0, lib.y), Math.max(0, window.innerHeight - 60)) + "px";
    } else {
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - lib.w - 12)) + "px";
      let top = r.bottom + 6;
      if (top + lib.h > window.innerHeight - 8) top = Math.max(8, r.top - lib.h - 6);
      pop.style.top = top + "px";
    }

    this.bindLibraryEvents(pop);
    this.bindDragResize(pop);

    try {
      await this.loadLibrary(false);
      if (!this.libPop) return;
      this.fillCategories();
      // 恢复上次打开的分类
      if (lib.cat && [...this.libCatSel.options].some((o) => o.value === lib.cat)) {
        this.libCatSel.value = lib.cat;
      }
      this.renderLibraryList();
    } catch (err) {
      if (!this.libPop) return;
      this.libList.innerHTML = `<div class="pf-lib-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  bindLibraryEvents(pop) {
    pop.querySelector(".pf-lib-close").addEventListener("click", () => this.closeLibrary());
    pop.querySelector(".pf-lib-refresh").addEventListener("click", async () => {
      this.libList.innerHTML = '<div class="pf-lib-empty">刷新中…</div>';
      try {
        await this.loadLibrary(true);
        this.fillCategories(true);
        this.renderLibraryList();
      } catch (err) {
        this.libList.innerHTML = `<div class="pf-lib-empty">${escapeHtml(err.message)}</div>`;
      }
    });
    pop.querySelector(".pf-lib-addbtn").addEventListener("click", () => this.showFormView("add", null));
    pop.querySelector(".pf-new-cancel").addEventListener("click", () => this.showListView());
    pop.querySelector(".pf-new-save").addEventListener("click", () => this.saveEntry());
    pop.querySelector(".pf-new-imgclear").addEventListener("click", () => {
      this.libNewFile = null;
      this.editingImage = "";
      pop.querySelector(".pf-new-thumb").style.display = "none";
      pop.querySelector(".pf-new-imgclear").style.display = "none";
      pop.querySelector(".pf-new-img").value = "";
    });
    pop.querySelector(".pf-new-img").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      this.libNewFile = f || null;
      const thumb = pop.querySelector(".pf-new-thumb");
      if (f) {
        thumb.src = URL.createObjectURL(f);
        thumb.style.display = "block";
        pop.querySelector(".pf-new-imgclear").style.display = "inline-block";
      } else {
        thumb.style.display = "none";
      }
    });

    this.libList.addEventListener("scroll", () => this.hideHoverCard());
    this.libSearch.addEventListener("input", () => this.renderLibraryList());
    this.libCatSel.addEventListener("change", () => {
      this.state.lib.cat = this.libCatSel.value;
      this.sync();
      this.renderLibraryList();
    });

    this._libOutside = (ev) => {
      if (this.libPop && !this.libPop.contains(ev.target)) this.closeLibrary();
    };
    setTimeout(() => document.addEventListener("mousedown", this._libOutside, true), 0);

    this._libEsc = (ev) => {
      if (ev.key === "Escape") {
        if (this.libViewAdd.style.display !== "none") this.showListView();
        else this.closeLibrary();
      }
    };
    document.addEventListener("keydown", this._libEsc, true);
  }

  bindDragResize(pop) {
    const save = () => {
      this.state.lib.x = pop.offsetLeft;
      this.state.lib.y = pop.offsetTop;
      this.state.lib.w = pop.offsetWidth;
      this.state.lib.h = pop.offsetHeight;
      this.sync();
    };

    const title = pop.querySelector(".pf-lib-title");
    title.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const ox = pop.offsetLeft;
      const oy = pop.offsetTop;
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev) => {
        pop.style.left = clamp(ox + ev.clientX - sx, -pop.offsetWidth + 90, window.innerWidth - 60) + "px";
        pop.style.top = clamp(oy + ev.clientY - sy, 0, window.innerHeight - 40) + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        save();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    const grip = pop.querySelector(".pf-lib-resize");
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const w0 = pop.offsetWidth;
      const h0 = pop.offsetHeight;
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev) => {
        pop.style.width = clamp(w0 + ev.clientX - sx, 320, window.innerWidth - 20) + "px";
        pop.style.height = clamp(h0 + ev.clientY - sy, 280, window.innerHeight - 20) + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        save();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  closeLibrary() {
    clearTimeout(this._hoverTimer);
    this.hideHoverCard();
    if (this._libOutside) document.removeEventListener("mousedown", this._libOutside, true);
    if (this._libEsc) document.removeEventListener("keydown", this._libEsc, true);
    this._libOutside = null;
    this._libEsc = null;
    this.libPop?.remove();
    this.libPop = null;
    this.libTarget = null;
    this.libItem = null;
    this.libNewFile = null;
  }

  fillCategories(keep) {
    if (!this.libPop) return;
    const cur = this.libCatSel.value;
    const opts = ['<option value="">全部分类</option>'].concat(
      this.libData
        .filter((c) => c.prompts.length)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "zh"))
        .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.prompts.length})</option>`)
    );
    this.libCatSel.innerHTML = opts.join("");
    if (cur && [...this.libCatSel.options].some((o) => o.value === cur)) this.libCatSel.value = cur;

    const dl = this.libPop.querySelector(".pf-catlist");
    dl.innerHTML = this.libData
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "zh"))
      .map((c) => `<option value="${escapeHtml(c.name)}">`)
      .join("");
  }

  currentChips() {
    const holder = this.libItem || this.state.summary;
    if (!holder.chips) holder.chips = [];
    return holder.chips;
  }

  renderLibraryList() {
    if (!this.libPop || !this.libData) return;
    const q = (this.libSearch.value || "").trim().toLowerCase();
    const cat = this.libCatSel.value;
    const rows = [];
    for (const c of this.libData) {
      if (cat && c.name !== cat) continue;
      for (const p of c.prompts) {
        const alias = String(p.alias || "");
        const body = String(p.prompt || "");
        if (q && !alias.toLowerCase().includes(q) && !body.toLowerCase().includes(q)) continue;
        rows.push({ p, alias, body, cat: c.name });
      }
    }

    // 已插入份数（同一个词可以插多份）
    const counts = new Map();
    for (const c of this.currentChips()) counts.set(c.id, (counts.get(c.id) || 0) + 1);

    const MAX = 400;
    const shown = rows.slice(0, MAX);
    this.libCount.textContent =
      rows.length > shown.length ? `${shown.length}/${rows.length} 条（缩小搜索）` : `${rows.length} 条`;

    const keepScroll = this.libList.scrollTop;
    this.hideHoverCard();
    if (!rows.length) {
      this.libList.innerHTML = '<div class="pf-lib-empty">没有匹配的词条</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const row of shown) {
      const pid = String(row.p.id || "");
      const n = counts.get(pid) || 0;
      const el = document.createElement("div");
      el.className = "pf-lib-item" + (n ? " on" : "");
      const img = row.p.image
        ? `<img class="pf-lib-thumb" loading="lazy" src="/prompt_selector/preview/${encodeURIComponent(row.p.image)}">`
        : `<span class="pf-lib-thumb pf-lib-thumb--none"></span>`;
      el.innerHTML = `
        ${img}
        <div class="pf-lib-main">
          <div class="pf-lib-alias">
            ${row.p.favorite ? '<span class="pf-lib-star">★</span>' : ""}${escapeHtml(row.alias || "(无别名)")}
            <span class="pf-lib-tag">${escapeHtml(row.cat)}</span>
          </div>
          <div class="pf-lib-prompt">${escapeHtml(row.body)}</div>
        </div>
        <button class="pf-lib-edit" title="编辑这条">✎</button>
        <span class="pf-lib-check">${n ? (n > 1 ? `✓${n}` : "✓") : ""}</span>
      `;
      const thumb = el.querySelector(".pf-lib-thumb");
      if (row.p.image && thumb) {
        thumb.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.showImage(`/prompt_selector/preview/${encodeURIComponent(row.p.image)}`, row.alias);
        });
      }
      el.querySelector(".pf-lib-edit").addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.showFormView("edit", row);
      });
      el.addEventListener("click", () => this.toggleVocab(row));
      el.addEventListener("mouseenter", () => {
        clearTimeout(this._hoverTimer);
        this._hoverTimer = setTimeout(() => this.showHoverCard(row, el), 260);
      });
      el.addEventListener("mouseleave", () => {
        clearTimeout(this._hoverTimer);
        this.hideHoverCard();
      });
      frag.appendChild(el);
    }
    this.libList.innerHTML = "";
    this.libList.appendChild(frag);
    this.libList.scrollTop = keepScroll;
  }

  showHoverCard(row, el) {
    if (!this.libPop) return;
    this.hideHoverCard();
    const card = document.createElement("div");
    card.className = "pf-hover";
    const img = row.p.image
      ? `<img class="pf-hover-img" src="/prompt_selector/preview/${encodeURIComponent(row.p.image)}">`
      : "";
    card.innerHTML = `
      ${img}
      <div class="pf-hover-body">
        <div class="pf-hover-alias">${row.p.favorite ? '<span class="pf-lib-star">★</span>' : ""}${escapeHtml(row.alias || "(无别名)")}
          <span class="pf-hover-cat">${escapeHtml(row.cat)}</span></div>
        <div class="pf-hover-text">${escapeHtml(row.body)}</div>
      </div>
    `;
    document.body.appendChild(card);
    this.hoverCardEl = card;

    // 贴着条目右侧，放不下就翻到左侧；再兜一次上下边界
    const r = el.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let left = r.right + 10;
    if (left + cw > window.innerWidth - 8) left = Math.max(8, r.left - cw - 10);
    let top = r.top;
    if (top + ch > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ch - 8);
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  hideHoverCard() {
    this.hoverCardEl?.remove();
    this.hoverCardEl = null;
  }

  toggleVocab(row) {
    const ta = this.libTarget;
    if (!ta) return;
    const chips = this.currentChips();
    let idx = -1;
    for (let i = chips.length - 1; i >= 0; i--) {
      if (chips[i].id === String(row.p.id || "")) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const rec = chips[idx];
      chips.splice(idx, 1);
      const next = cutText(ta.value, rec.text);
      if (next !== null) {
        ta.value = next;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      this.insertInto(ta, row.body);
      chips.push({ id: String(row.p.id || ""), text: row.body });
    }
    this.sync();
    this.renderLibraryList();
  }

  insertInto(ta, text) {
    if (!ta || !text) return;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);
    const needsComma = before.trim() !== "" && !/[,，、]\s*$/.test(before);
    const ins = (needsComma ? ", " : "") + text;
    ta.value = before + ins + after;
    const pos = before.length + ins.length;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ---- 新增 / 编辑词条 ---- */

  showFormView(mode, row) {
    this.libFormMode = mode;
    this.editingId = mode === "edit" && row ? String(row.p.id || "") : null;
    this.editingCat = mode === "edit" && row ? row.cat : "";
    this.editingImage = mode === "edit" && row ? String(row.p.image || "") : "";
    this.libNewFile = null;

    this.libViewList.style.display = "none";
    this.libViewAdd.style.display = "flex";

    const pop = this.libPop;
    const tip = pop.querySelector(".pf-form-tip");
    const thumb = pop.querySelector(".pf-new-thumb");
    const clearBtn = pop.querySelector(".pf-new-imgclear");
    const saveBtn = pop.querySelector(".pf-new-save");

    if (mode === "edit") {
      tip.textContent = `正在编辑：${row.alias || "(无别名)"} —— 保存会改动词库原条目`;
      pop.querySelector(".pf-new-cat").value = row.cat;
      pop.querySelector(".pf-new-alias").value = row.alias;
      pop.querySelector(".pf-new-prompt").value = row.body;
      saveBtn.textContent = "保存修改";
      if (this.editingImage) {
        thumb.src = `/prompt_selector/preview/${encodeURIComponent(this.editingImage)}`;
        thumb.style.display = "block";
        clearBtn.style.display = "inline-block";
      } else {
        thumb.style.display = "none";
        clearBtn.style.display = "none";
      }
    } else {
      tip.textContent = "新增词条 —— 会写进 Danbooru-Gallery 词库（自动备份）";
      pop.querySelector(".pf-new-cat").value = this.libCatSel.value || "";
      pop.querySelector(".pf-new-alias").value = "";
      pop.querySelector(".pf-new-prompt").value = this.libSearch.value.trim() || "";
      saveBtn.textContent = "存进词库";
      thumb.style.display = "none";
      clearBtn.style.display = "none";
    }
    pop.querySelector(".pf-new-img").value = "";
    pop.querySelector(".pf-new-msg").textContent = "";
    pop.querySelector(".pf-new-alias").focus({ preventScroll: true });
  }

  showListView() {
    if (!this.libPop) return;
    this.libViewAdd.style.display = "none";
    this.libViewList.style.display = "flex";
    this.libFormMode = "add";
    this.editingId = null;
    this.editingImage = "";
    this.libNewFile = null;
  }

  async saveEntry() {
    const pop = this.libPop;
    if (!pop) return;
    const catName = pop.querySelector(".pf-new-cat").value.trim();
    const alias = pop.querySelector(".pf-new-alias").value.trim();
    const body = pop.querySelector(".pf-new-prompt").value.trim();
    const msg = pop.querySelector(".pf-new-msg");
    const btn = pop.querySelector(".pf-new-save");
    const isEdit = this.libFormMode === "edit";

    if (!catName) return (msg.textContent = "分类不能为空");
    if (!body) return (msg.textContent = "内容不能为空");

    btn.disabled = true;
    msg.textContent = "保存中…";
    try {
      // 1) 有新图先传
      let image = this.editingImage || "";
      if (this.libNewFile) {
        const fd = new FormData();
        fd.append("image", this.libNewFile);
        fd.append("alias", alias || "untitled");
        const r = await api.fetchApi("/prompt_selector/upload_image", { method: "POST", body: fd });
        const j = await r.json();
        if (j.error) throw new Error("图片上传失败：" + j.error);
        image = j.filename || "";
      }

      // 2) 永远基于最新整包改，别拿旧缓存覆盖
      const cur = await (await api.fetchApi("/prompt_selector/data")).json();
      if (!Array.isArray(cur.categories)) throw new Error("词库结构异常");
      const now = new Date().toISOString();

      let cat = cur.categories.find((c) => c.name === catName);
      if (!cat) {
        cat = { id: "cat-" + Date.now(), name: catName, updated_at: now, prompts: [] };
        cur.categories.push(cat);
      }
      if (!Array.isArray(cat.prompts)) cat.prompts = [];

      if (isEdit) {
        // 找到原条目（可能在别的分类里）
        let hit = null;
        let oldCat = null;
        for (const c of cur.categories) {
          const p = (c.prompts || []).find((x) => String(x.id) === this.editingId);
          if (p) {
            hit = p;
            oldCat = c;
            break;
          }
        }
        if (!hit) throw new Error("词条已不存在（可能被别处删了），刷新列表看看");

        const oldBody = String(hit.prompt || "");
        hit.alias = alias;
        hit.prompt = body;
        hit.image = image;
        hit.updated_at = now;
        if (oldCat !== cat) {
          oldCat.prompts = oldCat.prompts.filter((x) => String(x.id) !== this.editingId);
          cat.prompts.push(hit);
        }
        if (oldBody !== body) this.refreshInsertedText(this.editingId, oldBody, body);
      } else {
        const newId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : "prompt-" + Date.now();
        cat.prompts.push({
          id: newId,
          alias: alias,
          prompt: body,
          description: "",
          image: image,
          tags: [],
          favorite: false,
          template: false,
          created_at: now,
          updated_at: now,
          usage_count: 0,
          last_used: null,
        });
      }

      // 3) 整包写回（原子保存 + 自动备份）
      const wr = await api.fetchApi("/prompt_selector/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cur),
      });
      const wj = await wr.json();
      if (wj.error) throw new Error(wj.error);

      // 4) 刷新缓存并落到对应分类
      this.libData = null;
      await this.loadLibrary(true);
      this.fillCategories(true);
      this.libCatSel.value = catName;
      this.state.lib.cat = catName;
      this.sync();
      this.showListView();
      this.libSearch.value = alias || body.slice(0, 12);
      this.renderLibraryList();
      msg.textContent = "";
    } catch (err) {
      msg.textContent = String(err.message || err);
    } finally {
      btn.disabled = false;
    }
  }

  // 词条正文改了以后，把已经插到画面上的那段同步换掉（找不到就跳过，别动用户手改的内容）
  refreshInsertedText(id, oldText, newText) {
    const holders = [this.state.summary, ...this.state.items];
    let touched = false;
    for (const h of holders) {
      if (!h || !Array.isArray(h.chips)) continue;
      let changed = false;
      for (const c of h.chips) {
        if (c.id === id && c.text === oldText) {
          c.text = newText;
          changed = true;
        }
      }
      if (!changed) continue;
      const i = String(h.caption || "").indexOf(oldText);
      if (i >= 0) {
        h.caption = h.caption.slice(0, i) + newText + h.caption.slice(i + oldText.length);
        touched = true;
      }
    }
    if (touched) {
      this.el.summary.value = this.state.summary.caption;
      this.renderList();
      this.sync();
    }
  }

  showImage(src, caption) {
    const box = document.createElement("div");
    box.className = "pf-lightbox";
    box.innerHTML = `<img src="${escapeHtml(src)}" alt="">
      <div class="pf-lightbox-cap">${escapeHtml(caption || "")}</div>`;
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }

  /* ---------------- 预设 ---------------- */

  async fetchPresets() {
    try {
      const res = await api.fetchApi("/prompt_forge/presets");
      const j = await res.json();
      this.presets = j.presets || [];
    } catch {
      this.presets = [];
    }
    this.renderPresets();
  }

  renderPresets() {
    const sel = this.el.preset;
    const cur = this.state.preset || "";
    sel.innerHTML = ['<option value="">— 预设 —</option>']
      .concat(this.presets.map((n) => `<option value="${n}">${n}</option>`))
      .join("");
    sel.value = this.presets.includes(cur) ? cur : "";
  }

  currentPayload() {
    return {
      name: this.state.preset,
      state: JSON.parse(JSON.stringify(this.state)),
      width: this.getW(),
      height: this.getH(),
    };
  }

  async savePreset(asNew) {
    let name = this.state.preset;
    if (asNew || !name) {
      name = window.prompt("预设名称", name || "新预设");
      if (!name) return;
    }
    const payload = this.currentPayload();
    payload.state.preset = name;
    const data = { ...payload.state, width: payload.width, height: payload.height };
    try {
      const res = await api.fetchApi("/prompt_forge/preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, data }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      this.presets = j.presets || this.presets;
      this.state.preset = name;
      this.renderPresets();
      this.sync();
      app.extensionManager?.toast?.add?.({ severity: "success", summary: "已保存", detail: name, life: 2000 });
    } catch (err) {
      console.error("[PromptForge] 保存预设失败", err);
      alert("保存失败：" + err.message);
    }
  }

  async loadPreset(name) {
    try {
      const res = await api.fetchApi(`/prompt_forge/preset?name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      const d = j.data || {};
      this.state = normalize(d);
      this.state.preset = name;
      if (Number(d.width)) this.wWidget.value = Number(d.width);
      if (Number(d.height)) this.hWidget.value = Number(d.height);
      this.sel = null;
      this.el.summary.value = this.state.summary.caption;
      this.el.meta.value = this.state.summary.meta;
      this.el.canvasName.value = this.state.summary.canvas;
      this.renderList();
      this.renderLoras();
      this.renderPresets();
      this.sync();
      requestAnimationFrame(() => this.resizeCanvas());
    } catch (err) {
      console.error("[PromptForge] 加载预设失败", err);
      alert("加载失败：" + err.message);
    }
  }

  async deletePreset() {
    const name = this.el.preset.value || this.state.preset;
    if (!name) return alert("先在左上角下拉里选一个预设");
    if (!confirm(`删除预设「${name}」？不可恢复。`)) return;
    try {
      const res = await api.fetchApi("/prompt_forge/preset/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await res.json();
      this.presets = j.presets || [];
      if (this.state.preset === name) this.state.preset = "";
      this.renderPresets();
      this.sync();
    } catch (err) {
      alert("删除失败：" + err.message);
    }
  }

  /* ---------------- 画布 ---------------- */

  resizeCanvas() {
    const wrap = this.el.canvasWrap;
    const [W, H] = this.alignW();
    const aw = wrap.clientWidth - 8;
    const ah = wrap.clientHeight - 8;
    if (aw < 20 || ah < 20) return;
    const aspect = W / H;
    let cw = aw;
    let ch = cw / aspect;
    if (ch > ah) {
      ch = ah;
      cw = ch * aspect;
    }
    const dpr = window.devicePixelRatio || 1;
    this.disp = { w: cw, h: ch, scale: cw / W, dpr, W, H };
    this.canvas.style.width = cw + "px";
    this.canvas.style.height = ch + "px";
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.draw();
  }

  draw() {
    if (!this.disp) return;
    // 自校正：布局刚变时可能算过一次错的尺寸，之后没人再叫我们重算。
    // 每次绘制前对一下容器，差得多就重算一次（带重入保护）。
    if (!this._inResize) {
      const aw = this.el.canvasWrap.clientWidth - 8;
      const ah = this.el.canvasWrap.clientHeight - 8;
      if (aw > 20 && ah > 20) {
        const expect = Math.min(aw, ah * (this.disp.W / this.disp.H));
        if (Math.abs(expect - this.disp.w) > 4) {
          this._inResize = true;
          this.resizeCanvas();
          this._inResize = false;
          return;
        }
      }
    }
    const { w: cw, h: ch, scale, dpr, W, H } = this.disp;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(0, 0, cw, ch);

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    const step = W / 8;
    for (let i = 1; i < 8; i++) {
      const x = Math.round(i * step * scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ch);
      ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const y = Math.round((i * (H / 8)) * scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
    }
    // 中线
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(cw / 2 + 0.5, 0);
    ctx.lineTo(cw / 2 + 0.5, ch);
    ctx.moveTo(0, ch / 2 + 0.5);
    ctx.lineTo(cw, ch / 2 + 0.5);
    ctx.stroke();

    // 区域
    for (const it of this.state.items) {
      const r = this.rectScreen(it);
      const isSel = it.id === this.sel;
      ctx.fillStyle = rgba(it.color, isSel ? 0.2 : 0.12);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = it.color;
      ctx.lineWidth = isSel ? 2 : 1.2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

      const tag = it.name || it.caption.slice(0, 18) || `#${this.state.items.indexOf(it) + 1}`;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      const tw = Math.min(ctx.measureText(tag).width + 8, r.w);
      ctx.fillStyle = rgba(it.color, 0.85);
      ctx.fillRect(r.x, Math.max(0, r.y - 14), tw, 13);
      ctx.fillStyle = "#0b0b0b";
      ctx.fillText(tag.slice(0, 24), r.x + 4, Math.max(9, r.y - 4), tw - 6);

      if (isSel) {
        for (const [, hx, hy] of this.handlePoints(r)) {
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = it.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(hx - 3.5, hy - 3.5, 7, 7);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // 新建中的虚线框
    if (this.drag && this.drag.type === "new" && this.drag.cur) {
      const a = this.drag.start;
      const b = this.drag.cur;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#4ea1ff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(78,161,255,0.10)";
      ctx.fillRect(x, y, w, h);
    }
  }

  rectScreen(it) {
    const s = this.disp.scale;
    const [x1, y1, x2, y2] = it.bbox;
    return {
      x: Math.min(x1, x2) * s,
      y: Math.min(y1, y2) * s,
      w: Math.abs(x2 - x1) * s,
      h: Math.abs(y2 - y1) * s,
    };
  }

  handlePoints(r) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return [
      ["nw", r.x, r.y],
      ["n", cx, r.y],
      ["ne", r.x + r.w, r.y],
      ["e", r.x + r.w, cy],
      ["se", r.x + r.w, r.y + r.h],
      ["s", cx, r.y + r.h],
      ["sw", r.x, r.y + r.h],
      ["w", r.x, cy],
    ];
  }

  eventPos(e) {
    // 节点整体会被 ComfyUI 缩放（transform: scale），getBoundingClientRect 拿到的是缩放后的尺寸，
    // 而绘制坐标是未缩放的 CSS 像素。这里先统一换算回 canvas 内部坐标系，否则点哪儿偏哪儿。
    const r = this.canvas.getBoundingClientRect();
    const k = r.width ? this.disp.w / r.width : 1;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  toImg(p) {
    const s = this.disp.scale;
    return { x: p.x / s, y: p.y / s };
  }

  hitScreen(p) {
    const sel = this.getSel();
    if (sel) {
      const r = this.rectScreen(sel);
      for (const [name, hx, hy] of this.handlePoints(r)) {
        if (Math.abs(p.x - hx) <= HANDLE_R && Math.abs(p.y - hy) <= HANDLE_R) {
          return { type: "resize", handle: name, item: sel };
        }
      }
    }
    for (let i = this.state.items.length - 1; i >= 0; i--) {
      const it = this.state.items[i];
      const r = this.rectScreen(it);
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        return { type: "move", item: it };
      }
    }
    return null;
  }

  onDown(e) {
    if (!this.disp) return;
    e.preventDefault();
    const p = this.eventPos(e);
    const hit = this.hitScreen(p);
    const img = this.toImg(p);
    if (hit) {
      this.select(hit.item.id);
      this.drag = {
        type: hit.type,
        handle: hit.handle,
        item: hit.item,
        start: p,
        startImg: img,
        orig: [...hit.item.bbox],
      };
    } else {
      this.sel = null;
      [...this.el.list.children].forEach((r) => r.classList.remove("sel"));
      this.drag = { type: "new", start: p, cur: p };
    }
    this.canvas.setPointerCapture?.(e.pointerId);
    this.draw();
  }

  onMove(e) {
    if (!this.drag || !this.disp) return;
    const p = this.eventPos(e);
    const [W, H] = [this.disp.W, this.disp.H];
    if (this.drag.type === "new") {
      this.drag.cur = p;
      this.draw();
      return;
    }
    const s = this.disp.scale;
    const dx = (p.x - this.drag.start.x) / s;
    const dy = (p.y - this.drag.start.y) / s;
    const it = this.drag.item;
    const o = this.drag.orig;

    if (this.drag.type === "move") {
      const w = o[2] - o[0];
      const h = o[3] - o[1];
      let nx = clamp(o[0] + dx, 0, W - w);
      let ny = clamp(o[1] + dy, 0, H - h);
      it.bbox = [nx, ny, nx + w, ny + h];
    } else if (this.drag.type === "resize") {
      const hd = this.drag.handle;
      let [x1, y1, x2, y2] = o;
      if (hd.includes("w")) x1 = clamp(o[0] + dx, 0, x2 - 8);
      if (hd.includes("e")) x2 = clamp(o[2] + dx, x1 + 8, W);
      if (hd.includes("n")) y1 = clamp(o[1] + dy, 0, y2 - 8);
      if (hd.includes("s")) y2 = clamp(o[3] + dy, y1 + 8, H);
      it.bbox = [x1, y1, x2, y2];
    }
    this.syncNumbers();
    this.draw();
    this.sync();
  }

  onUp(e) {
    if (!this.drag) return;
    if (this.drag.type === "new") {
      const a = this.toImg(this.drag.start);
      const b = this.toImg(this.drag.cur || this.drag.start);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      this.drag = null;
      if (w > 8 && h > 8) {
        const [W, H] = [this.disp.W, this.disp.H];
        const item = {
          id: uid(),
          label: "object",
          name: "",
          caption: "",
          text: "",
          color: PALETTE[this.state.items.length % PALETTE.length],
          bbox: [
            Math.round(clamp(Math.min(a.x, b.x), 0, W)),
            Math.round(clamp(Math.min(a.y, b.y), 0, H)),
            Math.round(clamp(Math.max(a.x, b.x), 0, W)),
            Math.round(clamp(Math.max(a.y, b.y), 0, H)),
          ],
          chips: [],
        };
        this.state.items.push(item);
        this.sel = item.id;
        this.renderList();
        this.sync();
        const row = this.el.list.querySelector(`[data-id="${item.id}"]`);
        if (row) row.scrollIntoView({ block: "nearest" });
      }
      this.draw();
      return;
    }
    this.drag = null;
    this.draw();
  }

  onResize() {
    this.applyPanelHeight();
    clearTimeout(this._rzTimer);
    this._rzTimer = setTimeout(() => this.resizeCanvas(), 30);
  }
}

app.registerExtension({
  name: "PromptForge.UI",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const res = onNodeCreated?.apply(this, arguments);
      try {
        this.pf = new ForgeUI(this);
      } catch (err) {
        console.error("[PromptForge] 面板初始化失败", err);
      }
      return res;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const res = onConfigure?.apply(this, arguments);
      if (this.pf) {
        this.pf.reloadFromWidget();
        requestAnimationFrame(() => {
          this.pf?.applyPanelHeight();
          this.pf?.resizeCanvas();
        });
      }
      return res;
    };

    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const res = onResize?.apply(this, arguments);
      this.pf?.onResize();
      return res;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.pf?.ro?.disconnect();
      return onRemoved?.apply(this, arguments);
    };
  },
});

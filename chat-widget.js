/* ==================================================================
   chat-widget.js  ·  แชตบอตสำหรับร้านเสื้อผ้า DYTORRO
   ================================================================== */

(function(){
  const s = document.createElement("script");
  s.src = "config.js?t=" + Date.now();
  s.onerror = () => console.error("ไม่พบไฟล์ config.js  วางไว้โฟลเดอร์เดียวกับหน้าเว็บ");
  s.onload = () => window.__startApp && window.__startApp();
  document.head.appendChild(s);
})();

const PROVIDERS = {
  worker: {
    name: "Worker",
    url: null,
    auth: () => ({}),
    style: "openai",
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    auth: (k) => ({ "Authorization": "Bearer " + k }),
    style: "openai",
  },
  groq: {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    auth: (k) => ({ "Authorization": "Bearer " + k }),
    style: "openai",
  },
  openai: {
    name: "OpenAI",
    url: "https://api.openai.com/v1/chat/completions",
    auth: (k) => ({ "Authorization": "Bearer " + k }),
    style: "openai",
  },
  gemini: {
    name: "Google Gemini",
    url: null,
    auth: (k) => ({ "x-goog-api-key": k }),
    style: "gemini",
  },
};

let CFG = {}, CHUNKS = [], INDEX = [];
let READY = false;
let onReady = () => {};

function workerURL(path){
  const base = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("ยังไม่ได้ใส่ WORKER_URL ใน config.js");
  return base + path;
}
let VEC = null;
let MODE = "local";
let FELL_BACK = false;
const $ = (id) => document.getElementById(id);
let onStatus = () => {};
const boot = (t) => onStatus(t);

/* ---------- ขั้นที่ 1  หั่นเอกสาร ---------- */
async function buildChunks(){
  const out = [];
  const base = (CFG.DOCS_BASE || "").replace(/\/+$/, "");
  for (const f of CFG.FILES) {
    const url = base ? `${base}/${f}` : f;
    let text;
    try {
      const r = await fetch(url + "?t=" + Date.now());
      if (!r.ok) throw new Error(r.status);
      text = (await r.text()).trim();
    } catch {
      throw new Error(`อ่านไฟล์ ${url} ไม่ได้\nตรวจว่าไฟล์อยู่ที่เดียวกับ index.html และชื่อสะกดตรงกับรายการ FILES`);
    }
    let start = 0, part = 1;
    while (start < text.length) {
      out.push({ source: f, part, text: text.slice(start, start + (CFG.CHUNK_SIZE || 500)) });
      start += (CFG.CHUNK_SIZE || 500) - (CFG.OVERLAP || 100);
      part++;
    }
  }
  return out;
}

/* ---------- ขั้นที่ 2  ทำดัชนีไว้ค้น ---------- */
function grams(s, n = 3){
  const t = s.replace(/\s+/g, "");
  const m = new Map();
  for (let i = 0; i + n <= t.length; i++) {
    const g = t.slice(i, i + n);
    m.set(g, (m.get(g) || 0) + 1);
  }
  let sum = 0;
  for (const v of m.values()) sum += v * v;
  return { m, norm: Math.sqrt(sum) || 1 };
}

function similarity(a, b){
  let num = 0;
  const [small, big] = a.m.size < b.m.size ? [a, b] : [b, a];
  for (const [g, v] of small.m) {
    const w = big.m.get(g);
    if (w) num += v * w;
  }
  return num / (a.norm * b.norm);
}

/* ---------- ขั้นที่ 3  ค้นหา ---------- */
function search(question){
  const q = grams(question);
  return INDEX
    .map((g, i) => ({ i, score: similarity(g, q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CFG.TOP_K || 3)
    .map(({ i, score }) => ({ ...CHUNKS[i], score: Math.round(score * 1000) / 1000 }));
}

/* ---------- โหมดเวกเตอร์ ---------- */
async function loadVectors(){
  const r = await fetch((CFG.VECTORS_FILE || "vectors.json") + "?t=" + Date.now());
  if (!r.ok) throw new Error(`อ่านไฟล์ ${CFG.VECTORS_FILE || "vectors.json"} ไม่ได้  รหัส ${r.status}`);
  const d = await r.json();
  if (!d.chunks || !d.chunks.length) throw new Error("ไฟล์เวกเตอร์ว่างเปล่า");
  return d;
}

async function embedQuestion(q){
  const viaWorker = CFG.PROVIDER === "worker";
  const url = viaWorker
    ? workerURL("/api/v1/embeddings")
    : "https://openrouter.ai/api/v1/embeddings";
  const auth = viaWorker ? {} : { "Authorization": "Bearer " + CFG.KEY };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      model: VEC.model || CFG.EMBED_MODEL || "nvidia/nemotron-3.5-embed-1b:free",
      input: [q],
    }),
  });
  if (!res.ok) throw new Error(`แปลงคำถามไม่สำเร็จ ${res.status}  ${(await res.text()).slice(0, 180)}`);
  const d = await res.json();
  const v = d.data?.[0]?.embedding;
  if (!v) throw new Error("ไม่ได้รับเวกเตอร์กลับมา");
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

function searchVector(qv){
  return VEC.chunks
    .map((c, i) => ({ i, score: c.v.reduce((s, x, k) => s + x * qv[k], 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CFG.TOP_K || 3)
    .map(({ i, score }) => ({
      source: VEC.chunks[i].source, part: VEC.chunks[i].part,
      text: VEC.chunks[i].text, score: Math.round(score * 1000) / 1000,
    }));
}

async function findChunks(question){
  if (MODE === "vector") {
    try {
      const qv = await embedQuestion(question);
      return { found: searchVector(qv), how: "เวกเตอร์" };
    } catch (e) {
      MODE = "local";
      FELL_BACK = true;
      console.warn("โหมดเวกเตอร์มีปัญหา ถอยไปใช้การเทียบตัวอักษร :", e.message);
      boot(bootLine() + "   (โหมดเวกเตอร์ใช้ไม่ได้ จึงสลับมาเทียบตัวอักษร)");
    }
  }
  return { found: search(question), how: "เทียบตัวอักษร" };
}

/* ---------- ขั้นที่ 4  ประกอบคำสั่งแล้วส่งให้ LLM ---------- */
function makePrompt(question, found){
  const docs = found.map((f, i) =>
    `[ชิ้นที่ ${i + 1}  จากไฟล์ ${f.source}]\n${f.text}`).join("\n\n");
  return `คุณคือผู้ช่วยตอบคำถามของร้านเสื้อผ้า DYTORRO
ให้ตอบโดยใช้เฉพาะข้อมูลในเอกสารด้านล่างเท่านั้น

ถ้าเอกสารไม่มีคำตอบ ให้ตอบว่า "ไม่พบข้อมูลนี้ในเอกสารของร้าน DYTORRO"
แล้วแนะนำให้ติดต่อแอดมินร้านโดยตรง  ห้ามเดา ห้ามเติมข้อมูลจากความรู้ทั่วไป

ตอบเป็นภาษาไทย สุภาพ สั้น กระชับ

เอกสารที่ค้นเจอ
${docs}

คำถามจากผู้ใช้
${question}`;
}

async function askLLM(prompt){
  const p = PROVIDERS[CFG.PROVIDER];
  if (!p) throw new Error(`ไม่รู้จักผู้ให้บริการชื่อ ${CFG.PROVIDER}\nเลือกได้จาก ${Object.keys(PROVIDERS).join("  ")}`);

  let url, body;
  if (p.style === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL}:generateContent`;
    body = { contents: [{ parts: [{ text: prompt }] }] };
  } else {
    url = CFG.PROVIDER === "worker"
      ? workerURL("/api/v1/chat/completions")
      : p.url;
    body = { model: CFG.MODEL, messages: [{ role: "user", content: prompt }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...p.auth(CFG.KEY) },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status}  ${t.slice(0, 250)}`);
  }
  const d = await res.json();
  return p.style === "gemini"
    ? (d.candidates?.[0]?.content?.parts?.[0]?.text ?? "ไม่ได้รับคำตอบกลับมา")
    : (d.choices?.[0]?.message?.content ?? "ไม่ได้รับคำตอบกลับมา");
}

function bootLine(){
  const files = new Set(CHUNKS.map(c => c.source)).size;
  const pv = PROVIDERS[CFG.PROVIDER]?.name ?? CFG.PROVIDER;
  const m = MODE === "vector" ? "เวกเตอร์" : "เทียบตัวอักษร";
  return `พร้อมใช้งาน · เอกสาร ${files} ไฟล์ (${m})`;
}

/* ---------- เริ่มระบบ ---------- */
window.__startApp = async () => {
  CFG = window.CONFIG || {};
  CFG.KEY = (CFG.KEY || "").trim();

  const needKey = CFG.PROVIDER !== "worker";
  if (needKey && (!CFG.KEY || CFG.KEY.startsWith("ใส่กุญแจ"))) {
    boot("ยังไม่ได้ใส่กุญแจ  หรือเบราว์เซอร์ยังใช้ไฟล์เก่า\n\n"
       + "1 เปิด config.js ตรง ๆ ในแท็บใหม่ ดูว่ามีกุญแจจริงไหม\n"
       + "2 ถ้ามี ให้กด Ctrl และ Shift + R\n"
       + "3 ถ้าไม่มี แปลว่ายังไม่ได้ Commit");
    return;
  }
  if (CFG.PROVIDER === "worker" && !CFG.WORKER_URL) {
    boot("ยังไม่ได้ใส่ที่อยู่ Worker\n\nแก้บรรทัด WORKER_URL ใน config.js ให้เป็นที่อยู่ของ Worker ที่สร้างไว้");
    return;
  }
  if (!CFG.FILES || !CFG.FILES.length) {
    boot("ไม่มีรายชื่อไฟล์เอกสาร\n\nตรวจรายการ FILES ในไฟล์ config.js");
    return;
  }

  try {
    boot("กำลังเชื่อมต่อคลังข้อมูล...");
    CHUNKS = await buildChunks();
    INDEX = CHUNKS.map(c => grams(c.text));

    MODE = "local";
    if ((CFG.SEARCH_MODE || "local") === "vector") {
      try {
        boot("กำลังโหลดเวกเตอร์...");
        VEC = await loadVectors();
        MODE = "vector";
      } catch (e) {
        console.warn("โหลดไฟล์เวกเตอร์ไม่ได้ จึงใช้โหมด local :", e.message);
      }
    }

    boot(bootLine());

    READY = true;
    onReady();
  } catch (e) {
    boot("เริ่มไม่สำเร็จ\n\n" + e.message);
  }
};

async function askBot(question){
  if (!READY) throw new Error("ระบบยังไม่พร้อม");
  const { found, how } = await findChunks(question);
  const answer = await askLLM(makePrompt(question, found));
  const refs = `ค้นแบบ${how} · ` +
    found.map(f => `${f.source} ส่วนที่ ${f.part} (${f.score})`).join(" · ");
  return { answer, refs };
}

/* ==================================================================
   ส่วนหน้าตาของกล่องแชต โทนพรีเมียม DYTORRO (Modern Obsidian & Blue)
   ================================================================== */
(function(){

  const C = {
    main:    "#09090B",
    accent:  "#2563EB",
    accent2: "#1D4ED8",
    ink:     "#18181B",
    soft:    "#A1A1AA",
    line:    "#E4E4E7",
    bg:      "#F8FAFC",
    card:    "#FFFFFF",
    muted:   "#64748B",
  };

  const css = `
/* ปุ่มไอคอนแชตพรีเมียมมุมขวาล่าง */
#pimbot-btn{
  position:fixed; right:24px; bottom:24px; z-index:9999;
  width:62px; height:62px; border-radius:50%;
  border:1.5px solid rgba(255,255,255,0.22);
  cursor:pointer;
  background: linear-gradient(135deg, #2563EB 0%, #1E3A8A 60%, #09090B 100%);
  color:#fff;
  box-shadow: 0 10px 28px rgba(37, 99, 235, 0.45), 0 0 0 0 rgba(37, 99, 235, 0.5);
  display:grid; place-items:center;
  transition: transform .25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow .25s ease;
  animation: pimbotPulse 3s infinite;
  margin-bottom: env(safe-area-inset-bottom, 0px);
}
@keyframes pimbotPulse {
  0%   { box-shadow: 0 10px 28px rgba(37, 99, 235, 0.42), 0 0 0 0 rgba(37, 99, 235, 0.55); }
  70%  { box-shadow: 0 10px 28px rgba(37, 99, 235, 0.42), 0 0 0 13px rgba(37, 99, 235, 0); }
  100% { box-shadow: 0 10px 28px rgba(37, 99, 235, 0.42), 0 0 0 0 rgba(37, 99, 235, 0); }
}
#pimbot-btn:hover{
  transform: translateY(-3px) scale(1.07);
  box-shadow: 0 14px 34px rgba(37, 99, 235, 0.65);
}
#pimbot-btn svg{width:30px; height:30px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.3))}
#pimbot-dot{
  position:absolute; top:3px; right:3px; width:14px; height:14px;
  border-radius:50%; background:#10B981; border:2.5px solid #09090B;
  box-shadow: 0 0 8px #10B981;
}

/* กล่องแชตหลัก */
#pimbot-panel{
  position:fixed; right:24px; bottom:98px; z-index:9999;
  width:min(395px, calc(100vw - 32px));
  background:${C.card}; border:1px solid rgba(37,99,235,0.18); border-radius:18px;
  overflow:hidden; display:none;
  box-shadow:0 20px 55px rgba(9, 9, 11, 0.28);
  font-family:'Anuphan','Noto Sans Thai','Segoe UI',system-ui,sans-serif;
  font-size:15px; line-height:1.65; color:${C.ink};
  margin-bottom: env(safe-area-inset-bottom, 0px);
}
#pimbot-panel.pimbot-open{
  display:block;
  animation: pimbotSlideUp .24s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes pimbotSlideUp {
  from { opacity:0; transform: translateY(14px) scale(0.97); }
  to   { opacity:1; transform: translateY(0) scale(1); }
}

/* ส่วนหัวกล่องแชต */
#pimbot-head{
  background: linear-gradient(135deg, #09090B 0%, #1E293B 100%);
  color:#fff; padding:15px 18px; position:relative;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.pimbot-brand-row{
  display:flex; align-items:center; gap:10px; padding-right:115px;
}
.pimbot-avatar{
  width:36px; height:36px; border-radius:50%;
  background: linear-gradient(135deg, #2563EB, #60A5FA);
  display:grid; place-items:center; flex-shrink:0;
  box-shadow: 0 2px 10px rgba(37, 99, 235, 0.45);
  overflow:hidden;
}
.pimbot-avatar img{
  width:24px; height:24px; object-fit:contain;
}
#pimbot-head b{font-size:15.5px; font-weight:700; letter-spacing:0.3px; display:block; line-height:1.25}
#pimbot-head small{display:block; font-size:11.5px; color:#94A3B8; margin-top:2px}

#pimbot-head-actions{
  position:absolute; top:14px; right:12px;
  display:flex; align-items:center; gap:6px;
}
#pimbot-human-btn{
  background: rgba(37, 99, 235, 0.22);
  color:#93C5FD;
  border:1px solid rgba(96, 165, 250, 0.45);
  border-radius:999px;
  padding:4px 11px; font-size:11.5px; font-weight:600;
  text-decoration:none; cursor:pointer; white-space:nowrap;
  transition: all .2s;
}
#pimbot-human-btn:hover{
  background:#2563EB; color:#fff; border-color:#2563EB;
}
#pimbot-close{
  background:rgba(255,255,255,0.08); border:0; color:#CBD5E1;
  font-size:19px; line-height:1; border-radius:50%;
  cursor:pointer; width:28px; height:28px; display:grid; place-items:center;
  transition: background .2s, color .2s;
}
#pimbot-close:hover{background:rgba(255,255,255,0.2); color:#fff}

/* แถบแจ้งเตือน AI */
#pimbot-warn{
  background: #EFF6FF;
  border-bottom:1px solid #DBEAFE;
  padding:9px 16px; font-size:12px; line-height:1.55; color:#1E3A8A;
}
#pimbot-warn b{color:#1D4ED8}

/* พื้นที่ข้อความแชต */
#pimbot-log{height:285px; overflow-y:auto; padding:14px 16px; background:${C.bg}}
.pimbot-m{
  max-width:85%; padding:11px 14px; border-radius:14px; margin:8px 0;
  font-size:14px; white-space:pre-wrap; line-height:1.6;
}
.pimbot-me{
  margin-left:auto;
  background: linear-gradient(135deg, #2563EB, #1D4ED8);
  color:#fff; border-bottom-right-radius:4px;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}
.pimbot-bot{
  background:${C.card}; border:1px solid ${C.line};
  border-bottom-left-radius:4px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
}
.pimbot-src{
  display:block; margin-top:7px; padding-top:5px;
  border-top:1px dashed #E2E8F0;
  font-size:11px; color:${C.muted};
}

/* ปุ่มคำถามแนะนำ */
#pimbot-chips{padding:4px 14px 10px; display:flex; flex-wrap:wrap; gap:6px; background:${C.bg}}
#pimbot-chips span{
  font-size:12px; padding:5px 12px;
  border:1px solid #CBD5E1; border-radius:999px;
  cursor:pointer; color:#334155; background:${C.card};
  transition: all .2s;
}
#pimbot-chips span:hover{
  border-color:#2563EB; color:#2563EB; background:#EFF6FF;
  transform: translateY(-1px);
}

/* ช่องพิมพ์ข้อความและปุ่มส่ง */
#pimbot-row{display:flex; gap:8px; padding:11px 14px; border-top:1px solid ${C.line}; background:${C.card}}
#pimbot-q{
  flex:1; padding:10px 14px; font-family:inherit; font-size:14px;
  border:1.5px solid #CBD5E1; border-radius:11px; background:#F8FAFC; color:${C.ink};
  transition: border-color .2s, background .2s;
}
#pimbot-q:focus{
  outline:none; border-color:#2563EB; background:#FFFFFF;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
#pimbot-send{
  padding:10px 18px; border:0; border-radius:11px;
  background: linear-gradient(135deg, #2563EB, #1D4ED8);
  color:#FFFFFF; font-family:inherit; font-size:14px; font-weight:600;
  cursor:pointer; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
  transition: transform .15s, box-shadow .15s;
}
#pimbot-send:hover:not(:disabled){
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.42);
}
#pimbot-send:disabled{opacity:.45; cursor:default; box-shadow:none}
`;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const wrap = document.createElement("div");
  wrap.innerHTML = `
<button id="pimbot-btn" aria-label="เปิดผู้ช่วย DYTORRO" title="คุยกับผู้ช่วย AI ร้าน DYTORRO">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3a9 9 0 0 0-8.1 12.9L3 21l5.1-.9A9 9 0 1 0 12 3z"></path>
    <path d="M9.5 10.5h.01M14.5 10.5h.01" stroke-width="2.4"></path>
    <path d="M9.5 14c.8.8 1.6 1.2 2.5 1.2s1.7-.4 2.5-1.2"></path>
  </svg>
  <span id="pimbot-dot"></span>
</button>

<div id="pimbot-panel" role="dialog" aria-label="กล่องสอบถาม DYTORRO">
  <div id="pimbot-head">
    <div id="pimbot-head-actions">
      <a id="pimbot-human-btn" href="Teammember.html" title="ติดต่อทีมงาน DYTORRO">ติดต่อเจ้าหน้าที่</a>
      <button id="pimbot-close" aria-label="ปิด">×</button>
    </div>
    <div class="pimbot-brand-row">
      <div class="pimbot-avatar">
        <img src="phoo.png" alt="DYTORRO" onerror="this.style.display='none'">
      </div>
      <div>
        <b>DYTORRO Assistant</b>
        <small id="pimbot-status">กำลังเตรียมระบบ...</small>
      </div>
    </div>
  </div>

  <div id="pimbot-warn">
    <b>นี่คือผู้ช่วยอัตโนมัติ (AI) ไม่ใช่พนักงาน</b>
    คำตอบอ้างอิงจากข้อมูลร้าน DYTORRO หากต้องการติดต่อพนักงานจริง โทร 089-000-0000
  </div>

  <div id="pimbot-log"></div>

  <div id="pimbot-chips">
    <span>ตารางไซซ์และราคาเสื้อ</span>
    <span>Geo Form Tee มีสีอะไรบ้าง</span>
    <span>ค่าจัดส่งเท่าไหร่</span>
    <span>เปลี่ยนไซซ์ได้ไหม</span>
  </div>

  <div id="pimbot-row">
    <input id="pimbot-q" type="text" placeholder="พิมพ์คำถามเกี่ยวกับร้าน DYTORRO..." disabled>
    <button id="pimbot-send" disabled>ส่ง</button>
  </div>
</div>`;
  document.body.appendChild(wrap);

  const $ = (id) => document.getElementById(id);

  onStatus = (t) => { $("pimbot-status").textContent = String(t).split("\n")[0]; };

  onReady = () => {
    $("pimbot-q").disabled = false;
    $("pimbot-send").disabled = false;
    say("สวัสดีครับ ยินดีต้อนรับสู่ร้าน DYTORRO สอบถามข้อมูลสินค้า ไซซ์ หรือการจัดส่งได้เลยครับ", "bot");
  };

  function say(text, who, src){
    const d = document.createElement("div");
    d.className = "pimbot-m " + (who === "me" ? "pimbot-me" : "pimbot-bot");
    d.textContent = text;
    if (src) {
      const s = document.createElement("span");
      s.className = "pimbot-src";
      s.textContent = src;
      d.appendChild(s);
    }
    $("pimbot-log").appendChild(d);
    $("pimbot-log").scrollTop = $("pimbot-log").scrollHeight;
    return d;
  }

  async function send(){
    const t = $("pimbot-q").value.trim();
    if (!t) return;
    $("pimbot-q").value = "";
    say(t, "me");
    const holder = say("กำลังค้นข้อมูล...", "bot");
    try {
      const { answer, refs } = await askBot(t);
      holder.textContent = answer;
      const s = document.createElement("span");
      s.className = "pimbot-src";
      s.textContent = refs;
      holder.appendChild(s);
    } catch (e) {
      const m = e.message || String(e);
      holder.textContent =
          m.includes("429") ? "ตอนนี้มีผู้ใช้งานมาก กรุณารอสักครู่แล้วถามใหม่"
        : m.includes("401") || m.includes("403") ? "ระบบยังตั้งค่าไม่ครบ กรุณาแจ้งผู้ดูแล"
        : "เกิดข้อผิดพลาด\n\n" + m;
    }
  }

  $("pimbot-btn").addEventListener("click", () => {
    const open = $("pimbot-panel").classList.toggle("pimbot-open");
    if (open) $("pimbot-q").focus();
  });
  $("pimbot-close").addEventListener("click", () =>
    $("pimbot-panel").classList.remove("pimbot-open"));
  $("pimbot-send").addEventListener("click", send);
  $("pimbot-q").addEventListener("keydown", e => { if (e.key === "Enter") send(); });
  document.querySelectorAll("#pimbot-chips span").forEach(el =>
    el.addEventListener("click", () => { $("pimbot-q").value = el.textContent; send(); }));

})();
// Isolated world: asks the background worker for this page's range, hands it to page.js for chart lines, and shows the
// same facts in a panel you can edit in place. Nothing from a page or the bridge is ever inserted as HTML, and only real
// actions from you count: a page script can call .click() on these controls, but its events are not trusted.
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const panel = document.createElement("div");
panel.id = "solard-panel";
panel.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;width:236px;box-sizing:border-box;background:#111418f2;color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:9px 11px;border-radius:9px;border:1px solid #2a3038;box-shadow:0 8px 24px #0008;display:none";
let collapsed = false, note = "";
let draft = null; // unsaved edits for one coin: they survive the 5s refresh until you save or reset
// Typing here must not reach the site's own hotkeys.
for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, e => e.stopPropagation());
(document.body ?? document.documentElement).appendChild(panel);

// Drag the title to move, drag the corner grip to resize. Both are remembered across sites and reloads.
let box = null, shown = null;
function placePanel() {
  if (!box) return;
  const b = globalThis.solardChartMath.panelBox(box, innerWidth, innerHeight);
  Object.assign(panel.style, { left: `${b.left}px`, top: `${b.top}px`, right: "auto", bottom: "auto", width: `${b.width}px`, height: b.height && !collapsed ? `${b.height}px` : "auto", overflow: "auto" });
}
chrome.storage.local.get("panelBox", v => { box = v.panelBox ?? null; placePanel(); });
addEventListener("resize", placePanel);
let held = null;
panel.addEventListener("pointerdown", e => {
  const mode = e.target.dataset?.solard;
  if (!e.isTrusted || !mode) return;
  const r = panel.getBoundingClientRect();
  held = { mode, x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height, moved: false };
  panel.setPointerCapture(e.pointerId); // a fast drag leaves the panel at once, so it must keep getting the moves
  e.preventDefault();
});
panel.addEventListener("pointermove", e => {
  if (!held || !e.isTrusted) return;
  const dx = e.clientX - held.x, dy = e.clientY - held.y;
  if (!held.moved) { if (Math.hypot(dx, dy) < 4) return; held.moved = true; }
  box = held.mode === "grip"
    ? { left: held.left, top: held.top, width: held.width + dx, height: held.height + dy }
    : { left: held.left + dx, top: held.top + dy, width: held.width, height: box?.height ?? null };
  placePanel();
});
panel.addEventListener("pointerup", e => {
  if (!held || !e.isTrusted) return;
  if (held.moved) chrome.storage.local.set({ panelBox: box });
  else if (held.mode === "title" && shown) { collapsed = !collapsed; placePanel(); render(shown); }
  held = null;
});
panel.addEventListener("pointercancel", () => { held = null; });

const usd = v => v == null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`;
const money = v => String(Math.round(v / 10) / 100);
function row(label, value, color) {
  const r = document.createElement("div"); r.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px";
  const a = document.createElement("span"); a.textContent = label; a.style.color = "#8b95a1";
  const b = document.createElement("span"); b.textContent = value; if (color) b.style.color = color;
  r.append(a, b); return r;
}
function button(label, run, color) {
  const x = document.createElement("button"); x.textContent = label;
  x.style.cssText = `font:inherit;padding:3px 7px;border-radius:5px;border:1px solid #2a3038;background:#1b2027;cursor:pointer;color:${color ?? "#e8eaed"}`;
  x.addEventListener("click", e => { e.stopPropagation(); if (e.isTrusted) run(); });
  return x;
}
/** A value you edit where it stands. Nothing is sent while you type: Enter saves all edits, Escape puts this one back. */
function field(label, value, color, unit, onInput, onEnter) {
  const i = document.createElement("input"); i.value = value; i.size = 7;
  i.style.cssText = `width:64px;box-sizing:border-box;font:inherit;padding:0 3px;background:transparent;color:${color ?? "#e8eaed"};border:1px solid transparent;border-bottom-color:#2a3038;border-radius:3px;text-align:right;outline:none`;
  i.addEventListener("focus", () => { i.style.borderColor = "#3b82f6"; i.select(); });
  i.addEventListener("blur", () => { i.style.borderColor = "transparent"; i.style.borderBottomColor = "#2a3038"; });
  i.addEventListener("input", e => { if (e.isTrusted) onInput(i.value); });
  i.addEventListener("keydown", e => { if (!e.isTrusted) return; if (e.key === "Enter") onEnter(); if (e.key === "Escape") { i.value = value; onInput(value); i.blur(); } });
  const r = row(label, ""), right = r.lastChild; right.replaceChildren(i);
  if (unit) { const u = document.createElement("span"); u.textContent = unit; u.style.cssText = "color:#8b95a1;margin-left:3px"; right.append(u); }
  return r;
}
const ask = body => new Promise(done => chrome.runtime.sendMessage({ type: "act", body }, r => done(chrome.runtime.lastError ? { ok: false, error: "extension error" } : r)));
function send(body) {
  chrome.runtime.sendMessage({ type: "act", body }, r => { note = chrome.runtime.lastError ? "extension error" : r?.ok ? r.message : `failed: ${r?.error}`; tick(); });
}
function message(text) { panel.replaceChildren(); panel.textContent = text; panel.style.display = "block"; }
function render(b) {
  shown = b;
  panel.replaceChildren();
  const title = document.createElement("div"); title.style.cssText = "font-weight:700;margin-bottom:4px;cursor:move;user-select:none;touch-action:none";
  title.dataset.solard = "title";
  title.textContent = `${b.symbol ?? "Bot"} ${collapsed ? "▸" : "▾"}`;
  panel.append(title);
  if (collapsed) { title.textContent += `  ${usd(b.capUsd)}`; panel.style.display = "block"; return; }
  const id = { wallet: b.wallet, mint: b.mint };
  const live = { mint: b.mint, buy: money(b.buy), sell: money(b.sell), steps: String(b.steps), size: String(b.budgetSol ?? "") };
  const numbers = d => ({ buy: Number(d.buy) * 1000, sell: Number(d.sell) * 1000, steps: Number(d.steps), size: Number(d.size) });
  const valid = p => p.buy > 0 && p.sell > p.buy && Number.isInteger(p.steps) && p.steps >= 1 && p.steps <= 20 && p.size > 0 && p.size <= 5;
  const rangeSame = p => Math.abs(p.buy - b.buy) < 1 && Math.abs(p.sell - b.sell) < 1 && p.steps === b.steps, sizeSame = p => Math.abs(p.size - (b.budgetSol ?? 0)) < 1e-9;
  if (draft && draft.mint !== b.mint) draft = null;
  // A save stays on screen until the bridge reports it, so old values never flash back.
  if (draft?.savedAt && ((rangeSame(numbers(draft)) && sizeSame(numbers(draft))) || Date.now() - draft.savedAt > 20_000)) draft = null;
  const shownValues = draft ?? live;
  const list = document.createElement("div"), saveRow = document.createElement("div");
  list.style.cssText = "max-height:150px;overflow:auto;margin:5px 0;border-top:1px solid #2a3038;border-bottom:1px solid #2a3038;padding:3px 0";
  saveRow.style.cssText = "display:none;gap:5px;margin-top:5px";
  function refresh() {
    const d = draft ?? live, p = numbers(d), dirty = !!draft && !draft.savedAt;
    saveRow.style.display = dirty ? "flex" : "none";
    if (!valid(p)) { list.textContent = "need buy below sell, steps 1-20, size up to 5 SOL"; return; }
    const heldSteps = dirty ? 0 : b.held ?? 0, steps = globalThis.solardChartMath.stepLevels(p.buy, p.sell, p.steps);
    list.replaceChildren(row(`${p.steps} steps`, `${(p.size / p.steps).toFixed(4)} SOL each`), ...steps.map((s, i) => row(`${i >= p.steps - heldSteps ? "●" : "○"} ${i + 1}`, `${usd(s.buy)} → ${usd(s.sell)}`)).reverse());
  }
  const edit = (key, value) => { draft ??= { ...live }; draft[key] = value; draft.savedAt = 0; refresh(); };
  async function save() {
    if (!draft) return;
    const p = numbers(draft); if (!valid(p)) { note = "fix the values first"; return render(b); }
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    draft.savedAt = Date.now(); note = "saving…"; render(b);
    const first = rangeSame(p) ? { ok: true } : await ask({ action: "range", ...id, buy: p.buy, sell: p.sell, steps: p.steps });
    const second = !first?.ok || sizeSame(p) ? first : await ask({ action: "budget", ...id, budget: p.size });
    if (first?.ok && second?.ok) note = "saved"; else { note = `failed: ${(first?.ok ? second : first)?.error ?? "no reply"}`; if (draft) draft.savedAt = 0; }
    tick();
  }
  saveRow.append(button("Save changes", save, "#22c55e"), button("Reset", () => { draft = null; note = ""; render(b); }));
  panel.append(
    field("Buy from", shownValues.buy, "#22c55e", "k", v => edit("buy", v), save),
    field("Sell to", shownValues.sell, "#ef4444", "k", v => edit("sell", v), save),
    field("Steps", shownValues.steps, null, null, v => edit("steps", v), save),
    field("Size", shownValues.size, null, "SOL", v => edit("size", v), save),
    saveRow, list,
    row("Now", usd(b.capUsd)));
  // Where the price sits in the range; a marker past either end means it is outside.
  const span = Math.max(1, b.sell - b.buy), pos = Math.max(0, Math.min(100, (b.capUsd - b.buy) / span * 100));
  const bar = document.createElement("div"); bar.style.cssText = "position:relative;height:6px;margin:5px 0 6px;border-radius:3px;background:linear-gradient(90deg,#22c55e55,#ef444455)";
  const mark = document.createElement("div"); mark.style.cssText = `position:absolute;top:-2px;left:calc(${pos}% - 1px);width:3px;height:10px;background:#fff;border-radius:1px`;
  bar.append(mark); panel.append(bar);
  refresh();
  panel.append(row("Held", `${b.held ?? 0}/${b.steps}`), row("Holding", b.valueSol ? `${b.valueSol.toFixed(4)} SOL` : "nothing"));
  if (b.nextSell && b.valueSol) panel.append(row("Next sell", usd(b.nextSell), "#ef4444"));
  if (b.paused) panel.append(row("Buys", "paused", "#f59e0b"));
  else if ((b.target ?? 0) > (b.held ?? 0)) panel.append(row("Next buy", `now, ${b.target - b.held} of ${b.steps} steps`, "#22c55e"));
  else if (b.nextBuy) panel.append(row("Next buy", usd(b.nextBuy), "#22c55e"));
  if (b.inactive) panel.append(row("Status", "disabled, last known numbers", "#f59e0b"));
  const name = b.symbol ?? b.mint.slice(0, 6), actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;margin-top:7px";
  if (b.inactive) actions.append(button("Enable", () => send({ action: "enable", ...id }), "#22c55e"));
  else if (b.isolated) actions.append(button("Disable", () => send({ action: "disable", ...id }), "#f59e0b"));
  actions.append(
    b.paused ? button("Resume", () => send({ action: "resume", ...id })) : button("Pause", () => send({ action: "pause", ...id })),
    b.locked ? button("Unlock", () => send({ action: "unlock", ...id })) : button("Lock", () => send({ action: "lock", ...id })),
    button("Sell all", () => { if (confirm(`Sell ALL ${name} and stop this bot?`)) send({ action: "stop", ...id }); }, "#ef4444"));
  panel.append(actions);
  if (note) { const n = document.createElement("div"); n.textContent = note; n.style.cssText = "color:#8b95a1;margin-top:4px"; panel.append(n); }
  const grip = document.createElement("div"); grip.dataset.solard = "grip"; grip.title = "Drag to resize";
  grip.style.cssText = "position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 55%,#8b95a1 55%,#8b95a1 65%,transparent 65%,transparent 75%,#8b95a1 75%,#8b95a1 85%,transparent 85%)";
  panel.append(grip);
  panel.style.display = "block";
}
/** No bot on this coin: open a position from the panel. */
let opening = null;
function openForm(coin, wallet) {
  if (opening?.mint !== coin.mint) {
    const c = coin.capUsd; opening = { mint: coin.mint, buy: c ? money(c * 0.85) : "", sell: c ? money(c * 1.2) : "", steps: "3", size: "0.05" };
  }
  panel.replaceChildren();
  const title = document.createElement("div"); title.style.cssText = "font-weight:700;margin-bottom:4px;cursor:move;user-select:none;touch-action:none";
  title.dataset.solard = "title"; title.textContent = coin.symbol ?? coin.mint.slice(0, 6); panel.append(title);
  const list = document.createElement("div"); list.style.cssText = "max-height:150px;overflow:auto;margin:5px 0;border-top:1px solid #2a3038;border-bottom:1px solid #2a3038;padding:3px 0";
  const p = () => ({ buy: Number(opening.buy) * 1000, sell: Number(opening.sell) * 1000, steps: Number(opening.steps), size: Number(opening.size) });
  const ok = v => v.buy > 0 && v.sell > v.buy && Number.isInteger(v.steps) && v.steps >= 1 && v.steps <= 20 && v.size > 0 && v.size <= 5;
  const preview = () => { const v = p(); if (!ok(v)) { list.textContent = "need buy below sell, steps 1-20, size up to 5 SOL"; return; }
    list.replaceChildren(row(`${v.steps} steps`, `${(v.size / v.steps).toFixed(4)} SOL each`), ...globalThis.solardChartMath.stepLevels(v.buy, v.sell, v.steps).map((s, i) => row(`○ ${i + 1}`, `${usd(s.buy)} → ${usd(s.sell)}`)).reverse()); };
  const open = async () => {
    const v = p(); if (!ok(v)) { note = "fix the values first"; return openForm(coin, wallet); }
    if (!wallet) { note = "no wallet known yet"; return openForm(coin, wallet); }
    if (!confirm(`Open ${coin.symbol ?? coin.mint.slice(0, 6)}: ${usd(v.buy)} → ${usd(v.sell)} in ${v.steps} steps, ${v.size} SOL?`)) return;
    const r = await ask({ action: "add", wallet, mint: coin.mint, buy: v.buy, sell: v.sell, steps: v.steps, budget: v.size });
    note = r?.ok ? "position opened" : `failed: ${r?.error ?? "no reply"}`; tick();
  };
  const set = k => v => { opening[k] = v; preview(); };
  panel.append(row("Now", usd(coin.capUsd)), row("Status", "no position"), field("Buy from", opening.buy, "#22c55e", "k", set("buy"), open), field("Sell to", opening.sell, "#ef4444", "k", set("sell"), open),
    field("Steps", opening.steps, null, null, set("steps"), open), field("Size", opening.size, null, "SOL", set("size"), open), list);
  const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:5px;margin-top:6px"; actions.append(button("Open position", open, "#22c55e")); panel.append(actions);
  if (note) { const n = document.createElement("div"); n.textContent = note; n.style.cssText = "color:#8b95a1;margin-top:4px"; panel.append(n); }
  preview(); panel.style.display = "block";
}
function tick() {
  const addresses = [...new Set(location.href.match(ADDRESS) ?? [])];
  if (!addresses.length) { panel.style.display = "none"; window.postMessage({ solard: "range", bot: null }, location.origin); return; }
  chrome.runtime.sendMessage({ type: "range", addresses }, r => {
    if (chrome.runtime.lastError) return;
    if (!r?.ok) return message(r?.error === "no-token" ? "Solard: paste your bridge token in the extension popup" : `Solard: bridge not reachable (${r?.error ?? "no reply"})`);
    window.postMessage({ solard: "range", bot: r.bot }, location.origin);
    if (panel.contains(document.activeElement)) return; // never rebuild a field you are typing in
    if (r.bot) render(r.bot); else if (r.coin) openForm(r.coin, r.wallet); else message(`Solard: no bot on this coin (${addresses[0].slice(0, 6)})`);
  });
}
tick();
setInterval(tick, 5000);

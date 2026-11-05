/** Copy-to-clipboard buttons for addresses (no side effects on import). */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const copyIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>`;
/** Small copy button for an address; clicks are handled by installCopy (and never select the row). */
export const copyCell = (value: string, label = "", tag: "button" | "span" = "button") =>
  `<${tag} class="copy" data-copy="${esc(value)}" title="Copy ${esc(value)}">${label ? `<span class="num">${esc(label)}</span>` : ""}${copyIcon}</${tag}>`;
export function installCopy() {
  document.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    void navigator.clipboard.writeText(b.dataset.copy!).then(() => {
      b.classList.add("done"); const t = b.title; b.title = "Copied";
      setTimeout(() => { b.classList.remove("done"); b.title = t; }, 900);
    });
  }, true);
}

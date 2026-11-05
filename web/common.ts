/** Helpers shared by the Discovery and Wallets pages: formatting, bridge API, copy-to-clipboard. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
export const usd = (v?: number | null) => v == null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}k`;
export const ago = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)}h` : `${(ms / 86400_000).toFixed(1)}d`;

// The bridge token arrives once in the URL hash (link printed by slrd-bridge), then lives in localStorage.
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get("token")) localStorage.setItem("slrd.bridgeToken", hash.get("token")!);
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
export const token = localStorage.getItem("slrd.bridgeToken") ?? "";
export const api = async <T,>(path: string): Promise<T> => {
  if (!token) throw new Error("no bridge token: open the link printed by slrd-bridge once");
  const r = await fetch(path, { headers: { "x-slrd-token": token } });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? String(r.status)); return j as T;
};

export { copyCell, installCopy } from "./copy.ts";

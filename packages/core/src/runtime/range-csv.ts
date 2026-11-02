import { parseRangeFile } from "./range-file.ts";
import type { RangeSpec } from "./market-cap-band.ts";

/** CSV supports quoted cells, escaped quotes, CRLF, and UTF-8 BOM editor saves. */
function rows(text: string): string[][] {
  const result: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell.trim()); cell = ""; closed = false;
      if (c !== ',') { if (row.some(Boolean)) result.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else if (c === '"') {
      if (cell.trim() || closed) throw Error("Malformed quoted CSV cell");
      cell = ""; quoted = true;
    } else { if (closed && c.trim()) throw Error("Unexpected text after CSV quote"); cell += c; }
  }
  if (quoted) throw Error("Unterminated CSV quote");
  row.push(cell.trim()); if (row.some(Boolean)) result.push(row);
  return result;
}

export function parseRangeCsv(text: string, wallet: string, mint: string): RangeSpec {
  const table = rows(text), header = table.shift();
  const expected = ["wallet", "mint", "buy_mcap_usd", "sell_mcap_usd"];
  if (!header || header.length !== expected.length || new Set(header).size !== expected.length || expected.some(k => !header.includes(k)))
    throw Error(`Range CSV requires columns: ${expected.join(",")}`);
  const index = (name: string) => header.indexOf(name);
  const selected = table.filter(row => row[index("wallet")] === wallet && row[index("mint")] === mint);
  if (selected.length !== 1) throw Error(`Range CSV needs exactly one row for ${wallet}/${mint}; found ${selected.length}`);
  const row = selected[0]!;
  if (row.length !== header.length) throw Error("Range CSV row has incorrect column count");
  return parseRangeFile(JSON.stringify({ buyMarketCapUsd: row[index("buy_mcap_usd")], sellMarketCapUsd: row[index("sell_mcap_usd")] }));
}

/** Discover identities only; validate each row separately before starting it. */
export function rangeCsvIdentities(text: string): { wallet: string; mint: string }[] {
  const table = rows(text), header = table.shift();
  if (!header || header.length !== 4 || new Set(header).size !== 4 || ["wallet", "mint", "buy_mcap_usd", "sell_mcap_usd"].some(k => !header.includes(k)))
    throw Error("Invalid range CSV header");
  const found = new Map<string, { wallet: string; mint: string }>();
  for (const row of table) {
    const wallet = row[header.indexOf("wallet")] ?? "", mint = row[header.indexOf("mint")] ?? "";
    if (wallet && mint) found.set(JSON.stringify([wallet, mint]), { wallet, mint });
  }
  return [...found.values()];
}

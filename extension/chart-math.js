/* Pure helpers shared by the page script and its test. The chart may show price or market cap: the unit is whichever
 * the coin's current value falls inside the visible axis. Null when neither fits (then nothing wrong gets drawn). */
globalThis.solardChartMath = {
  unit(axis, capUsd, priceUsd) {
    const inside = v => v >= axis.from * 0.5 && v <= axis.to * 2;
    if (inside(capUsd)) return "cap";
    if (priceUsd && inside(priceUsd)) return "price";
    return null;
  },
  /** Every address-looking part of a page URL (sites use the coin or the pair, some in lowercase). */
  addressesIn(url) { return [...new Set(url.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [])]; },
  /** The bot for these URL addresses: exact, then ignoring case, then asking `lookup` which coin a pair belongs to. */
  async findBot(addresses, bots, lookup) {
    for (const a of addresses) { const b = bots.find(x => x.mint === a); if (b) return b; }
    for (const a of addresses) { const l = a.toLowerCase(), b = bots.find(x => x.mint.toLowerCase() === l); if (b) return b; }
    for (const a of addresses) { const mint = await lookup(a); const b = mint && bots.find(x => x.mint === mint); if (b) return b; }
    return null;
  },
  /** Keeps the panel's title bar reachable on any screen size and stops it being sized past usable limits. */
  panelBox(box, viewW, viewH) {
    const width = Math.max(180, Math.min(viewW, box.width ?? 236)), height = box.height == null ? null : Math.max(90, Math.min(viewH, box.height));
    return { left: Math.max(0, Math.min(viewW - width, box.left)), top: Math.max(0, Math.min(viewH - 30, box.top)), width, height };
  },
  /** The bot's steps, lowest first: each buys at `buy` and sells at `sell`, the next step's buy. */
  stepLevels(buy, sell, steps) {
    const gap = (sell - buy) / steps;
    return Array.from({ length: steps }, (_, i) => ({ buy: buy + gap * i, sell: buy + gap * (i + 1) }));
  },
  levels(bot, unit) {
    const k = unit === "cap" ? 1 : bot.capUsd > 0 ? bot.priceUsd / bot.capUsd : 0;
    return { buy: bot.buy * k, sell: bot.sell * k };
  },
};

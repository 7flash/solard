// Page world: finds the site's TradingView chart object and draws two horizontal lines through its own API, so they
// scroll and zoom with the chart. Sites that keep the widget private cannot be drawn on: the badge says so.
(() => {
  const m = globalThis.solardChartMath;
  let bot = null, shapes = [], key = "";
  const isWidget = o => { try { return !!o && typeof o === "object" && typeof o.activeChart === "function"; } catch { return false; } };
  function findWidget() {
    for (const n of ["tvWidget", "tradingViewWidget", "widget", "tvChart"]) if (isWidget(window[n])) return window[n];
    for (const n of Object.getOwnPropertyNames(window)) {
      let v; try { v = window[n]; } catch { continue; }
      if (isWidget(v)) return v;
    }
    return null;
  }
  const report = how => window.postMessage({ solard: "drawn", how }, location.origin);
  const clear = c => { for (const id of shapes) { try { c.removeEntity(id); } catch {} } shapes = []; };
  function draw() {
    let c = null; try { c = findWidget()?.activeChart() ?? null; } catch {}
    if (!c) return report("none");
    if (!bot) { clear(c); key = ""; return; }
    let axis = null; try { axis = c.getPanes()[0].getRightPriceScale().getVisiblePriceRange(); } catch {}
    const unit = axis ? m.unit(axis, bot.capUsd, bot.priceUsd) : null;
    if (!unit) return report("none");
    const k = `${bot.buy}:${bot.sell}:${unit}`;
    if (k !== key || !shapes.length) {
      clear(c); key = k;
      const lv = m.levels(bot, unit), time = Math.floor(Date.now() / 1000);
      for (const [price, text, color] of [[lv.buy, "BUY", "#22c55e"], [lv.sell, "SELL", "#ef4444"]]) {
        const id = c.createShape({ time, price }, { shape: "horizontal_line", lock: true, disableSelection: true, disableSave: true, disableUndo: true, overrides: { linecolor: color, linewidth: 2, showLabel: true, text, textcolor: color } });
        Promise.resolve(id).then(x => { if (x) shapes.push(x); }).catch(() => {});
      }
    }
    report("lines");
  }
  window.addEventListener("message", e => { if (e.source === window && e.data?.solard === "range") { bot = e.data.bot; try { draw(); } catch { report("none"); } } });
})();

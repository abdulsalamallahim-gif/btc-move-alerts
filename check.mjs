import fs from "node:fs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const testMode = process.env.TEST_MODE === "true";
const dryRun = process.env.DRY_RUN === "true";
const THRESHOLD = 500;
const STATE_FILE = "state.json";
const EMA_SPECS = [
  { tf: "4h", intervalMin: 240, label: "4h" },
  { tf: "1d", intervalMin: 1440, label: "daily" },
  { tf: "1w", intervalMin: 10080, label: "weekly" },
];
const EMA_PERIODS = [50, 100, 200];
const LEVELS = (process.env.LEVELS || "85394.91,81844.53,80801.65,80000,79500.79")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const TRENDLINE = { t1: 1790020800000, p1: 87446.7, t2: 1790553600000, p2: 85060.8 };
const TOUCH_ZONE = 75;
const REARM_DIST = 400;
const LINE_SCAN_MS = 45 * 60e3;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "btc-move-alerts/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function sendTelegram(text) {
  if (dryRun) {
    console.log(`[dry] ${text}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) throw new Error(`telegram send failed: ${JSON.stringify(data)}`);
}

async function getSpot() {
  const sources = [
    ["Kraken", async () => {
      const j = await getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
      const v = Number((j.result?.XXBTZUSD || j.result?.XBTUSD)?.c?.[0]);
      if (v > 0) return v;
      throw new Error("unexpected kraken payload");
    }],
    ["Coinbase", async () => {
      const j = await getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
      const v = Number(j.data?.amount);
      if (v > 0) return v;
      throw new Error("unexpected coinbase payload");
    }],
    ["CoinGecko", async () => {
      const j = await getJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      const v = Number(j.bitcoin?.usd);
      if (v > 0) return v;
      throw new Error("unexpected coingecko payload");
    }],
  ];
  let lastErr = null;
  for (const [name, load] of sources) {
    try {
      return { price: await load(), source: name };
    } catch (err) {
      lastErr = err;
      console.error(`${name} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error("no price source available");
}

async function fetchPath(sinceMs) {
  const now = Date.now();
  const spanMs = now - sinceMs;
  const sinceSec = Math.floor(sinceMs / 1000);
  let lastErr = null;

  try {
    const intervalMin = spanMs <= 55 * 3600e3 ? 5 : spanMs <= 30 * 24 * 3600e3 ? 60 : 1440;
    const j = await getJson(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${intervalMin}&since=${sinceSec}`);
    const rows = j.result && (j.result.XXBTZUSD || j.result.XBTUSD);
    if (!Array.isArray(rows)) throw new Error("unexpected kraken payload");
    return {
      source: "Kraken",
      intervalMs: intervalMin * 60e3,
      points: rows.map((c) => ({ t: Number(c[0]) * 1000, high: Number(c[2]), low: Number(c[3]) })),
    };
  } catch (err) {
    lastErr = err;
    console.error(`kraken scan failed: ${err.message}`);
  }

  try {
    const from = Math.floor(sinceMs / 1000);
    const to = Math.floor(now / 1000);
    const j = await getJson(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
    if (!Array.isArray(j.prices)) throw new Error("unexpected coingecko payload");
    const intervalMs = spanMs > 90 * 24 * 3600e3 ? 24 * 3600e3 : spanMs > 24 * 3600e3 ? 3600e3 : 5 * 60e3;
    return {
      source: "CoinGecko",
      intervalMs,
      points: j.prices.map((p) => ({ t: Number(p[0]), high: Number(p[1]), low: Number(p[1]) })),
    };
  } catch (err) {
    lastErr = err;
    console.error(`coingecko scan failed: ${err.message}`);
  }

  throw lastErr || new Error("no scan source available");
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const t = typeof s.anchorTime === "number" ? s.anchorTime : Date.parse(s.anchorTime);
    return {
      anchor: Number(s.anchor),
      anchorTime: Number.isFinite(t) ? t : 0,
      signals: s.signals && typeof s.signals === "object" && !Array.isArray(s.signals) ? s.signals : {},
      lines: s.lines && typeof s.lines === "object" && !Array.isArray(s.lines) ? s.lines : {},
    };
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function findCross(closed, emas, i) {
  if (i < 1 || !(emas[i] > 0) || !(emas[i - 1] > 0)) return null;
  const prevClose = closed[i - 1].close;
  const lastClose = closed[i].close;
  if (prevClose <= emas[i - 1] && lastClose > emas[i]) return "up";
  if (prevClose >= emas[i - 1] && lastClose < emas[i]) return "down";
  return null;
}

const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const lineAt = (t) => TRENDLINE.p1 + ((TRENDLINE.p2 - TRENDLINE.p1) * (t - TRENDLINE.t1)) / (TRENDLINE.t2 - TRENDLINE.t1);

async function checkEmas(signals) {
  let changed = false;
  for (const spec of EMA_SPECS) {
    const intervalMs = spec.intervalMin * 60e3;
    let closed;
    try {
      const j = await getJson(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${spec.intervalMin}`);
      const rows = j.result && (j.result.XXBTZUSD || j.result.XBTUSD);
      if (!Array.isArray(rows)) throw new Error("unexpected kraken payload");
      const now = Date.now();
      closed = rows
        .map((c) => ({ t: Number(c[0]) * 1000, close: Number(c[4]) }))
        .filter((c) => c.t + intervalMs <= now + 60000);
    } catch (err) {
      console.error(`${spec.tf} ema candles failed: ${err.message}`);
      continue;
    }
    if (closed.length < 3) {
      console.error(`${spec.tf} ema: not enough closed candles`);
      continue;
    }
    const closes = closed.map((c) => c.close);
    for (const period of EMA_PERIODS) {
      const key = `${spec.tf}-${period}`;
      const emas = emaSeries(closes, period);
      if (!(emas[closed.length - 1] > 0)) {
        console.error(`${key}: not enough history for EMA${period}`);
        continue;
      }

      if (!(key in signals)) {
        signals[key] = closed[closed.length - 1].t;
        changed = true;
        console.log(`${key}: baseline set (silent)`);
        continue;
      }

      let floor = Number(signals[key]) || 0;
      for (let i = Math.max(1, closed.length - 2); i < closed.length; i++) {
        const dir = findCross(closed, emas, i);
        if (dir && closed[i].t > floor) {
          const closeTime = closed[i].t + intervalMs;
          const when = spec.tf === "4h"
            ? `${hhmm(closeTime)} UTC`
            : `${new Date(closeTime).toISOString().slice(0, 16).replace("T", " ")} UTC`;
          await sendTelegram(
            `${dir === "up" ? "🟢" : "🔴"} BTC ${spec.label} closed ${dir === "up" ? "above" : "below"} EMA${period}: $${fmt(closed[i].close)} vs EMA $${fmt(emas[i])} (candle closed ${when}).`
          );
          signals[key] = closed[i].t;
          floor = closed[i].t;
          changed = true;
          console.log(`${key}: ${dir}-cross at ${new Date(closed[i].t).toISOString()} (close ${closed[i].close} vs ema ${emas[i].toFixed(2)})`);
        }
      }
    }
  }
  return changed;
}

async function checkLines(linesState, spot) {
  let changed = false;
  let candles;
  try {
    const j = await getJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5");
    const rows = j.result && (j.result.XXBTZUSD || j.result.XBTUSD);
    if (!Array.isArray(rows)) throw new Error("unexpected kraken payload");
    const cutoff = Date.now() - LINE_SCAN_MS;
    candles = rows
      .map((c) => ({ t: Number(c[0]) * 1000, high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }))
      .filter((c) => c.t >= cutoff);
    if (!candles.length) throw new Error("no recent candles");
  } catch (err) {
    console.error(`lines candles failed: ${err.message}`);
    return false;
  }

  const targets = [];
  for (const level of LEVELS) {
    targets.push({ key: `level:${level}`, label: `the $${fmt(level)} level`, valueAt: () => level, valueNow: level, isLine: false });
  }
  targets.push({ key: "trendline", label: "the downtrend line", valueAt: (t) => lineAt(t), valueNow: lineAt(Date.now()), isLine: true });

  for (const target of targets) {
    if (!(target.key in linesState)) {
      linesState[target.key] = { armed: true };
      changed = true;
      console.log(`${target.key}: armed`);
    }
    const st = linesState[target.key];
    if (typeof st.seenUntil !== "number") {
      st.seenUntil = Date.now();
      changed = true;
    }
    const dist = Math.abs(spot - target.valueNow);
    if (!st.armed && dist > REARM_DIST) {
      st.armed = true;
      st.seenUntil = Date.now();
      changed = true;
      console.log(`${target.key}: re-armed (price is $${fmt(dist)} away; old candles ignored)`);
    }
    if (!st.armed) continue;
    const hit = candles.find((c) => {
      if (c.t <= st.seenUntil) return false;
      const lv = target.valueAt(c.t + 150e3);
      return c.low <= lv + TOUCH_ZONE && c.high >= lv - TOUCH_ZONE;
    });
    if (!hit) continue;
    const lv = target.valueAt(hit.t + 150e3);
    const above = hit.close > lv;
    await sendTelegram(
      `${above ? "🟢" : "🔴"} BTC touched ${target.label} (~$${fmt(lv)}); candle closed ${above ? "above" : "below"} it (low $${fmt(hit.low)}, high $${fmt(hit.high)}, now $${fmt(spot)}) (Kraken BTC/USD, ${hhmm(hit.t)}-${hhmm(hit.t + 300e3)} UTC).`
    );
    st.armed = false;
    st.seenUntil = hit.t;
    changed = true;
    console.log(`${target.key}: touched (candle ${hhmm(hit.t)} UTC, target $${lv.toFixed(2)}, close ${hit.close})`);
  }
  return changed;
}

async function main() {
  if (testMode) {
    await sendTelegram("Test from your GitHub-cloud BTC watcher: it is live and will alert you on moves of $500 or more, 24/7. No PC needed.");
    console.log("test message sent");
    return;
  }

  const { price: spot, source: spotSource } = await getSpot();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const prev = readState();

  let anchor = prev && prev.anchor > 0 ? prev.anchor : 0;
  let anchorTime = prev && prev.anchorTime > 0 ? prev.anchorTime : 0;
  const signals = { ...(prev ? prev.signals : {}) };
  const lines = { ...(prev ? prev.lines : {}) };
  let changed = false;

  if (!(anchor > 0) || !(anchorTime > 0)) {
    anchor = spot;
    anchorTime = now;
    changed = true;
    console.log(`baseline saved: anchor $${spot} (${spotSource}) at ${nowIso}`);
  } else {
    try {
      const path = await fetchPath(anchorTime);
      const points = path.points.filter((p) => p.t >= anchorTime);
      const fromAnchor = anchor;
      let steps = 0;
      let lastPoint = null;
      for (const p of points) {
        let stepped = true;
        while (stepped && steps < 20) {
          stepped = false;
          if (p.high >= anchor + THRESHOLD) {
            anchor += THRESHOLD;
            anchorTime = p.t + path.intervalMs;
            lastPoint = p;
            steps++;
            stepped = true;
            continue;
          }
          if (p.low <= anchor - THRESHOLD) {
            anchor -= THRESHOLD;
            anchorTime = p.t + path.intervalMs;
            lastPoint = p;
            steps++;
            stepped = true;
          }
        }
      }
      if (steps > 0 && anchor !== fromAnchor && lastPoint) {
        const moved = anchor - fromAnchor;
        const win = `${hhmm(lastPoint.t)}-${hhmm(lastPoint.t + path.intervalMs)} UTC`;
        await sendTelegram(
          `${moved > 0 ? "🟢" : "🔴"} BTC moved ${moved > 0 ? "+" : "-"}$${Math.abs(moved).toFixed(0)} from the last alert price: $${fmt(fromAnchor)} -> $${fmt(anchor)} (now $${fmt(spot)}) (${path.source} BTC/USD, ${win}).`
        );
        changed = true;
        console.log(`move ALERT once (${steps} steps), $${fromAnchor} -> $${anchor} (${path.source}, ${points.length} points scanned)`);
      } else if (steps > 0) {
        changed = true;
        console.log(`move round-trip (${steps} steps), anchor unchanged at $${anchor}; no text`);
      } else {
        console.log(`ok: no $${THRESHOLD} touch since ${new Date(anchorTime).toISOString()}; spot $${spot} vs anchor $${anchor} (${spotSource}, ${points.length} points scanned)`);
      }
    } catch (err) {
      console.error(`scan failed (${err.message}); falling back to spot check`);
      const delta = spot - anchor;
      if (Math.abs(delta) >= THRESHOLD) {
        const dir = delta > 0 ? "up" : "down";
        await sendTelegram(
          `${delta > 0 ? "🟢" : "🔴"} BTC ${dir} $${Math.abs(delta).toFixed(0)} from the last alert price: $${fmt(anchor)} -> $${fmt(spot)} (${spotSource} BTC/USD, ${nowIso}).`
        );
        anchor = spot;
        anchorTime = now;
        changed = true;
        console.log(`ALERT (fallback) ${dir} $${delta.toFixed(2)}`);
      } else {
        console.log(`ok (fallback): $${spot} vs anchor $${anchor} (delta ${delta.toFixed(2)})`);
      }
    }
  }

  try {
    const emaChanged = await checkEmas(signals);
    if (emaChanged) changed = true;
  } catch (err) {
    console.error(`ema section failed: ${err.message}`);
  }

  try {
    const linesChanged = await checkLines(lines, spot);
    if (linesChanged) changed = true;
  } catch (err) {
    console.error(`lines section failed: ${err.message}`);
  }

  if (changed) {
    writeState({ anchor, anchorTime, signals, lines });
    console.log(`state updated (anchor $${anchor}, ${Object.keys(signals).length} signals, ${Object.keys(lines).length} lines tracked)`);
  }
}

main().catch((err) => {
  console.error("error:", err.message);
  process.exit(1);
});

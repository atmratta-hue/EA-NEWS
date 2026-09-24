import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Biquote from "biquote";

dotenv.config();

const app = express();
const bq = new Biquote();

const PORT = Number(process.env.PORT || 3000);

const ALLOWED_SYMBOLS = new Set(["XAUUSD", "BTCUSD"]);

const INTERVALS = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  H1: "1h",
  H4: "4h"
};

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace("OANDA:", "")
    .replace("BITSTAMP:", "");
}

function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function formatPrice(value, symbol = "XAUUSD") {
  const number = toNumber(value, 0);

  if (symbol === "BTCUSD") {
    return number.toFixed(2);
  }

  return number.toFixed(2);
}

function getOpen(bar) {
  return toNumber(
    bar?.open ??
    bar?.o ??
    bar?.close ??
    bar?.c
  );
}

function getClose(bar) {
  return toNumber(
    bar?.close ??
    bar?.c ??
    bar?.price ??
    bar?.mid
  );
}

function getHigh(bar) {
  return toNumber(
    bar?.high ??
    bar?.h ??
    bar?.close ??
    bar?.c
  );
}

function getLow(bar) {
  return toNumber(
    bar?.low ??
    bar?.l ??
    bar?.close ??
    bar?.c
  );
}

function getVolume(bar) {
  return toNumber(
    bar?.volume ??
    bar?.v ??
    0
  );
}

function average(values) {
  if (!values.length) return 0;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateEMA(values, period) {
  if (!values.length) return 0;

  if (values.length < period) {
    return average(values);
  }

  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  const recent = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < recent.length; i++) {
    const change = recent[i] - recent[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

function calculateATR(bars, period = 14) {
  if (bars.length < 2) {
    return 0;
  }

  const trueRanges = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    const high = getHigh(current);
    const low = getLow(current);
    const previousClose = getClose(previous);

    const trueRange = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trueRanges.push(trueRange);
  }

  return average(trueRanges.slice(-period));
}

function getTrend(closes) {
  if (closes.length < 20) {
    return "sideway";
  }

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  if (ema20 > ema50) return "bullish";
  if (ema20 < ema50) return "bearish";

  return "sideway";
}

function calculateLevels(bars, symbol) {
  const recent = bars.slice(-100);
  const highs = recent.map(getHigh).filter((v) => v > 0);
  const lows = recent.map(getLow).filter((v) => v > 0);
  const closes = recent.map(getClose).filter((v) => v > 0);

  const price = closes[closes.length - 1] || 0;
  const atr = calculateATR(recent);

  if (!highs.length || !lows.length) {
    return {
      res2: price,
      res1: price,
      poc: price,
      sup1: price,
      sup2: price,
      atr
    };
  }

  const sortedHighs = [...highs].sort((a, b) => a - b);
  const sortedLows = [...lows].sort((a, b) => a - b);

  const res1 = sortedHighs[Math.floor(sortedHighs.length * 0.65)] || price;
  const res2 = sortedHighs[Math.floor(sortedHighs.length * 0.9)] || price;
  const sup1 = sortedLows[Math.floor(sortedLows.length * 0.35)] || price;
  const sup2 = sortedLows[Math.floor(sortedLows.length * 0.1)] || price;

  const volumeMap = new Map();
  const step = Math.max(atr * 0.1, symbol === "BTCUSD" ? 10 : 0.1);

  recent.forEach((bar) => {
    const close = getClose(bar);
    const volume = getVolume(bar);

    if (close <= 0) return;

    const zone = Math.round(close / step) * step;
    volumeMap.set(zone, (volumeMap.get(zone) || 0) + volume);
  });

  const poc = [...volumeMap.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] || price;

  return {
    res2,
    res1,
    poc,
    sup1,
    sup2,
    atr
  };
}

function candleConfirmation(bars, direction) {
  if (bars.length < 2) return false;

  const previous = bars[bars.length - 2];
  const current = bars[bars.length - 1];

  const prevOpen = getOpen(previous);
  const prevClose = getClose(previous);

  const currOpen = getOpen(current);
  const currClose = getClose(current);
  const currHigh = getHigh(current);
  const currLow = getLow(current);

  const body = Math.abs(currClose - currOpen);
  const upperWick = currHigh - Math.max(currOpen, currClose);
  const lowerWick = Math.min(currOpen, currClose) - currLow;

  if (direction === "BUY") {
    const bullishCandle = currClose > currOpen;
    const bullishEngulfing = currClose > prevOpen && currOpen < prevClose;
    const supportRejection = lowerWick > body * 1.2;

    return bullishCandle || bullishEngulfing || supportRejection;
  }

  if (direction === "SELL") {
    const bearishCandle = currClose < currOpen;
    const bearishEngulfing = currClose < prevOpen && currOpen > prevClose;
    const resistanceRejection = upperWick > body * 1.2;

    return bearishCandle || bearishEngulfing || resistanceRejection;
  }

  return false;
}

function analyzeTimeframe(bars, symbol) {
  const closes = bars.map(getClose).filter((v) => v > 0);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(bars, 14);
  const levels = calculateLevels(bars, symbol);

  const volumes = bars.slice(-20).map(getVolume).filter((v) => v > 0);
  const avgVolume = average(volumes);
  const currentVolume = getVolume(bars[bars.length - 1]);

  return {
    trend: getTrend(closes),
    ema20,
    ema50,
    rsi,
    atr,
    volumeIncreasing: avgVolume > 0 && currentVolume >= avgVolume,
    candleBullish: candleConfirmation(bars, "BUY"),
    candleBearish: candleConfirmation(bars, "SELL"),
    support: {
      low: levels.sup2,
      high: levels.sup1
    },
    resistance: {
      low: levels.res1,
      high: levels.res2
    },
    poc: levels.poc
  };
}

function calculateMarketBias(timeframes) {
  const values = Object.values(timeframes);

  const bullish = values.filter((it) => it.trend === "bullish").length;
  const bearish = values.filter((it) => it.trend === "bearish").length;

  if (bullish >= 3) return "BUY";
  if (bearish >= 3) return "SELL";

  return "WAIT";
}

function calculateScore({ direction, timeframes, nearZone, candleConfirmed }) {
  let score = 0;

  const trendMatches = Object.values(timeframes).filter((item) => {
    if (direction === "BUY") return item.trend === "bullish";
    if (direction === "SELL") return item.trend === "bearish";
    return false;
  }).length;

  score += trendMatches * 15;

  if (nearZone) score += 15;
  if (candleConfirmed) score += 15;

  const main = timeframes.m15;

  if (direction === "BUY" && main.rsi >= 35 && main.rsi <= 68) score += 15;
  if (direction === "SELL" && main.rsi >= 32 && main.rsi <= 65) score += 15;

  if (direction === "BUY" && main.ema20 > main.ema50) score += 10;
  if (direction === "SELL" && main.ema20 < main.ema50) score += 10;

  if (main.volumeIncreasing) score += 10;

  return Math.min(99, Math.max(0, score));
}

function calculateEntryScore(entryPrice, zoneLow, zoneHigh, atr) {
  const middle = (zoneLow + zoneHigh) / 2;
  const zoneWidth = Math.max(zoneHigh - zoneLow, atr * 0.1);
  const distance = Math.abs(entryPrice - middle);

  const score = 100 - (distance / zoneWidth) * 20;

  return Math.round(Math.min(95, Math.max(50, score)));
}

function createEntryNodes(direction, zone, atr, baseScore, symbol) {
  if (!zone) return [];

  const low = toNumber(zone.low);
  const high = toNumber(zone.high);
  const range = Math.max(high - low, 0);

  let entries = [];

  if (direction === "BUY") {
    entries = [
      { label: "BUY ไม้ 1", price: high, zoneType: "Support Edge" },
      { label: "BUY ไม้ 2", price: high - range * 0.5, zoneType: "Support Midpoint" },
      { label: "BUY ไม้ 3", price: low, zoneType: "Order Block Low" }
    ];
  }

  if (direction === "SELL") {
    entries = [
      { label: "SELL ไม้ 1", price: low, zoneType: "Resistance Edge" },
      { label: "SELL ไม้ 2", price: low + range * 0.5, zoneType: "FVG Midpoint" },
      { label: "SELL ไม้ 3", price: high, zoneType: "Order Block High" }
    ];
  }

  return entries.map((entry) => ({
    ...entry,
    price: formatPrice(entry.price, symbol),
    score: Math.round(
      (calculateEntryScore(entry.price, low, high, atr) + baseScore) / 2
    )
  }));
}

function createTargets(direction, currentPrice, atr, zone, higherZone, symbol) {
  const price = toNumber(currentPrice);
  const volatility = Math.max(toNumber(atr), price * 0.001);

  if (!zone) {
    return {
      tp1: formatPrice(price, symbol),
      tp2: formatPrice(price, symbol),
      tp3: formatPrice(price, symbol),
      sl: formatPrice(price, symbol)
    };
  }

  const low = toNumber(zone.low);
  const high = toNumber(zone.high);

  if (direction === "BUY") {
    const entry = (low + high) / 2;
    const sl = low - volatility * 0.8;
    const risk = Math.max(entry - sl, volatility);

    const tp1 = entry + risk * 1.0;
    const tp2 = entry + risk * 1.5;
    const tp3 = Math.max(tp2, toNumber(higherZone?.high, entry + risk * 2.2));

    return {
      tp1: formatPrice(tp1, symbol),
      tp2: formatPrice(tp2, symbol),
      tp3: formatPrice(tp3, symbol),
      sl: formatPrice(sl, symbol)
    };
  }

  if (direction === "SELL") {
    const entry = (low + high) / 2;
    const sl = high + volatility * 0.8;
    const risk = Math.max(sl - entry, volatility);

    const tp1 = entry - risk * 1.0;
    const tp2 = entry - risk * 1.5;
    const tp3 = Math.min(tp2, toNumber(higherZone?.low, entry - risk * 2.2));

    return {
      tp1: formatPrice(tp1, symbol),
      tp2: formatPrice(tp2, symbol),
      tp3: formatPrice(tp3, symbol),
      sl: formatPrice(sl, symbol)
    };
  }

  return {
    tp1: formatPrice(price, symbol),
    tp2: formatPrice(price, symbol),
    tp3: formatPrice(price, symbol),
    sl: formatPrice(price, symbol)
  };
}

function buildEntryAnalysis(symbol, currentPrice, timeframes) {
  const bias = calculateMarketBias(timeframes);
  const main = timeframes.m15;
  const higher = timeframes.h1;

  const price = toNumber(currentPrice);
  const atr = Math.max(toNumber(main.atr), price * 0.001);

  let selectedZone = null;
  let higherZone = null;
  let zoneType = "WAIT FOR CONFIRMATION";

  if (bias === "BUY") {
    selectedZone = {
      low: toNumber(main.support.low),
      high: toNumber(main.support.high)
    };

    higherZone = {
      low: toNumber(higher.resistance.low),
      high: toNumber(higher.resistance.high)
    };

    zoneType = "SUPPORT / DEMAND ZONE";
  }

  if (bias === "SELL") {
    selectedZone = {
      low: toNumber(main.resistance.low),
      high: toNumber(main.resistance.high)
    };

    higherZone = {
      low: toNumber(higher.support.low),
      high: toNumber(higher.support.high)
    };

    zoneType = "RESISTANCE / SUPPLY ZONE";
  }

  let nearZone = false;

  if (selectedZone) {
    const buffer = atr * 0.35;

    nearZone =
      price >= selectedZone.low - buffer &&
      price <= selectedZone.high + buffer;
  }

  const candleConfirmed =
    bias === "BUY"
      ? main.candleBullish
      : bias === "SELL"
        ? main.candleBearish
        : false;

  const score =
    bias === "WAIT"
      ? 0
      : calculateScore({
          direction: bias,
          timeframes,
          nearZone,
          candleConfirmed
        });

  const activeSignal = bias !== "WAIT" && nearZone;

  const entries = activeSignal
    ? createEntryNodes(bias, selectedZone, atr, score, symbol)
    : [];

  const targets = activeSignal
    ? createTargets(bias, price, atr, selectedZone, higherZone, symbol)
    : {
        tp1: formatPrice(price, symbol),
        tp2: formatPrice(price, symbol),
        tp3: formatPrice(price, symbol),
        sl: formatPrice(price, symbol)
      };

  let status = "WAIT";

  if (bias !== "WAIT" && !nearZone) {
    status = "WAIT FOR PULLBACK";
  }

  if (activeSignal) {
    status = bias === "BUY" ? "BUY" : "SELL";
  }

  return {
    bias,
    status,
    activeSignal,
    zoneType,
    confidence: score,
    entries,
    targets,
    currentPrice: formatPrice(price, symbol),
    analysis: {
      nearZone,
      candleConfirmed,
      atr: formatPrice(atr, symbol),
      updatedAt: new Date().toISOString()
    }
  };
}

function serializeTimeframe(data, symbol) {
  return {
    trend: data.trend,
    ema20: formatPrice(data.ema20, symbol),
    ema50: formatPrice(data.ema50, symbol),
    rsi: Number(data.rsi.toFixed(2)),
    atr: formatPrice(data.atr, symbol),
    support: {
      low: formatPrice(data.support.low, symbol),
      high: formatPrice(data.support.high, symbol)
    },
    resistance: {
      low: formatPrice(data.resistance.low, symbol),
      high: formatPrice(data.resistance.high, symbol)
    },
    poc: formatPrice(data.poc, symbol)
  };
}

async function getBars(symbol, interval) {
  const bars = await bq.ohlc(symbol, {
    interval,
    limit: 300
  });

  if (!Array.isArray(bars) || bars.length < 30) {
    throw new Error(`ข้อมูลแท่งเทียน ${symbol} ${interval} ไม่เพียงพอ`);
  }

  return bars;
}

async function getNews() {
  try {
    const events = await bq.calendar({
      importance: "high",
      countries: "US,EU,GB"
    });

    const list = Array.isArray(events) ? events.slice(0, 10) : [];

    return {
      overallImpact: list.length ? "HIGH IMPACT" : "NO DATA",
      badgeStyle: list.length ? "negative" : "neutral",
      overallDesc: list.length
        ? "มีข่าวสำคัญ ควรระวังความผันผวน"
        : "ไม่พบข่าวสำคัญในขณะนี้",
      newsList: list.map((item) => ({
        source: item.country || item.source || "Economic Calendar",
        title: item.title || item.event || "Economic Event",
        reason: item.description || item.impact || "High impact event",
        link: item.link || "#",
        sentiment: "neutral"
      }))
    };
  } catch (error) {
    console.error("Calendar Error:", error);

    return {
      overallImpact: "WAIT",
      badgeStyle: "neutral",
      overallDesc: "ไม่สามารถโหลด Economic Calendar ได้",
      newsList: []
    };
  }
}

app.get("/api/dashboard-data", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const timeframe = String(req.query.tf || "M15").toUpperCase();

    if (!ALLOWED_SYMBOLS.has(symbol)) {
      return res.status(400).json({
        error: "รองรับเฉพาะ XAUUSD และ BTCUSD เท่านั้น"
      });
    }

    const selectedInterval = INTERVALS[timeframe] || INTERVALS.M15;

    const [tick, selectedBars, m5Bars, m15Bars, h1Bars, h4Bars, dailyNews] =
      await Promise.all([
        bq.tick(symbol),
        getBars(symbol, selectedInterval),
        getBars(symbol, INTERVALS.M5),
        getBars(symbol, INTERVALS.M15),
        getBars(symbol, INTERVALS.H1),
        getBars(symbol, INTERVALS.H4),
        getNews()
      ]);

    const timeframes = {
      m5: analyzeTimeframe(m5Bars, symbol),
      m15: analyzeTimeframe(m15Bars, symbol),
      h1: analyzeTimeframe(h1Bars, symbol),
      h4: analyzeTimeframe(h4Bars, symbol)
    };

    const selectedAnalysis = analyzeTimeframe(selectedBars, symbol);

    const lastClose = getClose(selectedBars[selectedBars.length - 1]);
    const marketPrice = toNumber(tick?.mid, lastClose);

    const entryAnalysis = buildEntryAnalysis(symbol, marketPrice, timeframes);

    const bias = entryAnalysis.bias;
    const main = timeframes.m15;

    let recommendation =
      "รอให้แนวโน้มของหลาย Timeframe สอดคล้องกัน";

    if (bias === "BUY" && !entryAnalysis.activeSignal) {
      recommendation = "แนวโน้มขาขึ้น รอราคาย่อตัวเข้าสู่โซน BUY";
    }

    if (bias === "SELL" && !entryAnalysis.activeSignal) {
      recommendation = "แนวโน้มขาลง รอราคาดีดเข้าสู่โซน SELL";
    }

    if (bias === "BUY" && entryAnalysis.activeSignal) {
      recommendation = "ราคาอยู่ในโซน BUY รอแท่งเทียนยืนยัน";
    }

    if (bias === "SELL" && entryAnalysis.activeSignal) {
      recommendation = "ราคาอยู่ในโซน SELL รอแท่งเทียนยืนยัน";
    }

    const trendText =
      bias === "BUY" ? "ขาขึ้น" :
      bias === "SELL" ? "ขาลง" :
      "Sideway / รอการยืนยัน";

    res.json({
      symbol,
      timeframe,
      interval: selectedInterval,
      updatedAt: new Date().toISOString(),

      price: formatPrice(marketPrice, symbol),

      tradeZone: entryAnalysis.status,

      signal: {
        detail:
          `โครงสร้าง: ${trendText} | ` +
          `สถานะ: ${entryAnalysis.status} | ` +
          `M15 RSI: ${main.rsi.toFixed(2)} | ` +
          `EMA20: ${formatPrice(main.ema20, symbol)} | ` +
          `EMA50: ${formatPrice(main.ema50, symbol)}`,

        recommendation,
        direction: entryAnalysis.activeSignal ? bias : "WAIT",
        confidence: entryAnalysis.confidence
      },

      tradeSetup: {
        buyPoint:
          entryAnalysis.bias === "BUY" && entryAnalysis.entries[0]
            ? entryAnalysis.entries[0].price
            : formatPrice(main.support.high, symbol),

        sellPoint:
          entryAnalysis.bias === "SELL" && entryAnalysis.entries[0]
            ? entryAnalysis.entries[0].price
            : formatPrice(main.resistance.low, symbol),

        tpLevel: entryAnalysis.targets.tp1,
        slLevel: entryAnalysis.targets.sl
      },

      srLevels: {
        res2: formatPrice(main.resistance.high, symbol),
        res1: formatPrice(main.resistance.low, symbol),
        poc: formatPrice(main.poc, symbol),
        sup1: formatPrice(main.support.high, symbol),
        sup2: formatPrice(main.support.low, symbol)
      },

      indicators: {
        ema20: formatPrice(selectedAnalysis.ema20, symbol),
        ema50: formatPrice(selectedAnalysis.ema50, symbol),
        rsi: Number(selectedAnalysis.rsi.toFixed(2)),
        atr: formatPrice(selectedAnalysis.atr, symbol)
      },

      marketStructure: {
        m5: serializeTimeframe(timeframes.m5, symbol),
        m15: serializeTimeframe(timeframes.m15, symbol),
        h1: serializeTimeframe(timeframes.h1, symbol),
        h4: serializeTimeframe(timeframes.h4, symbol)
      },

      entryAnalysis,
      dailyNews
    });
  } catch (error) {
    console.error("Dashboard API Error:", error);

    res.status(500).json({
      error: "ไม่สามารถดึงหรือวิเคราะห์ข้อมูลตลาดได้",
      detail: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
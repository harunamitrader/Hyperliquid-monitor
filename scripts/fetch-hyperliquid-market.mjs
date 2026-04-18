const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
const DEX_NAME = "xyz";
const CANDLE_INTERVAL = "15m";
const CANDLE_WINDOW_HOURS = 24;

const REQUEST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent": "hyperliquid-monitor/0.1",
};

let assetContextsPromise = null;
const l2BookPromises = new Map();
const candlePromises = new Map();

function parseNumber(value) {
  if (value == null) {
    return null;
  }

  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

async function fetchInfo(body) {
  const response = await fetch(INFO_ENDPOINT, {
    method: "POST",
    headers: REQUEST_HEADERS,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Hyperliquid info API failed: ${response.status} ${response.statusText} ${text}`,
    );
  }

  return response.json();
}

async function getAssetContexts() {
  if (!assetContextsPromise) {
    assetContextsPromise = fetchInfo({
      type: "metaAndAssetCtxs",
      dex: DEX_NAME,
    }).then((payload) => {
      const universe = payload?.[0]?.universe;
      const contexts = payload?.[1];

      if (!Array.isArray(universe) || !Array.isArray(contexts)) {
        throw new Error("Hyperliquid metaAndAssetCtxs の形式が不正です。");
      }

      return new Map(
        universe.map((asset, index) => [
          asset.name,
          {
            asset,
            context: contexts[index] ?? {},
          },
        ]),
      );
    });
  }

  return assetContextsPromise;
}

function pickContextPrice(context) {
  return (
    parseNumber(context.midPx) ??
    parseNumber(context.markPx) ??
    parseNumber(context.oraclePx)
  );
}

async function fetchL2Book(coin) {
  if (!l2BookPromises.has(coin)) {
    l2BookPromises.set(
      coin,
      fetchInfo({
        type: "l2Book",
        coin,
      }).catch(() => null),
    );
  }

  return l2BookPromises.get(coin);
}

function getBookSidePrice(book, sideIndex) {
  const level = book?.levels?.[sideIndex]?.[0];
  return parseNumber(level?.px);
}

async function fetchCandles(coin) {
  const now = Date.now();
  const endTime = Math.ceil(now / 60000) * 60000;
  const startTime = endTime - CANDLE_WINDOW_HOURS * 60 * 60 * 1000;
  const key = `${coin}:${CANDLE_INTERVAL}:${startTime}:${endTime}`;

  if (!candlePromises.has(key)) {
    candlePromises.set(
      key,
      fetchInfo({
        type: "candleSnapshot",
        req: {
          coin,
          interval: CANDLE_INTERVAL,
          startTime,
          endTime,
        },
      }).catch(() => []),
    );
  }

  return candlePromises.get(key);
}

function summarizeCandles(candles) {
  const highs = [];
  const lows = [];

  for (const candle of candles || []) {
    const high = parseNumber(candle.h);
    const low = parseNumber(candle.l);

    if (high != null) {
      highs.push(high);
    }

    if (low != null) {
      lows.push(low);
    }
  }

  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
  };
}

async function loadSourceMarket(coin) {
  const contexts = await getAssetContexts();
  const entry = contexts.get(coin);

  if (!entry) {
    throw new Error(`Hyperliquid 銘柄が見つかりません: ${coin}`);
  }

  const { context } = entry;
  const [book, candles] = await Promise.all([
    fetchL2Book(coin),
    fetchCandles(coin),
  ]);
  const bestBid = getBookSidePrice(book, 0);
  const bestAsk = getBookSidePrice(book, 1);
  const currentPrice =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : pickContextPrice(context);
  const baselinePrice = parseNumber(context.prevDayPx);
  const candleSummary = summarizeCandles(candles);

  return {
    coin,
    bid: bestBid ?? parseNumber(context.impactPxs?.[0]),
    offer: bestAsk ?? parseNumber(context.impactPxs?.[1]),
    currentPrice,
    baselinePrice,
    high: candleSummary.high,
    low: candleSummary.low,
    candles,
    context,
  };
}

function computeChange(currentPrice, baselinePrice) {
  if (currentPrice == null || baselinePrice == null) {
    return {
      pageChange: null,
      pageChangePercent: null,
    };
  }

  const pageChange = round(currentPrice - baselinePrice, 6);
  return {
    pageChange,
    pageChangePercent:
      baselinePrice === 0 ? null : round((pageChange / baselinePrice) * 100, 6),
  };
}

function buildBaseRecord(market, detail) {
  const currentPrice = round(detail.currentPrice, 6);
  const pageBaselinePrice = round(detail.baselinePrice, 6);
  const change = computeChange(currentPrice, pageBaselinePrice);

  return {
    id: market.id,
    marketId: market.marketId,
    name: market.name,
    url: market.url,
    bid: round(detail.bid, 6),
    offer: round(detail.offer, 6),
    currentPrice,
    pageBaselinePrice,
    pageChange: change.pageChange,
    pageChangePercent: change.pageChangePercent,
    high: round(detail.high, 6),
    low: round(detail.low, 6),
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

function combineCandleProducts(leftCandles, rightCandles) {
  const rightByTime = new Map((rightCandles || []).map((candle) => [candle.t, candle]));
  const values = [];

  for (const left of leftCandles || []) {
    const right = rightByTime.get(left.t);
    if (!right) {
      continue;
    }

    const leftHigh = parseNumber(left.h);
    const rightHigh = parseNumber(right.h);
    const leftLow = parseNumber(left.l);
    const rightLow = parseNumber(right.l);

    if (leftHigh != null && rightHigh != null) {
      values.push(leftHigh * rightHigh);
    }

    if (leftLow != null && rightLow != null) {
      values.push(leftLow * rightLow);
    }
  }

  return {
    high: values.length ? Math.max(...values) : null,
    low: values.length ? Math.min(...values) : null,
  };
}

async function fetchDerivedMarket(market) {
  if (market.derived?.operation !== "multiply") {
    throw new Error(`未対応の派生銘柄です: ${market.id}`);
  }

  const sourceCoins = market.derived.sources || [];
  if (sourceCoins.length !== 2) {
    throw new Error(`派生銘柄のsourcesは2銘柄にしてください: ${market.id}`);
  }

  const [left, right] = await Promise.all(sourceCoins.map(loadSourceMarket));
  const currentPrice =
    left.currentPrice != null && right.currentPrice != null
      ? left.currentPrice * right.currentPrice
      : null;
  const baselinePrice =
    left.baselinePrice != null && right.baselinePrice != null
      ? left.baselinePrice * right.baselinePrice
      : null;
  const highLow = combineCandleProducts(left.candles, right.candles);

  return buildBaseRecord(market, {
    bid: left.bid != null && right.bid != null ? left.bid * right.bid : null,
    offer:
      left.offer != null && right.offer != null ? left.offer * right.offer : null,
    currentPrice,
    baselinePrice,
    high: highLow.high,
    low: highLow.low,
  });
}

export async function fetchMarketPage(market) {
  if (market.derived) {
    return fetchDerivedMarket(market);
  }

  return buildBaseRecord(market, await loadSourceMarket(market.marketId));
}

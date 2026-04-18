import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMarketPage } from "./fetch-hyperliquid-market.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const MARKETS_FILE = path.join(ROOT_DIR, "data", "markets.json");
const OUTPUT_FILE = path.join(ROOT_DIR, "docs", "data", "latest.json");
const CHART_OUTPUT_FILE = path.join(ROOT_DIR, "docs", "data", "chart-series.json");
const SNAPSHOT_FILE = path.join(ROOT_DIR, "data", "snapshots", "latest-run.json");
const HISTORY_DIR = path.join(ROOT_DIR, "data", "history");
const HISTORY_INDEX_FILE = path.join(HISTORY_DIR, "index.json");
const BASELINE_STATE_FILE = path.join(
  ROOT_DIR,
  "data",
  "snapshots",
  "baselines.json",
);
const TIME_ZONE = "Asia/Tokyo";
const BASELINE_STATE_VERSION = 3;
const SPARKLINE_WINDOW_HOURS = 24;
const DETAIL_WINDOW_HOURS = 72;
const CHART_HISTORY_FILE_COUNT = 4;

function resolveNow() {
  const raw = process.env.BUILD_NOW;
  if (!raw) {
    return new Date();
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`BUILD_NOW の日時が不正です: ${raw}`);
  }

  return parsed;
}

function round(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function getLocalTimeParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function getDateKeyInfo(dateKey, timezone) {
  const parts = getLocalTimeParts(new Date(`${dateKey}T12:00:00.000Z`), timezone);
  const normalizedDateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const isWeekend = parts.weekday === "Sat" || parts.weekday === "Sun";

  return {
    dateKey: normalizedDateKey,
    weekday: parts.weekday,
    isWeekend,
    isFriday: parts.weekday === "Fri",
  };
}

function shiftDateKey(dateKey, days, timezone) {
  const base = new Date(`${dateKey}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return getDateKeyInfo(
    `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(
      base.getUTCDate(),
    ).padStart(2, "0")}`,
    timezone,
  ).dateKey;
}

function findPreviousWeekdayDateKey(dateKey, timezone) {
  let cursor = shiftDateKey(dateKey, -1, timezone);
  while (true) {
    const info = getDateKeyInfo(cursor, timezone);
    if (!info.isWeekend) {
      return info.dateKey;
    }
    cursor = shiftDateKey(cursor, -1, timezone);
  }
}

function findLastFridayDateKey(dateKey, timezone) {
  let cursor = shiftDateKey(dateKey, -1, timezone);
  while (true) {
    const info = getDateKeyInfo(cursor, timezone);
    if (info.isFriday) {
      return info.dateKey;
    }
    cursor = shiftDateKey(cursor, -1, timezone);
  }
}

function isAtOrAfterCutover(parts, market) {
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const cutoverHour = Number(market.baselineCutoverHourLocal ?? 0);
  const cutoverMinute = Number(market.baselineCutoverMinuteLocal ?? 0);

  return hour > cutoverHour || (hour === cutoverHour && minute >= cutoverMinute);
}

function getSessionInfo(date, market) {
  const parts = getLocalTimeParts(date, market.baselineTimezone);
  const localDateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const sessionDateKey = isAtOrAfterCutover(parts, market)
    ? shiftDateKey(localDateKey, 1, market.baselineTimezone)
    : localDateKey;

  return getDateKeyInfo(sessionDateKey, market.baselineTimezone);
}

function getBaselineMode(sessionInfo) {
  if (sessionInfo.isWeekend) {
    return {
      mode: "friday_close",
      labelJa: "金曜終値",
    };
  }

  return {
    mode: "previous_close",
    labelJa: "前日終値",
  };
}

function normalizeCloseSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  return {
    date: snapshot.date ?? null,
    weekday: snapshot.weekday ?? null,
    closePrice:
      snapshot.closePrice == null ? null : round(Number(snapshot.closePrice)),
    capturedAt: snapshot.capturedAt ?? null,
    seeded: Boolean(snapshot.seeded),
  };
}

function hasCloseSnapshot(snapshot) {
  return snapshot?.closePrice != null;
}

function normalizeMarketState(state, market) {
  return {
    timezone: market.baselineTimezone,
    cutoverHourLocal: market.baselineCutoverHourLocal,
    cutoverMinuteLocal: market.baselineCutoverMinuteLocal,
    cutoverLabelJa: market.baselineCutoverLabelJa,
    currentSession: normalizeCloseSnapshot(state?.currentSession),
    previousClose: normalizeCloseSnapshot(state?.previousClose),
    fridayClose: normalizeCloseSnapshot(state?.fridayClose),
  };
}

function normalizeSnapshotState(state, markets) {
  if (state?.version === BASELINE_STATE_VERSION && state?.markets) {
    return {
      version: BASELINE_STATE_VERSION,
      markets: Object.fromEntries(
        markets.map((market) => [
          market.id,
          normalizeMarketState(state.markets?.[market.id], market),
        ]),
      ),
    };
  }

  return {
    version: BASELINE_STATE_VERSION,
    markets: Object.fromEntries(
      markets.map((market) => [
        market.id,
        {
          timezone: market.baselineTimezone,
          cutoverHourLocal: market.baselineCutoverHourLocal,
          cutoverMinuteLocal: market.baselineCutoverMinuteLocal,
          cutoverLabelJa: market.baselineCutoverLabelJa,
          currentSession: null,
          previousClose: null,
          fridayClose: null,
        },
      ]),
    ),
  };
}

function startMarketSession(sessionInfo) {
  return {
    date: sessionInfo.dateKey,
    weekday: sessionInfo.weekday,
    closePrice: null,
    capturedAt: null,
    seeded: false,
  };
}

function rollMarketState(state, sessionInfo) {
  if (!state.currentSession) {
    state.currentSession = startMarketSession(sessionInfo);
    return state;
  }

  if (state.currentSession.date === sessionInfo.dateKey) {
    state.currentSession.weekday = sessionInfo.weekday;
    return state;
  }

  const completedSession = state.currentSession;
  const completedWeekday = completedSession.weekday;
  const isCompletedWeekday =
    completedWeekday !== "Sat" && completedWeekday !== "Sun";

  if (isCompletedWeekday && hasCloseSnapshot(completedSession)) {
    state.previousClose = {
      ...completedSession,
      weekday: completedWeekday,
    };

    if (completedWeekday === "Fri") {
      state.fridayClose = {
        ...completedSession,
        weekday: completedWeekday,
      };
    }
  }

  state.currentSession = startMarketSession(sessionInfo);
  return state;
}

function updateCurrentSessionCloseCandidate(state, market, capturedAt) {
  if (!state.currentSession || market.stale || market.currentPrice == null) {
    return state;
  }

  state.currentSession.closePrice = market.currentPrice;
  state.currentSession.capturedAt = capturedAt;
  state.currentSession.seeded = false;
  return state;
}

function buildSeededCloseSnapshot(market, capturedAt) {
  if (market.stale || market.pageBaselinePrice == null) {
    return null;
  }

  return {
    date: null,
    weekday: null,
    closePrice: market.pageBaselinePrice,
    capturedAt,
    seeded: true,
  };
}

function seedMissingMarketBaselines(state, market, baselineMode, sessionInfo, capturedAt) {
  const seededSnapshot = buildSeededCloseSnapshot(market, capturedAt);
  if (!seededSnapshot) {
    return state;
  }

  if (!hasCloseSnapshot(state.previousClose)) {
    const previousDate = findPreviousWeekdayDateKey(
      sessionInfo.dateKey,
      state.timezone,
    );
    const previousInfo = getDateKeyInfo(previousDate, state.timezone);
    state.previousClose = {
      ...seededSnapshot,
      date: previousDate,
      weekday: previousInfo.weekday,
    };
  }

  const previousDate = state.previousClose?.date;
  const fridayDate = findLastFridayDateKey(sessionInfo.dateKey, state.timezone);
  const canSeedFriday =
    baselineMode.mode === "friday_close" || previousDate === fridayDate;

  if (!hasCloseSnapshot(state.fridayClose) && canSeedFriday) {
    const fridayInfo = getDateKeyInfo(fridayDate, state.timezone);
    state.fridayClose = {
      ...seededSnapshot,
      date: fridayDate,
      weekday: fridayInfo.weekday,
    };
  }

  return state;
}

function selectSnapshotBaseline(state, baselineMode) {
  const source =
    baselineMode.mode === "friday_close" ? state.fridayClose : state.previousClose;

  if (!hasCloseSnapshot(source)) {
    return null;
  }

  return {
    date: source.date,
    weekday: source.weekday,
    closePrice: source.closePrice,
    capturedAt: source.capturedAt,
    seeded: Boolean(source.seeded),
  };
}

function applyBaseline(record, baselineMode, snapshotBaseline) {
  const baseRecord = {
    id: record.id,
    marketId: record.marketId,
    name: record.name,
    url: record.url,
    bid: record.bid,
    offer: record.offer,
    currentPrice: record.currentPrice,
    high: record.high,
    low: record.low,
    stale: record.stale,
    fetchedAt: record.fetchedAt,
    baselineMode: baselineMode.mode,
    baselineLabelJa: baselineMode.labelJa,
    baselineTimezone: record.baselineTimezone,
    baselineCutoverHourLocal: record.baselineCutoverHourLocal,
    baselineCutoverMinuteLocal: record.baselineCutoverMinuteLocal,
    baselineCutoverLabelJa: record.baselineCutoverLabelJa,
    error: record.error,
  };

  if (snapshotBaseline?.closePrice != null && record.currentPrice != null) {
    const baselinePrice = round(snapshotBaseline.closePrice);
    const change = round(record.currentPrice - baselinePrice);
    const changePercent =
      baselinePrice === 0 ? null : round((change / baselinePrice) * 100);

    return {
      ...baseRecord,
      baselinePrice,
      change,
      changePercent,
      baselineSource: snapshotBaseline.seeded
        ? "snapshot-seeded"
        : "snapshot-close",
      baselineSnapshotDate: snapshotBaseline.date,
      baselineSnapshotCapturedAt: snapshotBaseline.capturedAt,
    };
  }

  return {
    ...baseRecord,
    baselinePrice: record.pageBaselinePrice,
    change: record.pageChange,
    changePercent: record.pageChangePercent,
    baselineSource: "source-prev-day",
    baselineSnapshotDate: null,
    baselineSnapshotCapturedAt: null,
  };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function loadMarkets() {
  const markets = await readJson(MARKETS_FILE, []);
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("data/markets.json に監視対象がありません。");
  }

  for (const market of markets) {
    if (
      !market.baselineTimezone ||
      market.baselineCutoverHourLocal == null ||
      market.baselineCutoverMinuteLocal == null ||
      !market.baselineCutoverLabelJa
    ) {
      throw new Error(`baseline 設定が不足しています: ${market.id}`);
    }
  }

  return markets;
}

function createFallbackRecord(market, previousRecord, reason) {
  if (previousRecord) {
    return {
      id: previousRecord.id ?? market.id,
      marketId: previousRecord.marketId ?? market.marketId,
      name: previousRecord.name ?? market.name,
      url: previousRecord.url ?? market.url,
      bid: previousRecord.bid ?? null,
      offer: previousRecord.offer ?? null,
      currentPrice: previousRecord.currentPrice ?? null,
      pageBaselinePrice:
        previousRecord.pageBaselinePrice ?? previousRecord.baselinePrice ?? null,
      pageChange: previousRecord.pageChange ?? previousRecord.change ?? null,
      pageChangePercent:
        previousRecord.pageChangePercent ?? previousRecord.changePercent ?? null,
      high: previousRecord.high ?? null,
      low: previousRecord.low ?? null,
      stale: true,
      error: reason,
      fetchedAt: new Date().toISOString(),
      baselineTimezone:
        previousRecord.baselineTimezone ?? market.baselineTimezone ?? null,
      baselineCutoverHourLocal:
        previousRecord.baselineCutoverHourLocal ??
        market.baselineCutoverHourLocal ??
        null,
      baselineCutoverMinuteLocal:
        previousRecord.baselineCutoverMinuteLocal ??
        market.baselineCutoverMinuteLocal ??
        null,
      baselineCutoverLabelJa:
        previousRecord.baselineCutoverLabelJa ??
        market.baselineCutoverLabelJa ??
        null,
    };
  }

  return {
    id: market.id,
    marketId: market.marketId,
    name: market.name,
    url: market.url,
    bid: null,
    offer: null,
    currentPrice: null,
    pageBaselinePrice: null,
    pageChange: null,
    pageChangePercent: null,
    high: null,
    low: null,
    stale: true,
    error: reason,
    fetchedAt: new Date().toISOString(),
    baselineTimezone: market.baselineTimezone,
    baselineCutoverHourLocal: market.baselineCutoverHourLocal,
    baselineCutoverMinuteLocal: market.baselineCutoverMinuteLocal,
    baselineCutoverLabelJa: market.baselineCutoverLabelJa,
  };
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

function buildHistoryRun(payload) {
  return {
    updatedAt: payload.updatedAt,
    baselineMode: payload.baselineMode,
    baselineLabelJa: payload.baselineLabelJa,
    source: payload.source,
    marketCount: payload.markets.length,
    markets: payload.markets.map((market) => ({
      id: market.id,
      marketId: market.marketId,
      name: market.name,
      url: market.url,
      bid: market.bid,
      offer: market.offer,
      currentPrice: market.currentPrice,
      baselinePrice: market.baselinePrice,
      change: market.change,
      changePercent: market.changePercent,
      high: market.high,
      low: market.low,
      baselineMode: market.baselineMode,
      baselineLabelJa: market.baselineLabelJa,
      baselineTimezone: market.baselineTimezone,
      baselineCutoverHourLocal: market.baselineCutoverHourLocal,
      baselineCutoverMinuteLocal: market.baselineCutoverMinuteLocal,
      baselineCutoverLabelJa: market.baselineCutoverLabelJa,
      baselineSource: market.baselineSource,
      baselineSnapshotDate: market.baselineSnapshotDate ?? null,
      stale: Boolean(market.stale),
      fetchedAt: market.fetchedAt,
      error: market.error ?? null,
    })),
  };
}

async function appendHistory(payload, nowInfo) {
  await ensureDirectory(HISTORY_DIR);

  const historyFile = path.join(HISTORY_DIR, `${nowInfo.dateKey}.json`);
  const historyPayload = await readJson(historyFile, {
    date: nowInfo.dateKey,
    timezone: TIME_ZONE,
    runs: [],
  });

  const run = buildHistoryRun(payload);
  const existingRunIndex = historyPayload.runs.findIndex(
    (entry) => entry.updatedAt === run.updatedAt,
  );

  if (existingRunIndex >= 0) {
    historyPayload.runs[existingRunIndex] = run;
  } else {
    historyPayload.runs.push(run);
    historyPayload.runs.sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
  }

  historyPayload.date = nowInfo.dateKey;
  historyPayload.timezone = TIME_ZONE;
  historyPayload.runCount = historyPayload.runs.length;
  historyPayload.latestUpdatedAt = run.updatedAt;

  await writeJson(historyFile, historyPayload);

  const historyIndex = await readJson(HISTORY_INDEX_FILE, {
    timezone: TIME_ZONE,
    files: [],
  });

  const nextIndexEntry = {
    date: historyPayload.date,
    file: `data/history/${nowInfo.dateKey}.json`,
    runCount: historyPayload.runCount,
    latestUpdatedAt: historyPayload.latestUpdatedAt,
  };

  const existingIndex = historyIndex.files.findIndex(
    (entry) => entry.date === nextIndexEntry.date,
  );

  if (existingIndex >= 0) {
    historyIndex.files[existingIndex] = nextIndexEntry;
  } else {
    historyIndex.files.push(nextIndexEntry);
    historyIndex.files.sort((left, right) => left.date.localeCompare(right.date));
  }

  historyIndex.timezone = TIME_ZONE;
  historyIndex.updatedAt = payload.updatedAt;

  await writeJson(HISTORY_INDEX_FILE, historyIndex);
}

function pickChartPrice(market) {
  if (market.currentPrice == null || !Number.isFinite(Number(market.currentPrice))) {
    return null;
  }

  return round(Number(market.currentPrice));
}

function dedupeChartPoints(points) {
  const byTimestamp = new Map();

  for (const point of points) {
    byTimestamp.set(point.t, point);
  }

  return [...byTimestamp.values()].sort((left, right) => left.t.localeCompare(right.t));
}

async function buildChartSeriesPayload(now) {
  const historyIndex = await readJson(HISTORY_INDEX_FILE, {
    timezone: TIME_ZONE,
    files: [],
  });
  const recentEntries = [...(historyIndex.files || [])].slice(-CHART_HISTORY_FILE_COUNT);
  const historyFiles = await Promise.all(
    recentEntries.map((entry) =>
      readJson(path.join(ROOT_DIR, entry.file), {
        date: entry.date,
        timezone: TIME_ZONE,
        runs: [],
      }),
    ),
  );

  const detailCutoff = now.getTime() - DETAIL_WINDOW_HOURS * 60 * 60 * 1000;
  const sparklineCutoff = now.getTime() - SPARKLINE_WINDOW_HOURS * 60 * 60 * 1000;
  const pointsByMarket = new Map();

  for (const historyFile of historyFiles) {
    for (const run of historyFile.runs || []) {
      const updatedMs = Date.parse(run.updatedAt);
      if (!Number.isFinite(updatedMs) || updatedMs < detailCutoff) {
        continue;
      }

      for (const market of run.markets || []) {
        const price = pickChartPrice(market);
        if (price == null) {
          continue;
        }

        if (!pointsByMarket.has(market.id)) {
          pointsByMarket.set(market.id, []);
        }

        pointsByMarket.get(market.id).push({
          t: run.updatedAt,
          price,
          stale: Boolean(market.stale),
        });
      }
    }
  }

  const markets = Object.fromEntries(
    [...pointsByMarket.entries()].map(([marketId, rawPoints]) => {
      const points72h = dedupeChartPoints(rawPoints);
      const points24h = points72h.filter(
        (point) => Date.parse(point.t) >= sparklineCutoff,
      );

      return [
        marketId,
        {
          points24h,
          points72h,
        },
      ];
    }),
  );

  return {
    updatedAt: now.toISOString(),
    timezone: TIME_ZONE,
    sparklineWindowHours: SPARKLINE_WINDOW_HOURS,
    detailWindowHours: DETAIL_WINDOW_HOURS,
    markets,
  };
}

function summarizeBaselinePayload(markets) {
  const uniqueModes = new Map();

  for (const market of markets) {
    const key = `${market.baselineMode}:${market.baselineLabelJa}`;
    uniqueModes.set(key, {
      mode: market.baselineMode,
      labelJa: market.baselineLabelJa,
    });
  }

  if (uniqueModes.size === 1) {
    return [...uniqueModes.values()][0];
  }

  return {
    mode: "mixed",
    labelJa: "銘柄別",
  };
}

async function main() {
  const now = resolveNow();
  const nowIso = now.toISOString();
  const nowInfo = getDateKeyInfo(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(now)
      .replaceAll("/", "-"),
    TIME_ZONE,
  );
  const markets = await loadMarkets();
  const marketConfigMap = new Map(markets.map((market) => [market.id, market]));
  const previous = await readJson(OUTPUT_FILE, { markets: [] });
  const baselineState = normalizeSnapshotState(
    await readJson(BASELINE_STATE_FILE, {}),
    markets,
  );
  const previousMap = new Map(
    (previous.markets || []).map((market) => [market.id, market]),
  );

  const settled = await Promise.allSettled(
    markets.map(async (market) => {
      const detail = await fetchMarketPage(market);
      return {
        ...detail,
        baselineTimezone: market.baselineTimezone,
        baselineCutoverHourLocal: market.baselineCutoverHourLocal,
        baselineCutoverMinuteLocal: market.baselineCutoverMinuteLocal,
        baselineCutoverLabelJa: market.baselineCutoverLabelJa,
      };
    }),
  );

  const rawMarkets = settled.map((result, index) => {
    const market = markets[index];

    if (result.status === "fulfilled") {
      return result.value;
    }

    const reason =
      result.reason instanceof Error ? result.reason.message : String(result.reason);
    return createFallbackRecord(market, previousMap.get(market.id), reason);
  });

  const nextBaselineState = {
    version: BASELINE_STATE_VERSION,
    markets: {},
  };

  const normalizedMarkets = rawMarkets.map((market) => {
    const marketConfig = marketConfigMap.get(market.id) ?? market;
    const marketState = normalizeMarketState(
      baselineState.markets?.[market.id],
      marketConfig,
    );
    const sessionInfo = getSessionInfo(now, marketConfig);
    const baselineMode = getBaselineMode(sessionInfo);

    rollMarketState(marketState, sessionInfo);
    seedMissingMarketBaselines(
      marketState,
      market,
      baselineMode,
      sessionInfo,
      nowIso,
    );
    updateCurrentSessionCloseCandidate(marketState, market, nowIso);

    nextBaselineState.markets[market.id] = marketState;

    const snapshotBaseline = selectSnapshotBaseline(marketState, baselineMode);
    return applyBaseline(market, baselineMode, snapshotBaseline);
  });

  const baselineSummary = summarizeBaselinePayload(normalizedMarkets);
  const payload = {
    updatedAt: nowIso,
    timezone: TIME_ZONE,
    baselineMode: baselineSummary.mode,
    baselineLabelJa: baselineSummary.labelJa,
    source: "hyperliquid.xyz",
    markets: normalizedMarkets,
  };

  await writeJson(OUTPUT_FILE, payload);
  await writeJson(SNAPSHOT_FILE, payload);
  await writeJson(BASELINE_STATE_FILE, nextBaselineState);
  await appendHistory(payload, nowInfo);
  await writeJson(CHART_OUTPUT_FILE, await buildChartSeriesPayload(now));

  const freshCount = normalizedMarkets.filter((market) => !market.stale).length;
  const staleCount = normalizedMarkets.length - freshCount;
  console.log(
    `Updated ${freshCount} markets${staleCount ? `, stale ${staleCount}` : ""}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

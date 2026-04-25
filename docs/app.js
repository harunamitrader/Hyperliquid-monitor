const DATA_URL = "./data/latest.json";
const CHART_DATA_URL = "./data/chart-series.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const REFRESH_INTERVAL_MS = 30 * 1000;

const marketGrid = document.querySelector("#market-grid");
const summaryText = document.querySelector("#summary-text");
const updatedAt = document.querySelector("#updated-at");
const template = document.querySelector("#market-card-template");
const chartDialog = document.querySelector("#chart-dialog");
const chartDialogTitle = document.querySelector("#chart-dialog-title");
const chartDialogCaption = document.querySelector("#chart-dialog-caption");
const chartDialogMeta = document.querySelector("#chart-dialog-meta");
const chartDialogSvg = document.querySelector("#chart-dialog-svg");
const chartDialogStart = document.querySelector("#chart-dialog-start");
const chartDialogEnd = document.querySelector("#chart-dialog-end");

const MARKET_GROUPS = [
  {
    key: "stock-indices",
    label: "株価指数",
    ids: ["sp500", "nasdaq100", "jp225"],
  },
  {
    key: "commodities",
    label: "商品",
    ids: ["gold", "silver", "platinum", "copper", "wti-oil", "natural-gas"],
  },
  {
    key: "fx",
    label: "為替",
    ids: ["usdjpy", "eurjpy", "eurusd"],
  },
  {
    key: "crypto",
    label: "暗号資産",
    ids: ["bitcoin", "ethereum"],
  },
];

const appState = {
  latestPayload: null,
  chartPayload: null,
  activeChartMarketId: null,
};

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatSigned(value, digits = 2, suffix = "") {
  if (value == null || Number.isNaN(value)) {
    return "--";
  }

  const formatted = formatNumber(Math.abs(value), digits);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatted}${suffix}`;
}

function formatUpdatedAt(value, timezone) {
  if (!value) {
    return "更新時刻なし";
  }

  const formatted = new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

  return `${formatted} JST`;
}

function formatChartTime(value, timezone, withDate = true) {
  if (!value) {
    return "--";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    month: withDate ? "2-digit" : undefined,
    day: withDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function applyMoveClass(node, value) {
  node.classList.remove("is-positive", "is-negative");

  if (value > 0) {
    node.classList.add("is-positive");
  } else if (value < 0) {
    node.classList.add("is-negative");
  }
}

function createSvgNode(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);

  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }

  return node;
}

function getChartPoints(chartPayload, marketId, seriesKey) {
  return chartPayload?.markets?.[marketId]?.[seriesKey] ?? [];
}

function summarizeSeries(points) {
  if (!points.length) {
    return null;
  }

  const prices = points.map((point) => point.price);
  const latest = points.at(-1);

  return {
    start: points[0],
    end: latest,
    latest: latest.price,
    high: Math.max(...prices),
    low: Math.min(...prices),
  };
}

function getPriceDigits(points) {
  const maxPrice = Math.max(...points.map((point) => Math.abs(point.price)));

  if (maxPrice >= 10000) {
    return 0;
  }

  if (maxPrice >= 1000) {
    return 1;
  }

  if (maxPrice >= 100) {
    return 2;
  }

  return 4;
}

function niceNumber(value, roundResult) {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let niceFraction;

  if (roundResult) {
    if (fraction < 1.5) {
      niceFraction = 1;
    } else if (fraction < 3) {
      niceFraction = 2;
    } else if (fraction < 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  } else if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }

  return niceFraction * 10 ** exponent;
}

function getNicePriceScale(min, max, tickCount = 5) {
  const range = Math.max(max - min, 1e-9);
  const step = niceNumber(range / Math.max(tickCount - 1, 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];

  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }

  return {
    min: niceMin,
    max: niceMax,
    step,
    ticks,
  };
}

function getNiceTimeTicks(minTimestamp, maxTimestamp, targetCount = 8) {
  const intervals = [
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
    2 * 60 * 60 * 1000,
    3 * 60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ];
  const span = Math.max(maxTimestamp - minTimestamp, 1);
  const interval =
    intervals.find((candidate) => span / candidate <= targetCount - 1) ??
    intervals.at(-1);
  const firstTick = Math.ceil(minTimestamp / interval) * interval;
  const ticks = [];

  for (let value = firstTick; value <= maxTimestamp; value += interval) {
    ticks.push(value);
  }

  return ticks.length > 1 ? ticks : [minTimestamp, maxTimestamp];
}

function buildChartGeometry(
  points,
  width,
  height,
  padding,
  _referencePrices = [],
  priceScale = null,
) {
  if (!points.length) {
    return null;
  }

  const timestamps = points.map((point) => Date.parse(point.t));
  const prices = points.map((point) => point.price);
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);
  const actualMinPrice = Math.min(...prices);
  const actualMaxPrice = Math.max(...prices);
  const pricePadding =
    actualMinPrice === actualMaxPrice
      ? Math.max(Math.abs(actualMinPrice) * 0.002, 1)
      : 0;
  const computedMinPrice = actualMinPrice - pricePadding;
  const computedMaxPrice = actualMaxPrice + pricePadding;
  const minPrice = priceScale?.min ?? computedMinPrice;
  const maxPrice = priceScale?.max ?? computedMaxPrice;
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const timeSpan = Math.max(maxTimestamp - minTimestamp, 1);
  const priceSpan = Math.max(maxPrice - minPrice, Number.EPSILON);

  return {
    minTimestamp,
    maxTimestamp,
    minPrice,
    maxPrice,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    coords: points.map((point, index) => {
      const x = plotLeft + ((timestamps[index] - minTimestamp) / timeSpan) * plotWidth;
      const y =
        plotBottom - ((prices[index] - minPrice) / priceSpan) * plotHeight;

      return { x, y, point };
    }),
  };
}

function buildPolyline(coords) {
  return coords.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function splitCoordsByTimestamp(coords, cutoffTimestamp) {
  if (!cutoffTimestamp || !Number.isFinite(cutoffTimestamp)) {
    return {
      before: coords,
      after: [],
    };
  }

  const before = [];
  const after = [];

  for (const coord of coords) {
    if (Date.parse(coord.point.t) <= cutoffTimestamp) {
      before.push(coord);
    } else {
      after.push(coord);
    }
  }

  if (before.length && after.length) {
    after.unshift(before.at(-1));
  }

  return { before, after };
}

function getPriceY(geometry, value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }

  const ratio =
    geometry.maxPrice === geometry.minPrice
      ? 0.5
      : (Number(value) - geometry.minPrice) / (geometry.maxPrice - geometry.minPrice);
  const clampedRatio = Math.min(Math.max(ratio, 0), 1);

  return geometry.plotBottom - clampedRatio * geometry.plotHeight;
}

function appendReferenceLines(svg, geometry, referenceLines = []) {
  let lastLabelY = null;

  for (const line of referenceLines) {
    const y = getPriceY(geometry, line.value);
    if (y == null) {
      continue;
    }

    svg.append(
      createSvgNode("line", {
        x1: geometry.plotLeft,
        y1: y.toFixed(2),
        x2: geometry.plotRight,
        y2: y.toFixed(2),
        class: `chart-reference-line ${line.className}`,
      }),
    );

    if (line.label) {
      let labelY = y - 4;
      if (lastLabelY != null && Math.abs(labelY - lastLabelY) < 12) {
        labelY = lastLabelY - 12;
      }

      svg.append(
        createSvgNode("text", {
          x: geometry.plotRight - 4,
          y: labelY.toFixed(2),
          "text-anchor": "end",
          class: `chart-reference-label ${line.className}`,
        }),
      );
      svg.lastChild.textContent = line.label;
      lastLabelY = labelY;
    }
  }
}

function createTicks(min, max, count) {
  if (count <= 1) {
    return [min];
  }

  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function renderEmptyChart(svg, width, height, message = "履歴なし") {
  svg.replaceChildren();
  svg.classList.add("is-empty");
  svg.append(
    createSvgNode("text", {
      x: width / 2,
      y: height / 2,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      class: "chart-empty-text",
    }),
  );
  svg.lastChild.textContent = message;
}

function renderSparkline(svg, points, options = {}) {
  const width = options.width ?? 192;
  const height = options.height ?? 108;
  const geometry = buildChartGeometry(points, width, height, {
    top: options.paddingTop ?? 8,
    right: options.paddingRight ?? 8,
    bottom: options.paddingBottom ?? 8,
    left: options.paddingLeft ?? 8,
  }, (options.referenceLines || []).map((line) => line.value));

  if (!geometry) {
    renderEmptyChart(svg, width, height);
    return;
  }

  svg.replaceChildren();
  svg.classList.toggle("is-empty", points.length < 2);

  appendReferenceLines(svg, geometry, options.referenceLines);

  const segments = splitCoordsByTimestamp(
    geometry.coords,
    options.highlightAfter ? Date.parse(options.highlightAfter) : null,
  );

  if (segments.before.length > 1) {
    svg.append(
      createSvgNode("polyline", {
        points: buildPolyline(segments.before),
        class: "chart-line",
      }),
    );
  }

  if (segments.after.length > 1) {
    svg.append(
      createSvgNode("polyline", {
        points: buildPolyline(segments.after),
        class: "chart-line chart-line-current",
      }),
    );
  }
}

function renderDetailedChart(svg, points, timezone, options = {}) {
  const width = options.width ?? 800;
  const height = options.height ?? 450;
  const padding = {
    top: options.paddingTop ?? 18,
    right: options.paddingRight ?? 12,
    bottom: options.paddingBottom ?? 38,
    left: options.paddingLeft ?? 64,
  };
  const referencePrices = (options.referenceLines || []).map((line) => line.value);
  const baseGeometry = buildChartGeometry(
    points,
    width,
    height,
    padding,
    referencePrices,
  );

  if (!baseGeometry) {
    renderEmptyChart(svg, width, height, "72時間の履歴なし");
    return;
  }

  const priceScale = getNicePriceScale(
    baseGeometry.minPrice,
    baseGeometry.maxPrice,
    5,
  );
  const geometry = buildChartGeometry(
    points,
    width,
    height,
    padding,
    referencePrices,
    priceScale,
  );

  svg.replaceChildren();
  svg.classList.toggle("is-empty", points.length < 2);

  const priceDigits = getPriceDigits(points);
  const yTicks = priceScale.ticks;
  const xTicks = getNiceTimeTicks(geometry.minTimestamp, geometry.maxTimestamp, 8);

  for (const tickValue of yTicks) {
    const ratio =
      geometry.maxPrice === geometry.minPrice
        ? 0.5
        : (tickValue - geometry.minPrice) / (geometry.maxPrice - geometry.minPrice);
    const y = geometry.plotBottom - ratio * geometry.plotHeight;

    svg.append(
      createSvgNode("line", {
        x1: geometry.plotLeft,
        y1: y.toFixed(2),
        x2: geometry.plotRight,
        y2: y.toFixed(2),
        class: "chart-grid-line",
      }),
    );

    svg.append(
      createSvgNode("text", {
        x: geometry.plotLeft - 8,
        y: (y + 4).toFixed(2),
        "text-anchor": "end",
        class: "chart-axis-label",
      }),
    );
    svg.lastChild.textContent = formatNumber(tickValue, priceDigits);
  }

  for (const tickValue of xTicks) {
    const ratio =
      geometry.maxTimestamp === geometry.minTimestamp
        ? 0.5
        : (tickValue - geometry.minTimestamp) /
          (geometry.maxTimestamp - geometry.minTimestamp);
    const x = geometry.plotLeft + ratio * geometry.plotWidth;

    svg.append(
      createSvgNode("line", {
        x1: x.toFixed(2),
        y1: geometry.plotTop,
        x2: x.toFixed(2),
        y2: geometry.plotBottom,
        class: "chart-grid-line",
      }),
    );

    svg.append(
      createSvgNode("text", {
        x: x.toFixed(2),
        y: height - 10,
        "text-anchor": "middle",
        class: "chart-axis-label",
      }),
    );
    svg.lastChild.textContent = formatChartTime(new Date(tickValue), timezone);
  }

  appendReferenceLines(svg, geometry, options.referenceLines);

  const segments = splitCoordsByTimestamp(
    geometry.coords,
    options.highlightAfter ? Date.parse(options.highlightAfter) : null,
  );

  if (segments.before.length > 1) {
    svg.append(
      createSvgNode("polyline", {
        points: buildPolyline(segments.before),
        class: "chart-line",
      }),
    );
  }

  if (segments.after.length > 1) {
    svg.append(
      createSvgNode("polyline", {
        points: buildPolyline(segments.after),
        class: "chart-line chart-line-current",
      }),
    );
  }
}

function updateChartDialog(market, chartPayload, timezone) {
  const points = getChartPoints(chartPayload, market.id, "points72h");
  const summary = summarizeSeries(points);

  chartDialogTitle.textContent = market.name;
  chartDialogCaption.textContent =
    chartPayload?.detailWindowLabelJa ??
    `過去${chartPayload?.detailWindowHours ?? 72}時間`;

  if (!summary) {
    chartDialogMeta.textContent = "チャート履歴がまだありません。";
    chartDialogStart.textContent = "";
    chartDialogEnd.textContent = "";
    renderDetailedChart(chartDialogSvg, [], timezone);
  } else {
    const priceDigits = getPriceDigits(points);
    chartDialogMeta.textContent =
      `最新 ${formatNumber(summary.latest, priceDigits)} / 高値 ${formatNumber(summary.high, priceDigits)} / 安値 ${formatNumber(summary.low, priceDigits)}`;
    chartDialogStart.textContent = formatChartTime(summary.start.t, timezone);
    chartDialogEnd.textContent = formatChartTime(summary.end.t, timezone);
    renderDetailedChart(chartDialogSvg, points, timezone, {
      width: 800,
      height: 450,
      highlightAfter: market.baselineHighlightAfter ?? market.baselineSnapshotCapturedAt,
      referenceLines: [
        { value: market.baselinePrice, className: "is-baseline", label: "基準値" },
        { value: market.currentPrice, className: "is-current", label: "現在値" },
      ],
    });
  }
}

function openChartDialog(market, chartPayload, timezone) {
  if (!chartDialog) {
    return;
  }

  appState.activeChartMarketId = market.id;
  updateChartDialog(market, chartPayload, timezone);

  if (typeof chartDialog.showModal === "function") {
    if (!chartDialog.open) {
      chartDialog.showModal();
    }
    return;
  }

  chartDialog.setAttribute("open", "");
  chartDialog.dataset.open = "true";
}

function renderMarket(market, chartPayload, timezone) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".market-card");
  const marketName = fragment.querySelector(".market-name");
  const currentPrice = fragment.querySelector(".current-price");
  const baselinePrice = fragment.querySelector(".baseline-price");
  const changeValue = fragment.querySelector(".change-value");
  const changePercent = fragment.querySelector(".change-percent");
  const chartTrigger = fragment.querySelector(".chart-trigger");
  const sparklineSvg = fragment.querySelector(".chart-sparkline");
  const sparklinePoints = getChartPoints(chartPayload, market.id, "points24h");
  const detailPoints = getChartPoints(chartPayload, market.id, "points72h");

  marketName.textContent = market.name;
  if (market.url) {
    marketName.href = market.url;
    marketName.target = "_blank";
    marketName.rel = "noreferrer";
    marketName.classList.add("market-name-link");
    marketName.removeAttribute("aria-disabled");
  } else {
    marketName.removeAttribute("href");
    marketName.removeAttribute("target");
    marketName.removeAttribute("rel");
    marketName.classList.remove("market-name-link");
    marketName.setAttribute("aria-disabled", "true");
  }
  currentPrice.textContent = formatNumber(market.currentPrice, 4);
  baselinePrice.textContent = formatNumber(market.baselinePrice, 4);
  changeValue.textContent = formatSigned(market.change, 4);
  changePercent.textContent = formatSigned(market.changePercent, 2, "%");

  chartTrigger.setAttribute("aria-label", `${market.name} の過去72時間チャートを開く`);
  chartTrigger.disabled = detailPoints.length === 0;
  chartTrigger.classList.toggle("is-disabled", detailPoints.length === 0);

  renderSparkline(sparklineSvg, sparklinePoints, {
    width: 192,
    height: 108,
    highlightAfter: market.baselineHighlightAfter ?? market.baselineSnapshotCapturedAt,
    referenceLines: [
      { value: market.baselinePrice, className: "is-baseline" },
      { value: market.currentPrice, className: "is-current" },
    ],
  });

  chartTrigger.addEventListener("click", () => {
    openChartDialog(market, chartPayload, timezone);
  });

  applyMoveClass(changeValue, market.change);
  applyMoveClass(changePercent, market.changePercent);

  if (market.stale) {
    card.classList.add("is-stale");
  }

  return fragment;
}

function renderGroupHeading(label, count) {
  const heading = document.createElement("div");
  heading.className = "market-group-heading";
  heading.innerHTML = `
    <span class="market-group-label">${label}</span>
    <span class="market-group-count">${count}銘柄</span>
  `;
  return heading;
}

function groupMarkets(markets) {
  const byId = new Map(markets.map((market) => [market.id, market]));
  const groups = [];
  const seen = new Set();

  for (const group of MARKET_GROUPS) {
    const items = group.ids.map((id) => byId.get(id)).filter(Boolean);

    for (const market of items) {
      seen.add(market.id);
    }

    if (items.length > 0) {
      groups.push({
        label: group.label,
        markets: items,
      });
    }
  }

  const remaining = markets.filter((market) => !seen.has(market.id));
  if (remaining.length > 0) {
    groups.push({
      label: "その他",
      markets: remaining,
    });
  }

  return groups;
}

function renderEmpty(message) {
  marketGrid.innerHTML = `<p class="empty-state">${message}</p>`;
}

async function fetchJson(url, fallback = null) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    if (fallback !== null) {
      return fallback;
    }

    throw new Error(`データ取得失敗: ${response.status}`);
  }

  return response.json();
}

async function loadData() {
  const [latestPayload, chartPayload] = await Promise.all([
    fetchJson(DATA_URL),
    fetchJson(CHART_DATA_URL, {
      updatedAt: null,
      timezone: "Asia/Tokyo",
      sparklineWindowHours: 24,
      detailWindowHours: 72,
      markets: {},
    }),
  ]);

  return { latestPayload, chartPayload };
}

function bindDialogEvents() {
  if (!chartDialog) {
    return;
  }

  chartDialog.addEventListener("close", () => {
    appState.activeChartMarketId = null;
  });

  chartDialog.addEventListener("click", (event) => {
    const bounds = chartDialog.getBoundingClientRect();
    const clickedOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (clickedOutside) {
      chartDialog.close();
    }
  });
}

function renderPage(latestPayload, chartPayload) {
  const markets = Array.isArray(latestPayload.markets) ? latestPayload.markets : [];
  const timezone = latestPayload.timezone || chartPayload.timezone || "Asia/Tokyo";

  summaryText.textContent =
    `${markets.length}銘柄 / ${latestPayload.baselineLabelJa || "前日終値"}`;
  updatedAt.textContent = `最終更新 ${formatUpdatedAt(latestPayload.updatedAt, timezone)}`;

  if (markets.length === 0) {
    renderEmpty("まだ監視データがありません。");
    return;
  }

  const groups = groupMarkets(markets);

  marketGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    fragment.append(renderGroupHeading(group.label, group.markets.length));
    for (const market of group.markets) {
      fragment.append(renderMarket(market, chartPayload, timezone));
    }
  }
  marketGrid.append(fragment);

  if (appState.activeChartMarketId) {
    const activeMarket = markets.find((market) => market.id === appState.activeChartMarketId);
    if (activeMarket) {
      updateChartDialog(activeMarket, chartPayload, timezone);
    }
  }
}

async function refreshData(options = {}) {
  const { latestPayload, chartPayload } = await loadData();
  const hasChanged =
    latestPayload.updatedAt !== appState.latestPayload?.updatedAt ||
    chartPayload.updatedAt !== appState.chartPayload?.updatedAt;

  if (!hasChanged) {
    return;
  }

  appState.latestPayload = latestPayload;
  appState.chartPayload = chartPayload;
  renderPage(latestPayload, chartPayload);
}

function startAutoRefresh() {
  const runRefresh = () => {
    void refreshData().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  };

  window.setInterval(runRefresh, REFRESH_INTERVAL_MS);
  window.addEventListener("focus", runRefresh);
  window.addEventListener("pageshow", runRefresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      runRefresh();
    }
  });
}

async function main() {
  bindDialogEvents();

  try {
    await refreshData();
    startAutoRefresh();
  } catch (error) {
    summaryText.textContent = "データ取得不可";
    updatedAt.textContent = "更新に失敗しました";
    renderEmpty(error instanceof Error ? error.message : "読み込みエラー");
  }
}

main();

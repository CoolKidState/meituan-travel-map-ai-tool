import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 4173);
const AMAP_WEB_SERVICE_KEY = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_KEY || "";
const AMAP_JS_API_KEY = process.env.AMAP_JS_API_KEY || "";
const AMAP_JS_SECURITY_KEY = process.env.AMAP_JS_SECURITY_KEY || process.env.AMAP_SECURITY_KEY || "";
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_MODEL = process.env.DASHSCOPE_MODEL || "qwen-plus";

const defaultCenter = "116.397428,39.909230";
const demoExecutionOrders = [];
const DASHSCOPE_TIMEOUT_MS = 18000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/status") {
      return sendJson(res, {
        amapWebConfigured: Boolean(AMAP_WEB_SERVICE_KEY),
        amapJsConfigured: Boolean(AMAP_JS_API_KEY),
        dashscopeConfigured: Boolean(DASHSCOPE_API_KEY),
        model: DASHSCOPE_MODEL
      });
    }

    if (url.pathname === "/api/map-config") {
      return sendJson(res, {
        jsApiConfigured: Boolean(AMAP_JS_API_KEY),
        key: AMAP_JS_API_KEY,
        securityJsCode: AMAP_JS_SECURITY_KEY,
        defaultCenter
      });
    }

    if (url.pathname === "/api/nearby" && req.method === "POST") {
      const body = await readJson(req);
      const result = await buildNearbyRecommendations(body);
      return sendJson(res, result);
    }

    if (url.pathname === "/api/afternoon-plan" && req.method === "POST") {
      const body = await readJson(req);
      const result = await buildAfternoonPlan(body);
      return sendJson(res, result);
    }

    if (url.pathname === "/api/execute-action" && req.method === "POST") {
      const body = await readJson(req);
      const result = executeLocalAction(body);
      return sendJson(res, result);
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    return await serveStatic(url.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    return sendJson(res, { error: error.message || "请求失败" }, status);
  }
});

server.listen(PORT, () => {
  console.log(`Nearby AI is running at http://localhost:${PORT}`);
});

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
}

async function buildNearbyRecommendations(input) {
  requireAmapKey();

  const locationText = String(input.locationText || "").trim();
  const keyword = String(input.keyword || "").trim();
  const types = String(input.types || "").trim();
  const preference = String(input.preference || "").trim();
  const radius = clamp(Number(input.radius || 1500), 300, 50000);
  const city = String(input.city || "").trim();

  let center;
  let centerLabel = "地图中心";
  let centerDetail = null;

  if (locationText) {
    centerDetail = await geocode(locationText, city);
    center = centerDetail.location;
    centerLabel = centerDetail.formattedAddress || locationText;
  } else if (isLocation(input.center)) {
    center = String(input.center);
  } else {
    center = defaultCenter;
    centerLabel = "默认位置";
  }

  const rankMode = types === "street-rank";
  const pois = rankMode
    ? await searchStreetRank({ center, keyword, radius, city })
    : await searchAround({ center, keyword, types, radius, city });
  const topPois = pois.slice(0, 12);

  let aiAdvice = "";
  if (topPois.length) {
    try {
      aiAdvice = await askDashScope(buildNearbyPrompt({
      centerLabel,
      keyword,
      types: rankMode ? "高德扫街榜单风格" : types,
      radius,
      preference,
      pois: topPois
      }));
    } catch (error) {
      aiAdvice = `AI 推荐暂时不可用：${error.message}`;
    }
  } else {
    aiAdvice = "这个范围内没有找到匹配的地点。可以扩大半径，或换一个关键词。";
  }

  return {
    center,
    centerLabel,
    centerDetail,
    keyword,
    types: rankMode ? "street-rank" : types,
    radius,
    pois: topPois,
    aiAdvice
  };
}

async function buildAfternoonPlan(input) {
  const trace = [];

  const goal = String(input.goal || "").trim();
  const scenario = String(input.scenario || "无明确").trim();
  const duration = String(input.duration || "无明确").trim();
  const requestedStopCount = String(input.stopCount || "无明确").trim();
  const city = String(input.city || "").trim();
  trace.push(`收到目标：${goal || "未填写具体想法"}`);
  if (!AMAP_WEB_SERVICE_KEY) {
    trace.push("高德 Web 服务 Key 未配置，将直接使用本地默认方案兜底");
  }

  let center;
  let centerLabel = "地图中心";
  let centerDetail = null;
  let centerSource = "map";
  const intent = await analyzePlanningIntent({ goal, scenario, duration });
  const stopCount = resolveStopCount(requestedStopCount, intent, duration, goal);
  const extractedLocation = intent.startLocation || extractLocationFromGoal(goal);
  trace.push(`AI 意图：场景=${intent.scenario || scenario}，地点=${intent.startLocation || "无明确"}，时长=${intent.duration || duration}，地点数=${stopCount}`);

  if (extractedLocation) {
    try {
      centerDetail = await geocode(extractedLocation, city);
      center = centerDetail.location;
      centerLabel = centerDetail.formattedAddress || extractedLocation;
      centerSource = "goal";
      trace.push(`起点：使用 AI 识别地点“${extractedLocation}”，解析为 ${centerLabel}`);
    } catch {
      center = isLocation(input.center) ? String(input.center) : defaultCenter;
      centerLabel = "地图中心";
      centerSource = "map-fallback";
      trace.push(`起点：AI 识别地点“${extractedLocation}”解析失败，回退到地图中心`);
    }
  }

  if (!center && isLocation(input.center)) {
    center = String(input.center);
    trace.push("起点：想法里无明确地点，使用地图中心");
  }

  if (!center) {
    center = defaultCenter;
    centerLabel = "默认位置";
    trace.push("起点：无地图中心，使用默认位置");
  }

  const areaBoundary = centerDetail?.adcode
    ? await districtBoundary(centerDetail.adcode)
    : null;

  const effectiveScenario = intent.scenario && intent.scenario !== "无明确" ? intent.scenario : scenario;
  const queries = buildPlanningQueries({ goal, intent, scenario: effectiveScenario });

  const groups = await Promise.all(queries.map(async (query) => {
    try {
      const pois = await searchAroundFallback({
        center,
        keywords: query.keywords,
        types: query.types,
        radius: 5000,
        city
      });
      trace.push(`附近召回：${query.label}，拿到 ${pois.length} 个候选`);
      return {
        key: query.key,
        label: query.label,
        pois: pois.slice(0, 8)
      };
    } catch (error) {
      trace.push(`附近召回：${query.label} 失败，继续使用其他候选：${error.message}`);
      return {
        key: query.key,
        label: query.label,
        pois: []
      };
    }
  }));

  let candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 24);
  trace.push(`第一轮去重后候选：${candidates.length} 个`);
  if (candidates.length < 3) {
    const broadGroups = await safeFallbackGroups("扩大半径兜底", trace, () => broadFallbackGroups({ center, city }));
    groups.push(...broadGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 24);
    trace.push(`扩大半径兜底后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const cityGroups = await safeFallbackGroups("城市级兜底", trace, () => cityFallbackGroups({ center, city }));
    groups.push(...cityGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 32);
    trace.push(`城市级兜底后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const emergencyGroups = await safeFallbackGroups("最终兜底", trace, () => emergencyFallbackGroups({ center, city }));
    groups.push(...emergencyGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 40);
    trace.push(`最终兜底后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const globalGroups = await safeFallbackGroups("全国文本兜底", trace, () => globalFallbackGroups({ goal, intent }));
    groups.push(...globalGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 50);
    trace.push(`全国文本兜底后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const hardGroups = await safeFallbackGroups("保底强召回", trace, () => hardGuaranteeGroups({ center, city, goal }));
    groups.push(...hardGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 60);
    trace.push(`保底强召回后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const provinceGroups = await safeFallbackGroups("省份/城市默认兜底", trace, () => provinceDefaultGroups({ goal, city }));
    groups.push(...provinceGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 72);
    trace.push(`省份/城市默认兜底后候选：${candidates.length} 个`);
  }
  if (candidates.length < stopCount) {
    const staticGroups = buildStaticDefaultGroups({ goal, city, center });
    groups.push(...staticGroups);
    candidates = dedupePois(groups.flatMap((group) => group.pois)).slice(0, 80);
    trace.push(`本地静态默认兜底后候选：${candidates.length} 个`);
  }
  if (!candidates.length) {
    return {
      center,
      centerLabel,
      centerSource,
      extractedLocation,
      areaBoundary,
      intent,
      centerDetail,
      goal,
      scenario: effectiveScenario,
      duration,
      planText: "附近没有找到足够的候选地点。可以把地图拖到更热闹的位置，或输入一个具体商圈再试。",
      trace,
      shareText: "",
      routePoints: [],
      actions: [],
      groups
    };
  }

  const prompt = buildAfternoonPlanPrompt({
    goal,
    intent,
    scenario,
    duration,
    stopCount,
    centerLabel,
    groups: compactPlanningGroups(groups)
  });

  let aiText = "";
  let aiPlanningOk = true;
  try {
    aiText = await askDashScope(prompt);
  } catch (error) {
    aiPlanningOk = false;
    trace.push(`AI 规划暂时不可用，已使用本地规则兜底：${error.message}`);
  }

  const parsed = parsePlanJson(aiText);
  const routePoints = selectRoutePoints(parsed, groups, candidates, stopCount);
  const fallbackText = buildFallbackPlanText({ goal, scenario, duration, centerLabel, routePoints });
  const finalPlanText = normalizeText(parsed.planText)
    || normalizeText(parsed.plan)
    || normalizeText(parsed.summary)
    || (aiPlanningOk ? normalizeText(aiText) : "")
    || fallbackText;

  return {
    center,
    centerLabel,
    centerSource,
    extractedLocation,
    areaBoundary,
    intent,
    centerDetail,
    goal,
    scenario: effectiveScenario,
    duration,
    planText: finalPlanText,
    shareText: parsed.shareText || buildShareText({ scenario, routePoints }),
    routePoints,
    actions: normalizePlanActions(parsed.actions, routePoints),
    trace,
    groups
  };
}

async function geocode(address, city) {
  const params = new URLSearchParams({
    key: AMAP_WEB_SERVICE_KEY,
    address,
    output: "json"
  });
  if (city) params.set("city", city);
  const data = await amapFetch(`/v3/geocode/geo?${params.toString()}`);
  const first = data.geocodes?.[0];
  if (!first) throw httpError(404, `没有找到地点：${address}`);
  return {
    input: address,
    formattedAddress: first.formatted_address,
    province: first.province,
    city: Array.isArray(first.city) ? "" : first.city,
    district: Array.isArray(first.district) ? "" : first.district,
    adcode: first.adcode,
    location: first.location,
    level: first.level
  };
}

async function searchAround({ center, keyword, types, radius, city }) {
  const params = new URLSearchParams({
    key: AMAP_WEB_SERVICE_KEY,
    location: center,
    radius: String(radius),
    offset: "20",
    page: "1",
    extensions: "all",
    output: "json"
  });
  if (keyword) params.set("keywords", keyword);
  if (types) params.set("types", types);
  if (city) params.set("city", city);

  const data = await amapFetch(`/v3/place/around?${params.toString()}`);
  return (data.pois || [])
    .filter((poi) => isLocation(poi.location))
    .map((poi) => ({
      id: poi.id,
      name: poi.name,
      type: poi.type,
      typecode: normalizeText(poi.typecode),
      province: normalizeText(poi.pname),
      city: normalizeText(poi.cityname),
      district: normalizeText(poi.adname),
      businessArea: normalizeText(poi.business_area),
      address: normalizeText(poi.address),
      location: poi.location,
      entranceLocation: normalizeText(poi.entr_location),
      exitLocation: normalizeText(poi.exit_location),
      distance: Number(poi.distance || 0),
      tel: normalizeText(poi.tel),
      website: normalizeText(poi.website),
      email: normalizeText(poi.email),
      postcode: normalizeText(poi.postcode),
      parkingType: normalizeText(poi.parking_type),
      indoorMap: normalizeText(poi.indoor_map),
      rating: normalizeText(poi.biz_ext?.rating),
      cost: normalizeText(poi.biz_ext?.cost),
      bizExt: poi.biz_ext || {},
      tag: normalizeText(poi.tag),
      photos: Array.isArray(poi.photos) ? poi.photos.slice(0, 5).map((photo) => photo.url).filter(Boolean) : []
    }));
}

async function searchAroundFallback({ center, keywords, types, radius, city }) {
  const all = [];
  for (const keyword of keywords) {
    const pois = await searchAround({ center, keyword, types, radius, city });
    all.push(...pois);
    if (dedupePois(all).length >= 8) break;
  }
  return dedupePois(all);
}

function buildPlanningQueries({ goal, intent, scenario }) {
  const text = [
    goal,
    scenario,
    ...(intent.people || []),
    ...(intent.constraints || []),
    ...(intent.preferences || [])
  ].join(" ");
  const queries = [];

  const add = (key, label, types, keywords) => {
    if (queries.some((query) => query.key === key)) return;
    queries.push({ key, label, types, keywords: dedupeStrings([...keywords, ""]) });
  };

  if (/孩子|娃|亲子|儿童|老婆|家庭|老人|家人/.test(text)) {
    add("family-play", "亲子/轻松活动", "110000", ["公园", "儿童", "乐园", "博物馆", "动物园"]);
    add("family-meal", "家庭友好餐饮", "050000", ["亲子", "轻食", "健康", "餐厅"]);
  }

  if (/朋友|同学|同事|聚会|多人|男|女|4个人|四个人|2男2女/.test(text)) {
    add("group-fun", "朋友活动", "080000", ["桌游", "KTV", "密室", "咖啡", "酒吧"]);
    add("group-meal", "朋友聚餐", "050000", ["火锅", "烧烤", "聚餐", "小吃"]);
  }

  if (/约会|对象|女朋友|男朋友|情侣|拍照|聊天|浪漫/.test(text)) {
    add("date-light", "约会活动", "110000", ["展览", "公园", "街区", "夜景"]);
    add("date-meal", "约会餐饮", "050000", ["西餐", "咖啡", "轻食", "餐厅"]);
  }

  if (/吃|饭|餐|火锅|烧烤|轻食|减肥|健康|不油腻/.test(text)) {
    add("meal", "餐饮", "050000", ["轻食", "健康", "餐厅", "美食"]);
  }

  if (/逛|买|商场|购物|下雨|室内/.test(text)) {
    add("shopping", "购物/室内", "060000", ["商场", "购物中心", "室内"]);
  }

  if (/电影|影院|演出|展览|博物馆|艺术|文化/.test(text)) {
    add("culture", "文化娱乐", "080000", ["电影院", "展览", "博物馆", "艺术"]);
  }

  if (/走走|散步|citywalk|城市漫步|小吃街|街区/.test(text)) {
    add("walk", "漫步街区", "110000", ["街区", "公园", "小吃街", "步行街"]);
  }

  if (/附近|周边|玩|逛|活动|安排|去哪/.test(text)) {
    add("nearby-play", "附近玩乐", "110000", ["公园", "景区", "街区", "广场"]);
    add("nearby-food", "附近餐饮", "050000", ["餐厅", "美食", "小吃"]);
    add("nearby-extra", "附近休闲", "080000", ["咖啡", "电影院", "休闲"]);
  }

  if (!queries.length) {
    add("general-play", "通用活动", "110000", ["公园", "景区", "街区"]);
    add("general-meal", "通用餐饮", "050000", ["餐厅", "美食", "小吃"]);
    add("general-extra", "通用休闲", "080000", ["咖啡", "休闲", "电影院"]);
  }

  if (!queries.some((query) => query.types === "050000")) {
    add("meal-default", "餐饮补充", "050000", ["餐厅", "美食"]);
  }

  if (queries.length < 3) {
    add("extra-default", "补充活动", "080000", ["咖啡", "休闲", "电影院"]);
  }

  return queries.slice(0, 6);
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value, index, array) => value || index === array.length - 1))];
}

async function safeFallbackGroups(label, trace, loader) {
  try {
    return await loader();
  } catch (error) {
    trace.push(`${label}失败，继续使用下一层兜底：${error.message}`);
    return [];
  }
}

async function broadFallbackGroups({ center, city }) {
  const configs = [
    { key: "fallback-play", label: "兜底玩乐", types: "110000", keywords: ["", "公园", "景区", "广场"] },
    { key: "fallback-food", label: "兜底餐饮", types: "050000", keywords: ["", "餐厅", "美食", "小吃"] },
    { key: "fallback-shopping", label: "兜底购物", types: "060000", keywords: ["", "商场", "购物中心"] },
    { key: "fallback-entertainment", label: "兜底休闲娱乐", types: "080000", keywords: ["", "电影院", "KTV", "桌游", "咖啡"] }
  ];
  const groups = [];

  for (const radius of [8000, 15000, 25000]) {
    const current = await Promise.all(configs.map(async (config) => ({
      key: `${config.key}-${radius}`,
      label: `${config.label} ${radius / 1000}km`,
      pois: (await searchAroundFallback({
        center,
        keywords: config.keywords,
        types: config.types,
        radius,
        city
      })).slice(0, 8)
    })));
    groups.push(...current);
    if (dedupePois(groups.flatMap((group) => group.pois)).length >= 6) break;
  }

  return groups;
}

async function cityFallbackGroups({ center, city }) {
  const resolvedCity = city || await cityFromLocation(center);
  const configs = [
    { key: "city-play", label: "城市玩乐兜底", types: "110000", keywords: ["公园", "景区", "广场", "博物馆"] },
    { key: "city-food", label: "城市餐饮兜底", types: "050000", keywords: ["餐厅", "美食", "小吃", "咖啡"] },
    { key: "city-shopping", label: "城市购物兜底", types: "060000", keywords: ["商场", "购物中心", "步行街"] },
    { key: "city-fun", label: "城市休闲兜底", types: "080000", keywords: ["电影院", "KTV", "桌游", "休闲"] }
  ];

  const groups = await Promise.all(configs.map(async (config) => ({
    key: config.key,
    label: config.label,
    pois: (await searchTextFallback({
      city: resolvedCity,
      keywords: config.keywords,
      types: config.types
    })).slice(0, 8)
  })));

  return groups;
}

async function emergencyFallbackGroups({ center, city }) {
  const resolvedCity = city || await cityFromLocation(center);
  const aroundConfigs = [
    { key: "emergency-around-food", label: "附近餐饮兜底", types: "050000", keywords: ["", "餐厅", "小吃"] },
    { key: "emergency-around-shop", label: "附近购物兜底", types: "060000", keywords: ["", "商场"] },
    { key: "emergency-around-fun", label: "附近休闲兜底", types: "080000", keywords: ["", "咖啡", "电影院"] },
    { key: "emergency-around-view", label: "附近玩乐兜底", types: "110000", keywords: ["", "公园", "景区"] }
  ];

  const aroundGroups = await Promise.all(aroundConfigs.map(async (config) => ({
    key: config.key,
    label: config.label,
    pois: (await searchAroundFallback({
      center,
      keywords: config.keywords,
      types: config.types,
      radius: 50000,
      city: resolvedCity
    })).slice(0, 10)
  })));

  if (dedupePois(aroundGroups.flatMap((group) => group.pois)).length >= 3) {
    return aroundGroups;
  }

  const textGroups = await Promise.all(aroundConfigs.map(async (config) => ({
    key: `${config.key}-text`,
    label: `${config.label} 城市补充`,
    pois: (await searchTextFallback({
      city: resolvedCity,
      keywords: config.keywords.filter(Boolean).length ? config.keywords.filter(Boolean) : ["餐厅", "公园"],
      types: config.types
    })).slice(0, 10)
  })));

  return [...aroundGroups, ...textGroups];
}

async function globalFallbackGroups({ goal, intent }) {
  const text = [
    goal,
    intent?.scenario,
    ...(intent?.constraints || []),
    ...(intent?.preferences || [])
  ].join(" ");
  const foodKeywords = /孩子|娃|减肥|健康|轻食/.test(text)
    ? ["轻食", "健康餐", "亲子餐厅", "餐厅"]
    : ["餐厅", "美食", "小吃", "咖啡"];
  const playKeywords = /孩子|娃|亲子/.test(text)
    ? ["儿童乐园", "公园", "博物馆", "亲子"]
    : ["公园", "商场", "电影院", "休闲"];

  const configs = [
    { key: "global-play", label: "通用玩乐兜底", types: "110000", keywords: playKeywords },
    { key: "global-food", label: "通用餐饮兜底", types: "050000", keywords: foodKeywords },
    { key: "global-extra", label: "通用休闲兜底", types: "080000", keywords: ["咖啡", "电影院", "KTV", "休闲"] },
    { key: "global-shop", label: "通用购物兜底", types: "060000", keywords: ["商场", "购物中心", "步行街"] }
  ];

  return Promise.all(configs.map(async (config) => ({
    key: config.key,
    label: config.label,
    pois: (await searchTextFallback({
      city: "",
      keywords: config.keywords,
      types: config.types
    })).slice(0, 10)
  })));
}

async function hardGuaranteeGroups({ center, city, goal }) {
  const resolvedCity = city || await cityFromLocation(center) || "北京";
  const goalText = String(goal || "");
  const keywords = [
    ...goalText.split(/\s+|，|。|、|；|,|;/).filter((item) => item.length >= 2 && item.length <= 12),
    "餐厅",
    "公园",
    "商场",
    "咖啡",
    "电影院",
    "小吃",
    "休闲"
  ];
  const configs = [
    { key: "hard-any-food", label: "强制餐饮召回", types: "050000", keywords },
    { key: "hard-any-play", label: "强制玩乐召回", types: "110000", keywords },
    { key: "hard-any-shop", label: "强制购物召回", types: "060000", keywords },
    { key: "hard-any-fun", label: "强制休闲召回", types: "080000", keywords }
  ];

  const cityGroups = await Promise.all(configs.map(async (config) => ({
    key: `${config.key}-city`,
    label: `${config.label} ${resolvedCity}`,
    pois: (await searchTextFallback({
      city: resolvedCity,
      keywords: config.keywords,
      types: config.types
    })).slice(0, 12)
  })));

  if (dedupePois(cityGroups.flatMap((group) => group.pois)).length) {
    return cityGroups;
  }

  return Promise.all(configs.map(async (config) => ({
    key: `${config.key}-global`,
    label: `${config.label} 全国`,
    pois: (await searchTextFallback({
      city: "",
      keywords: config.keywords,
      types: config.types
    })).slice(0, 12)
  })));
}

async function provinceDefaultGroups({ goal, city }) {
  const profile = resolveProvinceProfile(goal, city);
  if (!profile) return [];

  const configs = [
    { key: "province-default-play", label: `${profile.label} 默认玩乐`, types: "110000", keywords: profile.play },
    { key: "province-default-food", label: `${profile.label} 默认餐饮`, types: "050000", keywords: profile.food },
    { key: "province-default-fun", label: `${profile.label} 默认活动`, types: "080000", keywords: profile.fun },
    { key: "province-default-shop", label: `${profile.label} 默认商圈`, types: "060000", keywords: profile.shop }
  ];

  return Promise.all(configs.map(async (config) => ({
    key: config.key,
    label: config.label,
    pois: (await searchTextFallback({
      city: profile.city,
      keywords: config.keywords,
      types: config.types
    })).slice(0, 8)
  })));
}

function buildStaticDefaultGroups({ goal, city, center }) {
  const profile = resolveProvinceProfile(goal, city) || {
    label: "地图中心",
    city: city || "",
    center: isLocation(center) ? center : defaultCenter,
    food: ["餐厅"],
    play: ["公园"],
    fun: ["休闲"],
    shop: ["商圈"]
  };
  const baseCenter = isLocation(center) ? center : profile.center || defaultCenter;
  const text = `${goal || ""} ${city || ""}`;
  const family = /孩子|娃|老婆|亲子|家庭|减肥|健康|轻食/.test(text);
  const friend = /朋友|同学|聚会|2男2女|四个人|4个人/.test(text);
  const label = profile.localLabel || profile.label || "本地";
  const groups = [
    {
      key: "static-default-play",
      label: `${label} 本地默认玩乐`,
      pois: [
        staticDefaultPoi({ profile, center: baseCenter, index: 0, name: `${label}默认轻松活动点（兜底）`, type: family ? "体育休闲服务;娱乐场所;儿童乐园" : "风景名胜;公园广场;公园", typecode: family ? "080601" : "110101", address: "本地兜底演示点，用于方案不断流" }),
        staticDefaultPoi({ profile, center: baseCenter, index: 1, name: `${label}默认城市漫步点（兜底）`, type: "风景名胜;风景名胜相关;旅游景点", typecode: "110000", address: "本地兜底演示点，用于路线串联" })
      ]
    },
    {
      key: "static-default-food",
      label: `${label} 本地默认餐饮`,
      pois: [
        staticDefaultPoi({ profile, center: baseCenter, index: 2, name: `${label}${family ? "默认轻食餐厅" : "默认餐饮点"}（兜底）`, type: "餐饮服务;中餐厅;中餐厅", typecode: "050100", address: "本地兜底演示餐饮点，可演示订座/排队/套餐" }),
        staticDefaultPoi({ profile, center: baseCenter, index: 3, name: `${label}默认小吃补给点（兜底）`, type: "餐饮服务;快餐厅;快餐厅", typecode: "050300", address: "本地兜底演示餐饮点，可演示团购套餐" })
      ]
    },
    {
      key: "static-default-fun",
      label: `${label} 本地默认活动`,
      pois: [
        staticDefaultPoi({ profile, center: baseCenter, index: 4, name: `${label}${friend ? "默认展览活动" : "默认休闲活动"}（兜底）`, type: friend ? "科教文化服务;展览馆;展览馆" : "体育休闲服务;休闲场所;休闲场所", typecode: friend ? "140200" : "080300", address: "本地兜底演示活动点，可演示预约/购票提醒" })
      ]
    },
    {
      key: "static-default-shop",
      label: `${label} 本地默认商圈`,
      pois: [
        staticDefaultPoi({ profile, center: baseCenter, index: 5, name: `${label}默认商圈小逛点（兜底）`, type: "购物服务;商场;购物中心", typecode: "060100", address: "本地兜底演示商圈点，用于吃逛组合" })
      ]
    }
  ];

  return groups;
}

function staticDefaultPoi({ profile, center, index, name, type, typecode, address }) {
  const location = offsetLocation(center, index);
  return {
    id: `STATIC-DEMO-${index}-${hashText(`${profile.city || ""}${name}`)}`,
    name,
    type,
    typecode,
    province: profile.province || profile.label || "",
    city: profile.city || "",
    district: profile.district || "",
    businessArea: profile.localLabel || profile.label || "",
    address,
    location,
    entranceLocation: "",
    exitLocation: "",
    distance: (index + 1) * 280,
    tel: "",
    website: "",
    email: "",
    postcode: "",
    parkingType: "",
    indoorMap: "",
    rating: "",
    cost: "",
    bizExt: {
      demoFallback: true,
      seat_ordering: /餐饮/.test(type) ? "demo_available" : "",
      ticket_ordering: /展览馆|风景名胜|儿童乐园/.test(type) ? "demo_available" : ""
    },
    tag: "比赛演示兜底，不代表真实库存",
    photos: []
  };
}

function offsetLocation(center, index) {
  const [lng, lat] = String(center || defaultCenter).split(",").map(Number);
  const offsets = [
    [0.0020, 0.0015],
    [-0.0022, 0.0012],
    [0.0018, -0.0016],
    [-0.0019, -0.0014],
    [0.0030, 0.0004],
    [-0.0030, -0.0005]
  ];
  const [dx, dy] = offsets[index % offsets.length];
  return `${(lng + dx).toFixed(6)},${(lat + dy).toFixed(6)}`;
}

function hashText(text) {
  let hash = 0;
  for (const char of String(text)) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

function resolveProvinceProfile(goal, city) {
  const text = `${goal || ""} ${city || ""}`;
  const localProfiles = [
    ["回龙观", "北京", "北京市", "昌平区", "116.336116,40.070800"],
    ["中关村", "北京", "北京市", "海淀区", "116.316467,39.983991"],
    ["望京", "北京", "北京市", "朝阳区", "116.481499,39.996644"]
  ];
  const localMatched = localProfiles.find(([name]) => text.includes(name));
  const profiles = [
    ["北京", "北京市", "116.407387,39.904179"], ["上海", "上海市", "121.473701,31.230416"], ["天津", "天津市", "117.200983,39.084158"], ["重庆", "重庆市", "106.551643,29.562849"],
    ["河北", "石家庄市", "114.514976,38.042007"], ["山西", "太原市", "112.548879,37.870590"], ["内蒙古", "呼和浩特市", "111.749181,40.842585"], ["辽宁", "沈阳市", "123.431475,41.805698"],
    ["吉林", "长春市", "125.323544,43.817072"], ["黑龙江", "哈尔滨市", "126.642464,45.756967"], ["江苏", "南京市", "118.796877,32.060255"], ["浙江", "杭州市", "120.155070,30.274085"],
    ["安徽", "合肥市", "117.227538,31.820587"], ["福建", "福州市", "119.296494,26.074508"], ["江西", "南昌市", "115.858197,28.682892"], ["山东", "济南市", "117.120098,36.651200"],
    ["河南", "郑州市", "113.625368,34.746600"], ["湖北", "武汉市", "114.305392,30.593098"], ["湖南", "长沙市", "112.938814,28.228209"], ["广东", "广州市", "113.264385,23.129112"],
    ["广西", "南宁市", "108.366543,22.817002"], ["海南", "海口市", "110.198293,20.044002"], ["四川", "成都市", "104.066541,30.572269"], ["贵州", "贵阳市", "106.630153,26.647661"],
    ["云南", "昆明市", "102.832891,24.880095"], ["西藏", "拉萨市", "91.140856,29.645554"], ["陕西", "西安市", "108.939840,34.341270"], ["甘肃", "兰州市", "103.834303,36.061089"],
    ["青海", "西宁市", "101.778916,36.623178"], ["宁夏", "银川市", "106.230909,38.487193"], ["新疆", "乌鲁木齐市", "87.616824,43.825377"], ["香港", "香港", "114.169361,22.319303"],
    ["澳门", "澳门", "113.543873,22.198745"], ["台湾", "台北市", "121.565418,25.032969"]
  ];
  const matched = profiles.find(([province, capital]) => text.includes(province) || text.includes(capital.replace("市", "")));
  const label = localMatched?.[0] || matched?.[0] || normalizeText(city).replace("市", "") || "";
  const resolvedCity = city || localMatched?.[2] || matched?.[1] || "";
  if (!resolvedCity) return null;

  return {
    label: label || resolvedCity,
    localLabel: localMatched?.[0] || "",
    province: localMatched?.[1] || matched?.[0] || "",
    city: resolvedCity,
    district: localMatched?.[3] || "",
    center: localMatched?.[4] || matched?.[2] || defaultCenter,
    play: ["公园", "景区", "博物馆", "亲子乐园"],
    food: /减肥|健康|轻食|孩子|娃|老婆/.test(text)
      ? ["轻食", "健康餐", "亲子餐厅", "餐厅"]
      : ["餐厅", "美食", "小吃", "火锅"],
    fun: /朋友|同学|聚会|2男2女|四个人|4个人/.test(text)
      ? ["展览", "电影院", "桌游", "KTV"]
      : ["咖啡", "电影院", "休闲", "展览"],
    shop: ["商场", "购物中心", "步行街", "小吃街"]
  };
}

function compactPlanningGroups(groups) {
  return groups
    .filter((group) => group?.pois?.length)
    .slice(0, 8)
    .map((group) => ({
      key: group.key,
      label: group.label,
      pois: group.pois.slice(0, 5).map(compactPoiForPrompt)
    }));
}

function compactPoiForPrompt(poi) {
  return {
    id: poi.id,
    name: poi.name,
    type: poi.type,
    address: poi.address,
    location: poi.location,
    distance: poi.distance,
    rating: poi.rating,
    cost: poi.cost,
    tel: poi.tel,
    businessArea: poi.businessArea,
    openTime: normalizeText(poi.bizExt?.open_time || poi.bizExt?.opentime2),
    mealOrdering: normalizeText(poi.bizExt?.meal_ordering),
    seatOrdering: normalizeText(poi.bizExt?.seat_ordering),
    ticketOrdering: normalizeText(poi.bizExt?.ticket_ordering),
    tag: poi.tag
  };
}

async function cityFromLocation(location) {
  if (!isLocation(location)) return "";
  const params = new URLSearchParams({
    key: AMAP_WEB_SERVICE_KEY,
    location,
    extensions: "base",
    output: "json"
  });
  try {
    const data = await amapFetch(`/v3/geocode/regeo?${params.toString()}`);
    return normalizeText(data.regeocode?.addressComponent?.city)
      || normalizeText(data.regeocode?.addressComponent?.province)
      || "";
  } catch {
    return "";
  }
}

async function searchTextFallback({ city, keywords, types }) {
  const all = [];
  for (const keyword of keywords) {
    const pois = await searchText({ city, keyword, types });
    all.push(...pois);
    if (dedupePois(all).length >= 8) break;
  }
  return dedupePois(all);
}

async function searchText({ city, keyword, types }) {
  const params = new URLSearchParams({
    key: AMAP_WEB_SERVICE_KEY,
    keywords: keyword,
    types,
    offset: "20",
    page: "1",
    extensions: "all",
    output: "json"
  });
  if (city) {
    params.set("city", city);
    params.set("citylimit", "true");
  }

  try {
    const data = await amapFetch(`/v3/place/text?${params.toString()}`);
    return (data.pois || [])
      .filter((poi) => isLocation(poi.location))
      .map((poi) => ({
        id: poi.id,
        name: poi.name,
        type: poi.type,
        typecode: normalizeText(poi.typecode),
        province: normalizeText(poi.pname),
        city: normalizeText(poi.cityname),
        district: normalizeText(poi.adname),
        businessArea: normalizeText(poi.business_area),
        address: normalizeText(poi.address),
        location: poi.location,
        entranceLocation: normalizeText(poi.entr_location),
        exitLocation: normalizeText(poi.exit_location),
        distance: 0,
        tel: normalizeText(poi.tel),
        website: normalizeText(poi.website),
        email: normalizeText(poi.email),
        postcode: normalizeText(poi.postcode),
        parkingType: normalizeText(poi.parking_type),
        indoorMap: normalizeText(poi.indoor_map),
        rating: normalizeText(poi.biz_ext?.rating),
        cost: normalizeText(poi.biz_ext?.cost),
        bizExt: poi.biz_ext || {},
        tag: normalizeText(poi.tag),
        photos: Array.isArray(poi.photos) ? poi.photos.slice(0, 5).map((photo) => photo.url).filter(Boolean) : []
      }));
  } catch {
    return [];
  }
}

async function districtBoundary(adcode) {
  const params = new URLSearchParams({
    key: AMAP_WEB_SERVICE_KEY,
    keywords: String(adcode),
    subdistrict: "0",
    extensions: "all",
    output: "json"
  });

  try {
    const data = await amapFetch(`/v3/config/district?${params.toString()}`);
    const district = data.districts?.[0];
    if (!district?.polyline) return null;
    const polylines = String(district.polyline)
      .split("|")
      .map((line) => line.split(";").filter(isLocation))
      .filter((line) => line.length >= 3);
    return {
      adcode: district.adcode,
      name: district.name,
      level: district.level,
      labelPoint: boundaryLabelPoint(polylines),
      polylines
    };
  } catch {
    return null;
  }
}

async function searchStreetRank({ center, keyword, radius, city }) {
  const configs = keyword
    ? [
        { types: "050000", keywords: [keyword, ""] },
        { types: "060000", keywords: [keyword, ""] },
        { types: "080000", keywords: [keyword, ""] },
        { types: "110000", keywords: [keyword, ""] }
      ]
    : [
        { types: "050000", keywords: ["小吃", "咖啡", "火锅", "烧烤", "甜品", ""] },
        { types: "060000", keywords: ["商场", "购物中心", "步行街", ""] },
        { types: "080000", keywords: ["电影院", "KTV", "桌游", "酒吧", ""] },
        { types: "110000", keywords: ["街区", "公园", "景区", ""] }
      ];

  const groups = await Promise.all(configs.map(async (config) => searchAroundFallback({
    center,
    keywords: config.keywords,
    types: config.types,
    radius: Math.max(radius, 3000),
    city
  })));

  return dedupePois(groups.flat())
    .map((poi) => ({
      ...poi,
      rankScore: streetRankScore(poi)
    }))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 20);
}

function streetRankScore(poi) {
  const rating = Number.parseFloat(poi.rating || "0");
  const distance = Number(poi.distance || 0);
  let score = 0;

  if (Number.isFinite(rating) && rating > 0) score += rating * 22;
  if (poi.photos?.length) score += 8;
  if (poi.tag) score += 6;
  if (poi.cost) score += 4;
  if (distance > 0) score += Math.max(0, 28 - distance / 250);

  return Math.round(score * 10) / 10;
}

function buildNearbyPrompt({ centerLabel, keyword, types, radius, preference, pois }) {
  return [
    "请基于以下高德地图周边 POI 数据，给出中文周边推荐。",
    "要求：先给 3 个最值得去的推荐，再按场景给选择建议；必须引用地点名称、距离、评分或消费等真实字段；不要编造数据。",
    `中心位置：${centerLabel}`,
    `搜索关键词：${keyword || "无"}`,
    `类别：${types || "不限"}`,
    `半径：${radius} 米`,
    preference ? `用户偏好：${preference}` : "用户没有额外偏好。",
    `POI 数据：${JSON.stringify(pois, null, 2)}`
  ].join("\n");
}

function buildAfternoonPlanPrompt({ goal, intent, scenario, duration, stopCount = 3, centerLabel, groups }) {
  return [
    "你是美团本地短时活动规划 Agent。请根据用户目标和真实高德 POI 候选，智能拆解需求，组合一个可执行的本地短时活动方案。",
    "必须考虑人群、时间段、距离、活动顺序、餐饮需求和用户约束。不要编造未提供的评分、排队、空位或价格。",
    "请只输出 JSON，不要 Markdown，不要解释 JSON 外的内容。",
    "JSON 字段：",
    "{",
    '  "planText": "完整中文方案，包含时间线、推荐理由、注意事项",',
    `  "routeNames": ["按执行顺序选 ${stopCount} 个地点名称，必须来自 POI 候选"],`,
    '  "shareText": "可以直接发给老婆/朋友的简短文案",',
    '  "actions": ["需要用户确认或执行的动作按钮文案，例如查看排队、预约、订座、发给朋友"]',
    "}",
    `用户目标：${goal || "想安排一次本地短时活动"}`,
    `AI 意图解析：${JSON.stringify(intent || {}, null, 2)}`,
    `场景：${intent?.scenario || scenario}`,
    `预计时长：${intent?.duration || duration}`,
    `用户指定地点数：${stopCount}`,
    `起点/中心：${centerLabel}`,
    `POI 候选：${JSON.stringify(groups, null, 2)}`
  ].join("\n");
}

async function analyzePlanningIntent({ goal, scenario, duration }) {
  const fallback = {
    startLocation: "",
    scenario,
    duration,
    people: [],
    constraints: [],
    preferences: []
  };

  if (!goal || !DASHSCOPE_API_KEY) {
    return fallback;
  }

  const prompt = [
    "你是本地短时活动规划 Agent 的需求理解模块。请从用户一句话中抽取结构化意图。",
    "只输出 JSON，不要 Markdown，不要解释。",
    "如果没有明确地点，startLocation 必须为空字符串。不要把“家附近”“别太远”这种模糊说法当成具体地点。",
    "JSON 字段：",
    "{",
    '  "startLocation": "明确地点名，例如望京、三里屯、奥森、回龙观；没有则空字符串",',
    '  "scenario": "家庭/朋友/约会/临时聚会/个人休闲/其他；如果默认场景是无明确，必须根据用户原话判断",',
    '  "duration": "用户希望的时长或时间段",',
    '  "people": ["同行人群，例如孩子5岁、老婆、2男2女"],',
    '  "constraints": ["硬约束，例如别离家太远、减肥、适合孩子"],',
    '  "preferences": ["软偏好，例如轻松、不太贵、适合拍照"]',
    "}",
    `默认场景：${scenario}（如果是“无明确”，请不要照抄，必须从用户原话判断）`,
    `默认时长：${duration}`,
    `用户原话：${goal}`
  ].join("\n");

  try {
    const text = await askDashScope(prompt);
    const parsed = parsePlanJson(text);
    return {
      startLocation: normalizeText(parsed.startLocation).trim(),
      scenario: normalizeText(parsed.scenario) || scenario,
      duration: normalizeText(parsed.duration) || duration,
      people: Array.isArray(parsed.people) ? parsed.people.map(normalizeText).filter(Boolean) : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(normalizeText).filter(Boolean) : [],
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.map(normalizeText).filter(Boolean) : []
    };
  } catch {
    return fallback;
  }
}

async function amapFetch(pathname) {
  let response;
  try {
    response = await fetch(`https://restapi.amap.com${pathname}`);
  } catch (error) {
    throw httpError(502, `无法连接高德地图接口。请检查电脑网络、代理/防火墙，以及高德 Key 是否已开通 Web服务。原始错误：${error.message}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === "0") {
    throw httpError(response.status || 502, `高德接口返回错误：${data.info || response.statusText}`);
  }
  return data;
}

async function askDashScope(prompt) {
  if (!DASHSCOPE_API_KEY) {
    throw httpError(400, "缺少百炼 API Key。请在 .env 中配置 DASHSCOPE_API_KEY。");
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DASHSCOPE_TIMEOUT_MS);
  try {
    response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: DASHSCOPE_MODEL,
        messages: [
          {
            role: "system",
            content: "你是一个务实的中文本地生活推荐助手。只基于给定地图数据推荐，不编造评分、距离、价格。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.35
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(504, `百炼接口超过 ${Math.round(DASHSCOPE_TIMEOUT_MS / 1000)} 秒未返回。`);
    }
    throw httpError(502, `无法连接阿里云百炼接口。请检查电脑网络、代理/防火墙，以及百炼 API Key 是否可用。原始错误：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, `百炼接口返回错误：${data.error?.message || response.statusText}`);
  }
  return data.choices?.[0]?.message?.content?.trim() || "百炼没有返回内容。";
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const resolved = path.normalize(path.join(publicDir, cleanPath));
  if (!resolved.startsWith(publicDir)) {
    throw httpError(403, "禁止访问。");
  }
  if (!existsSync(resolved)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const content = await readFile(resolved);
  res.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  return res.end(content);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "请求体不是有效 JSON。");
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  return res.end(JSON.stringify(payload));
}

function requireAmapKey() {
  if (!AMAP_WEB_SERVICE_KEY) {
    throw httpError(400, "缺少高德 Web 服务 Key。请在 .env 中配置 AMAP_WEB_SERVICE_KEY。");
  }
}

function normalizeText(value) {
  if (Array.isArray(value)) return "";
  return value ? String(value) : "";
}

function dedupePois(pois) {
  const seen = new Set();
  const result = [];
  for (const poi of pois) {
    const key = poi.id || `${poi.name}-${poi.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(poi);
  }
  return result;
}

function parsePlanJson(text) {
  if (!text) return {};
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { planText: text };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { planText: text };
  }
}

function selectRoutePoints(parsed, groups, candidates, stopCount = 3) {
  const selected = [];
  const names = Array.isArray(parsed.routeNames) ? parsed.routeNames : [];
  for (const name of names) {
    const poi = candidates.find((candidate) => candidate.name === name || candidate.name.includes(name) || String(name).includes(candidate.name));
    if (poi && !selected.some((item) => item.id === poi.id)) selected.push(poi);
  }

  if (selected.length < 2) {
    for (const key of ["play", "meal", "extra"]) {
      const group = groups.find((item) => item.key === key);
      const poi = group?.pois?.find((candidate) => !selected.some((item) => item.id === candidate.id));
      if (poi) selected.push(poi);
    }
  }

  if (selected.length < 2) {
    const buckets = [
      (poi) => poi.type?.includes("风景") || poi.type?.includes("公园") || poi.type?.includes("休闲"),
      (poi) => poi.type?.includes("餐饮") || poi.type?.includes("美食"),
      (poi) => poi.type?.includes("购物") || poi.type?.includes("体育") || poi.type?.includes("娱乐"),
      () => true
    ];
    for (const matcher of buckets) {
      const poi = candidates.find((candidate) => matcher(candidate) && !selected.some((item) => item.id === candidate.id));
      if (poi) selected.push(poi);
      if (selected.length >= 3) break;
    }
  }

  if (selected.length < stopCount) {
    for (const poi of candidates) {
      if (!selected.some((item) => item.id === poi.id)) selected.push(poi);
      if (selected.length >= stopCount) break;
    }
  }

  return selected.slice(0, stopCount).map((poi, index) => ({
    ...poi,
    order: index + 1
  }));
}

function buildFallbackPlanText({ goal, scenario, duration, centerLabel, routePoints }) {
  if (!routePoints.length) return "没有足够地点生成路线。";
  const lines = [
    `已按“${goal || scenario}”在 ${centerLabel} 附近规划 ${duration} 方案：`
  ];
  routePoints.forEach((point, index) => {
    lines.push(`${index + 1}. ${point.name}，距离约 ${point.distance} 米，${point.type || "适合作为一站"}`);
  });
  lines.push("建议先确认第一站营业和餐厅排队情况，再出发。");
  return lines.join("\n");
}

function buildShareText({ scenario, routePoints }) {
  if (!routePoints.length) return "";
  const names = routePoints.map((point) => point.name).join(" → ");
  return `下午安排好了，按${scenario}场景走：${names}。先看第一站和餐厅情况，合适就出发。`;
}

function buildActions(routePoints) {
  const actions = ["open-route", "place-detail", "calendar-hold", "copy-share"];
  return actions;
}

function executeLocalAction(input) {
  const poi = input.poi || {};
  const actionType = normalizeText(input.actionType).trim();
  const quantity = clamp(Number(input.quantity || 1), 1, 20);
  const scheduledAt = normalizeText(input.scheduledAt).trim();
  const contact = normalizeText(input.contact).trim();
  const note = normalizeText(input.note).trim();
  const source = normalizeText(input.source).trim() || "地点";

  if (!normalizeText(poi.name).trim()) {
    throw httpError(400, "缺少地点信息，无法生成演示订单。");
  }
  if (!actionType) {
    throw httpError(400, "请选择要执行的下单/预订动作。");
  }
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw httpError(400, "请选择有效的到店或预约时间。");
  }
  if (!contact) {
    throw httpError(400, "请填写联系方式，用于生成演示订单。");
  }

  const actionLabel = executionActionLabel(actionType);
  const order = {
    orderId: buildDemoOrderId(),
    status: "demo_confirmed",
    statusLabel: "演示已确认",
    actionType,
    actionLabel,
    poiName: normalizeText(poi.name),
    poiType: normalizeText(poi.type) || "地点",
    poiAddress: normalizeText(poi.address) || "暂无地址",
    poiTel: normalizeText(poi.tel) || "",
    scheduledAt,
    scheduledAtLabel: formatExecutionTime(scheduledAt),
    quantity,
    contact,
    note,
    source,
    createdAt: new Date().toISOString(),
    demoNotice: "这是比赛演示闭环生成的本地模拟订单，不代表真实美团支付、库存或商家确认。",
    nextSteps: executionNextSteps(actionType, poi)
  };

  demoExecutionOrders.unshift(order);
  demoExecutionOrders.splice(20);
  return order;
}

function executionActionLabel(actionType) {
  const labels = {
    "reserve-table": "订座",
    "queue-ticket": "排队取号",
    "deal-package": "团购套餐",
    "entry-reservation": "预约入场",
    "ticket-reminder": "购票提醒",
    "arrival-booking": "预约到店",
    "phone-confirm": "电话确认",
    navigation: "导航",
    "calendar-hold": "加入日程",
    "copy-place": "复制地点"
  };
  return labels[actionType] || "执行动作";
}

function executionNextSteps(actionType, poi) {
  const phone = normalizeText(poi.tel);
  const common = [
    "出发前再次确认营业状态",
    "到店后按演示订单号核对"
  ];
  if (actionType === "navigation") return ["已把地点转为出发动作", "建议打开高德路线确认交通方式"];
  if (actionType === "phone-confirm") return [phone ? `可拨打 ${phone} 做最终确认` : "暂无电话，建议到店前再次查询", "确认后再出发"];
  if (actionType === "copy-place") return ["地点信息已沉淀为可转发内容", "发给同行人确认时间"];
  if (actionType === "calendar-hold") return ["已生成日程提醒语义", "出发前 30 分钟再次检查路线"];
  return common;
}

function buildDemoOrderId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MT-DEMO-${date}-${suffix}`;
}

function formatExecutionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (item) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizePlanActions(actions, routePoints) {
  const normalized = [];
  const source = Array.isArray(actions) ? actions : [];

  for (const action of source) {
    const text = typeof action === "string" ? action : action?.label || action?.id || "";
    if (/转发|朋友|老婆|复制|文案/.test(text)) normalized.push("copy-share");
    else if (/路线|导航|出发|交通/.test(text)) normalized.push("open-route");
    else if (/餐厅|订座|排队|电话|联系|预约/.test(text)) normalized.push("place-detail");
    else if (/日程|提醒|时间|安排/.test(text)) normalized.push("calendar-hold");
    else if (/地点|清单|列表|站点/.test(text)) normalized.push("place-detail");
  }

  for (const action of buildActions(routePoints)) normalized.push(action);
  return [...new Set(normalized)];
}

function extractLocationFromGoal(goal) {
  const text = String(goal || "")
    .replace(/[，。！？；、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const patterns = [
    /(?:从|在|住在|位于|定位到|以)([^ ]{2,20}?)(?:出发|附近|周边|旁边|开始|为中心)/,
    /(?:去|到)([^ ]{2,20}?)(?:附近|周边|玩|逛|吃|活动|出发|$)/,
    /([^ ]{2,20}?)(?:附近|周边)(?:玩|逛|吃|活动|安排|$)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = cleanupLocationCandidate(match?.[1]);
    if (candidate) return candidate;
  }

  return "";
}

function cleanupLocationCandidate(value) {
  if (!value) return "";
  const cleaned = String(value)
    .replace(/^(今天|下午|上午|晚上|周末|想|和|跟|带|老婆|孩子|朋友|同事|家人)+/, "")
    .replace(/(今天|下午|上午|晚上|周末|玩几个小时|几个小时|别太远|不要太远|离家不远).*$/, "")
    .replace(/[“”"'：:]/g, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 20) return "";
  return cleaned;
}

function resolveStopCount(requestedStopCount, intent, duration, goal) {
  const explicit = Number(requestedStopCount);
  if (Number.isFinite(explicit)) return clamp(explicit, 2, 5);

  const goalText = String(goal || "");
  const placeMatch = goalText.match(/([2-5二三四五两])\s*个(?:地方|地点|点|站)/);
  if (placeMatch) {
    const numberMap = { "2": 2, "3": 3, "4": 4, "5": 5, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5 };
    return clamp(numberMap[placeMatch[1]], 2, 5);
  }

  const text = `${intent?.duration || ""} ${duration || ""} ${goalText}`;
  if (/一天|整天|8\s*小时|9\s*小时|10\s*小时/.test(text)) return 5;
  if (/半天|6\s*小时|5\s*小时/.test(text)) return 4;
  if (/4\s*小时|3\s*小时/.test(text)) return 3;
  if (/2\s*小时|1\s*小时|一会|简单|随便/.test(text)) return 2;
  return 3;
}

function isLocation(value) {
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(value || ""));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function boundaryLabelPoint(polylines) {
  const points = polylines.flat();
  if (!points.length) return "";
  let minLng = Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    const [lng, lat] = point.split(",").map(Number);
    if (Number.isFinite(lng) && lng < minLng) minLng = lng;
    if (Number.isFinite(lat) && lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(maxLat)) return "";
  return `${minLng},${maxLat}`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

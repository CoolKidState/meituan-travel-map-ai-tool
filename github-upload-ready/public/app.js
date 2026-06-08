const form = document.querySelector("#nearbyForm");
const plannerForm = document.querySelector("#plannerForm");
const mapStatus = document.querySelector("#mapStatus");
const aiStatus = document.querySelector("#aiStatus");
const mapFallback = document.querySelector("#mapFallback");
const adviceText = document.querySelector("#adviceText");
const copyAdvice = document.querySelector("#copyAdvice");
const poiList = document.querySelector("#poiList");
const resultCount = document.querySelector("#resultCount");
const submitButton = form.querySelector("button[type='submit']");
const locateButton = document.querySelector("#locateButton");
const mapLocateButton = document.querySelector("#mapLocateButton");
const mapAreaToggle = document.querySelector("#mapAreaToggle");
const modeButtons = document.querySelectorAll(".mode-button");
const nearbyPanel = document.querySelector("#nearbyPanel");
const plannerPanel = document.querySelector("#plannerPanel");
const planPreview = document.querySelector("#planPreview");
const planTrace = document.querySelector("#planTrace");
const planActions = document.querySelector("#planActions");
const actionFeedback = document.querySelector("#actionFeedback");
const copyPlan = document.querySelector("#copyPlan");
const randomIdeaButton = document.querySelector("#randomIdeaButton");
const actionDrawer = document.querySelector("#actionDrawer");
const actionDrawerTitle = document.querySelector("#actionDrawerTitle");
const actionDrawerBody = document.querySelector("#actionDrawerBody");
const actionDrawerClose = document.querySelector("#actionDrawerClose");
const executionSidebar = document.querySelector("#executionSidebar");
const executionSidebarBody = document.querySelector("#executionSidebarBody");
const executionSidebarClose = document.querySelector("#executionSidebarClose");

const DEFAULT_CENTER = [116.397428, 39.90923];
const FIT_PADDING = [60, 60, 60, 60];
const EXECUTION_STORAGE_KEY = "meituan-demo-execution-orders";
const MAP_CLICK_MOVE_MS = 650;

let mapConfig = null;
let currentMap = null;
let searchCenterMarker = null;
let intentAreaMarker = null;
let intentAreaPolygons = [];
let poiMarkers = [];
let planMarkers = [];
let planRouteLines = [];
let clickMoveLine = null;
let clickMoveLineTimer = null;
let clickMoveTarget = null;
let mapCenterAnimationId = 0;
let planRoutePoints = [];
let segmentModes = [];
let latestAdvice = "";
let latestPlanShare = "";
let latestPlanAreaLabel = "";
let latestPlanAreaBoundary = null;
let showIntentArea = true;
let activeMode = "planner";
let currentCenter = [...DEFAULT_CENTER];
let selectedExecutionPoi = null;
let selectedExecutionAction = "";
let latestExecutionOrders = readExecutionOrders();
let currentDrawerExecutionPoints = [];

init();

const ideaExamples = [
  "今天不想太折腾，想在昌平区回龙观附近安排一个 2 小时的小路线。",
  "想在海淀区中关村附近安排 4 个地方，有吃有逛，别太绕。",
  "我在朝阳区望京附近，想安排 3 个地方，轻松一点。"
];

randomIdeaButton.addEventListener("click", () => {
  const textarea = plannerForm.elements.goal;
  const current = textarea.value;
  let next = current;
  while (next === current && ideaExamples.length > 1) {
    next = ideaExamples[Math.floor(Math.random() * ideaExamples.length)];
  }
  textarea.value = next;
  textarea.focus();
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    modeButtons.forEach((item) => {
      const selected = item.dataset.mode === mode;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    nearbyPanel.hidden = mode !== "nearby";
    plannerPanel.hidden = mode !== "planner";
    activeMode = mode;
    syncModeOverlays();
  });
});

async function init() {
  try {
    const [status, config] = await Promise.all([
      request("/api/status"),
      request("/api/map-config")
    ]);
    mapConfig = config;
    setStatus(mapStatus, status.amapWebConfigured && status.amapJsConfigured, status.amapJsConfigured ? "高德地图已配置" : "缺少 JS 地图 Key");
    setStatus(aiStatus, status.dashscopeConfigured, status.dashscopeConfigured ? `百炼已配置：${status.model}` : "百炼未配置");
    await bootMap();
  } catch (error) {
    mapFallback.innerHTML = `<strong>初始化失败</strong><span>${escapeHtml(error.message)}</span>`;
    adviceText.textContent = error.message;
    adviceText.classList.add("error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await searchNearby();
});

plannerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await generateAfternoonPlan();
});

locateButton.addEventListener("click", () => locateToCurrentPosition(locateButton));
mapLocateButton.addEventListener("click", () => locateToCurrentPosition(mapLocateButton));

mapAreaToggle.addEventListener("click", () => {
  showIntentArea = !showIntentArea;
  mapAreaToggle.classList.toggle("active", showIntentArea);
  mapAreaToggle.textContent = showIntentArea ? "区块" : "隐藏";
  if (showIntentArea && latestPlanAreaLabel) {
    renderIntentArea(parseLocation(latestPlanAreaBoundary?.labelPoint) || safeCurrentCenter(), latestPlanAreaLabel);
  } else {
    clearIntentArea();
  }
});

copyAdvice.addEventListener("click", async () => {
  if (!latestAdvice) return;
  await navigator.clipboard.writeText(latestAdvice);
  copyAdvice.textContent = "已复制";
  setTimeout(() => {
    copyAdvice.textContent = "复制";
  }, 1200);
});

copyPlan.addEventListener("click", async () => {
  if (!latestPlanShare) return;
  await navigator.clipboard.writeText(latestPlanShare);
  copyPlan.textContent = "已复制";
  setTimeout(() => {
    copyPlan.textContent = "复制";
  }, 1200);
});

actionDrawerClose.addEventListener("click", () => {
  closeActionDrawer();
});

executionSidebarClose.addEventListener("click", () => {
  closeExecutionSidebar();
});

async function bootMap() {
  if (!mapConfig?.jsApiConfigured) {
    mapFallback.innerHTML = "<strong>缺少交互地图配置</strong><span>请在 .env 填入 AMAP_JS_API_KEY 和 AMAP_JS_SECURITY_KEY 后重启。</span>";
    return;
  }

  await loadAmap();
  currentCenter = parseLocation(mapConfig.defaultCenter) || [...DEFAULT_CENTER];
  currentMap = new window.AMap.Map("amapContainer", {
    resizeEnable: true,
    zoom: 14,
    center: currentCenter,
    viewMode: "2D",
    scrollWheel: false
  });
  setupCenterWheelZoom();

  currentMap.on("mapmove", () => {
    currentCenter = safePoint(lngLatToArray(currentMap.getCenter()), currentCenter);
    updateClickMoveLine();
  });

  currentMap.on("moveend", () => {
    currentCenter = safePoint(lngLatToArray(currentMap.getCenter()), currentCenter);
    scheduleClickMoveLineClear();
  });

  currentMap.on("click", (event) => {
    const point = safePoint([event.lnglat.lng, event.lnglat.lat], null);
    if (!point) return;
    moveMapCenterFixed(point);
  });

  mapFallback.hidden = true;
  adviceText.textContent = "";
}

async function searchNearby() {
  setLoading(true);
  adviceText.classList.remove("error");
  adviceText.textContent = "正在查询高德周边地点，并生成推荐...";

  const payload = Object.fromEntries(new FormData(form).entries());
  payload.center = safeCurrentCenter().join(",");

  try {
    const result = await request("/api/nearby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderNearbyResult(result);
  } catch (error) {
    latestAdvice = "";
    copyAdvice.disabled = true;
    adviceText.textContent = error.message;
    adviceText.classList.add("error");
  } finally {
    setLoading(false);
  }
}

function renderNearbyResult(result) {
  currentCenter = parseLocation(result.center) || safeCurrentCenter();
  currentMap?.setCenter(currentCenter);

  latestAdvice = result.aiAdvice || "";
  adviceText.textContent = latestAdvice || "没有返回推荐。";
  adviceText.classList.toggle("error", latestAdvice.startsWith("AI 推荐暂时不可用"));
  copyAdvice.disabled = !latestAdvice;

  renderPois(result.pois || []);
  renderNearbyMarkers(result.center, result.pois || []);
}

function renderPois(pois) {
  resultCount.textContent = `${pois.length} 个结果`;
  poiList.innerHTML = "";

  if (!pois.length) {
    poiList.innerHTML = `<div class="empty">没有找到匹配地点，试试扩大半径或换个关键词。</div>`;
    return;
  }

  pois.forEach((poi, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "poi-card";
    item.innerHTML = `
      <span class="poi-thumb">${renderPoiThumb(poi)}</span>
      <span class="rank">${index + 1}</span>
      <span class="poi-body">
        <strong>${escapeHtml(poi.name)}</strong>
        <span>${escapeHtml(poi.type || "地点")} · ${formatDistance(poi.distance)}</span>
        <span>${escapeHtml(poi.address || "暂无地址")}</span>
        <span>${metaLine(poi)}</span>
      </span>
    `;
    item.addEventListener("click", () => focusPoi(poi, index));
    poiList.appendChild(item);
  });
}

function renderNearbyMarkers(center, pois) {
  if (!currentMap || !window.AMap) return;
  clearPoiOverlays();
  clearPlanOverlays();
  clearSearchCenterMarker();

  const centerPoint = parseLocation(center) || safeCurrentCenter();
  searchCenterMarker = createSearchPin(centerPoint, "本次搜索中心");

  poiMarkers = pois
    .map((poi, index) => {
      const position = parseLocation(poi.location);
      if (!position) return null;
      const marker = new window.AMap.Marker({
        position,
        label: { content: String(index + 1), direction: "top" },
        title: poi.name
      });
      marker.on("click", () => openExecutionSidebar(poi, "附近地点"));
      return marker;
    })
    .filter(Boolean);

  currentMap.add([searchCenterMarker, ...poiMarkers].filter(Boolean));
  fitValidOverlays([searchCenterMarker, ...poiMarkers]);
}

async function generateAfternoonPlan() {
  const button = plannerForm.querySelector("button[type='submit']");
  const label = button.querySelector("span");
  button.disabled = true;
  label.textContent = "正在生成...";
  planPreview.innerHTML = `<article><strong>正在理解需求</strong><span>正在让 AI 判断场景、起点、约束和该搜索的地点类型。</span></article>`;
  planTrace.innerHTML = "";
  planActions.innerHTML = "";

  const payload = Object.fromEntries(new FormData(plannerForm).entries());
  payload.center = safeCurrentCenter().join(",");

  try {
    const result = await request("/api/afternoon-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderPlan(result);
  } catch (error) {
    latestPlanShare = "";
    copyPlan.disabled = true;
    planPreview.innerHTML = `<article><strong>规划失败</strong><span>${escapeHtml(error.message)}</span></article>`;
  } finally {
    button.disabled = false;
    label.textContent = "生成智能方案";
  }
}

function renderPlan(result) {
  latestPlanShare = result.shareText || "";
  latestPlanAreaLabel = result.centerSource === "goal" ? (result.centerLabel || result.extractedLocation || "") : "";
  latestPlanAreaBoundary = result.areaBoundary || null;
  copyPlan.disabled = !latestPlanShare;
  planRoutePoints = (result.routePoints || []).filter((point) => parseLocation(point.location));
  segmentModes = planRoutePoints.slice(0, -1).map(() => "walking");
  const planText = result.planText || clientPlanFallback(result, planRoutePoints);

  planPreview.innerHTML = `
    <article>
      <strong>AI 方案</strong>
      <span>${escapeHtml(planOriginText(result))}<br>${escapeHtml(planText).replaceAll("\n", "<br>")}</span>
    </article>
    ${planRoutePoints.map((point, index) => `
      <article>
        <button class="plan-stop-button" type="button" data-plan-index="${index}">
          <strong>${point.order || index + 1}. ${escapeHtml(point.name)}</strong>
          <span>${escapeHtml(point.type || "地点")} · ${formatDistance(point.distance)} · ${escapeHtml(point.address || "暂无地址")}</span>
        </button>
      </article>
      ${index < planRoutePoints.length - 1 ? renderSegmentControls(index) : ""}
    `).join("")}
  `;
  renderPlanTrace(result.trace || []);
  bindSegmentControls();
  bindPlanStopButtons();

  const actions = normalizeUiActions(result.actions || []);
  planActions.innerHTML = actions.map((action) => (
    renderActionButton(action, result)
  )).join("");
  bindPlanActions(result);

  renderPlanMarkers(result.center, planRoutePoints);
  openActionDrawer("地点详情", renderPlaceDetail(result.routePoints || []));
}

function renderPlanTrace(trace) {
  if (!trace.length) {
    planTrace.innerHTML = `<div class="empty">暂无链路信息。</div>`;
    return;
  }
  planTrace.innerHTML = trace.map((item, index) => `
    <div class="trace-item">
      <span>${index + 1}</span>
      <p>${escapeHtml(item)}</p>
    </div>
  `).join("");
}

function renderActionButton(action, result) {
  const actionId = typeof action === "string" ? action : action.id;
  const meal = findMealPoint(result.routePoints || []);
  const labels = {
    "copy-share": "复制转发文案",
    "open-route": "打开高德路线",
    "place-detail": "查看地图、地点详情",
    "show-stops": "查看地图、地点详情",
    "contacts": "查看地图、地点详情",
    "restaurant-check": "查看地图、地点详情",
    "calendar-hold": "复制生成日程提醒",
    "execution-note": "查看方案说明",
    "send-friend": "生成发给朋友的话"
  };
  const className = actionId === "open-route" ? "action-primary" : "";
  return `<button class="${className}" type="button" data-action="${escapeHtml(actionId)}">${escapeHtml(labels[actionId] || "查看详情")}</button>`;
}

function bindPlanActions(result) {
  planActions.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "copy-share" || action === "send-friend") {
        openActionDrawer("转发文案", renderTextBlock(result.shareText || clientPlanFallback(result, result.routePoints || [])));
        await copyText(result.shareText || clientPlanFallback(result, result.routePoints || []), button, "已复制");
      } else if (action === "open-route") {
        openActionDrawer("路线详情", renderRouteDetail(result.routePoints || []));
        openAmapRoute(result.routePoints || []);
      } else if (action === "place-detail" || action === "show-stops" || action === "contacts" || action === "restaurant-check") {
        openActionDrawer("地点详情", renderPlaceDetail(result.routePoints || []));
      } else if (action === "calendar-hold") {
        openActionDrawer("日程提醒", renderTextBlock(buildCalendarText(result)));
        await copyText(buildCalendarText(result), button, "日程已复制");
      } else {
        openActionDrawer("动作说明", renderTextBlock("当前可用的是打开高德路线、查看地图和地点详情、复制日程提醒、复制转发文案。"));
      }
    });
  });
}

function normalizeUiActions(actions) {
  const mapped = actions.map((action) => {
    const id = typeof action === "string" ? action : action?.id || action?.label || "";
    if (/地点|清单|列表|联系|电话|餐厅|订座|排队|contacts|restaurant|show-stops|place-detail/.test(id)) return "place-detail";
    if (/路线|导航|open-route/.test(id)) return "open-route";
    if (/转发|朋友|复制文案|copy-share|send-friend/.test(id)) return "copy-share";
    if (/日程|提醒|calendar/.test(id)) return "calendar-hold";
    return "";
  }).filter(Boolean);

  const allowed = ["open-route", "place-detail", "calendar-hold", "copy-share"];
  const unique = new Set([...mapped, ...allowed].filter((action) => allowed.includes(action)));
  return allowed.filter((action) => unique.has(action));
}

function openActionDrawer(title, html) {
  actionDrawerTitle.textContent = title;
  actionDrawerBody.innerHTML = html;
  actionDrawer.hidden = false;
  document.querySelector(".app-shell").classList.add("drawer-visible", "action-visible");
  bindDrawerExecutionTargets();
}

function closeActionDrawer() {
  actionDrawer.hidden = true;
  document.querySelector(".app-shell").classList.remove("drawer-visible", "action-visible");
}

function openExecutionSidebar(poi, source = "地点") {
  selectedExecutionPoi = poi;
  const actions = buildExecutionActions(poi);
  selectedExecutionAction = actions[0]?.id || "reserve";
  executionSidebarBody.innerHTML = renderExecutionSidebar(poi, source, actions);
  executionSidebar.hidden = false;
  document.querySelector(".app-shell").classList.add("execution-visible");
  bindExecutionSidebar(actions, source);
}

function closeExecutionSidebar() {
  executionSidebar.hidden = true;
  document.querySelector(".app-shell").classList.remove("execution-visible");
}

function renderExecutionSidebar(poi, source, actions, result = null, error = "") {
  if (!poi) {
    return `<div class="execution-empty">点击任意地点后，这里会生成订座、排队、预约或下单动作。</div>`;
  }
  const activeAction = actions.find((action) => action.id === selectedExecutionAction) || actions[0];
  const nowValue = defaultExecutionTime();
  return `
    <section class="execution-place">
      ${renderDrawerThumb(poi, "下")}
      <div>
        <strong>${escapeHtml(poi.name)}</strong>
        <p>${escapeHtml(source)} · ${escapeHtml(poi.type || "地点")} · ${formatDistance(poi.distance)}</p>
        <p>${escapeHtml(poi.address || "暂无地址")}</p>
        ${poi.tel ? `<p>电话：${escapeHtml(poi.tel)}</p>` : ""}
      </div>
    </section>

    <section class="execution-automation">
      <div>
        <span>商业动作自动化</span>
        <strong>已识别：${escapeHtml(activeAction?.commercial || "关键履约动作")}</strong>
      </div>
      <ol>
        <li>识别地点类型</li>
        <li>匹配可变现动作</li>
        <li>自动生成履约单</li>
      </ol>
    </section>

    <section class="execution-block">
      <div class="execution-heading">
        <h3>关键商业动作</h3>
        <span>${escapeHtml(activeAction?.label || "选择动作")}</span>
      </div>
      <div class="execution-actions">
        ${actions.map((action) => `
          <button class="${action.id === selectedExecutionAction ? "active" : ""}" type="button" data-exec-action="${escapeHtml(action.id)}">
            <strong>${escapeHtml(action.label)}<em>${escapeHtml(action.commercial || "商业动作")}</em></strong>
            <span>${escapeHtml(action.reason)}</span>
          </button>
        `).join("")}
      </div>
    </section>

    <form class="execution-form" id="executionForm">
      <div class="execution-heading">
        <h3>自动执行参数</h3>
        <span>一键完成</span>
      </div>
      <input type="hidden" name="actionType" value="${escapeHtml(selectedExecutionAction)}" />
      <div class="row">
        <label>
          人数/数量
          <input name="quantity" type="number" min="1" max="20" value="2" />
        </label>
        <label>
          时间
          <input name="scheduledAt" type="datetime-local" value="${escapeHtml(nowValue)}" />
        </label>
      </div>
      <label>
        联系方式
        <input name="contact" placeholder="手机号或联系人" />
      </label>
      <label>
        备注
        <textarea name="note" rows="3" placeholder="例如靠窗、带孩子、少油少辣、到店后再支付"></textarea>
      </label>
      <button class="primary" type="submit">
        <span>一键自动完成${escapeHtml(activeAction?.label || "下单/预订")}</span>
      </button>
      <p class="execution-disclaimer">比赛演示闭环：会生成本地模拟订单，不代表真实美团支付、库存或商家确认。</p>
    </form>

    ${error ? `<div class="execution-error">${escapeHtml(error)}</div>` : ""}
    ${result ? renderExecutionResult(result) : ""}
    ${renderExecutionHistory()}
  `;
}

function bindExecutionSidebar(actions, source) {
  executionSidebarBody.querySelectorAll("button[data-exec-action]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedExecutionAction = button.dataset.execAction;
      executionSidebarBody.innerHTML = renderExecutionSidebar(selectedExecutionPoi, source, actions);
      bindExecutionSidebar(actions, source);
    });
  });

  const formElement = executionSidebarBody.querySelector("#executionForm");
  formElement?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = formElement.querySelector("button[type='submit']");
    const label = button.querySelector("span");
    button.disabled = true;
    label.textContent = "正在提交...";
    const payload = Object.fromEntries(new FormData(formElement).entries());
    payload.poi = selectedExecutionPoi;
    payload.source = source;

    try {
      const result = await submitExecutionAction(payload);
      latestExecutionOrders = [result, ...latestExecutionOrders.filter((item) => item.orderId !== result.orderId)].slice(0, 5);
      writeExecutionOrders(latestExecutionOrders);
      executionSidebarBody.innerHTML = renderExecutionSidebar(selectedExecutionPoi, source, actions, result);
      bindExecutionSidebar(actions, source);
    } catch (error) {
      executionSidebarBody.innerHTML = renderExecutionSidebar(selectedExecutionPoi, source, actions, null, error.message);
      bindExecutionSidebar(actions, source);
    }
  });
}

function buildExecutionActions(poi) {
  const text = `${poi?.type || ""} ${poi?.name || ""} ${poi?.tag || ""}`;
  const actions = [];
  const add = (id, label, reason, commercial) => {
    if (!actions.some((action) => action.id === id)) actions.push({ id, label, reason, commercial });
  };

  if (/餐饮|美食|火锅|烧烤|咖啡|小吃|餐厅|茶饮|甜品/.test(text)) {
    add("reserve-table", "订座", "餐饮地点优先锁定到店时间和人数", "到店预订");
    add("queue-ticket", "排队取号", "适合高峰期先拿号减少等待", "排队转化");
    add("deal-package", "团购套餐", "适合先确认套餐再到店核销", "团购核销");
  }
  if (/风景|景区|展览|博物馆|艺术|文化|公园|乐园|影院|电影/.test(text)) {
    add("entry-reservation", "预约入场", "适合需要入场时段或票务确认的地点", "预约入场");
    add("ticket-reminder", "购票提醒", "先保留票务动作，避免临近出发遗漏", "票务转化");
  }
  if (/休闲|娱乐|KTV|桌游|密室|运动|健身|酒吧|茶馆/.test(text)) {
    add("arrival-booking", "预约到店", "适合按时间段预留服务", "到店预约");
    add("phone-confirm", "电话确认", "适合先确认空位、营业和低峰时段", "商家确认");
  }

  if (poi?.tel) add("phone-confirm", "电话确认", "已有商家电话，可直接确认关键事项", "商家确认");

  return actions;
}

async function submitExecutionAction(payload) {
  try {
    return await request("/api/execute-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error.status === 404) return buildClientExecutionResult(payload);
    throw error;
  }
}

function renderExecutionResult(result) {
  return `
    <section class="execution-result">
      <div>
        <span class="execution-status">${escapeHtml(result.statusLabel || "已生成")}</span>
        <strong>已自动完成${escapeHtml(result.actionLabel)}</strong>
      </div>
      <p class="execution-result-lead">关键商业动作已沉淀为本地演示履约单。</p>
      <p>订单号：${escapeHtml(result.orderId)}</p>
      <p>地点：${escapeHtml(result.poiName)}</p>
      <p>时间：${escapeHtml(result.scheduledAtLabel)}</p>
      <p>联系人：${escapeHtml(result.contact)}</p>
      <div class="execution-next">
        ${(result.nextSteps || []).map((step) => `<span>${escapeHtml(step)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderExecutionHistory() {
  if (!latestExecutionOrders.length) {
    return `<section class="execution-history"><h3>最近执行</h3><div class="execution-empty small">暂无本地订单/预订记录。</div></section>`;
  }
  return `
    <section class="execution-history">
      <h3>最近执行</h3>
      ${latestExecutionOrders.map((order) => `
        <article>
          <strong>${escapeHtml(order.actionLabel)} · ${escapeHtml(order.poiName)}</strong>
          <span>${escapeHtml(order.orderId)} · ${escapeHtml(order.scheduledAtLabel)}</span>
        </article>
      `).join("")}
    </section>
  `;
}

function buildClientExecutionResult(payload) {
  const poi = payload.poi || {};
  if (!poi.name) throw new Error("缺少地点信息，无法生成演示订单。");
  if (!payload.scheduledAt) throw new Error("请选择有效的到店或预约时间。");
  if (!payload.contact) throw new Error("请填写联系方式，用于生成演示订单。");
  const actionLabel = executionActionLabel(payload.actionType);
  return {
    orderId: buildClientDemoOrderId(),
    status: "demo_confirmed",
    statusLabel: "本地演示已确认",
    actionType: payload.actionType,
    actionLabel,
    poiName: poi.name,
    poiType: poi.type || "地点",
    poiAddress: poi.address || "暂无地址",
    poiTel: poi.tel || "",
    scheduledAt: payload.scheduledAt,
    scheduledAtLabel: payload.scheduledAt.replace("T", " "),
    quantity: Number(payload.quantity || 1),
    contact: payload.contact,
    note: payload.note || "",
    source: payload.source || "地点",
    demoNotice: "这是比赛演示闭环生成的本地模拟订单，不代表真实美团支付、库存或商家确认。",
    nextSteps: clientExecutionNextSteps(payload.actionType, poi)
  };
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

function clientExecutionNextSteps(actionType, poi) {
  if (actionType === "phone-confirm") {
    return [poi.tel ? `可拨打 ${poi.tel} 做最终确认` : "暂无电话，建议到店前再次查询", "确认后再出发"];
  }
  if (actionType === "navigation") return ["已把地点转为出发动作", "建议打开高德路线确认交通方式"];
  if (actionType === "calendar-hold") return ["已生成日程提醒语义", "出发前 30 分钟再次检查路线"];
  return ["出发前再次确认营业状态", "到店后按演示订单号核对"];
}

function buildClientDemoOrderId() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MT-DEMO-${day}-${suffix}`;
}

function bindPlanStopButtons() {
  document.querySelectorAll(".plan-stop-button").forEach((button) => {
    button.addEventListener("click", () => {
      const point = planRoutePoints[Number(button.dataset.planIndex)];
      if (point) openExecutionSidebar(point, "智能规划站点");
    });
  });
}

function renderTextBlock(text) {
  return `<div class="drawer-text">${escapeHtml(text || "暂无内容").replaceAll("\n", "<br>")}</div>`;
}

function renderRouteDetail(points) {
  const validPoints = points.filter((point) => parseLocation(point.location));
  if (!validPoints.length) return renderTextBlock("暂无可用路线点。");
  currentDrawerExecutionPoints = validPoints;
  return `
    <div class="drawer-list">
      ${validPoints.map((point, index) => `
        <button class="drawer-place-button" type="button" data-drawer-execution-index="${index}" data-drawer-execution-source="路线详情">
          ${renderDrawerThumb(point, index + 1)}
          <div>
            <strong>${escapeHtml(point.name)}</strong>
            <p>${escapeHtml(point.type || "地点")} · ${formatDistance(point.distance)}</p>
            <p>${escapeHtml(point.address || "暂无地址")}</p>
            ${renderExtraPoiMeta(point)}
          </div>
        </button>
      `).join("")}
    </div>
    <div class="drawer-note">已尝试打开高德路线。点击上方任意地点，会在路线详情右侧打开智能下单侧边栏。</div>
  `;
}

function renderPlaceDetail(points) {
  const targets = points.filter((point) => point.address || point.tel);
  if (!targets.length) return renderTextBlock("这条方案里没有可展示联系方式的地点。");
  currentDrawerExecutionPoints = targets;
  return `
    <div class="drawer-list">
      ${targets.map((item, index) => `
        <button class="drawer-place-button" type="button" data-drawer-execution-index="${index}" data-drawer-execution-source="智能规划地点详情">
          ${renderDrawerThumb(item, index + 1)}
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <p>${escapeHtml(item.type || "地点")}</p>
            <p>地址：${escapeHtml(item.address || "暂无地址")}</p>
            <p>电话：${escapeHtml(item.tel || "暂无电话")}</p>
            ${item.rating ? `<p>评分：${escapeHtml(item.rating)}</p>` : ""}
            ${item.cost ? `<p>人均：${escapeHtml(item.cost)}</p>` : ""}
            ${renderExtraPoiMeta(item)}
            ${renderPhotoStrip(item)}
          </div>
        </button>
      `).join("")}
    </div>
    <div class="drawer-note">点击上方具体地点，会在地点详情右侧打开新的智能下单侧边栏。当前生成的是比赛演示闭环，不代表真实美团支付或商家确认。</div>
  `;
}

function bindDrawerExecutionTargets() {
  actionDrawerBody.querySelectorAll("button[data-drawer-execution-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const point = currentDrawerExecutionPoints[Number(button.dataset.drawerExecutionIndex)];
      if (point) openExecutionSidebar(point, button.dataset.drawerExecutionSource || "智能规划地点详情");
    });
  });
}

async function copyText(text, button, doneLabel) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = doneLabel;
  showActionFeedback(text);
  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function openAmapRoute(points) {
  const validPoints = points.filter((point) => parseLocation(point.location));
  if (validPoints.length < 2) {
    showActionFeedback("路线点不足，暂时不能打开完整路线。");
    return;
  }
  const origin = validPoints[0];
  const destination = validPoints[validPoints.length - 1];
  const url = new URL("https://uri.amap.com/navigation");
  url.searchParams.set("from", `${origin.location},${origin.name}`);
  url.searchParams.set("to", `${destination.location},${destination.name}`);
  const waypoints = validPoints.slice(1, -1);
  if (waypoints.length) {
    url.searchParams.set("via", waypoints.map((point) => `${point.location},${point.name}`).join(";"));
  }
  url.searchParams.set("mode", "car");
  url.searchParams.set("policy", "1");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
  showActionFeedback(waypoints.length ? "已打开包含途经点的高德路线。" : "已打开高德路线。");
}

function showRestaurantInfo(points) {
  const meal = findMealPoint(points);
  if (!meal) {
    const first = points.find((point) => point.address || point.tel);
    if (!first) {
      showActionFeedback("这条方案里没有可展示联系方式的地点。");
      return;
    }
    showActionFeedback([
      `地点：${first.name}`,
      `地址：${first.address || "暂无地址"}`,
      `电话：${first.tel || "暂无电话"}`
    ].join("\n"));
    return;
  }
  const lines = [
    `餐厅：${meal.name}`,
    `地址：${meal.address || "暂无地址"}`,
    `电话：${meal.tel || "暂无电话"}`,
    meal.rating ? `评分：${meal.rating}` : "",
    meal.cost ? `人均：${meal.cost}` : "",
    "真实排队/订座需要接入美团商家和排队接口。"
  ].filter(Boolean);
  showActionFeedback(lines.join("\n"));
}

function renderAllContacts(points) {
  const targets = points.filter((point) => point.address || point.tel);
  if (!targets.length) return renderTextBlock("这条方案里没有可展示联系方式的地点。");
  return `
    <div class="drawer-list">
      ${targets.map((item, index) => `
        <article>
          ${renderDrawerThumb(item, index + 1)}
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <p>${escapeHtml(item.type || "地点")}</p>
            <p>地址：${escapeHtml(item.address || "暂无地址")}</p>
            <p>电话：${escapeHtml(item.tel || "暂无电话")}</p>
            ${renderExtraPoiMeta(item)}
            ${renderPhotoStrip(item)}
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function buildRouteListText(points) {
  if (!points.length) return "暂无路线点。";
  return points.map((point, index) => (
    `${index + 1}. ${point.name}\n地址：${point.address || "暂无地址"}\n类型：${point.type || "地点"}`
  )).join("\n\n");
}

function buildCompactPlanExport(result) {
  const routePoints = (result.routePoints || []).map((point) => ({
    order: point.order,
    name: point.name,
    type: point.type,
    address: point.address,
    location: point.location,
    distance: point.distance,
    rating: point.rating || "",
    cost: point.cost || "",
    tel: point.tel || "",
    businessArea: point.businessArea || "",
    commercialActions: buildExecutionActions(point).map((action) => ({
      id: action.id,
      label: action.label,
      commercial: action.commercial,
      reason: action.reason
    }))
  }));

  return {
    goal: result.goal || "",
    scenario: result.scenario || "",
    duration: result.duration || "",
    centerLabel: result.centerLabel || "",
    extractedLocation: result.extractedLocation || "",
    planText: result.planText || "",
    shareText: result.shareText || "",
    routePoints,
    executableSummary: {
      routeStops: routePoints.length,
      availableCommercialActions: [...new Set(routePoints.flatMap((point) => (
        point.commercialActions.map((action) => action.commercial)
      )))],
      recentDemoOrders: latestExecutionOrders.map((order) => ({
        orderId: order.orderId,
        actionLabel: order.actionLabel,
        poiName: order.poiName,
        scheduledAtLabel: order.scheduledAtLabel,
        statusLabel: order.statusLabel
      }))
    },
    trace: result.trace || [],
    dataSummary: {
      groups: (result.groups || []).map((group) => ({
        key: group.key,
        label: group.label,
        candidateCount: group.pois?.length || 0
      })),
      areaBoundary: result.areaBoundary ? {
        name: result.areaBoundary.name,
        adcode: result.areaBoundary.adcode,
        level: result.areaBoundary.level
      } : null
    },
    omittedLargeFields: [
      "areaBoundary.polylines",
      "groups.pois.photos",
      "groups.pois.rawCandidateDetails"
    ]
  };
}

function renderExecutionNote(result) {
  const meal = findMealPoint(result.routePoints || []);
  return `
    <div class="drawer-list">
      <article>
        <span class="drawer-index">✓</span>
        <div>
          <strong>已可执行</strong>
          <p>打开高德路线、查看地图和地点详情、复制日程提醒、复制转发文案。</p>
        </div>
      </article>
      <article>
        <span class="drawer-index">!</span>
        <div>
          <strong>需要外部接口</strong>
          <p>真实排队、订座、下单、买票、买蛋糕鲜花，需要接入美团商家/订单/排队/履约接口。</p>
        </div>
      </article>
      <article>
        <span class="drawer-index">${meal ? "餐" : "-"}</span>
        <div>
          <strong>${meal ? "餐饮点已识别" : "未识别餐饮点"}</strong>
          <p>${meal ? `${escapeHtml(meal.name)} 可查看地址和电话。` : "可以重新生成方案，或在想法里说明需要吃饭。"}</p>
        </div>
      </article>
    </div>
  `;
}

function buildCalendarText(result) {
  const lines = [
    "本地活动安排",
    planOriginText(result),
    result.planText || clientPlanFallback(result, result.routePoints || []),
    "",
    "路线点：",
    ...(result.routePoints || []).map((point, index) => `${index + 1}. ${point.name} - ${point.address || "暂无地址"}`)
  ];
  return lines.join("\n");
}

function findMealPoint(points) {
  return points.find((point) => point.type?.includes("餐饮") || point.type?.includes("美食"));
}

function showActionFeedback(text) {
  actionFeedback.textContent = text;
  actionFeedback.hidden = !text;
}

function renderPlanMarkers(center, routePoints) {
  if (!currentMap || !window.AMap) return;
  activeMode = "planner";
  syncModeOverlays();
  clearPoiOverlays();
  clearPlanOverlays();
  clearSearchCenterMarker();

  const centerPoint = parseLocation(center) || safeCurrentCenter();
  searchCenterMarker = createSearchPin(centerPoint, "本次规划中心");
  if (showIntentArea) renderIntentArea(centerPoint, latestPlanAreaLabel);

  planMarkers = routePoints
    .map((point, index) => {
      const position = parseLocation(point.location);
      if (!position) return null;
      const marker = new window.AMap.Marker({
        position,
        zIndex: 125,
        title: point.name,
        content: `<div class="plan-pin">${point.order || index + 1}</div>`
      });
      marker.on("click", () => openExecutionSidebar(point, "智能规划站点"));
      return marker;
    })
    .filter(Boolean);

  currentMap.add([searchCenterMarker, ...planMarkers].filter(Boolean));
  fitValidOverlays([searchCenterMarker, ...planMarkers]);
  renderRouteSegments();
}

function syncModeOverlays() {
  const plannerMode = activeMode === "planner";
  mapAreaToggle.hidden = !plannerMode;
  mapAreaToggle.classList.toggle("active", plannerMode && showIntentArea);
  mapAreaToggle.textContent = showIntentArea ? "区块" : "隐藏";
  if (!plannerMode) {
    clearIntentArea();
  } else if (showIntentArea && latestPlanAreaLabel) {
    renderIntentArea(parseLocation(latestPlanAreaBoundary?.labelPoint) || safeCurrentCenter(), latestPlanAreaLabel);
  }
}

function renderSegmentControls(index) {
  return `
    <div class="segment-mode" data-segment="${index}">
      <span>${index + 1} → ${index + 2}</span>
      <button type="button" data-mode="driving" title="驾车">驾车</button>
      <button class="active" type="button" data-mode="walking" title="步行">步行</button>
      <button type="button" data-mode="riding" title="骑行">骑行</button>
    </div>
  `;
}

function bindSegmentControls() {
  document.querySelectorAll(".segment-mode button").forEach((button) => {
    button.addEventListener("click", async () => {
      const wrapper = button.closest(".segment-mode");
      const index = Number(wrapper.dataset.segment);
      segmentModes[index] = button.dataset.mode;
      wrapper.querySelectorAll("button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      await renderRouteSegments();
    });
  });
}

async function renderRouteSegments() {
  if (!currentMap || !window.AMap || planRoutePoints.length < 2) return;
  removeOverlays(planRouteLines);
  planRouteLines = [];

  for (let index = 0; index < planRoutePoints.length - 1; index += 1) {
    const start = parseLocation(planRoutePoints[index].location);
    const end = parseLocation(planRoutePoints[index + 1].location);
    if (!start || !end) continue;
    const mode = segmentModes[index] || "driving";
    let path = [];

    try {
      path = await calculateRoutePath(start, end, mode);
    } catch {
      path = [start, end];
    }

    const line = new window.AMap.Polyline({
      path,
      strokeColor: routeColor(mode),
      strokeWeight: 6,
      strokeOpacity: 0.88,
      strokeStyle: path.length <= 2 ? "dashed" : "solid",
      lineJoin: "round",
      lineCap: "round",
      zIndex: 80
    });
    planRouteLines.push(line);
  }

  if (planRouteLines.length) currentMap.add(planRouteLines);
}

function calculateRoutePath(start, end, mode) {
  const pluginName = {
    driving: "AMap.Driving",
    walking: "AMap.Walking",
    riding: "AMap.Riding"
  }[mode] || "AMap.Driving";

  return new Promise((resolve, reject) => {
    window.AMap.plugin([pluginName], () => {
      const Service = pluginName.split(".").reduce((obj, key) => obj?.[key], window);
      if (!Service) return reject(new Error("路线服务不可用"));
      const service = new Service({ hideMarkers: true });
      service.search(start, end, (status, result) => {
        if (status !== "complete") return reject(new Error("路线规划失败"));
        const path = extractRoutePath(result);
        if (path.length < 2) return reject(new Error("路线点为空"));
        resolve(path);
      });
    });
  });
}

function extractRoutePath(result) {
  const route = result.routes?.[0] || result.route?.paths?.[0] || result.paths?.[0];
  if (!route) return [];
  const direct = normalizePath(route.path || route.polyline);
  if (direct.length >= 2) return direct;
  const steps = route.steps || route.rides || route.walks || [];
  return steps.flatMap((step) => normalizePath(step.path || step.polyline));
}

function normalizePath(value) {
  if (!value) return [];
  if (typeof value === "string") return value.split(";").map(parseLocation).filter(Boolean);
  if (Array.isArray(value)) return value.map(lngLatToArray).map((point) => safePoint(point, null)).filter(Boolean);
  return [];
}

function routeColor(mode) {
  if (mode === "walking") return "#16735f";
  if (mode === "riding") return "#2f6fdd";
  return "#d86634";
}

function planOriginText(result) {
  if (result.centerSource === "goal" && result.extractedLocation) {
    return `规划起点：${result.centerLabel || result.extractedLocation}（AI 从想法中识别）`;
  }
  return `规划起点：${result.centerLabel || "地图中心"}（地图中心）`;
}

function clientPlanFallback(result, points) {
  if (!points.length) {
    return "暂时没有拿到可用地点。请确认高德 Web 服务 Key 可用，或在想法里写明具体城市/区域后再试。";
  }
  return [
    `已按 ${result.duration || "当前时长"} 生成基础路线：`,
    ...points.map((point, index) => `${index + 1}. ${point.name}，${formatDistance(point.distance)}，${point.type || "地点"}`),
    "建议出发前确认营业状态、排队和订座情况。"
  ].join("\n");
}

function drawClickMoveLine(from, to) {
  if (!currentMap || !window.AMap || !from || !to) return;
  if (clickMoveLineTimer) {
    clearTimeout(clickMoveLineTimer);
    clickMoveLineTimer = null;
  }
  clickMoveTarget = to;
  removeOverlays([clickMoveLine]);
  clickMoveLine = new window.AMap.Polyline({
    path: [from, to],
    strokeColor: "#13202c",
    strokeWeight: 3,
    strokeOpacity: 0.72,
    strokeStyle: "dashed",
    zIndex: 150
  });
  currentMap.add(clickMoveLine);
}

function moveMapCenterFixed(target) {
  if (!currentMap || !target) return;
  const from = safeCurrentCenter();
  const to = safePoint(target, from);
  if (!to) return;

  if (mapCenterAnimationId) {
    cancelAnimationFrame(mapCenterAnimationId);
    mapCenterAnimationId = 0;
  }

  drawClickMoveLine(from, to);

  const startedAt = performance.now();
  const ease = (value) => 1 - Math.pow(1 - value, 3);

  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / MAP_CLICK_MOVE_MS);
    const eased = ease(progress);
    const next = [
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased
    ];

    currentCenter = next;
    currentMap.setCenter(next);

    if (progress < 1) {
      mapCenterAnimationId = requestAnimationFrame(step);
      return;
    }

    currentCenter = to;
    currentMap.setCenter(to);
    mapCenterAnimationId = 0;
    scheduleClickMoveLineClear();
  };

  mapCenterAnimationId = requestAnimationFrame(step);
}

function scheduleClickMoveLineClear() {
  if (!clickMoveLine) return;
  if (clickMoveLineTimer) clearTimeout(clickMoveLineTimer);
  clickMoveLineTimer = setTimeout(() => {
    removeOverlays([clickMoveLine]);
    clickMoveLine = null;
    clickMoveTarget = null;
    clickMoveLineTimer = null;
  }, 900);
}

function updateClickMoveLine() {
  if (!clickMoveLine || !clickMoveTarget || !currentMap) return;
  const from = safeCurrentCenter();
  clickMoveLine.setPath([from, clickMoveTarget]);
}

function createSearchPin(position, title) {
  return new window.AMap.Marker({
    position,
    offset: new window.AMap.Pixel(-15, -34),
    zIndex: 130,
    content: `<div class="search-pin" title="${escapeHtml(title)}"></div>`
  });
}

function renderIntentArea(centerPoint, label) {
  clearIntentArea();
  if (!label || !centerPoint) return;
  renderServerBoundary();
  const labelPoint = parseLocation(latestPlanAreaBoundary?.labelPoint) || areaLabelPointFromBoundary() || centerPoint;
  intentAreaMarker = new window.AMap.Marker({
    position: labelPoint,
    offset: new window.AMap.Pixel(0, 0),
    zIndex: 140,
    content: `<div class="area-badge">${escapeHtml(areaName(label))}</div>`
  });
  currentMap.add(intentAreaMarker);
}

function renderServerBoundary() {
  const polylines = latestPlanAreaBoundary?.polylines || [];
  if (!polylines.length) return;
  intentAreaPolygons = polylines
    .map((line) => line.map(parseLocation).filter(Boolean))
    .filter((line) => line.length >= 3)
    .map((path) => new window.AMap.Polygon({
      path,
      strokeColor: "#16735f",
      strokeWeight: 2,
      strokeOpacity: 0.95,
      fillColor: "#16735f",
      fillOpacity: 0.12,
      zIndex: 58
    }));
  if (intentAreaPolygons.length) currentMap.add(intentAreaPolygons);
}

function areaLabelPointFromBoundary() {
  const polylines = latestPlanAreaBoundary?.polylines || [];
  const points = polylines.flat().map(parseLocation).filter(Boolean);
  if (!points.length) return null;
  let minLng = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return safePoint([minLng, maxLat], null);
}

function areaName(fallback) {
  return latestPlanAreaBoundary?.name || fallback;
}

function focusPoi(poi, index) {
  const position = parseLocation(poi.location);
  if (currentMap && position) {
    currentMap.setZoomAndCenter(17, position);
    currentCenter = position;
    poiMarkers[index]?.setAnimation?.("AMAP_ANIMATION_BOUNCE");
    setTimeout(() => poiMarkers[index]?.setAnimation?.("AMAP_ANIMATION_NONE"), 1200);
  }
  openExecutionSidebar(poi, "附近地点");
}

function fitValidOverlays(overlays) {
  const items = overlays.filter(Boolean);
  if (!currentMap || !items.length) return;
  try {
    currentMap.setFitView(items, false, FIT_PADDING);
    currentCenter = safePoint(lngLatToArray(currentMap.getCenter()), currentCenter);
  } catch {
    currentMap.setCenter(safeCurrentCenter());
  }
}

function clearPoiOverlays() {
  removeOverlays(poiMarkers);
  poiMarkers = [];
}

function clearPlanOverlays() {
  removeOverlays(planMarkers);
  removeOverlays(planRouteLines);
  clearIntentArea();
  planMarkers = [];
  planRouteLines = [];
}

function clearIntentArea() {
  removeOverlays([intentAreaMarker, ...intentAreaPolygons]);
  intentAreaMarker = null;
  intentAreaPolygons = [];
}

function clearSearchCenterMarker() {
  if (!searchCenterMarker) return;
  removeOverlays([searchCenterMarker]);
  searchCenterMarker = null;
}

function removeOverlays(overlays) {
  if (!currentMap || !overlays?.length) return;
  const items = overlays.filter(Boolean);
  if (!items.length) return;
  try {
    currentMap.remove(items);
  } catch {
    for (const item of items) {
      try {
        currentMap.remove(item);
      } catch {
        // Ignore overlays already detached by AMap internals.
      }
    }
  }
}

function locateToCurrentPosition(triggerButton) {
  if (!navigator.geolocation) {
    adviceText.textContent = "当前浏览器不支持定位。可以拖动地图或输入地点搜索。";
    adviceText.classList.add("error");
    return;
  }

  const originalText = triggerButton.textContent;
  triggerButton.disabled = true;
  triggerButton.classList.add("loading");
  if (triggerButton === locateButton) triggerButton.textContent = "正在定位";

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      currentCenter = safePoint([position.coords.longitude, position.coords.latitude], currentCenter);
      currentMap?.setZoomAndCenter(15, currentCenter);
      form.elements.locationText.value = "";
      triggerButton.disabled = false;
      triggerButton.classList.remove("loading");
      if (triggerButton === locateButton) triggerButton.textContent = originalText || "定位到当前位置";
      await searchNearby();
    },
    (error) => {
      adviceText.textContent = `定位失败：${error.message || "浏览器没有授权定位"}。可以拖动地图或输入地点搜索。`;
      adviceText.classList.add("error");
      triggerButton.disabled = false;
      triggerButton.classList.remove("loading");
      if (triggerButton === locateButton) triggerButton.textContent = originalText || "定位到当前位置";
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

function loadAmap() {
  if (window.AMap) return Promise.resolve();
  if (mapConfig.securityJsCode) {
    window._AMapSecurityConfig = {
      securityJsCode: mapConfig.securityJsCode
    };
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(mapConfig.key)}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("高德 JS API 脚本加载失败，请确认 Web端(JS API) Key 和安全密钥正确。"));
    document.head.appendChild(script);
  });
}

function setupCenterWheelZoom() {
  const container = document.querySelector("#amapContainer");
  container.addEventListener("wheel", (event) => {
    if (!currentMap) return;
    event.preventDefault();
    const nextZoom = currentMap.getZoom() + (event.deltaY < 0 ? 1 : -1);
    currentMap.setZoom(nextZoom);
    currentCenter = safePoint(lngLatToArray(currentMap.getCenter()), currentCenter);
  }, { passive: false });
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("本地服务没有连上。请确认 start-tool.cmd 窗口正在运行，并且浏览器打开的是 http://localhost:4173。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setStatus(element, ok, text) {
  element.textContent = text;
  element.classList.toggle("ok", ok);
  element.classList.toggle("warn", !ok);
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector("span").textContent = loading ? "正在搜索..." : "搜索周边";
}

function parseLocation(value) {
  const point = String(value || "").split(",").map(Number);
  return safePoint(point, null);
}

function lngLatToArray(lngLat) {
  if (Array.isArray(lngLat)) return lngLat;
  if (typeof lngLat?.toArray === "function") return lngLat.toArray();
  if (typeof lngLat?.getLng === "function" && typeof lngLat?.getLat === "function") {
    return [lngLat.getLng(), lngLat.getLat()];
  }
  return [lngLat?.lng, lngLat?.lat];
}

function safePoint(point, fallback = [...DEFAULT_CENTER]) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : fallback;
}

function safeCurrentCenter() {
  if (currentMap) {
    currentCenter = safePoint(lngLatToArray(currentMap.getCenter()), currentCenter);
  }
  return safePoint(currentCenter);
}

function formatDistance(meters) {
  const value = Number(meters || 0);
  if (value >= 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value)} m`;
}

function metaLine(poi) {
  const parts = [];
  if (poi.rankScore) parts.push(`榜单分 ${poi.rankScore}`);
  if (poi.rating) parts.push(`评分 ${poi.rating}`);
  if (poi.cost) parts.push(`人均 ${poi.cost}`);
  if (poi.tel) parts.push(poi.tel);
  return escapeHtml(parts.join(" · ") || "暂无评分/电话");
}

function renderPoiThumb(poi) {
  const url = poi.photos?.[0];
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(poi.name)}" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<span>${escapeHtml((poi.name || "地点").slice(0, 1))}</span>`;
}

function renderDrawerThumb(point, index) {
  const url = point.photos?.[0];
  if (url) {
    return `
      <span class="drawer-thumb">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(point.name)}" loading="lazy" referrerpolicy="no-referrer" />
        <b>${index}</b>
      </span>
    `;
  }
  return `<span class="drawer-index">${index}</span>`;
}

function renderExtraPoiMeta(point) {
  const items = [
    point.businessArea ? `商圈：${point.businessArea}` : "",
    point.district ? `区域：${point.district}` : "",
    point.typecode ? `类型编码：${point.typecode}` : "",
    point.entranceLocation ? `入口：${point.entranceLocation}` : "",
    point.parkingType ? `停车：${point.parkingType}` : "",
    point.indoorMap ? `室内地图：${point.indoorMap}` : "",
    point.website ? `官网：${point.website}` : "",
    point.tag ? `标签：${point.tag}` : ""
  ].filter(Boolean);
  if (!items.length) return "";
  return `<div class="extra-meta">${items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
}

function renderPhotoStrip(point) {
  const photos = point.photos || [];
  if (photos.length <= 1) return "";
  return `
    <div class="photo-strip">
      ${photos.slice(1).map((url) => `
        <img src="${escapeHtml(url)}" alt="${escapeHtml(point.name)}" loading="lazy" referrerpolicy="no-referrer" />
      `).join("")}
    </div>
  `;
}

function defaultExecutionTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes())
  ].join("");
}

function readExecutionOrders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXECUTION_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function writeExecutionOrders(orders) {
  try {
    localStorage.setItem(EXECUTION_STORAGE_KEY, JSON.stringify(orders.slice(0, 5)));
  } catch {
    // Local storage may be unavailable in hardened browsers.
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

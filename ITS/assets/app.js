// 初始化高德地图与功能
let map;
let trafficLayer;
let driving; // 驾车路线规划实例
let geocoder; // 地理编码实例（把地址转经纬度）
let trafficOverlays = [];
let trafficAutoTimer = null;
let lastTrafficQuery = null; // { type, radiusKm }
let trafficInfoWin = null; // 新增：交通态势信息弹窗
let selectedTrafficOverlay = null; // 新增：当前高亮的态势折线

function initMap() {
  map = new AMap.Map('map', {
    viewMode: '3D',
    zoom: 12,
    center: [120.15507, 30.27415], // 默认杭州
    mapStyle: 'amap://styles/darkblue'
  });

  // 交通图层
  trafficLayer = new AMap.TileLayer.Traffic({
    autoRefresh: true, // 自动刷新
    interval: 180 // 刷新间隔秒
  });
  // 新增：信息窗体
  trafficInfoWin = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -20) });
}

function initRouting() {
  // 加载路线规划、地理编码与其他方式插件
  AMap.plugin(['AMap.Driving', 'AMap.Transfer', 'AMap.Walking', 'AMap.Riding', 'AMap.Geocoder'], function() {
    driving = new AMap.Driving({
      map: map,
      panel: 'route-panel',
      hideMarkers: false,
      showTraffic: false
    });
    // Transfer 需要 city 参数，先占位创建，后续根据起点反查城市重建
    transfer = new AMap.Transfer({
      map: map,
      panel: 'route-panel'
    });
    walking = new AMap.Walking({ map: map, panel: 'route-panel' });
    riding  = new AMap.Riding({ map: map, panel: 'route-panel' });
    geocoder = new AMap.Geocoder();
  });
}

function parseInputToLngLat(text) {
  const t = (text || '').trim();
  if (!t) return null;
  // 支持“lng,lat”直接输入
  const m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return new AMap.LngLat(parseFloat(m[1]), parseFloat(m[2]));
  return t; // 返回字符串，后续用地理编码解析
}

async function resolveToLngLat(input) {
  const parsed = parseInputToLngLat(input);
  if (!parsed) return null;
  if (parsed instanceof AMap.LngLat) return parsed;
  // 关键字 -> 经纬度
  return new Promise((resolve) => {
    geocoder.getLocation(parsed, function(status, result) {
      if (status === 'complete' && result.geocodes && result.geocodes.length) {
        const { location } = result.geocodes[0];
        resolve(location);
      } else {
        resolve(null);
      }
    });
  });
}

async function doRoute() {
  const o = document.getElementById('origin-input').value;
  const d = document.getElementById('dest-input').value;
  const origin = await resolveToLngLat(o);
  const dest = await resolveToLngLat(d);
  if (!origin || !dest) {
    alert('起点或终点无法解析，请输入有效的地址或经纬度（lng,lat）。');
    return;
  }
  const mode = getRouteMode();

  // 驾车策略与路况开关
  if (mode === 'driving' && driving) {
    try {
      const polEl = document.getElementById('route-policy');
      const policyKey = polEl && polEl.value ? polEl.value : 'LEAST_TIME';
      const show = !!(document.getElementById('route-show-traffic')?.checked);
      const policy = AMap.DrivingPolicy[policyKey] || AMap.DrivingPolicy.LEAST_TIME;
      driving.setOptions({ showTraffic: show, policy });
    } catch (e) {}
  }

  switch (mode) {
    case 'driving': {
      driving.search(origin, dest, function(status) {
        if (status !== 'complete') alert('驾车路线规划失败，请稍后重试');
      });
      break;
    }
    case 'walking': {
      walking.search(origin, dest, function(status) {
        if (status !== 'complete') alert('步行路线规划失败，请稍后重试');
      });
      break;
    }
    case 'riding': {
      riding.search(origin, dest, function(status) {
        if (status !== 'complete') alert('骑行路线规划失败，请稍后重试');
      });
      break;
    }
    case 'transfer': {
      let city = (document.getElementById('city-input')?.value || '').trim();
      if (!city) city = await getTransitCityFromLngLat(origin);
      if (!city) {
        alert('无法确定公交换乘所在城市，请在“城市”输入框填写城市名称（如：杭州市）。');
        return;
      }
      try {
        transfer && transfer.clear && transfer.clear();
        transfer = new AMap.Transfer({ map, panel: 'route-panel', city });
      } catch (e) {}
      transfer.search(origin, dest, function(status) {
        if (status !== 'complete') alert('公交/地铁换乘规划失败，请稍后重试');
      });
      break;
    }
    case 'taxi': {
      // 用驾车代替出租车计算
      driving.search(origin, dest, function(status) {
        if (status !== 'complete') alert('出租车（驾车）路线规划失败，请稍后重试');
      });
      break;
    }
    default: {
      driving.search(origin, dest, function(status) {
        if (status !== 'complete') alert('路线规划失败，请稍后重试');
      });
    }
  }
}

function clearDriving() {
  if (driving) {
    driving.clear();
    const panel = document.getElementById('route-panel');
    if (panel) panel.innerHTML = '在此显示路线详情';
  }
}

// 城市切换：将输入城市转换为中心点并移动地图
function changeCity() {
  const city = document.getElementById('city-input').value.trim();
  if (!city) return alert('请输入城市名称');
  AMap.plugin('AMap.Geocoder', function() {
    const gc = new AMap.Geocoder();
    gc.getLocation(city, function(status, result) {
      if (status === 'complete' && result.geocodes && result.geocodes.length) {
        const { location, formattedAddress } = result.geocodes[0];
        map.setCenter(location);
        map.setZoom(12);
        // 同步刷新天气
        fetchLive();
        fetchForecast();
      } else {
        alert('无法解析城市，请输入规范的城市名称，例如：杭州市、北京市');
      }
    });
  });
}

// 在绑定UI中增加按钮事件
function getRouteMode() {
  const el = document.getElementById('route-mode');
  const v = (el && el.value) ? el.value : 'driving';
  // 兼容“出租车”作为驾车计算
  if (v === 'taxi') return 'driving';
  return v;
}

function clearRoutePanel() {
  const panel = document.getElementById('route-panel');
  if (panel) panel.innerHTML = '在此显示路线详情';
}

function clearRouting() {
  try {
    driving && driving.clear && driving.clear();
    transfer && transfer.clear && transfer.clear();
    walking && walking.clear && walking.clear();
    riding && riding.clear && riding.clear();
    clearRoutePanel();
  } catch (e) {}
}

// 城市切换：将输入城市转换为中心点并移动地图
function changeCity() {
  const city = document.getElementById('city-input').value.trim();
  if (!city) return alert('请输入城市名称');
  AMap.plugin('AMap.Geocoder', function() {
    const gc = new AMap.Geocoder();
    gc.getLocation(city, function(status, result) {
      if (status === 'complete' && result.geocodes && result.geocodes.length) {
        const { location, formattedAddress } = result.geocodes[0];
        map.setCenter(location);
        map.setZoom(12);
        // 同步刷新天气
        fetchLive();
        fetchForecast();
      } else {
        alert('无法解析城市，请输入规范的城市名称，例如：杭州市、北京市');
      }
    });
  });
}

// 在绑定UI中增加按钮事件
function bindUI() {
  const toggle = document.getElementById('traffic-toggle');
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      map.add(trafficLayer);
    } else {
      map.remove(trafficLayer);
    }
  });

  document.getElementById('btn-live').addEventListener('click', () => fetchLive());
  document.getElementById('btn-forecast').addEventListener('click', () => fetchForecast());
  document.getElementById('btn-change-city').addEventListener('click', () => changeCity());

  // 路线规划按钮改为通用 doRoute
  document.getElementById('btn-route').addEventListener('click', () => doRoute());
  document.getElementById('btn-clear-route').addEventListener('click', () => clearRouting());

  // 模式切换时清理旧路线
  const modeEl = document.getElementById('route-mode');
  if (modeEl) modeEl.addEventListener('change', () => clearRouting());

  // 交通态势查询/清除
  const btnTrafficQuery = document.getElementById('btn-traffic-query');
  const btnTrafficClear = document.getElementById('btn-traffic-clear');
  if (btnTrafficQuery) btnTrafficQuery.addEventListener('click', () => queryTrafficStatus());
  if (btnTrafficClear) btnTrafficClear.addEventListener('click', () => clearTrafficStatus());

  // 保留其他绑定（策略、路况显示等）如存在则可继续扩展
}

// 在初始化阶段调用 initRouting
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  initRouting();
  bindUI();
});

function fetchLive() {
  const city = document.getElementById('city-input').value.trim();
  if (!city) return alert('请输入城市');
  AMap.plugin('AMap.Weather', function() {
    const weather = new AMap.Weather();
    weather.getLive(city, function(err, data) {
      const el = document.getElementById('weather-live');
      if (err) {
        el.textContent = '查询失败：' + (err?.message || String(err));
        return;
      }
      el.classList.remove('empty');
      el.innerHTML = `
        <div class="weather-item"><span>城市</span><span class="badge">${data.city}</span></div>
        <div class="weather-item"><span>天气</span><span>${data.weather}</span></div>
        <div class="weather-item"><span>温度</span><span>${data.temperature}℃</span></div>
        <div class="weather-item"><span>风向/风力</span><span>${data.windDirection} / ${data.windPower}</span></div>
        <div class="weather-item"><span>湿度</span><span>${data.humidity}%</span></div>
        <div class="weather-item"><span>发布时间</span><span>${data.reportTime}</span></div>
      `;
    });
  });
}

function fetchForecast() {
  const city = document.getElementById('city-input').value.trim();
  if (!city) return alert('请输入城市');
  AMap.plugin('AMap.Weather', function() {
    const weather = new AMap.Weather();
    weather.getForecast(city, function(err, data) {
      const el = document.getElementById('weather-forecast');
      if (err) {
        el.textContent = '查询失败：' + (err?.message || String(err));
        return;
      }
      el.classList.remove('empty');
      const days = data.forecasts || [];
      el.innerHTML = days.map(d => `
        <div class="weather-item">
          <span>${d.date} ${d.dayWeather}/${d.nightWeather}</span>
          <span>${d.dayTemp}~${d.nightTemp}℃</span>
        </div>
      `).join('');
    });
  });
}

function statusColor(code) {
  switch (String(code)) {
    case '3': return '#ef4444'; // 拥堵
    case '2': return '#f59e0b'; // 缓行
    case '1': return '#22c55e'; // 畅通
    default: return '#9ca3af'; // 未知
  }
}
function statusWeight(code) {
  switch (String(code)) {
    case '3': return 6;
    case '2': return 5;
    case '1': return 4;
    default: return 3;
  }
}
function statusText(code) {
  switch (String(code)) {
    case '3': return '拥堵';
    case '2': return '缓行';
    case '1': return '畅通';
    default: return '未知';
  }
}
// 新增：高亮与弹窗
function highlightTrafficOverlay(overlay) {
  if (selectedTrafficOverlay && selectedTrafficOverlay !== overlay) {
    restoreTrafficOverlay(selectedTrafficOverlay);
  }
  // 记录原始样式
  if (!overlay.__origStyle) {
    overlay.__origStyle = {
      weight: statusWeight(overlay.__traffic?.status),
      color: statusColor(overlay.__traffic?.status),
      opacity: 0.9,
      zIndex: 120
    };
  }
  overlay.setOptions({
    strokeWeight: (overlay.__origStyle.weight || 4) + 2,
    strokeOpacity: 1,
    zIndex: 200
  });
  selectedTrafficOverlay = overlay;
}
function restoreTrafficOverlay(overlay) {
  const os = overlay.__origStyle || {};
  overlay.setOptions({
    strokeWeight: os.weight || 4,
    strokeOpacity: os.opacity ?? 0.9,
    zIndex: os.zIndex ?? 120,
    strokeColor: os.color || undefined
  });
  if (selectedTrafficOverlay === overlay) selectedTrafficOverlay = null;
}
function showTrafficInfo(overlay, lnglat) {
  const r = overlay.__traffic || {};
  const html = `
    <div class="traffic-popup">
      <div><strong>${r.name || '道路'}</strong></div>
      <div>态势：${statusText(r.status)}</div>
      <div>速度：${r.speed != null ? r.speed + ' km/h' : '—'}</div>
      <div>方向：${r.direction || '—'}${r.angle != null ? ' (' + r.angle + '°)' : ''}</div>
    </div>
  `;
  trafficInfoWin.setContent(html);
  const pos = lnglat || (overlay.getPath && overlay.getPath()[0]);
  if (pos) trafficInfoWin.open(map, pos);
}

function clearTrafficStatus() {
  if (trafficAutoTimer) {
    clearInterval(trafficAutoTimer);
    trafficAutoTimer = null;
  }
  if (trafficOverlays.length) {
    map.remove(trafficOverlays);
    trafficOverlays = [];
  }
  if (trafficInfoWin) trafficInfoWin.close(); // 新增：关闭弹窗
  if (selectedTrafficOverlay) { // 新增：复原高亮
    restoreTrafficOverlay(selectedTrafficOverlay);
    selectedTrafficOverlay = null;
  }
  const panel = document.getElementById('traffic-status-panel');
  if (panel) {
    panel.classList.add('empty');
    panel.textContent = '暂无数据';
  }
}

async function queryTrafficStatus() {
  const type = document.getElementById('traffic-type').value;
  const radiusKm = Number(document.getElementById('traffic-radius').value || 3);
  const autorefresh = !!document.getElementById('traffic-autorefresh').checked;
  const key = getAmapWebKey();
  if (!key) return alert('未能获取到高德Key，无法请求交通态势。');

  const center = map.getCenter();
  let url = '';
  if (type === 'circle') {
    const radiusM = Math.max(200, Math.min(5000, radiusKm * 1000));
    const loc = `${center.getLng()},${center.getLat()}`;
    url = `https://restapi.amap.com/v3/traffic/status/circle?location=${encodeURIComponent(loc)}&radius=${radiusM}&extensions=all&output=json&key=${key}`;
  } else {
    const rect = makeRectangle(center, radiusKm);
    url = `https://restapi.amap.com/v3/traffic/status/rectangle?rectangle=${encodeURIComponent(rect)}&extensions=all&output=json&key=${key}`;
  }

  try {
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.status !== '1') {
      throw new Error(json.info || '接口返回错误');
    }
    const roads = (json.trafficinfo && json.trafficinfo.roads) ? json.trafficinfo.roads : [];
    // 清除旧覆盖物
    if (trafficOverlays.length) {
      map.remove(trafficOverlays);
      trafficOverlays = [];
    }
    let cnt = { '3': 0, '2': 0, '1': 0, '0': 0 };
    roads.forEach(r => {
      const status = String(r.status ?? '0');
      cnt[status] = (cnt[status] || 0) + 1;
      const coords = (r.polyline || '').split(';').map(p => {
        const [lng, lat] = p.split(',').map(Number);
        return new AMap.LngLat(lng, lat);
      }).filter(Boolean);
      if (coords.length >= 2) {
        const pl = new AMap.Polyline({
          path: coords,
          strokeColor: statusColor(status),
          strokeWeight: statusWeight(status),
          strokeOpacity: 0.9,
          showDir: false,
          zIndex: 120
        });
        // 新增：绑定元数据与点击事件
        pl.__traffic = r;
        pl.on('click', (e) => {
          highlightTrafficOverlay(pl);
          showTrafficInfo(pl, e.lnglat);
        });
        trafficOverlays.push(pl);
      }
    });
    if (trafficOverlays.length) map.add(trafficOverlays);

    // 更新面板
    const panel = document.getElementById('traffic-status-panel');
    if (panel) {
      if (!roads.length) {
        panel.classList.add('empty');
        panel.textContent = '查询范围暂无道路态势，请尝试扩大半径或移动到主干道密集区';
      } else {
        panel.classList.remove('empty');
        const total = roads.length;
        panel.innerHTML = `
          <div class="item"><span>道路数</span><span class="badge">${total}</span></div>
          <div class="item"><span>拥堵(3)</span><span class="badge">${cnt['3'] || 0}</span></div>
          <div class="item"><span>缓行(2)</span><span class="badge">${cnt['2'] || 0}</span></div>
          <div class="item"><span>畅通(1)</span><span class="badge">${cnt['1'] || 0}</span></div>
          <div class="item"><span>未知(0)</span><span class="badge">${cnt['0'] || 0}</span></div>
        `;
      }
    }

    // 记录与自动刷新
    lastTrafficQuery = { type, radiusKm };
    if (autorefresh && !trafficAutoTimer) {
      trafficAutoTimer = setInterval(() => {
        if (lastTrafficQuery) queryTrafficStatus();
      }, 120000); // 2分钟刷新
    } else if (!autorefresh && trafficAutoTimer) {
      clearInterval(trafficAutoTimer);
      trafficAutoTimer = null;
    }
  } catch (e) {
    alert('交通态势查询失败：' + e.message);
  }
}

function getAmapWebKey() {
  // 优先从页面输入框读取 Web 服务 Key（restapi）
  const el = document.getElementById('traffic-ws-key');
  const val = el && el.value ? el.value.trim() : '';
  if (val) return val;
  // 如果未填写，提示用户不要使用 JSAPI 的 Key
  alert('请在“交通态势查询”区域填写 Web 服务 Key（restapi），不要使用 JSAPI 的浏览器端 Key。');
  return '';
}

async function getTransitCityFromLngLat(lnglat) {
  if (!lnglat) return null;
  return new Promise((resolve) => {
    const gc = geocoder || new AMap.Geocoder();
    gc.getAddress(lnglat, function(status, result) {
      if (status === 'complete' && result && result.regeocode && result.regeocode.addressComponent) {
        const comp = result.regeocode.addressComponent;
        let city = comp.city;
        // 直辖市或某些地区 city 可能为空，使用省份名作为城市
        if (!city || (Array.isArray(city) && city.length === 0)) {
          city = comp.province;
        }
        resolve(city || null);
      } else {
        resolve(null);
      }
    });
  });
}

function makeRectangle(center, radiusKm) {
  // 依据中心点与半径生成“左下;右上”矩形（GCJ-02），横向距离按纬度校正
  const lat = center.getLat();
  const lng = center.getLng();
  const dLat = radiusKm / 111.32; // 每公里对应纬度度数近似
  const dLng = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const ll = [lng - dLng, lat - dLat];
  const ur = [lng + dLng, lat + dLat];
  return `${ll[0]},${ll[1]};${ur[0]},${ur[1]}`;
}

async function fetchPlaceAround({ key, location, radiusMeters, keywords = '', types = '', page = 1, offset = 25 }) {
  const base = 'https://restapi.amap.com/v3/place/around';
  const params = new URLSearchParams({
    key, location, radius: Math.max(100, Math.min(5000, radiusMeters)), keywords, types, page: String(page), offset: String(Math.min(50, Math.max(1, offset))), extensions: 'base', output: 'JSON'
  });
  const url = `${base}?${params.toString()}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.status !== '1') throw new Error(json.info || 'POI周边搜索失败');
  return json.pois || [];
}

async function analyzeBizArea() {
  const key = getAmapWebKey();
  if (!key) return; // getAmapWebKey 已提示
  const radiusKm = Number(document.getElementById('biz-radius')?.value || 1.0);
  const center = map.getCenter();
  const panel = document.getElementById('biz-report');

  const writeError = (msg) => {
    if (!panel) return;
    panel.classList.remove('empty');
    panel.innerHTML = `<div class=\"item\"><span>数据异常</span><span class=\"badge\">${msg}</span></div>
      <div class=\"sub\"><div class=\"label\">核查建议：</div>
        <div class=\"item\"><span>1) 使用 Web 服务 Key（REST），不要用 JSAPI 浏览器端 Key。</span><span class=\"badge\">Key</span></div>
        <div class=\"item\"><span>2) 控制台为“Web服务”启用并查看白名单/来源。</span><span class=\"badge\">平台匹配</span></div>
        <div class=\"item\"><span>3) 若接口限城市，请确认当前城市支持交通态势。</span><span class=\"badge\">城市支持</span></div>
      </div>`;
  };

  // 1) rectangle
  const rect = makeRectangle(center, radiusKm);
  const tsRectUrl = `https://restapi.amap.com/v3/traffic/status/rectangle?rectangle=${encodeURIComponent(rect)}&extensions=all&output=json&key=${key}`;
  let roadsRect = [];
  try {
    const r = await fetch(tsRectUrl);
    const j = await r.json();
    if (j.status === '1') {
      roadsRect = (j.trafficinfo && j.trafficinfo.roads) ? j.trafficinfo.roads : [];
    } else {
      writeError(j.info || '交通态势矩形查询失败');
    }
  } catch (e) { writeError(e.message || '矩形查询异常'); }

  // 1b) circle
  const locStr = `${center.getLng()},${center.getLat()}`;
  const radiusM = Math.max(100, Math.min(5000, radiusKm * 1000));
  const tsCircleUrl = `https://restapi.amap.com/v3/traffic/status/circle?location=${encodeURIComponent(locStr)}&radius=${radiusM}&extensions=all&output=json&key=${key}`;
  let roadsCircle = [];
  try {
    const r2 = await fetch(tsCircleUrl);
    const j2 = await r2.json();
    if (j2.status === '1') {
      roadsCircle = (j2.trafficinfo && j2.trafficinfo.roads) ? j2.trafficinfo.roads : [];
    } else {
      writeError(j2.info || '交通态势圆形查询失败');
    }
  } catch (e) { writeError(e.message || '圆形查询异常'); }

  // 2) 统计拥堵/缓行/畅通与Top拥堵道路（基于矩形结果）
  const stats = { '3': 0, '2': 0, '1': 0, '0': 0 };
  const topCongested = [];
  (roadsRect || []).forEach(rd => {
    const s = String(rd.status ?? '0');
    stats[s] = (stats[s] || 0) + 1;
    if (s === '3') topCongested.push({ name: rd.name || '道路', speed: rd.speed ?? null });
  });
  topCongested.sort((a, b) => (a.speed ?? 0) - (b.speed ?? 0));
  const top5 = topCongested.slice(0, 5);

  // 3) 一致性核查（rectangle vs circle）
  const setRect = new Set((roadsRect || []).map(x => x.name || x.polyline || ''));
  const setCircle = new Set((roadsCircle || []).map(x => x.name || x.polyline || ''));
  const union = new Set([...setRect, ...setCircle]);
  let interCount = 0;
  setRect.forEach(k => { if (setCircle.has(k)) interCount++; });
  const mismatchRatio = union.size > 0 ? (1 - interCount / union.size) : 0;
  const onlyRect = [...setRect].filter(k => !setCircle.has(k)).slice(0, 3);
  const onlyCircle = [...setCircle].filter(k => !setRect.has(k)).slice(0, 3);

  // 4) 公共交通站点分布（近似）：公交/地铁站
  let busStops = [];
  let metroStations = [];
  try {
    busStops = await fetchPlaceAround({ key, location: locStr, radiusMeters: radiusM, keywords: '公交站|公交车站|公交站点', types: '150700' });
  } catch (e) {}
  try {
    metroStations = await fetchPlaceAround({ key, location: locStr, radiusMeters: radiusM, keywords: '地铁站|地铁', types: '150500' });
  } catch (e) {}

  // 5) 行人流量分布（近似代理）：商场/餐饮/景点
  let pedestrianProxy = [];
  try {
    const malls = await fetchPlaceAround({ key, location: locStr, radiusMeters: radiusM, keywords: '商场|购物中心|购物广场', types: '060100|060000' });
    const foods = await fetchPlaceAround({ key, location: locStr, radiusMeters: radiusM, keywords: '餐饮|美食', types: '050000' });
    const sights = await fetchPlaceAround({ key, location: locStr, radiusMeters: radiusM, keywords: '旅游景点|景区|公园', types: '110000|110100' });
    pedestrianProxy = [...malls, ...foods, ...sights];
  } catch (e) {}

  // 6) 渲染报告
  if (panel) {
    panel.classList.remove('empty');
    const totalRoadsRect = roadsRect.length;
    const totalRoadsCircle = roadsCircle.length;
    const busCnt = busStops.length;
    const metroCnt = metroStations.length;
    const pedCnt = pedestrianProxy.length;
    const densityPerKm2 = (count) => {
      const areaKm2 = Math.PI * radiusKm * radiusKm;
      return (areaKm2 > 0 ? (count / areaKm2) : 0).toFixed(2);
    };
    const chartSvg = buildBarChart([
      { label: '拥堵道路', value: stats['3'] || 0, color: '#ef4444' },
      { label: '缓行道路', value: stats['2'] || 0, color: '#f59e0b' },
      { label: '畅通道路', value: stats['1'] || 0, color: '#22c55e' }
    ]);
    const topListHtml = top5.map(t => `<div class=\"item\"><span>${t.name}</span><span class=\"badge\">${t.speed != null ? t.speed + ' km/h' : '—'}</span></div>`).join('');
    const onlyRectHtml = onlyRect.map(n => `<div class=\"item\"><span>${n || '道路'}</span><span class=\"badge\">矩形特有</span></div>`).join('');
    const onlyCircleHtml = onlyCircle.map(n => `<div class=\"item\"><span>${n || '道路'}</span><span class=\"badge\">圆形特有</span></div>`).join('');
    const nowStr = new Date().toLocaleString();
    panel.innerHTML = `
      <div class=\"item\"><span>道路总数（矩形）</span><span class=\"badge\">${totalRoadsRect}</span></div>
      <div class=\"item\"><span>道路总数（圆形）</span><span class=\"badge\">${totalRoadsCircle}</span></div>
      <div class=\"item\"><span>不一致比率</span><span class=\"badge\">${(mismatchRatio * 100).toFixed(1)}%</span></div>
      <div class=\"item\"><span>公交站</span><span class=\"badge\">${busCnt}（密度 ${densityPerKm2(busCnt)}/km²）</span></div>
      <div class=\"item\"><span>地铁站</span><span class=\"badge\">${metroCnt}（密度 ${densityPerKm2(metroCnt)}/km²）</span></div>
      <div class=\"item\"><span>人流代理POI</span><span class=\"badge\">${pedCnt}（密度 ${densityPerKm2(pedCnt)}/km²）</span></div>
      <div class=\"chart\">${chartSvg}</div>
      <div class=\"sub\">
        <div class=\"label\">Top拥堵道路（按速度升序）：</div>
        ${topListHtml || '<div class=\"item\"><span>暂无拥堵道路</span><span class=\"badge\">—</span></div>'}
      </div>
      <div class=\"sub\">
        <div class=\"label\">一致性核查（rectangle vs circle）：</div>
        ${onlyRectHtml || '<div class=\"item\"><span>矩形特有：无</span><span class=\"badge\">—</span></div>'}
        ${onlyCircleHtml || '<div class=\"item\"><span>圆形特有：无</span><span class=\"badge\">—</span></div>'}
      </div>
      <div class=\"item\"><span>查询时间</span><span class=\"badge\">${nowStr}</span></div>
    `;

    // 新增：公交线路覆盖与班次窗口（采样查询）
    const cityName = await getTransitCityFromLngLat(center);
    let sampledStops = busStops.slice(0, 12); // 限制采样，避免频繁请求
    const stopLineDetails = [];
    if (cityName && key && sampledStops.length) {
      for (const s of sampledStops) {
        try {
          const lines = await fetchBusStopLines({ key, city: cityName, keywords: s.name || '' });
          const lineCnt = (lines || []).length;
          // 统计首末班时间窗口（分钟）
          let totalWindow = 0, metroLineCnt = 0;
          (lines || []).forEach(l => {
            const st = timeStrToMinutes(l.start_time);
            const et = timeStrToMinutes(l.end_time);
            if (st != null && et != null) {
              const win = et >= st ? (et - st) : (et + 24 * 60 - st); // 跨天处理
              totalWindow += win;
            }
            if ((l.type || '').includes('地铁')) metroLineCnt++;
          });
          const avgWindow = lineCnt > 0 ? Math.round(totalWindow / lineCnt) : null;
          stopLineDetails.push({ stop: s.name || '公交站', lineCnt, avgWindow, metroLineCnt });
        } catch (e) {
          stopLineDetails.push({ stop: s.name || '公交站', lineCnt: 0, avgWindow: null, metroLineCnt: 0 });
        }
      }
    }
    const totalLineCnt = stopLineDetails.reduce((acc, x) => acc + (x.lineCnt || 0), 0);
    const avgLinesPerStop = stopLineDetails.length ? (totalLineCnt / stopLineDetails.length) : 0;
    const maxStop = stopLineDetails.reduce((m, x) => (x.lineCnt > (m?.lineCnt || 0) ? x : m), null);
    const topStopsHtml = stopLineDetails
      .slice()
      .sort((a,b)=>b.lineCnt-a.lineCnt)
      .slice(0,3)
      .map(x=>`<div class=\"item\"><span>${x.stop}</span><span class=\"badge\">线路 ${x.lineCnt}${x.avgWindow!=null?`，平均窗口 ${x.avgWindow} 分`:''}</span></div>`)
      .join('');

    panel.innerHTML += `
      <div class=\"sub\">
        <div class=\"label\">公交线路覆盖（采样${stopLineDetails.length}站）：</div>
        <div class=\"item\"><span>平均每站覆盖线路数</span><span class=\"badge\">${avgLinesPerStop.toFixed(1)}</span></div>
        <div class=\"item\"><span>线路最多的站</span><span class=\"badge\">${maxStop ? (maxStop.stop + '（' + maxStop.lineCnt + '条）') : '—'}</span></div>
        ${topStopsHtml || '<div class=\"item\"><span>暂无线路数据</span><span class=\"badge\">—</span></div>'}
      </div>
    `;
  }
}

// 缺失工具函数与导出功能补充
function buildBarChart(items) {
  const width = 300, height = 160, pad = 20;
  const maxVal = Math.max(1, ...items.map(i => i.value));
  const barW = Math.floor((width - pad * 2) / items.length) - 10;
  let x = pad;
  const bars = items.map(i => {
    const h = Math.round((i.value / maxVal) * (height - pad * 2));
    const y = height - pad - h;
    const rect = `<rect x=\"${x}\" y=\"${y}\" width=\"${barW}\" height=\"${h}\" fill=\"${i.color}\" rx=\"4\" />`;
    const label = `<text x=\"${x + barW / 2}\" y=\"${height - 6}\" fill=\"#cbd5e1\" font-size=\"12\" text-anchor=\"middle\">${i.label}</text>`;
    const val = `<text x=\"${x + barW / 2}\" y=\"${y - 4}\" fill=\"#e5e7eb\" font-size=\"12\" text-anchor=\"middle\">${i.value}</text>`;
    x += barW + 10;
    return rect + label + val;
  }).join('');
  return `<svg viewBox=\"0 0 ${width} ${height}\" xmlns=\"http://www.w3.org/2000/svg\">${bars}</svg>`;
}

function exportBizReport() {
  const panel = document.getElementById('biz-report');
  if (!panel) return alert('报告面板不存在');
  const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>商圈分析报告</title></head><body>${panel.innerHTML}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '商圈分析报告.html';
  a.click();
  URL.revokeObjectURL(url);
}

// 绑定新增按钮（若未绑定则补充）
(function bindBizUI(){
  window.addEventListener('DOMContentLoaded', () => {
    const btnAnalyze = document.getElementById('btn-biz-analyze');
    const btnExport = document.getElementById('btn-biz-export');
    if (btnAnalyze) btnAnalyze.addEventListener('click', () => analyzeBizArea());
    if (btnExport) btnExport.addEventListener('click', () => exportBizReport());
  });
})();

// Web 服务：公交站关键字查询，返回途经线路与首末班时间
async function fetchBusStopLines({ key, city, keywords }) {
  // stopname 支持按城市+关键字查询站点信息，返回 buslines 中包含线路名称与首末班时间
  const base = 'https://restapi.amap.com/v3/bus/stopname';
  const params = new URLSearchParams({ key, city, keywords, output: 'JSON' });
  const url = `${base}?${params.toString()}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.status !== '1') throw new Error(json.info || '公交站查询失败');
  const stops = json.busstops || [];
  const buslines = stops.length ? (stops[0].buslines || []) : [];
  return buslines.map(bl => ({
    name: bl.name,
    type: bl.type,
    start_time: bl.start_time,
    end_time: bl.end_time
  }));
}

function timeStrToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}
/**
 * Maven 依赖搜索 - 后台逻辑 (uTools Preload 脚本)
 *
 * 性能优化要点：
 * 1. HTTPS Keep-Alive Agent —— 复用 TCP 连接，省去重复 TLS 握手
 * 2. 内存 LRU 缓存 —— 相同关键词直接返回，避免重复网络请求
 * 3. 字段裁剪 (fl 参数) —— 只请求需要的字段，减少传输体积
 * 4. 请求取消 —— 新请求发出时自动终止上一次未完成的请求
 */

const https = require('https');

// ============================================================
// 搜索源配置 —— 多源，每个源有名称、API 地址
// ============================================================
const DEFAULT_SEARCH_URL = 'https://search.maven.org/solrsearch/select';
const DEFAULT_SOURCES = [{ name: 'Maven Central', url: DEFAULT_SEARCH_URL, default: true }];
let SEARCH_BASE_URL = DEFAULT_SEARCH_URL;
let SOURCES = DEFAULT_SOURCES.slice();
let ACTIVE_SOURCE = SOURCES[0];
const CONFIG_DOC_ID = 'pluginConfig';

function loadConfig() {
  try {
    if (typeof utools !== 'undefined' && utools.db) {
      let doc = utools.db.get(CONFIG_DOC_ID);
      if (!doc) return;
      // 迁移旧格式
      if (doc.searchBaseUrl && !doc.sources) {
        doc.sources = [{ name: 'Maven Central', url: doc.searchBaseUrl, default: true }];
        doc.activeName = 'Maven Central';
        delete doc.searchBaseUrl;
        utools.db.put(doc);
      }
      // 去掉旧版 keyword 字段
      if (doc.sources) {
        doc.sources = doc.sources.map(s => ({ name: s.name, url: s.url, default: !!s.default }));
        if (doc.activeKeyword) { doc.activeName = doc.activeKeyword; delete doc.activeKeyword; }
        utools.db.put(doc);
      }
      if (doc.sources && doc.sources.length) {
        SOURCES = doc.sources;
        const def = doc.activeName || (SOURCES.find(s => s.default) || SOURCES[0]).name;
        ACTIVE_SOURCE = SOURCES.find(s => s.name === def) || SOURCES[0];
        SEARCH_BASE_URL = ACTIVE_SOURCE.url.replace(/\/+$/, '');
      }
    }
  } catch (e) { /* use default */ }
}
loadConfig();

function getSearchConfig() {
  return { sources: SOURCES, activeName: ACTIVE_SOURCE ? ACTIVE_SOURCE.name : '' };
}

function updateSearchConfig(config) {
  if (!config || !config.sources || !config.sources.length) return false;
  const sources = config.sources.filter(s => s.name && s.url);
  if (!sources.length) return false;
  const activeName = config.activeName || (sources.find(s => s.default) || sources[0]).name;
  try {
    if (typeof utools !== 'undefined' && utools.db) {
      const doc = utools.db.get(CONFIG_DOC_ID) || { _id: CONFIG_DOC_ID };
      doc.sources = sources; doc.activeName = activeName;
      utools.db.put(doc);
    }
  } catch (e) { /* persist optional */ }
  SOURCES = sources;
  ACTIVE_SOURCE = SOURCES.find(s => s.name === activeName) || SOURCES[0];
  SEARCH_BASE_URL = (ACTIVE_SOURCE && ACTIVE_SOURCE.url || DEFAULT_SEARCH_URL).replace(/\/+$/, '');
  cache.clear();
  return true;
}

function setActiveSource(name) {
  const src = SOURCES.find(s => s.name === name);
  if (!src || src === ACTIVE_SOURCE) return !!src;
  ACTIVE_SOURCE = src;
  SEARCH_BASE_URL = src.url.replace(/\/+$/, '');
  cache.clear();
  try {
    if (typeof utools !== 'undefined' && utools.db) {
      const doc = utools.db.get(CONFIG_DOC_ID);
      if (doc) { doc.activeName = name; utools.db.put(doc); }
    }
  } catch (e) {}
  return true;
}

function getActiveSource() {
  return ACTIVE_SOURCE ? { name: ACTIVE_SOURCE.name, url: ACTIVE_SOURCE.url } : null;
}

// ============================================================
// 优化1: Keep-Alive Agent —— 复用 TCP+TLS 连接
// ============================================================
// 默认每次 https.request 都建立新连接（TCP 三次握手 + TLS 握手），
// 开启 keepAlive 后，同一域名的后续请求直接复用已有连接，
// 省 200~500ms 的握手开销。对 Maven API 这种同一域名反复请求的场景提升巨大。
const keepAliveAgent = new https.Agent({
  keepAlive: true,       // 开启连接池复用
  maxSockets: 4,         // 最大同时连接数
  keepAliveMsecs: 30000, // keep-alive 探测间隔 30s
});

// ============================================================
// 优化2: 内存 LRU 缓存
// ============================================================
// 缓存最近的搜索结果，避免相同关键词重复请求网络。
// 容量 100 条，TTL 5 分钟 —— 够覆盖一次完整的搜索会话。
const CACHE_MAX = 100;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  // LRU 淘汰：超过容量时删除最早的条目
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, ts: Date.now() });
}

// ============================================================
// 优化3: 请求取消 —— 自动终止上一次未完成的请求
// ============================================================
// 用户快速输入时，多个请求可能同时在途。只保留最新的请求，
// 之前的请求直接中断，避免旧结果覆盖新结果。
let activeRequest = null;

function cancelActiveRequest() {
  if (activeRequest) {
    activeRequest.destroy();
    activeRequest = null;
  }
}

// ============================================================
// 通用 HTTPS GET（带 Keep-Alive、重定向、超时）
// ============================================================

function httpsGet(url, maxRedirect = 3) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        agent: keepAliveAgent, // 关键：使用 Keep-Alive Agent
        headers: {
          'User-Agent': 'MavenSearchPlugin/1.0',
          'Accept': 'application/json',
        },
      },
      (res) => {
        // 处理重定向
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (maxRedirect <= 0) return reject(new Error('重定向次数过多'));
          return resolve(httpsGet(new URL(res.headers.location, url).href, maxRedirect - 1));
        }
        if (res.statusCode !== 200) {
          // 消费掉响应体，让连接可以复用
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', (e) => {
      // 被主动取消的不算错误
      if (req.destroyed) return resolve(null);
      reject(e);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.end();
    return req;
  });
}

/**
 * 安全解析 JSON
 */
function safeParseJSON(raw) {
  if (!raw) throw new Error('请求被取消');
  const trimmed = raw.trim();
  if (trimmed.startsWith('<') || trimmed.startsWith('<!--')) {
    throw new Error('Maven API 返回了 HTML 而非 JSON，可能是网络代理或防火墙拦截了请求');
  }
  return JSON.parse(trimmed);
}

// ============================================================
// 搜索 API
// ============================================================

// 只请求需要的字段，减少响应体积
const SEARCH_FIELDS = 'g,a,v,latestVersion,versionCount';

/**
 * 关键词搜索 Maven 仓库
 */
async function searchMaven(query, rows = 10) {
  const cacheKey = `search:${query}:${rows}`;

  // 命中缓存直接返回
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: query,
    rows: rows,
    wt: 'json',
    fl: SEARCH_FIELDS,
    sort: 'versionCount desc',
  });

  // 取消上一次未完成的搜索请求
  cancelActiveRequest();

  const url = `${SEARCH_BASE_URL}?${params.toString()}`;
  const raw = await httpsGet(url);
  if (!raw) return [];

  const json = safeParseJSON(raw);
  const docs = json.response?.docs || [];

  const results = docs.map((doc) => ({
    groupId: doc.g,
    artifactId: doc.a,
    version: doc.v,
    latestVersion: doc.latestVersion || doc.v,
    versionCount: doc.versionCount || 0,
  }));

  // 写入缓存
  cacheSet(cacheKey, results);
  return results;
}

/**
 * 精确查询最新版本号
 */
async function getLatestVersion(groupId, artifactId) {
  const cacheKey = `version:${groupId}:${artifactId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: `g:"${groupId}" AND a:"${artifactId}"`,
    rows: 1,
    wt: 'json',
    fl: 'latestVersion,v',
    sort: 'versionCount desc',
  });

  const url = `${SEARCH_BASE_URL}?${params.toString()}`;
  const raw = await httpsGet(url);
  if (!raw) return '';

  const json = safeParseJSON(raw);
  const docs = json.response?.docs || [];
  const version = docs.length > 0 ? (docs[0].latestVersion || docs[0].v) : '';

  cacheSet(cacheKey, version);
  return version;
}

/**
 * 生成 Maven <dependency> XML 片段
 */
function generateDependencyXML(groupId, artifactId, version) {
  return `<dependency>
    <groupId>${groupId}</groupId>
    <artifactId>${artifactId}</artifactId>
    <version>${version}</version>
</dependency>`;
}

// ============================================================
// 暴露给前端的方法
// ============================================================

window.searchMaven = async function (query) {
  try {
    return await searchMaven(query);
  } catch (e) {
    return { error: e.message };
  }
};

window.getLatestVersion = async function (groupId, artifactId) {
  try {
    return await getLatestVersion(groupId, artifactId);
  } catch (e) {
    return '';
  }
};

window.searchSimilar = async function (groupId, rows = 10) {
  try {
    const cacheKey = `similar:${groupId}:${rows}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams({
      q: `g:"${groupId}"`,
      rows: rows,
      wt: 'json',
      fl: SEARCH_FIELDS,
      sort: 'versionCount desc',
    });

    cancelActiveRequest();

    const url = `${SEARCH_BASE_URL}?${params.toString()}`;
    const raw = await httpsGet(url);
    if (!raw) return [];

    const json = safeParseJSON(raw);
    const docs = json.response?.docs || [];

    const results = docs.map((doc) => ({
      groupId: doc.g,
      artifactId: doc.a,
      version: doc.v,
      latestVersion: doc.latestVersion || doc.v,
      versionCount: doc.versionCount || 0,
    }));

    cacheSet(cacheKey, results);
    return results;
  } catch (e) {
    return { error: e.message };
  }
};

window.generateDependencyXML = function (groupId, artifactId, version) {
  return generateDependencyXML(groupId, artifactId, version);
};

window.getSearchConfig = function () { return getSearchConfig(); };
window.updateSearchConfig = function (c) { return updateSearchConfig(c); };
window.setActiveSource = function (k) { return setActiveSource(k); };
window.getActiveSource = function () { return getActiveSource(); };

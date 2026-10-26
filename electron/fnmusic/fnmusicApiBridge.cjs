// electron/fnmusic/fnmusicApiBridge.cjs
// 飞牛音乐（fnOS 官方音乐服务器）API 主进程桥。
//
// 为什么需要主进程桥：
//  1. 渲染进程 fetch 不允许设置 Cookie 请求头（Chromium 受限头），而飞牛音乐认证依赖
//     `music-token` cookie（网页端 credentials:'include' 自动携带）。
//  2. 跨域请求受 CORS 限制，NAS 不一定会放行；主进程 Node http/https 无此限制。
//  3. 用户 NAS 多为自签名 HTTPS 证书，主进程可直接 rejectUnauthorized:false。
//
// 协议（提取自飞牛音乐网页 JS bundle，见 docs/fnmusic-protocol.md）：
//  - 基础路径 {origin}/music/api/v1{path}
//  - 每个请求带 authx 头：nonce={6位随机}&timestamp={Date.now()}&sign={md5}
//    sign = md5("NDzZTVxnRKP8Z0jXg1VAMonaG8akvh" + "_" + pathname + "_" + nonce + "_" + timestamp + "_" + bodyHash + "_" + apiKey)
//    bodyHash(GET) = md5(decodeURIComponent(排序后的 query string))
//    bodyHash(POST) = md5(JSON.stringify(body))
//    apiKey = "6D5602D4-A342-4799-A0F0-BB795E7167D0"（bundle 内 XOR 混淆，已还原）
//  - 认证：登录返回 {userToken, user}；后续请求带 Cookie: music-token={userToken}
//  - 响应信封：{ code, msg, data }，code ∈ {0, 200} 视为成功
//  - 播放流：GET /music/api/v1/track/stream 返回播放源；若 url 为 hls://{fileId}?quality=，
//    则继续 GET {origin}/api/stream/unified?fileId=...&quality=...（此接口不签名）取 m3u8
//
// 安全约定（与桌面端其他平台的主进程桥一致）：
//  - 服务器地址与凭据（token）只存在主进程：safeStorage 加密后写入 store，渲染进程只发操作。
//  - 本地播放代理只在“配置了飞牛”（有已保存的服务器 + token）时才 listen 127.0.0.1，
//    base / token 一律从主进程配置读取，绝不从请求 URL 取。
//  - 代理响应不加 Access-Control-Allow-Origin: *；音频/封面走 <audio>/<img> 标签不受 CORS 限制。
//  - 日志只走 console.* 加 [FnMusic] 前缀，不写文件（避免凭据落盘）。

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const API_SECRET = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const API_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0';
const SUCCESS_CODES = new Set([0, 200]);
const MD5 = value => crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
const SHA256 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const CONFIG_STORE_KEY = 'fnmusic-config';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const log = (...args) => console.log('[FnMusic]', ...args);
const warn = (...args) => console.warn('[FnMusic]', ...args);

/** 排序后的 key=value 串（与网页端 yO + decodeURIComponent 等价的输入串）。 */
const sortedQueryString = (params) => {
  if (!params) return '';
  return Object.keys(params)
    .filter(key => params[key] != null)
    .sort()
    .map(key => `${key}=${String(params[key])}`)
    .join('&');
};

/** 生成 authx 请求头。pathname 必须是完整 API 路径（如 /music/api/v1/user/password-login）。 */
const buildAuthxHeader = ({ pathname, method, params, body }) => {
  const isGet = String(method).toUpperCase() === 'GET';
  const bodySource = isGet
    ? sortedQueryString(params)
    : (body === undefined || body === null ? '' : JSON.stringify(body));
  const bodyHash = MD5(bodySource);
  const nonce = String(Math.floor(Math.random() * 9e5) + 1e5);
  const timestamp = String(Date.now());
  const sign = MD5([API_SECRET, pathname, nonce, timestamp, bodyHash, API_KEY].join('_'));
  return `nonce=${nonce}&timestamp=${timestamp}&sign=${sign}`;
};

const encodeQuery = (params) => {
  if (!params) return '';
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null) usp.set(key, String(value));
  });
  return usp.toString();
};

const requestOnce = (url, { method, headers, body }) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const req = transport.request(parsed, {
    method,
    headers,
    rejectUnauthorized: false,
    timeout: 12000, // 12s 无响应即失败：NAS 关机/断网时快速返回错误，界面不永久转圈
  }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, raw });
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error(`请求超时（12s）: ${url}`));
  });
  req.on('error', reject);
  if (body !== undefined && body !== null) req.write(body);
  req.end();
});

const parseJsonEnvelope = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * 发一次请求并解信封。
 * @returns {{ok:true,data:any,status:number} | {ok:false,error:{code?,msg?,status?},status:number}}
 */
const performRequest = async ({
  base, method, path, params, body, token, unsigned = false,
}) => {
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const query = encodeQuery(params);
  const url = `${base.replace(/\/+$/, '')}${pathname}${query ? `?${query}` : ''}`;
  const headers = { Accept: 'application/json' };
  if (token) headers.Cookie = `music-token=${encodeURIComponent(token)}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (!unsigned) headers.authx = buildAuthxHeader({ pathname, method, params, body });
  const payload = body === undefined || body === null ? undefined : JSON.stringify(body);

  let response;
  try {
    response = await requestOnce(url, { method, headers, body: payload });
  } catch (error) {
    log(`FAIL ${method} ${pathname} query=${query} error=${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      status: 0,
      error: { code: 'network', msg: error instanceof Error ? error.message : String(error) },
    };
  }
  const envelope = parseJsonEnvelope(response.raw);
  if (envelope && typeof envelope.code === 'number' && !SUCCESS_CODES.has(envelope.code)) {
    log(`BIZ-ERR ${method} ${pathname} query=${query} status=${response.status} code=${envelope.code} msg=${envelope.msg || ''}`);
    return {
      ok: false,
      status: response.status,
      error: { code: envelope.code, msg: envelope.msg || `业务错误 code=${envelope.code}` },
    };
  }
  if (!response.raw || !envelope) {
    log(`BAD-RESP ${method} ${pathname} query=${query} status=${response.status}`);
    return {
      ok: false,
      status: response.status,
      error: { code: 'invalid-response', msg: response.raw?.slice(0, 200) || '空响应' },
    };
  }
  log(`OK ${method} ${pathname} query=${query} status=${response.status} dataKeys=${Object.keys(envelope.data || {}).join(',')}`);
  return { ok: true, status: response.status, data: envelope.data ?? null };
};

/**
 * 主进程桥。服务器地址与 token 用 safeStorage 加密存进 store（渲染进程只发操作）。
 * @param {{ store: import('electron').ElectronStore, safeStorage: import('electron').safeStorage }} deps
 */
const createFnmusicApiBridge = ({ store, safeStorage }) => {
  let proxyServer = null;
  let proxyPort = 0;

  const readConfig = () => {
    const encoded = store.get(CONFIG_STORE_KEY);
    if (!encoded) return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(String(encoded), 'base64')));
    } catch (error) {
      warn('无法解密已保存的飞牛配置（可能换了机器密钥）:', error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const writeConfig = (config) => {
    if (config) {
      const encrypted = safeStorage.encryptString(JSON.stringify(config));
      store.set(CONFIG_STORE_KEY, encrypted.toString('base64'));
    } else if (typeof store.delete === 'function') {
      store.delete(CONFIG_STORE_KEY);
    } else {
      store.set(CONFIG_STORE_KEY, undefined);
    }
  };

  const stopProxy = () => {
    if (proxyServer) {
      proxyServer.close(() => { proxyServer = null; proxyPort = 0; });
      proxyServer = null;
      proxyPort = 0;
    }
  };

  // 本地播放/封面代理：只服务本机（127.0.0.1），base/token 实时从主进程配置读取，
  // URL 上只允许携带 trackGUID/quality 或 coverId/size，不做任何任意地址转发。
  const startProxy = () => {
    if (proxyServer) return;
    const server = http.createServer((req, res) => {
      let config = null;
      try {
        config = readConfig();
        if (!config?.base) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('fnmusic not configured');
          return;
        }
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/fnmusic-stream') {
          const trackGUID = u.searchParams.get('trackGUID');
          if (!trackGUID) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('missing trackGUID');
            return;
          }
          // 网页端源码实据：stream 接口参数名为 guid（非 trackGUID）。
          const query = new URLSearchParams({ guid: trackGUID });
          const targetUrl = `${config.base.replace(/\/+$/, '')}/music/api/v1/track/stream?${query.toString()}`;
          const headers = { Accept: '*/*' };
          if (config.token) headers.Cookie = `music-token=${encodeURIComponent(config.token)}`;
          headers.authx = buildAuthxHeader({ pathname: '/music/api/v1/track/stream', method: 'GET', params: { guid: trackGUID }, body: undefined });
          if (req.headers.range) headers.Range = req.headers.range;
          const transport = targetUrl.startsWith('https:') ? https : http;
          const upstream = transport.request(targetUrl, { method: 'GET', headers }, (up) => {
            const out = { 'Content-Type': up.headers['content-type'] || 'application/octet-stream' };
            if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
            if (up.headers['accept-ranges']) out['Accept-Ranges'] = up.headers['accept-ranges'];
            if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range'];
            res.writeHead(up.statusCode || 200, out);
            up.pipe(res);
          });
          upstream.on('error', (error) => {
            warn('播放代理上游错误:', error.message);
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('upstream error');
          });
          req.on('error', () => upstream.destroy());
          upstream.end();
          return;
        }
        if (u.pathname === '/fnmusic-cover') {
          const coverId = u.searchParams.get('coverId');
          const size = u.searchParams.get('size') || '600';
          if (!coverId) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('missing coverId');
            return;
          }
          const coverQuery = new URLSearchParams({ coverId, size });
          const targetUrl = `${config.base.replace(/\/+$/, '')}/music/api/v1/static/cover?${coverQuery.toString()}`;
          const headers = { Accept: 'image/*' };
          if (config.token) headers.Cookie = `music-token=${encodeURIComponent(config.token)}`;
          const transport = targetUrl.startsWith('https:') ? https : http;
          const upstream = transport.request(targetUrl, { method: 'GET', headers }, (up) => {
            const out = { 'Content-Type': up.headers['content-type'] || 'application/octet-stream' };
            if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
            res.writeHead(up.statusCode || 200, out);
            up.pipe(res);
          });
          upstream.on('error', (error) => {
            warn('封面代理上游错误:', error.message);
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('upstream error');
          });
          req.on('error', () => upstream.destroy());
          upstream.end();
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      } catch (error) {
        warn('代理处理异常:', error instanceof Error ? error.message : String(error));
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('proxy error');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      proxyPort = server.address().port;
      log(`本地代理已就绪 127.0.0.1:${proxyPort}`);
    });
    server.on('error', (error) => {
      warn('本地代理启动失败:', error.message);
      proxyPort = 0;
      proxyServer = null;
    });
    proxyServer = server;
  };

  return {
    /** 当前桥状态：是否已配置、是否已登录、代理端口（供渲染层拼音频/封面地址）。 */
    getStatus() {
      const config = readConfig();
      return {
        available: true,
        configured: Boolean(config?.base),
        authenticated: Boolean(config?.token),
        streamProxyPort: proxyPort,
        base: config?.base ?? null,
        username: config?.username ?? null,
      };
    },

    /** 登录：POST /music/api/v1/user/password-login，密码 SHA-256，成功后加密保存配置并启动代理。 */
    async login({ base, username, password, deviceId }) {
      if (!base || !username || !password) {
        return { ok: false, status: 0, error: { code: 'invalid-params', msg: '登录缺少服务器地址 / 账号 / 密码' } };
      }
      const result = await performRequest({
        base,
        method: 'POST',
        path: '/music/api/v1/user/password-login',
        body: { username, password: SHA256(password), deviceId },
      });
      if (!result.ok) return result;
      if (!result.data?.userToken || !result.data?.user) {
        return {
          ok: false,
          status: result.status,
          error: { code: 'invalid-response', msg: '登录响应缺少 userToken 或 user' },
        };
      }
      writeConfig({ base: base.replace(/\/+$/, ''), username, token: result.data.userToken, deviceId });
      startProxy();
      return { ok: true, status: result.status, data: { user: result.data.user } };
    },

    /** 登出：POST /music/api/v1/user/logout，随后清配置并停代理。 */
    async logout() {
      const config = readConfig();
      if (config?.base && config.token) {
        await performRequest({ base: config.base, method: 'POST', path: '/music/api/v1/user/logout', token: config.token });
      }
      writeConfig(null);
      stopProxy();
      return { ok: true, status: 200, data: null };
    },

    /** 通用请求（搜索/歌词/歌单等）：path 为完整 API 路径；base/token 由主进程配置提供。 */
    async request({ path, method, params, body }) {
      const config = readConfig();
      if (!config?.base) {
        return { ok: false, status: 0, error: { code: 'unconfigured', msg: '飞牛尚未配置服务器' } };
      }
      return performRequest({ base: config.base, method: method || 'GET', path, params, body, token: config.token });
    },

    /** 播放地址：返回本地代理 URL（代理从主进程配置取 base/token，URL 不带任何凭据）。 */
    stream({ trackId, quality }) {
      const config = readConfig();
      if (!config?.base) return { ok: false, status: 0, error: { code: 'unconfigured', msg: '飞牛尚未配置服务器' } };
      if (!proxyPort) return { ok: false, status: 0, error: { code: 'proxy-unavailable', msg: '播放代理未就绪' } };
      const q = new URLSearchParams({ trackGUID: trackId });
      if (quality) q.set('quality', quality);
      return { ok: true, status: 200, data: { url: `http://127.0.0.1:${proxyPort}/fnmusic-stream?${q.toString()}` } };
    },

    /** 封面地址：返回本地代理 URL（coverId 由歌曲携带，地址在显示时生成，端口变化不影响已存数据）。 */
    coverUrl({ coverId, size }) {
      const config = readConfig();
      if (!config?.base) return { ok: false, status: 0, error: { code: 'unconfigured', msg: '飞牛尚未配置服务器' } };
      if (!proxyPort) return { ok: false, status: 0, error: { code: 'proxy-unavailable', msg: '封面代理未就绪' } };
      const q = new URLSearchParams({ coverId });
      if (size) q.set('size', String(size));
      return { ok: true, status: 200, data: { url: `http://127.0.0.1:${proxyPort}/fnmusic-cover?${q.toString()}` } };
    },

    /** 应用启动时若有已保存配置，恢复代理（登录态由渲染层通过 getStatus 感知）。 */
    restore() {
      const config = readConfig();
      if (config?.base) startProxy();
    },
  };
};

module.exports = { createFnmusicApiBridge, performRequest };

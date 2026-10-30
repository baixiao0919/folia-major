// electron/fnmusic/fnmusicApiBridge.cjs
// 飞牛音乐（fnOS 官方音乐服务器）API 主进程桥。
//
// 为什么需要主进程桥：
//  1. 渲染进程 fetch 不允许设置 Cookie 请求头（Chromium 受限头），而飞牛音乐认证依赖
//     `music-token` cookie（网页端 credentials:'include' 自动携带）。
//  2. 跨域请求受 CORS 限制，NAS 不一定会放行；主进程 Node http/https 无此限制。
//  3. 用户 NAS 多为自签名 HTTPS 证书；只对私网地址放行自签名（公网 FN Connect 中继有正规证书）。
//
// 协议（提取自飞牛音乐网页 JS bundle，见 docs/fnmusic-protocol.md）：
//  - 基础路径 {origin}/music/api/v1{path}
//  - 认证：登录返回 {userToken, user}；后续请求带 Cookie: music-token={userToken}
//  - 响应信封：{ code, msg, data }，code ∈ {0, 200} 视为成功
//  - 播放流：GET /music/api/v1/track/stream?guid=&quality= 返回播放源
//  - 封面：GET {origin}/music/api/v1/static/cover?coverId=&size= 返回图片
//
// 播放与封面经 `folia-fnmusic://` 自定义协议服务（protocol.handle）：
//  - 没有本地 HTTP 端口：本机其他进程/网页无法扫到、无法借它带 token 取歌；
//  - scheme 注册为 corsEnabled，响应带 Access-Control-Allow-Origin: *：<audio crossOrigin="anonymous">
//    和带 crossOrigin 读封面的 <img> 都能读（CORS 不再拦）；
//  - base / token 每次请求实时从主进程配置读取，URL 上只有 trackGUID/coverId，不带任何凭据；
//  - 播放 URL 带一次性 key（本次运行内签发），页面内容不能拿任意 id 来取。
//
// 安全约定（与桌面端其他平台的主进程桥一致）：
//  - 服务器地址与凭据（token）只存在主进程：safeStorage 加密后写入 store，渲染进程只发操作。
//  - 系统加密不可用（Linux basic_text / 无后端）时，配置只保存在本次运行内（内存），不落盘。
//  - 日志只走 console.* 加 [FnMusic] 前缀，不写文件（避免凭据落盘）；成功请求不逐行记日志。

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');

const SUCCESS_CODES = new Set([0, 200]);
const MD5 = value => crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
const SHA256 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const CONFIG_STORE_KEY = 'fnmusic-config';
const FNMUSIC_AUDIO_SCHEME = 'folia-fnmusic';
const FNMUSIC_AUDIO_PRIVILEGED_SCHEME = {
  scheme: FNMUSIC_AUDIO_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};
const MAX_ISSUED_KEYS = 512;
const REQUEST_TIMEOUT_MS = 12000;

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const warn = (...args) => console.warn('[FnMusic]', ...args);

/**
 * 只对私网地址放行自签名证书：家庭 NAS 常用自签名 HTTPS；公网 FN Connect 中继有正规证书，
 * 必须保留证书校验，公共网络上的中间人拿不到 SHA256(密码) 和 userToken。
 */
const isPrivateTarget = (hostname) => {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  if (host.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
};

const encodeQuery = (params) => {
  if (!params) return '';
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null) usp.set(key, String(value));
  });
  return usp.toString();
};

/** 发一次上游请求。自签名证书只对私网地址放行；超时（12s）快速失败。 */
const requestOnce = (url, { method, headers, body }) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const req = transport.request(parsed, {
    method,
    headers,
    rejectUnauthorized: isPrivateTarget(parsed.hostname),
    timeout: REQUEST_TIMEOUT_MS,
  }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, raw });
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）: ${url}`));
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
 * @returns {{ok:true,data:any,status:number} | {ok:false,error:{code?,message?,status?},status:number}}
 */
const performRequest = async ({
  base, method, path, params, body, token,
}) => {
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const query = encodeQuery(params);
  const url = `${base.replace(/\/+$/, '')}${pathname}${query ? `?${query}` : ''}`;
  const headers = { Accept: 'application/json' };
  if (token) headers.Cookie = `music-token=${encodeURIComponent(token)}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const payload = body === undefined || body === null ? undefined : JSON.stringify(body);

  let response;
  try {
    response = await requestOnce(url, { method, headers, body: payload });
  } catch (error) {
    warn(`FAIL ${method} ${pathname}`, error);
    return {
      ok: false,
      status: 0,
      error: { code: 'network', message: error instanceof Error ? error.message : String(error) },
    };
  }
  const envelope = parseJsonEnvelope(response.raw);
  if (response.status >= 400) {
    // 非 2xx：即便信封 code 是成功码也按失败回（HTTP 401/403 是登录失效，渲染层据此报 auth-required）。
    const business = envelope && typeof envelope.code === 'number' && !SUCCESS_CODES.has(envelope.code);
    warn(`HTTP-ERR ${method} ${pathname} status=${response.status}${business ? ` code=${envelope.code}` : ''}`);
    return {
      ok: false,
      status: response.status,
      error: {
        code: business ? String(envelope.code) : 'http-error',
        message: envelope?.msg || `HTTP ${response.status}`,
      },
    };
  }
  if (envelope && typeof envelope.code === 'number' && !SUCCESS_CODES.has(envelope.code)) {
    warn(`BIZ-ERR ${method} ${pathname} status=${response.status} code=${envelope.code}`);
    return {
      ok: false,
      status: response.status,
      error: { code: String(envelope.code), message: envelope.msg || `业务错误 code=${envelope.code}` },
    };
  }
  if (!response.raw || !envelope) {
    warn(`BAD-RESP ${method} ${pathname} status=${response.status}`);
    return {
      ok: false,
      status: response.status,
      error: { code: 'invalid-response', message: response.raw?.slice(0, 200) || '空响应' },
    };
  }
  return { ok: true, status: response.status, data: envelope.data ?? null };
};

/**
 * 主进程桥。服务器地址与 token 用 safeStorage 加密存进 store（渲染进程只发操作）。
 * 系统加密不可用时（Linux basic_text / 无后端）配置只保存在本次运行内。
 * @param {{ store: import('electron').ElectronStore, safeStorage: import('electron').safeStorage }} deps
 */
const createFnmusicApiBridge = ({ store, safeStorage }) => {
  // 本次运行内的配置（系统加密不可用时的降级）；有它优先用它（比落盘的值新）。
  let memoryConfig = null;
  // 播放 URL 的一次性 key：本次运行内签发，请求时校验（页面内容不能拿任意 id 来取）。
  const streamKeys = new Map();

  const canEncrypt = () => (
    Boolean(safeStorage?.isEncryptionAvailable?.())
    && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  );

  const readConfig = () => {
    if (memoryConfig) return memoryConfig;
    const encoded = store.get(CONFIG_STORE_KEY);
    if (!encoded) return null;
    if (!canEncrypt()) return null; // 明文落盘的值不可信（此前版本在 basic_text 下也直接加密写盘，读它等于读明文）。
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(String(encoded), 'base64')));
    } catch (error) {
      warn('无法解密已保存的飞牛配置（可能换了机器密钥）', error);
      return null;
    }
  };
  const writeConfig = (config) => {
    const clearStored = () => {
      if (typeof store.delete === 'function') store.delete(CONFIG_STORE_KEY);
      else store.set(CONFIG_STORE_KEY, undefined);
    };
    if (!config) {
      memoryConfig = null;
      clearStored();
      return;
    }
    memoryConfig = config;
    if (!canEncrypt()) {
      clearStored();
      warn('配置仅保存在本次运行内（系统加密不可用，Linux basic_text 拒绝落盘）');
      return;
    }
    try {
      store.set(CONFIG_STORE_KEY, safeStorage.encryptString(JSON.stringify(config)).toString('base64'));
    } catch (error) {
      clearStored();
      warn('配置加密保存失败，仅保存在本次运行内', error);
    }
  };

  const issueStreamKey = (trackId, quality) => {
    const key = crypto.randomBytes(16).toString('hex');
    streamKeys.set(key, { trackId, quality });
    while (streamKeys.size > MAX_ISSUED_KEYS) streamKeys.delete(streamKeys.keys().next().value);
    return key;
  };

  /** 取一次上游（播放/封面），把流交给 protocol.handle 的 Response。URL 上只有 trackGUID/coverId。 */
  const forwardUpstream = (request, targetUrl, headers, { range = false } = {}) => new Promise((resolve) => {
    if (range && request.headers.has('range')) headers.Range = request.headers.get('range');
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const upstream = transport.request(parsed, {
      method: 'GET',
      headers,
      rejectUnauthorized: isPrivateTarget(parsed.hostname),
    }, (up) => {
      const out = {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      };
      if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
      if (up.headers['accept-ranges']) out['Accept-Ranges'] = up.headers['accept-ranges'];
      if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range'];
      // 取消（拖进度条、切歌）时销毁上游请求，不留下暂停着的连接。
      request.signal?.addEventListener('abort', () => upstream.destroy(), { once: true });
      resolve(new Response(Readable.toWeb(up), { status: up.statusCode || 200, headers: out }));
    });
    upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`上游请求超时（${REQUEST_TIMEOUT_MS / 1000}s）: ${targetUrl}`));
    });
    upstream.on('error', (error) => {
      warn('上游请求失败', error);
      resolve(new Response(null, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }));
    });
    upstream.end();
  });
  return {
    /** 当前桥状态：是否已配置、是否已登录、服务器地址与账号（供登录表单回填）。 */
    getStatus() {
      const config = readConfig();
      return {
        available: true,
        configured: Boolean(config?.base),
        authenticated: Boolean(config?.token),
        base: config?.base ?? null,
        username: config?.username ?? null,
      };
    },

    /** 登录：POST /music/api/v1/user/password-login，密码 SHA-256，成功后加密保存配置。 */
    async login({ base, username, password }) {
      if (!base || !username || !password) {
        return { ok: false, status: 0, error: { code: 'invalid-params', message: '登录缺少服务器地址 / 账号 / 密码' } };
      }
      // 已保存的 deviceId 持久复用（不在 NAS 上堆积设备）；没有才生成。
      const existing = readConfig();
      const deviceId = existing?.deviceId ?? crypto.randomBytes(16).toString('hex');
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
          error: { code: 'invalid-response', message: '登录响应缺少 userToken 或 user' },
        };
      }
      writeConfig({ base: base.replace(/\/+$/, ''), username, token: result.data.userToken, deviceId });
      return { ok: true, status: result.status, data: { user: result.data.user } };
    },

    /** 登出：POST /music/api/v1/user/logout，随后清配置。 */
    async logout() {
      const config = readConfig();
      if (config?.base && config.token) {
        await performRequest({ base: config.base, method: 'POST', path: '/music/api/v1/user/logout', token: config.token });
      }
      writeConfig(null);
      streamKeys.clear();
      return { ok: true, status: 200, data: null };
    },

    /** 通用请求（搜索/歌词/歌单等）：path 为完整 API 路径；base/token 由主进程配置提供。 */
    async request({ path, method, params, body }) {
      const config = readConfig();
      if (!config?.base) {
        return { ok: false, status: 0, error: { code: 'unconfigured', message: '飞牛尚未配置服务器' } };
      }
      return performRequest({ base: config.base, method: method || 'GET', path, params, body, token: config.token });
    },

    /** 播放地址：签发一次性 key，返回 `folia-fnmusic://stream/<trackGUID>?k=<key>`（URL 不带凭据）。 */
    async stream({ trackId, quality }) {
      const config = readConfig();
      if (!config?.base) return { ok: false, status: 0, error: { code: 'unconfigured', message: '飞牛尚未配置服务器' } };
      if (!trackId) return { ok: false, status: 0, error: { code: 'invalid-params', message: '缺少 trackId' } };
      const key = issueStreamKey(String(trackId), quality ?? 'original');
      return {
        ok: true,
        status: 200,
        data: { url: `${FNMUSIC_AUDIO_SCHEME}://stream/${encodeURIComponent(String(trackId))}?k=${key}` },
      };
    },

    /** 封面地址：返回 `folia-fnmusic://cover/<coverId>?size=`（显示时生成，端口/代次不影响已存数据）。 */
    async coverUrl({ coverId, size }) {
      const config = readConfig();
      if (!config?.base) return { ok: false, status: 0, error: { code: 'unconfigured', message: '飞牛尚未配置服务器' } };
      if (!coverId) return { ok: false, status: 0, error: { code: 'invalid-params', message: '缺少 coverId' } };
      const q = size ? `?size=${Number(size)}` : '';
      return {
        ok: true,
        status: 200,
        data: { url: `${FNMUSIC_AUDIO_SCHEME}://cover/${encodeURIComponent(String(coverId))}${q}` },
      };
    },

    /** 自定义协议的请求处理（播放与封面）。base/token 实时从配置取，URL 只带 id。 */
    async handleAudioRequest(request) {
      try {
        const url = new URL(request.url);
        const config = readConfig();
        if (!config?.base) {
          return new Response(null, { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        const base = config.base.replace(/\/+$/, '');
        const headers = { Accept: '*/*' };
        if (config.token) headers.Cookie = `music-token=${encodeURIComponent(config.token)}`;

        if (url.hostname === 'stream') {
          const trackId = decodeURIComponent(url.pathname.slice(1));
          const key = url.searchParams.get('k') ?? '';
          // 一次性 key 必须匹配：页面内容不能拿任意 id 来取歌。
          const link = streamKeys.get(key);
          if (request.method !== 'GET' || !trackId || !link || link.trackId !== trackId) {
            return new Response(null, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
          }
          const query = new URLSearchParams({ guid: trackId });
          if (link.quality) query.set('quality', link.quality);
          // 播放链路不带 authx 签名（2026-10-28 服务端实测：无 authx 同样返回音频）。
          return await forwardUpstream(
            request,
            `${base}/music/api/v1/track/stream?${query.toString()}`,
            headers,
            { range: true },
          );
        }
        if (url.hostname === 'cover') {
          const coverId = decodeURIComponent(url.pathname.slice(1));
          const size = url.searchParams.get('size') || '600';
          if (request.method !== 'GET' || !coverId) {
            return new Response(null, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
          }
          const coverQuery = new URLSearchParams({ coverId, size });
          return await forwardUpstream(
            request,
            `${base}/music/api/v1/static/cover?${coverQuery.toString()}`,
            { ...headers, Accept: 'image/*' },
          );
        }
        return new Response(null, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (error) {
        warn('协议请求处理失败', error);
        return new Response(null, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    },
  };
};

module.exports = {
  createFnmusicApiBridge,
  FNMUSIC_AUDIO_SCHEME,
  FNMUSIC_AUDIO_PRIVILEGED_SCHEME,
  performRequest,
  isPrivateTarget,
};

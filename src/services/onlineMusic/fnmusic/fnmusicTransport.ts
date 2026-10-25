import md5 from 'blueimp-md5';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/fnmusic/fnmusicTransport.ts
// 飞牛音乐（飞牛 fnOS 官方音乐服务器）协议客户端。
//
// 协议说明：见 docs/fnmusic-protocol.md：
//  - 基础路径 {origin}/music/api/v1{path}
//  - 请求头 authx 签名（nonce/timestamp/sign=md5(...)），apiKey 为 bundle 内混淆还原值
//  - 登录 POST /music/api/v1/user/password-login {username, password: sha256(password), deviceId}
//    → 响应 {userToken, user}；认证通过 Cookie: music-token={userToken} 携带
//  - 响应信封 {code, msg, data}，code ∈ {0, 200} 为成功
//
// 桌面端（Electron）所有请求走主进程桥 fnmusicRequest（渲染进程无法设置 Cookie 受限头，
// 且跨域受 CORS 限制）；非 Electron 环境回退到直接 fetch（Cookie 头可能被浏览器丢弃，仅调试用）。

export type FnMusicLoginType = 0 | 1; // 0=音乐账号 1=NAS 账号（网页端密码登录为音乐账号）

export interface FnMusicServerConfig {
    host: string;
    port: number;
    https: boolean;
    account: string;
    password: string;
    loginType: FnMusicLoginType;
    token?: string;
    serverName?: string;
    serverId?: string;
    deviceId?: string;
}

export type FnMusicBridgeParams =
    | { base: string; username: string; password: string; deviceId: string }  // login
    | { base: string; token?: string }                                        // logout
    | { base: string; method: 'GET' | 'POST'; path: string; params?: Record<string, string | number | boolean | undefined>; body?: Record<string, unknown>; token?: string; unsigned?: boolean } // request
    | { base: string; token?: string; trackId: string; quality?: string };    // stream

export type FnMusicBridgeResult =
    | { ok: true; data: unknown; status?: number }
    | { ok: false; status?: number; error?: { code?: string | number; msg?: string } };

const CONFIG_KEY = 'fnmusic_server_config';

const CONFIG_DEFAULT: Omit<FnMusicServerConfig, 'account' | 'password'> = {
    host: '', port: 5666, https: false, loginType: 0,
};

const text = (value: unknown): string => (value == null ? '' : String(value));

export const loadFnMusicConfig = (): FnMusicServerConfig | null => {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FnMusicServerConfig>;
        if (!parsed.host || !parsed.account) return null;
        return { ...CONFIG_DEFAULT, account: '', password: '', ...parsed };
    } catch {
        return null;
    }
};

export const saveFnMusicConfig = (config: FnMusicServerConfig): void => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
};

export const clearFnMusicConfig = (): void => {
    localStorage.removeItem(CONFIG_KEY);
};

/** 服务器源：{scheme}://{host}:{port}（所有 API 路径为完整路径，如 /music/api/v1/user/password-login） */
export const fnMusicBaseUrl = (config: Pick<FnMusicServerConfig, 'host' | 'port' | 'https'>): string => (
    `${config.https ? 'https' : 'http'}://${config.host}:${config.port}`
);

/** 封面地址：优先走本地代理（带 Cookie、可诊断），代理不可用时直连 NAS。
 *  网页端封面生成规则：{origin}/music/api/v1/static/cover?coverId=...&size=600（ei() 默认 size=Medium(600)；img 直连无需签名）。 */
let cachedCoverProxyPort = 0;
export const fnMusicCoverUrl = (config: Pick<FnMusicServerConfig, 'host' | 'port' | 'https' | 'token'>, coverId: string): string => {
    const coverQuery = new URLSearchParams({ coverId, size: '600' });
    const base = fnMusicBaseUrl(config);
    if (cachedCoverProxyPort <= 0 && typeof window !== 'undefined' && (window as any).electron?.fnmusicStatusSync) {
        try {
            cachedCoverProxyPort = Number((window as any).electron.fnmusicStatusSync()?.streamProxyPort || 0);
        } catch { cachedCoverProxyPort = 0; }
    }
    if (cachedCoverProxyPort > 0) {
        const proxyQuery = new URLSearchParams({ coverId, base });
        if (config.token) proxyQuery.set('token', config.token);
        return `http://127.0.0.1:${cachedCoverProxyPort}/fnmusic-cover?${proxyQuery.toString()}`;
    }
    return `${base}/music/api/v1/static/cover?${coverQuery.toString()}`;
};

const hasElectronBridge = (): boolean => typeof window !== 'undefined' && Boolean((window as any).electron?.fnmusicRequest);

const bridgeError = (result: FnMusicBridgeResult & { ok: false }, operation: string): OnlineProviderError => {
    const msg = result.error?.msg || `飞牛音乐 ${operation} 失败`;
    const code = text(result.error?.code);
    if (code === 'network') return new OnlineProviderError('network', msg, 'fnmusic');
    if (code && !Number.isNaN(Number(code))) {
        return new OnlineProviderError('invalid-response', `飞牛音乐 ${operation} 业务错误: ${msg}`, 'fnmusic');
    }
    return new OnlineProviderError('invalid-response', msg, 'fnmusic');
};

// ---------------------------------------------------------------------------
// 非 Electron 兜底：直接 fetch + 本地 authx 签名。Cookie 头在浏览器里会被丢弃，
// 仅用于调试/网页预览，桌面端请走桥。
// ---------------------------------------------------------------------------
const WEB_SECRET = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const WEB_API_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0';

const sha256Hex = async (value: string): Promise<string> => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const webAuthx = (pathname: string, method: string, params: Record<string, unknown> | undefined, body: unknown): string => {
    const isGet = method.toUpperCase() === 'GET';
    const sortedQuery = (params ? Object.entries(params).filter(([, v]) => v != null).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${String(v)}`) : []).join('&');
    const bodyHash = md5(isGet ? sortedQuery : (body === undefined || body === null ? '' : JSON.stringify(body)));
    const nonce = String(Math.floor(Math.random() * 9e5) + 1e5);
    const timestamp = String(Date.now());
    const sign = md5([WEB_SECRET, pathname, nonce, timestamp, bodyHash, WEB_API_KEY].join('_'));
    return `nonce=${nonce}&timestamp=${timestamp}&sign=${sign}`;
};

// ---------------------------------------------------------------------------

/**
 * 发一次请求。path 为完整 API 路径（如 /music/api/v1/album/list）。
 * 信封校验：code ∈ {0, 200} 时返回 data；否则抛业务错误。
 */
export async function fnmusicRequest<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; signal?: AbortSignal },
): Promise<T> {
    const config = loadFnMusicConfig();
    if (!config) throw new OnlineProviderError('unavailable', '飞牛音乐服务器未配置', 'fnmusic');
    const base = fnMusicBaseUrl(config);
    const method = options?.method ?? 'GET';

    if (hasElectronBridge()) {
        const result = await (window as any).electron.fnmusicRequest('request', {
            base, method, path, params, body: options?.body, token: config.token || undefined,
        } as FnMusicBridgeParams) as FnMusicBridgeResult;
        if (!result.ok) throw bridgeError(result, path);
        return result.data as T;
    }

    // Web 兜底
    const query = new URLSearchParams();
    if (params) Object.entries(params).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    const queryString = query.toString();
    const url = `${base}${path}${queryString ? `?${queryString}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.token) headers.Cookie = `music-token=${encodeURIComponent(config.token)}`;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    headers.authx = webAuthx(path, method, params, options?.body);
    const response = await fetch(url, {
        method,
        headers,
        signal: options?.signal,
        body: method === 'POST' && options?.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
        throw new OnlineProviderError('unavailable', `飞牛音乐服务器返回 ${response.status}`, 'fnmusic', undefined, response.status);
    }
    const raw: unknown = await response.json().catch(() => null);
    if (raw && typeof raw === 'object' && 'code' in raw) {
        const envelope = raw as { code?: unknown; msg?: unknown; data?: unknown };
        const code = Number(envelope.code ?? 0);
        if (code !== 0 && code !== 200) {
            throw new OnlineProviderError('invalid-response', text(envelope.msg) || `飞牛音乐接口 ${path} 返回 code ${code}`, 'fnmusic');
        }
        return envelope.data as T;
    }
    return raw as T;
}

/** 解析播放地址（走主进程桥处理 hls:// 与相对路径）。 */
export async function fnMusicStreamSource(trackId: string, quality = 'original'): Promise<string> {
    const config = loadFnMusicConfig();
    if (!config) throw new OnlineProviderError('unavailable', '飞牛音乐服务器未配置', 'fnmusic');
    if (!hasElectronBridge()) {
        const raw = await fnmusicRequest<{ source?: { url?: string }; url?: string; playUrl?: string }>('/music/api/v1/track/stream', { trackGUID: trackId });
        const url = text(raw?.source?.url ?? raw?.url ?? raw?.playUrl ?? '');
        if (!url) throw new OnlineProviderError('not-playable', '飞牛音乐未返回播放地址', 'fnmusic');
        return url;
    }
    const base = fnMusicBaseUrl(config);
    const result = await (window as any).electron.fnmusicRequest('stream', {
        base, token: config.token || undefined, trackId, quality,
    } as FnMusicBridgeParams) as FnMusicBridgeResult;
    if (!result.ok) throw bridgeError(result, 'track/stream');
    const data = result.data as { url?: string } | null;
    const url = text(data?.url);
    if (!url) throw new OnlineProviderError('not-playable', '飞牛音乐未返回播放地址', 'fnmusic');
    return url;
}

/** 登录：POST /music/api/v1/user/password-login（密码 SHA-256），成功后保存 token。 */
export async function fnMusicLogin(config: FnMusicServerConfig): Promise<{ userToken: string; user: unknown }> {
    const deviceId = config.deviceId || Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('').padStart(32, '0');
    const base = fnMusicBaseUrl(config);
    let result: FnMusicBridgeResult;
    if (hasElectronBridge()) {
        result = await (window as any).electron.fnmusicRequest('login', {
            base, username: config.account, password: config.password, deviceId,
        } as FnMusicBridgeParams) as FnMusicBridgeResult;
    } else {
        // Web 兜底：本地 SHA-256 + authx
        const hashed = await sha256Hex(config.password);
        const body = { username: config.account, password: hashed, deviceId };
        const path = '/music/api/v1/user/password-login';
        const url = `${base}${path}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', authx: webAuthx(path, 'POST', undefined, body) },
            body: JSON.stringify(body),
        });
        const raw: unknown = await response.json().catch(() => null);
        const envelope = raw && typeof raw === 'object' ? raw as { code?: unknown; msg?: unknown; data?: unknown } : {};
        if (Number(envelope.code ?? 0) !== 0 && Number(envelope.code ?? 0) !== 200) {
            throw new OnlineProviderError('auth-required', text(envelope.msg) || '登录失败：账号或密码错误', 'fnmusic');
        }
        result = { ok: true, data: envelope.data ?? null };
    }
    if (!result.ok) throw bridgeError(result, 'user/password-login');
    const data = result.data as { userToken?: unknown; user?: unknown } | null;
    const userToken = text(data?.userToken);
    if (!userToken) throw new OnlineProviderError('invalid-response', '登录响应缺少 userToken（字段待实机确认）', 'fnmusic');
    saveFnMusicConfig({ ...config, token: userToken, deviceId });
    return { userToken, user: data?.user };
}

/** 登出。 */
export async function fnMusicLogout(): Promise<void> {
    const config = loadFnMusicConfig();
    if (!config) return;
    try {
        if (hasElectronBridge()) {
            const base = fnMusicBaseUrl(config);
            await (window as any).electron.fnmusicRequest('logout', { base, token: config.token || undefined } as FnMusicBridgeParams);
        }
    } catch {
        // 登出失败不阻塞：本地清 token
    }
    clearFnMusicConfig();
}

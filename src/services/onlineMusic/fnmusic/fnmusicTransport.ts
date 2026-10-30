import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/fnmusic/fnmusicTransport.ts
// 飞牛音乐（飞牛 fnOS 官方音乐服务器）协议客户端（仅桌面端渲染层）。
//
// 协议说明：见 docs/fnmusic-protocol.md：
//  - 基础路径 {origin}/music/api/v1{path}
//  - 登录 POST /music/api/v1/user/password-login {username, password: sha256(password), deviceId}
//    → 响应 {userToken, user}；认证通过 Cookie: music-token={userToken} 携带
//  - 响应信封 {code, msg, data}，code ∈ {0, 200} 为成功
//  - 播放/封面走 folia-fnmusic:// 自定义协议（主进程 protocol.handle，无本地 HTTP 端口）
//
// 安全约定：服务器地址与凭据（token / 密码）全部由主进程 safeStorage 加密保存，
// 渲染进程只发操作（login/request/stream/coverUrl），不读写 localStorage，也不在
// URL 里携带 base/token。非 Electron 环境（网页/Docker）不可用（Cookie 受限头与
// CORS 使直连不可行），由 provider 的 getAvailability 返回 runtime-unavailable。

export type FnMusicBridgeOperation = 'login' | 'logout' | 'request' | 'stream' | 'coverUrl' | 'getStatus';

export type FnMusicBridgeParams =
    | { base: string; username: string; password: string }                    // login（deviceId 由主进程复用/生成）
    | { path: string; method: 'GET' | 'POST'; params?: Record<string, string | number | boolean | undefined>; body?: Record<string, unknown> } // request
    | { trackId: string; quality?: string }                                   // stream
    | { coverId: string; size?: number }                                      // coverUrl
    | {};                                                                     // logout / getStatus

export type FnMusicBridgeResult =
    | { ok: true; data: unknown; status?: number }
    | { ok: false; status?: number; error?: { code?: string | number; message?: string } };

export interface FnMusicBridgeStatus {
    available: boolean;
    configured: boolean;
    authenticated: boolean;
    base: string | null;
    username: string | null;
}

const text = (value: unknown): string => (value == null ? '' : String(value));

const hasElectronBridge = (): boolean => typeof window !== 'undefined' && Boolean(window.electron?.fnmusicRequest);

/** 同步查询桥状态（base/username 供登录表单回填；封面地址现在走自定义协议，不再需要端口）。 */
export const fnMusicBridgeStatus = (): FnMusicBridgeStatus | null => {
    if (typeof window === 'undefined' || !window.electron?.fnmusicStatusSync) return null;
    try {
        return window.electron.fnmusicStatusSync();
    } catch {
        return null;
    }
};

const bridgeError = (result: FnMusicBridgeResult & { ok: false }, operation: string): OnlineProviderError => {
    const msg = result.error?.message || `飞牛音乐 ${operation} 失败`;
    const code = text(result.error?.code);
    const httpStatus = result.status;
    // 登录失效：HTTP 401/403，或业务码 120001（账号或密码错误，NAS 账号与音乐独立账号是两套体系）。
    if (httpStatus === 401 || httpStatus === 403 || code === '120001') {
        return new OnlineProviderError('auth-required', msg, 'fnmusic', undefined, httpStatus);
    }
    if (code === 'network') return new OnlineProviderError('network', msg, 'fnmusic', undefined, httpStatus);
    if (code && !Number.isNaN(Number(code))) {
        return new OnlineProviderError('invalid-response', `飞牛音乐 ${operation} 业务错误(code=${code}, HTTP ${httpStatus}): ${msg}`, 'fnmusic', undefined, httpStatus);
    }
    return new OnlineProviderError('invalid-response', msg, 'fnmusic', undefined, httpStatus);
};

/**
 * 发一次请求。path 为完整 API 路径（如 /music/api/v1/album/list）。
 * 仅 Electron 桌面端可用：服务器与凭据由主进程配置提供，渲染进程只传操作。
 */
export async function fnmusicRequest<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; signal?: AbortSignal },
): Promise<T> {
    if (!hasElectronBridge()) {
        throw new OnlineProviderError('unavailable', '飞牛音乐仅支持桌面端（需主进程桥）', 'fnmusic');
    }
    const bridge = window.electron!;
    const result = await bridge.fnmusicRequest('request', {
        path, method: options?.method ?? 'GET', params, body: options?.body,
    });
    if (!result.ok) throw bridgeError(result, path);
    return result.data as T;
}

/** 播放地址：主进程签发一次性 key，返回 folia-fnmusic:// 协议 URL（URL 不带任何凭据）。 */
export async function fnMusicStreamSource(trackId: string, quality = 'original'): Promise<string> {
    if (!hasElectronBridge()) {
        throw new OnlineProviderError('unavailable', '飞牛音乐仅支持桌面端（需主进程桥）', 'fnmusic');
    }
    const bridge = window.electron!;
    const result = await bridge.fnmusicRequest('stream', { trackId, quality });
    if (!result.ok) throw bridgeError(result, 'track/stream');
    const data = result.data as { url?: string } | null;
    const url = text(data?.url);
    if (!url) throw new OnlineProviderError('not-playable', '飞牛音乐未返回播放地址', 'fnmusic');
    return url;
}

/**
 * 封面地址：歌曲对象只携带 coverId，显示时生成 folia-fnmusic:// 协议 URL。
 * 地址不含端口、不依赖代理端口，重启后已存数据依然有效（主进程每次请求实时取配置）。
 */
export function fnMusicCoverUrl(coverId: string, size = 600): string {
    if (!coverId) return '';
    return `folia-fnmusic://cover/${encodeURIComponent(coverId)}?size=${Number(size)}`;
}

/**
 * 登录：POST /music/api/v1/user/password-login（密码 SHA-256、deviceId 复用/生成由主进程完成）。
 * 成功后凭据由主进程加密保存，本函数只返回用户信息（不含 token）。
 */
export async function fnMusicLogin(config: { base: string; username: string; password: string }): Promise<{ user: unknown }> {
    if (!hasElectronBridge()) {
        throw new OnlineProviderError('unavailable', '飞牛音乐仅支持桌面端（需主进程桥）', 'fnmusic');
    }
    const bridge = window.electron!;
    const result = await bridge.fnmusicRequest('login', config);
    if (!result.ok) throw bridgeError(result, 'user/password-login');
    const data = result.data as { user?: unknown } | null;
    if (!data?.user) throw new OnlineProviderError('invalid-response', '登录响应缺少用户信息', 'fnmusic');
    return { user: data.user };
}

/** 登出：主进程调登出接口并清配置。 */
export async function fnMusicLogout(): Promise<void> {
    const bridge = window.electron;
    if (!bridge?.fnmusicRequest) return;
    try {
        await bridge.fnmusicRequest('logout', {});
    } catch {
        // 登出失败不阻塞
    }
}

import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

// test/unit/electron/fnmusicApiBridge.test.ts — 主进程桥：配置加密保存与降级、deviceId 复用、
// 一次性播放 key、私网证书策略、错误对象 {code,message}、登出清配置。

const require = createRequire(import.meta.url);
const { createFnmusicApiBridge, isPrivateTarget } = require('../../../electron/fnmusic/fnmusicApiBridge.cjs');

const createStore = () => {
    const values = new Map<string, unknown>();
    return { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
};
const cipher = () => ({
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xa5)),
    decryptString: (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0xa5)).toString(),
});

/** 一个应答信封的本地 HTTP fixture 服务器：路径 → {code,msg,data}。 */
const startFixture = async (routes: Record<string, { code: number; msg?: string; data?: unknown }>) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const route = routes[url.pathname];
        if (!route) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: route.code, msg: route.msg ?? '', data: route.data ?? null }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return { server, base: `http://127.0.0.1:${address.port}` };
};

/** 播放/封面上游 fixture：登录 + track/stream 回音频字节，static/cover 回图片字节。 */
const startMediaFixture = async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/music/api/v1/user/password-login') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, msg: '', data: { userToken: 'tk', user } }));
            return;
        }
        if (url.pathname === '/music/api/v1/track/stream') {
            res.writeHead(200, { 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes' });
            res.end(Buffer.from([0x66, 0x4c, 0x61, 0x43])); // fLaC
            return;
        }
        if (url.pathname === '/music/api/v1/static/cover') {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
            return;
        }
        res.writeHead(404); res.end('not found');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return { server, base: `http://127.0.0.1:${address.port}` };
};

const user = { id: '42', name: 'Fixture' };

describe('FnMusic desktop bridge', () => {
    it.each([
        ['localhost', 'localhost', true],
        ['127.0.0.1', '127.0.0.1', true],
        ['::1', '::1', true],
        ['LAN 10.x', '10.1.2.3', true],
        ['LAN 192.168.x', '192.168.1.10', true],
        ['LAN 172.16-31.x', '172.16.0.1', true],
        ['LAN 172.15.x (公网段)', '172.15.0.1', false],
        ['mDNS 主机名', 'nas.local', true],
        ['公网域名（FN Connect 中继）', 'fn.12345.fnconnect.net', false],
        ['公网 IP', '203.0.113.7', false],
    ])('isPrivateTarget：%s → %s', (_name, host, expected) => {
        expect(isPrivateTarget(host)).toBe(expected);
    });

    it('login 成功后凭据加密落盘，getStatus 可读回', async () => {
        const fixture = await startFixture({
            '/music/api/v1/user/password-login': { code: 0, data: { userToken: 'tk-fixture', user } },
        });
        try {
            const store = createStore();
            const bridge = createFnmusicApiBridge({ store, safeStorage: cipher() });
            const result = await bridge.login({ base: fixture.base, username: 'u', password: 'p' });
            expect(result.ok).toBe(true);
            const sealed = store.get('fnmusic-config');
            expect(Buffer.from(String(sealed), 'base64').toString()).not.toContain('tk-fixture');
            const rebuilt = createFnmusicApiBridge({ store, safeStorage: cipher() });
            expect(rebuilt.getStatus()).toMatchObject({ configured: true, authenticated: true, base: fixture.base, username: 'u' });
        } finally {
            fixture.server.close();
        }
    });

    it.each([
        ['没有系统加密', { isEncryptionAvailable: () => false }],
        ['Linux basic_text', { getSelectedStorageBackend: () => 'basic_text' }],
    ])('系统加密不可用（%s）：配置只保存在本次运行内，不落盘', async (_case, locked) => {
        const fixture = await startFixture({
            '/music/api/v1/user/password-login': { code: 0, data: { userToken: 'tk', user } },
        });
        try {
            const store = createStore();
            const bridge = createFnmusicApiBridge({ store, safeStorage: { ...cipher(), ...locked } });
            const result = await bridge.login({ base: fixture.base, username: 'u', password: 'p' });
            expect(result.ok).toBe(true);
            expect(store.get('fnmusic-config')).toBeUndefined();
            expect(bridge.getStatus().authenticated).toBe(true); // 本次运行内仍有配置
            const rebuilt = createFnmusicApiBridge({ store, safeStorage: { ...cipher(), ...locked } });
            expect(rebuilt.getStatus()).toMatchObject({ configured: false, authenticated: false });
        } finally {
            fixture.server.close();
        }
    });

    it('deviceId 持久复用：再次登录沿用同一个 deviceId', async () => {
        const seen: unknown[] = [];
        const fixture = await startFixture({
            '/music/api/v1/user/password-login': { code: 0, data: { userToken: 'tk', user } },
        });
        try {
            const original = (req: IncomingMessage, res: ServerResponse) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                if (url.pathname !== '/music/api/v1/user/password-login') { res.writeHead(404); res.end(); return; }
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => { seen.push(JSON.parse(body).deviceId); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, msg: '', data: { userToken: 'tk', user } })); });
            };
            const server = createServer(original);
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address() as { port: number };
            try {
                const store = createStore();
                const bridge = createFnmusicApiBridge({ store, safeStorage: cipher() });
                await bridge.login({ base: `http://127.0.0.1:${address.port}`, username: 'u', password: 'p1' });
                await bridge.login({ base: `http://127.0.0.1:${address.port}`, username: 'u', password: 'p2' });
                expect(seen).toHaveLength(2);
                expect(seen[0]).toMatch(/^[a-f0-9]{32}$/);
                expect(seen[1]).toBe(seen[0]);
            } finally {
                server.close();
            }
        } finally {
            fixture.server.close();
        }
    });

    it('业务错误走 { code, message }（信封 code/msg）', async () => {
        const fixture = await startFixture({
            '/music/api/v1/user/password-login': { code: 120001, msg: '账号或密码错误' },
        });
        try {
            const bridge = createFnmusicApiBridge({ store: createStore(), safeStorage: cipher() });
            const result = await bridge.login({ base: fixture.base, username: 'u', password: 'wrong' });
            expect(result).toMatchObject({ ok: false, error: { code: '120001', message: '账号或密码错误' } });
        } finally {
            fixture.server.close();
        }
    });

    it('网络失败走 { code: "network", message }，不带敏感信息', async () => {
        const bridge = createFnmusicApiBridge({ store: createStore(), safeStorage: cipher() });
        const result = await bridge.login({ base: 'http://127.0.0.1:1', username: 'u', password: 'p' });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('network');
        expect(JSON.stringify(result)).not.toContain('p');
    });

    it('stream 签发一次性 key 的协议 URL，handleAudioRequest 校验后转发上游', async () => {
        const media = await startMediaFixture();
        try {
            const store = createStore();
            const bridge = createFnmusicApiBridge({ store, safeStorage: cipher() });
            const fixture = await startFixture({
                '/music/api/v1/user/password-login': { code: 0, data: { userToken: 'tk', user } },
            });
            try {
                await bridge.login({ base: media.base, username: 'u', password: 'p' });
                const streamed = await bridge.stream({ trackId: 'g-1', quality: 'original' });
                expect(streamed.ok).toBe(true);
                const url = String((streamed.data as { url: string }).url);
                expect(url).toMatch(/^folia-fnmusic:\/\/stream\/g-1\?k=[a-f0-9]{32}$/);
                const response = await bridge.handleAudioRequest(new Request(url));
                expect(response.status).toBe(200);
                expect(response.headers.get('access-control-allow-origin')).toBe('*');
                expect(Buffer.from(await response.arrayBuffer()).toString('hex')).toBe('664c6143');

                // 一次性 key：错误 key、无 key 都被拒（404），不发上游。
                const wrong = url.replace(/k=[a-f0-9]{32}$/, `k=${'0'.repeat(32)}`);
                expect((await bridge.handleAudioRequest(new Request(wrong))).status).toBe(404);
                expect((await bridge.handleAudioRequest(new Request('folia-fnmusic://stream/g-1'))).status).toBe(404);

                // 封面走协议 URL，转发成功。
                const cover = await bridge.coverUrl({ coverId: 'c-1', size: 600 });
                const coverUrl = String((cover.data as { url: string }).url);
                expect(coverUrl).toBe('folia-fnmusic://cover/c-1?size=600');
                const coverResponse = await bridge.handleAudioRequest(new Request(coverUrl));
                expect(coverResponse.status).toBe(200);
                expect(coverResponse.headers.get('content-type')).toBe('image/jpeg');
            } finally {
                fixture.server.close();
            }
        } finally {
            media.server.close();
        }
    });

    it('未配置时协议请求回 503，不发起上游', async () => {
        const bridge = createFnmusicApiBridge({ store: createStore(), safeStorage: cipher() });
        expect((await bridge.handleAudioRequest(new Request('folia-fnmusic://cover/c-1'))).status).toBe(503);
        expect((await bridge.stream({ trackId: 'g-1' }))).toMatchObject({ ok: false, error: { code: 'unconfigured' } });
    });

    it('登出清配置，stream key 一并作废', async () => {
        const media = await startMediaFixture();
        try {
            const store = createStore();
            const bridge = createFnmusicApiBridge({ store, safeStorage: cipher() });
            const fixture = await startFixture({
                '/music/api/v1/user/password-login': { code: 0, data: { userToken: 'tk', user } },
                '/music/api/v1/user/logout': { code: 0 },
            });
            try {
                await bridge.login({ base: media.base, username: 'u', password: 'p' });
                const streamed = await bridge.stream({ trackId: 'g-1' });
                const url = String((streamed.data as { url: string }).url);
                await bridge.logout();
                expect(store.get('fnmusic-config')).toBeUndefined();
                expect(bridge.getStatus().authenticated).toBe(false);
                // 登出后配置与 key 一并清掉：协议请求按未配置回 503（即使还拿着旧 URL）。
                expect((await bridge.handleAudioRequest(new Request(url))).status).toBe(503);
            } finally {
                fixture.server.close();
            }
        } finally {
            media.server.close();
        }
    });

    it('request 走配置里的 base/token，401 按 {code,message} 回', async () => {
        const seen: string[] = [];
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname === '/music/api/v1/user/password-login') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ code: 0, msg: '', data: { userToken: 'tk-fixture', user } }));
                return;
            }
            seen.push(String(req.headers.cookie ?? ''));
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, msg: '', data: null }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        try {
            const store = createStore();
            const bridge = createFnmusicApiBridge({ store, safeStorage: cipher() });
            const base = `http://127.0.0.1:${address.port}`;
            await bridge.login({ base, username: 'u', password: 'p' });
            const result = await bridge.request({ path: '/music/api/v1/search/track', method: 'GET', params: { q: 'x' } });
            expect(result).toMatchObject({ ok: false, status: 401, error: { code: 'http-error' } });
            expect(seen[0]).toContain('music-token=tk-fixture');
        } finally {
            server.close();
        }
    });
});

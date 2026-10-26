import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fnMusicCoverUrl, fnMusicLogin, makeFnMusicDeviceId } from '@/services/onlineMusic/fnmusic/fnmusicTransport';
import { normalizeFnMusicSong } from '@/services/onlineMusic/fnmusic/fnmusicProvider';

// test/unit/fnmusic/fnmusicProvider.test.ts
// 归一化、登录参数与封面地址的逻辑测试：桥的答复用替身，不碰真实 fnOS 服务。
// 封面代理与播放地址只带操作参数，不带 base / token / 明文凭据（作者 review 第 3、5 点的安全要求）。

const bridgeRequest = vi.fn();
const statusSync = vi.fn();

beforeEach(() => {
    bridgeRequest.mockReset().mockResolvedValue({ ok: true, data: null });
    statusSync.mockReset().mockReturnValue({ configured: true, authenticated: false, username: '', streamProxyPort: 43210 });
    vi.stubGlobal('window', { electron: { fnmusicRequest: bridgeRequest, fnmusicStatusSync: statusSync } });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('makeFnMusicDeviceId', () => {
    it('returns a 32-digit hex device id', () => {
        const id = makeFnMusicDeviceId();
        expect(id).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('fnMusicCoverUrl', () => {
    it('builds the cover address from the current proxy port, without base or token', () => {
        const url = fnMusicCoverUrl('cover-123', 300);
        expect(url).toBe('http://127.0.0.1:43210/fnmusic-cover?coverId=cover-123&size=300');
        expect(url).not.toMatch(/base=/);
        expect(url).not.toMatch(/token=/);
    });

    it('returns an empty string when the proxy port is unknown', () => {
        statusSync.mockReturnValue({ configured: false, authenticated: false, username: '', streamProxyPort: 0 });
        expect(fnMusicCoverUrl('cover-123')).toBe('');
    });
});

describe('fnMusicLogin', () => {
    it('sends the login operation with device id and no plaintext beyond the form values', async () => {
        bridgeRequest.mockResolvedValue({ ok: true, data: { user: { guid: 'u1', name: 'Tester' } } });
        const result = await fnMusicLogin({ base: 'http://192.168.1.10:5666', username: 'alice', password: 'secret', deviceId: 'ab'.repeat(16) });
        expect(bridgeRequest).toHaveBeenCalledWith('login', expect.objectContaining({
            base: 'http://192.168.1.10:5666',
            username: 'alice',
            password: 'secret',
            deviceId: 'ab'.repeat(16),
        }));
        expect(result.user).toEqual({ guid: 'u1', name: 'Tester' });
        // 登录答复不把 token 带回渲染进程
        expect(bridgeRequest.mock.calls[0][1]).not.toHaveProperty('token');
    });
});

describe('normalizeFnMusicSong', () => {
    it('normalizes the web adapter fields and keeps coverId in providerData', () => {
        const song = normalizeFnMusicSong({
            guid: 'track-1',
            title: 'Title',
            artists: [{ guid: 'a1', name: 'Artist' }],
            album: { guid: 'al1', name: 'Album' },
            coverId: 'cover-1',
            duration: 210,
        });
        expect(song.id).toBe('track-1');
        expect(song.name).toBe('Title');
        expect(song.artists[0].name).toBe('Artist');
        expect(song.album.name).toBe('Album');
        expect(song.album.coverUrl).toMatch(/^http:\/\/127\.0\.0\.1:43210\/fnmusic-cover\?/);
        if (song.sourceRef.kind === 'online') {
            expect(song.sourceRef.providerData?.coverId).toBe('cover-1');
        } else {
            throw new Error('expected an online source');
        }
    });

    it('falls back to a generic user id when name fields are missing, with no hard-coded Chinese nickname', () => {
        const song = normalizeFnMusicSong({ guid: 'track-2' });
        expect(song.name).toBe('');
        expect(song.album.coverUrl).toBe('');
    });
});

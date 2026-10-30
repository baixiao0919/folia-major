import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fnMusicCoverUrl, fnMusicLogin } from '@/services/onlineMusic/fnmusic/fnmusicTransport';
import { normalizeFnMusicSong } from '@/services/onlineMusic/fnmusic/fnmusicProvider';

// test/unit/fnmusic/fnmusicProvider.test.ts
// 归一化、登录参数与封面地址的逻辑测试：桥的答复用替身，不碰真实 fnOS 服务。
// 封面与播放地址走 folia-fnmusic:// 自定义协议，不带 base / token / 明文凭据（review 第 3、5、10 点的安全要求）。

const bridgeRequest = vi.fn();
const statusSync = vi.fn();

beforeEach(() => {
    bridgeRequest.mockReset().mockResolvedValue({ ok: true, data: null });
    statusSync.mockReset().mockReturnValue({ available: true, configured: true, authenticated: false, base: null, username: '' });
    vi.stubGlobal('window', { electron: { fnmusicRequest: bridgeRequest, fnmusicStatusSync: statusSync } });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('fnMusicCoverUrl', () => {
    it('builds the protocol cover address from the cover id only, without base, token or port', () => {
        const url = fnMusicCoverUrl('cover-123', 300);
        expect(url).toBe('folia-fnmusic://cover/cover-123?size=300');
        expect(url).not.toMatch(/base=/);
        expect(url).not.toMatch(/token=/);
        expect(url).not.toMatch(/127\.0\.0\.1/);
    });

    it('escapes the cover id and returns empty for a missing one', () => {
        expect(fnMusicCoverUrl('a/b?c=1')).toBe('folia-fnmusic://cover/a%2Fb%3Fc%3D1?size=600');
        expect(fnMusicCoverUrl('')).toBe('');
    });
});

describe('fnMusicLogin', () => {
    it('sends the login operation with only the form values (device id stays in the main process)', async () => {
        bridgeRequest.mockResolvedValue({ ok: true, data: { user: { guid: 'u1', name: 'Tester' } } });
        const result = await fnMusicLogin({ base: 'http://192.168.1.10:5666', username: 'alice', password: 'secret' });
        expect(bridgeRequest).toHaveBeenCalledWith('login', {
            base: 'http://192.168.1.10:5666',
            username: 'alice',
            password: 'secret',
        });
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
        expect(song.album.coverUrl).toBe('folia-fnmusic://cover/cover-1?size=600');
        if (song.sourceRef.kind === 'online') {
            expect(song.sourceRef.providerData?.coverId).toBe('cover-1');
        } else {
            throw new Error('expected an online source');
        }
    });

    it('a song that is already normalized is rewritten to the protocol cover from its saved coverId', () => {
        const once = normalizeFnMusicSong({ guid: 'track-1', title: 'T', coverId: 'c-1' });
        const again = normalizeFnMusicSong(once);
        expect(again.id).toBe('track-1');
        expect(again.album.coverUrl).toBe('folia-fnmusic://cover/c-1?size=600');
    });

    it('rewrites a cover URL left over from the old port-based proxy (http://127.0.0.1:<port>/fnmusic-cover)', () => {
        const legacy = normalizeFnMusicSong({ guid: 'track-1', title: 'T', coverId: 'c-1' });
        (legacy.album as { coverUrl: string }).coverUrl = 'http://127.0.0.1:43210/fnmusic-cover?coverId=c-1&size=300';
        const fixed = normalizeFnMusicSong(legacy);
        expect(fixed.album.coverUrl).toBe('folia-fnmusic://cover/c-1?size=600');
    });

    it('name fields may be missing: empty name and empty cover fall back without a hard-coded Chinese nickname', () => {
        const song = normalizeFnMusicSong({ guid: 'track-2' });
        expect(song.name).toBe('');
        expect(song.album.coverUrl).toBe('');
        expect(song.album.name).toBe('');
    });
});

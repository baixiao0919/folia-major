import type { Artist, SongResult, UnifiedSong } from '../../../types';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type {
    AudioQualityPreference,
    LoginFailureDetail,
    LoginState,
    MediaId,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderCollection,
    ProviderLikedSongIds,
    ProviderLyricsResult,
    ProviderPage,
    ProviderUser,
} from '../../../types/onlineMusic';
import { parseFoliaLyricDocument } from '../../../utils/lyrics/foliaLyricDocument';
import {
    clearFnMusicConfig,
    fnMusicCoverUrl,
    fnMusicLogin,
    fnMusicLogout,
    fnMusicStreamSource,
    fnmusicRequest,
    loadFnMusicConfig,
} from './fnmusicTransport';

// src/services/onlineMusic/fnmusic/fnmusicProvider.ts
// 飞牛音乐（飞牛 fnOS 官方音乐服务器）provider。
//
// 协议说明：见 docs/fnmusic-protocol.md，字段映射：
//  歌曲: guid / title / artists[{guid,name}] / album{guid,name,coverId,artists} /
//        duration(ms) / coverId / trackNo / discNo / isFavorite / isCue / createdAt(秒)
//  搜索: GET /music/api/v1/search/track?q=&page=&size= → { total, list }
//  歌词: GET /music/api/v1/lyric/list?trackGUID= → { list, preferred }
//  播放: GET /music/api/v1/track/stream?trackGUID= → 播放源（hls:// 经 /api/stream/unified 转 m3u8）

type FnMusicRecord = Record<string, any>;
const record = (value: unknown): FnMusicRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);
const text = (value: unknown): string => (value == null ? '' : String(value));
const catalogRef = (kind: 'album' | 'artist', id: unknown) => (
    id ? { providerId: 'fnmusic' as const, kind, id: text(id) } : undefined
);

const artistsOf = (raw: unknown): Artist[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.flatMap(entry => {
        const single = record(entry);
        const name = text(typeof entry === 'string' ? entry : (single.name ?? single.artistName));
        const id = text(typeof entry === 'string' ? entry : (single.guid ?? single.id ?? single.artistId));
        if (!name || seen.has(name)) return [];
        seen.add(name);
        return [{ id: id || name, name, catalogRef: catalogRef('artist', id || name) }];
    });
};

const coverOf = (coverId: unknown): string => {
    const id = text(coverId);
    if (!id) return '';
    const config = loadFnMusicConfig();
    return config ? fnMusicCoverUrl(config, id) : '';
};

/** 归一化一首飞牛音乐歌曲（字段名取自网页端 Sj 映射器）。 */
export const normalizeFnMusicSong = (raw: unknown): UnifiedSong => {
    const item = record(raw);
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === 'fnmusic') return item as UnifiedSong;
    const id = text(item.guid ?? item.id ?? item.mediaId ?? '');
    if (!id) throw new OnlineProviderError('invalid-response', '飞牛音乐歌曲缺少 guid', 'fnmusic');
    const album = record(item.album);
    const albumId = text(album.guid ?? item.albumId ?? '');
    return {
        id,
        name: text(item.title ?? item.trackName ?? item.name ?? ''),
        artists: artistsOf(item.artists),
        album: {
            id: albumId,
            name: text(album.name ?? item.albumName ?? ''),
            coverUrl: coverOf(item.coverId ?? album.coverId) || '',
            catalogRef: catalogRef('album', albumId),
        },
        durationMs: Math.max(0, Number(item.duration ?? item.durationMs ?? 0)),
        sourceRef: {
            kind: 'online',
            providerId: 'fnmusic',
            mediaId: id,
            providerData: {
                coverId: text(item.coverId ?? album.coverId ?? ''),
                createdAt: item.createdAt ?? null,
                updatedAt: item.updatedAt ?? null,
                isFavorite: Boolean(item.isFavorite),
                isCue: Boolean(item.isCue),
                trackNo: item.trackNo ?? null,
                discNo: item.discNo ?? null,
            },
        },
    };
};

const normalizeFnMusicUser = (raw: unknown): ProviderUser => {
    const item = record(raw);
    return {
        id: text(item.guid ?? item.id ?? item.uid ?? item.account ?? 'fnmusic-user'),
        nickname: text(item.name ?? item.nickname ?? item.account ?? item.username ?? '飞牛音乐账号'),
        avatarUrl: text(item.avatarUrl ?? item.avatar ?? '') || undefined,
    };
};

const fnMusicPage = (items: UnifiedSong[], total: number, offset: number, limit: number): ProviderPage<UnifiedSong> => ({
    items,
    total,
    hasMore: offset + items.length < total,
    nextOffset: offset + items.length,
});

const songIdOf = (song: SongResult): string => {
    const source = song.sourceRef;
    if (source?.kind !== 'online' || source.providerId !== 'fnmusic') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to 飞牛音乐', 'fnmusic');
    }
    return text(source.mediaId);
};

/** 统一错误文案（日志用）。 */
const errorMessageOf = (error: unknown): string => (
    error instanceof Error ? error.message : String(error)
);

/** 歌词项取文本字段（LRC 文本）。字段名（lyric/lyrics/content/lrc）待实机确认。 */
const lyricTextOf = (raw: unknown): string => {
    const item = record(raw);
    return text(item.lyric ?? item.lyrics ?? item.content ?? item.lrc ?? item.text ?? '');
};

/** 数量字段（网页端可能是 number 或数字字符串）。 */
const countOf = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 列表接口信封：可能为 { total, list }，也可能直接是数组。list 缺失按空列表处理，total 缺失按 list 长度。 */
const pageList = async <T = unknown>(path: string, params: Record<string, string | number | boolean | undefined> | undefined): Promise<{ total: number; list: T[] }> => {
    const raw = await fnmusicRequest<unknown>(path, params);
    if (Array.isArray(raw)) return { total: raw.length, list: raw as T[] };
    const record = (raw && typeof raw === 'object' ? raw : {}) as { total?: unknown; list?: unknown };
    const list = Array.isArray(record.list) ? record.list as T[] : [];
    const total = Number(record.total ?? list.length) || list.length;
    return { total, list };
};

/** 歌单/专辑/歌手列表项 → 收藏卡片（字段名与网页端 bundle 对齐）。 */
const collectionOf = (type: 'playlist' | 'album' | 'artist') => (raw: unknown): ProviderCollection => {
    const item = record(raw);
    const id = text(item.guid ?? item.id ?? '');
    return {
        providerId: 'fnmusic',
        id,
        type,
        name: text(item.name ?? item.title ?? ''),
        coverUrl: coverOf(item.coverId) || '',
        description: text(item.description ?? item.summary ?? ''),
        trackCount: countOf(item.trackCount ?? item.track_total ?? item.songCount ?? item.trackTotal),
        albumCount: countOf(item.albumCount ?? item.album_total),
        artists: Array.isArray(item.artists)
            ? item.artists.map((entry: unknown) => {
                const a = record(entry);
                const artistName = text(a.name ?? a.artistName);
                return artistName
                    ? { name: artistName, id: text(a.guid ?? a.id ?? a.artistId ?? artistName) }
                    : null;
            }).filter((a: { name: string; id: string } | null): a is { name: string; id: string } => a !== null)
            : undefined,
    };
};

/** detail 接口响应 → 收藏卡片（元数据字段可能与列表项略有出入，做兼容）。 */
const collectionDetailOf = (type: 'playlist' | 'album' | 'artist') => (raw: unknown): ProviderCollection | null => {
    const item = record(raw);
    const id = text(item.guid ?? item.id ?? '');
    if (!id) return null;
    return collectionOf(type)(item);
};

/** 歌曲列表响应里的歌曲数组：兼容 tracks/list/items/songs 等常见字段名。 */
const trackListOf = (raw: unknown): unknown[] => {
    const item = record(raw);
    const list = item.tracks ?? item.list ?? item.items ?? item.songs ?? item.songList;
    return Array.isArray(list) ? list : [];
};

const fnMusicPageOf = (list: unknown[], total: number, offset: number, limit: number): ProviderPage<UnifiedSong> =>
    fnMusicPage(list.map(normalizeFnMusicSong), total, offset, limit);

export const fnMusicLibrary = {
    /** 我的歌单。请求失败返回空页（不抛错）：登录后的账户刷新不被歌单接口卡住，保证登录成功即切换平台。网页端 playlist.list 无参数调用。 */
    async getUserPlaylists(_userId: string, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
        try {
            const { total, list } = await pageList<unknown>('/music/api/v1/playlist/list', undefined);
            const items = list.map(collectionOf('playlist'));
            // playlist/list 不返回每首歌单的歌曲数：「我的喜欢」是收藏歌单（红心 + 添加到歌单都进这里），
            // 用 playlist/detail 拿真实 trackCount，保证收藏后数字实时正确。
            const liked = items.find(collection => collection.name === '我的喜欢');
            if (liked && typeof liked.id === 'string' && !liked.id.startsWith('online:')) {
                const detail = await fnmusicRequest<{ trackCount?: unknown }>('/music/api/v1/playlist/detail', { guid: liked.id })
                    .then(raw => Number(raw?.trackCount ?? 0))
                    .catch(() => 0);
                if (detail > 0) liked.trackCount = detail;
            }
            // 歌单封面兜底：NAS 对部分歌单（如「我的喜欢」）coverId 为 null 不存封面，
            // 取歌单第一首有封面的歌补上，避免歌单卡片显示空白。
            for (const collection of items) {
                if (collection.coverUrl || typeof collection.id !== 'string' || collection.id.startsWith('online:')) continue;
                const first = await fnmusicRequest<{ list?: unknown[] }>('/music/api/v1/track/playlist-detail/list', { playlistGUID: collection.id, page: 1, size: 1 })
                    .then(raw => Array.isArray(raw?.list) ? raw.list[0] : undefined)
                    .catch(() => undefined);
                const coverId = first ? text(record(first).coverId) : '';
                if (coverId) collection.coverUrl = coverOf(coverId);
            }
            return { items, total, hasMore: offset + items.length < total, nextOffset: offset + items.length };
        } catch (error) {
            console.warn('[FnMusic] playlist/list failed, returning empty page:', errorMessageOf(error));
            return { items: [], total: 0, hasMore: false, nextOffset: offset };
        }
    },

    /** 专辑列表（Folia 的「专辑」页）。请求失败返回空页。 */
    async getUserAlbums(_userId: string, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> {
        try {
            const { total, list } = await pageList<unknown>('/music/api/v1/album/list', {
                page: Math.floor(offset / limit) + 1,
                size: limit,
            });
            const items = list.map(collectionOf('album'));
            return { items, total, hasMore: offset + items.length < total, nextOffset: offset + items.length };
        } catch (error) {
            console.warn('[FnMusic] album/list failed, returning empty page:', errorMessageOf(error));
            return { items: [], total: 0, hasMore: false, nextOffset: offset };
        }
    },

    /** 我喜欢的歌曲 id 全量（favorite-track/list 分页循环）。失败返回空（不抛错）。 */
    async getLikedSongIds(): Promise<ProviderLikedSongIds> {
        const ids: string[] = [];
        try {
            const PAGE = 100;
            for (let page = 1; page <= 20; page += 1) {
                const raw = await fnmusicRequest<{ list?: unknown; total?: unknown }>(
                    '/music/api/v1/favorite-track/list',
                    { page, size: PAGE },
                );
                const list = Array.isArray(raw?.list) ? raw.list : [];
                const pageIds = list
                    .map((entry) => text(record(entry).trackGUID ?? record(entry).guid ?? record(entry).id ?? ''))
                    .filter(Boolean);
                ids.push(...pageIds);
                const total = Number(raw?.total ?? 0);
                if (list.length < PAGE || (total > 0 && ids.length >= total)) break;
            }
        } catch (error) {
            console.warn('[FnMusic] favorite-track/list failed:', errorMessageOf(error));
        }
        return { ids, whole: true };
    },
} as const;

/** 变更能力：红心（favorite-track create/delete）、添加/移除歌单曲目（playlist add-track/remove-track）、建歌单（playlist create）。
 *  飞牛音乐没有"收藏歌单"接口（网页端无此功能），明确禁用。 */
export const fnMusicMutations = {
    likeSong: async (song: MediaId | SongResult, liked: boolean): Promise<void> => {
        const id = typeof song === 'string' ? song : (typeof song === 'number' ? String(song) : songIdOf(song));
        const config = loadFnMusicConfig();
        if (!config) throw new OnlineProviderError('unavailable', '飞牛音乐服务器未配置', 'fnmusic');
        await fnmusicRequest<unknown>(
            liked ? '/music/api/v1/favorite-track/create' : '/music/api/v1/favorite-track/delete',
            undefined,
            { method: 'POST', body: { trackGUID: id } },
        );
    },
    canSubscribe: () => false,
    canAddToPlaylist: () => true,
    async createPlaylist(name: string): Promise<ProviderCollection> {
        const raw = await fnmusicRequest<unknown>('/music/api/v1/playlist/create', undefined, { method: 'POST', body: { name } });
        return collectionOf('playlist')(raw);
    },
    async updatePlaylistTracks(
        operation: 'add' | 'del',
        playlist: MediaId | ProviderCollection,
        tracks: Array<MediaId | SongResult>,
    ): Promise<void> {
        const playlistId = typeof playlist === 'string' ? playlist : (typeof playlist === 'number' ? String(playlist) : playlist.id);
        const trackGUIDs = tracks.map((track) => (
            typeof track === 'string' ? track : (typeof track === 'number' ? String(track) : songIdOf(track))
        ));
        await fnmusicRequest<unknown>(
            operation === 'add' ? '/music/api/v1/playlist/add-track' : '/music/api/v1/playlist/remove-track',
            undefined,
            { method: 'POST', body: { guid: playlistId, trackGUIDs } },
        );
    },
} as const;

export const fnMusicCatalog = {
    /** 歌单内歌曲：/music/api/v1/track/playlist-detail/list?playlistGUID=&page=&size= */
    async getPlaylistTracks(id: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
        const { total, list } = await pageList<unknown>('/music/api/v1/track/playlist-detail/list', {
            playlistGUID: id,
            page: Math.floor(offset / limit) + 1,
            size: limit,
        });
        return fnMusicPageOf(list, total, offset, limit);
    },

    async getPlaylistDetail(id: string): Promise<ProviderCollection | null> {
        const raw = await fnmusicRequest<unknown>('/music/api/v1/playlist/detail', { guid: id });
        return collectionDetailOf('playlist')(raw);
    },

    /** 专辑内歌曲：/music/api/v1/track/album-detail/list?albumGUID=&page=&size= */
    async getAlbumTracks(id: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
        const { total, list } = await pageList<unknown>('/music/api/v1/track/album-detail/list', {
            albumGUID: id,
            page: Math.floor(offset / limit) + 1,
            size: limit,
        });
        return fnMusicPageOf(list, total, offset, limit);
    },

    async getAlbumDetail(id: string): Promise<ProviderCollection | null> {
        const raw = await fnmusicRequest<unknown>('/music/api/v1/album/detail', { guid: id });
        return collectionDetailOf('album')(raw);
    },

    /** 歌手歌曲：/music/api/v1/track/artist-detail/list?artistGUID=&page=&size= */
    async getArtistSongs(id: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
        const { total, list } = await pageList<unknown>('/music/api/v1/track/artist-detail/list', {
            artistGUID: id,
            page: Math.floor(offset / limit) + 1,
            size: limit,
        });
        return fnMusicPageOf(list, total, offset, limit);
    },

    async getArtistDetail(id: string): Promise<ProviderCollection | null> {
        const raw = await fnmusicRequest<unknown>('/music/api/v1/artist/detail', { guid: id });
        return collectionDetailOf('artist')(raw);
    },
} as const;

export const fnmusicProvider: OnlineMusicProvider = {
    id: 'fnmusic',
    displayName: '飞牛音乐',
    shortName: '飞牛',
    mark: { letter: '飞', color: '#0891b2' },
    getAvailability: () => ({ configured: true }),
    capabilities: {
        search: true, playback: true, lyrics: true, wordByWordLyrics: false,
        auth: true,
        userLibrary: true, playlists: true, albums: true, artists: true, userAlbums: true,
        recommendations: false, mutations: true, likes: true, playlistTrackMutations: true,
    },
    normalizeSong: normalizeFnMusicSong,
    normalizeUser: normalizeFnMusicUser,
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return fnMusicPage([], 0, offset, limit);
            const page = Math.floor(offset / limit) + 1; // 网页端 page 从 1 起
            const raw = await fnmusicRequest<{ total?: unknown; list?: unknown }>(
                '/music/api/v1/search/track',
                { q: query, page, size: limit },
            );
            const list = Array.isArray(raw?.list) ? raw.list : [];
            const total = Number(raw?.total ?? list.length) || list.length;
            const items = list.map(normalizeFnMusicSong);
            return fnMusicPage(items, total, offset, limit);
        },
    },
    playback: {
        async getSongDetail(id) {
            const raw = await fnmusicRequest<unknown>('/music/api/v1/track/metadata', { trackGUID: id });
            const item = record(raw);
            return normalizeFnMusicSong(item.track ?? item.song ?? raw);
        },
        async getAudioSource(song, quality: AudioQualityPreference) {
            const url = await fnMusicStreamSource(songIdOf(song), quality);
            return { url, fetchedAt: Date.now(), quality } as ProviderAudioSource;
        },
    },
    lyrics: {
        async getLyrics(song): Promise<ProviderLyricsResult> {
            const raw = await fnmusicRequest<{ list?: unknown; preferred?: unknown }>(
                '/music/api/v1/lyric/list',
                { trackGUID: songIdOf(song) },
            );
            const list = Array.isArray(raw?.list) ? raw.list : [];
            if (list.length === 0) return { lyrics: null, isPureMusic: false };
            const preferredIndex = Number(raw?.preferred ?? 0);
            const candidates = list.length > 1 && Number.isFinite(preferredIndex) && preferredIndex >= 0 && preferredIndex < list.length
                ? [list[preferredIndex], ...list.slice(0, preferredIndex), ...list.slice(preferredIndex + 1)]
                : list;
            for (const candidate of candidates) {
                const lrcText = lyricTextOf(candidate);
                if (!lrcText) continue;
                const lyrics = parseFoliaLyricDocument(lrcText);
                return { lyrics, mainText: lrcText, isPureMusic: false };
            }
            return { lyrics: null, isPureMusic: false };
        },
    },
    library: fnMusicLibrary,
    catalog: fnMusicCatalog,
    mutations: fnMusicMutations,
    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitleFnMusic', note: 'home.loginNoteFnMusic' }),
        async getLoginStatus(): Promise<ProviderUser | null> {
            const config = loadFnMusicConfig();
            if (!config?.token) return null;
            return {
                id: config.account || 'fnmusic-user',
                nickname: config.serverName || config.account || '飞牛音乐账号',
            };
        },
        async logout() {
            await fnMusicLogout();
        },
        // 登录入口：从已保存的服务器配置发起登录。配置入口见设置页（Navidrome 形态，待补）。
        async startLogin(): Promise<string> {
            const config = loadFnMusicConfig();
            if (!config || !config.host || !config.account || !config.password) {
                throw new OnlineProviderError(
                    'unavailable',
                    '请先在设置中配置飞牛音乐服务器地址与账号',
                    'fnmusic',
                );
            }
            await fnMusicLogin(config);
            return 'fnmusic-login-done';
        },
        async checkLogin(): Promise<LoginState> {
            const config = loadFnMusicConfig();
            return config?.token ? { state: 'confirmed' } : { state: 'error', message: '登录未完成' };
        },
        describeLoginFailure: (_step, error): LoginFailureDetail | null => ({
            case: 'unknown',
            message: error instanceof Error ? error.message : '登录失败',
        }),
    },
};

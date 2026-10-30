# 飞牛音乐服务器协议

> 状态：**接口路径、登录流程、核心字段依据飞牛音乐服务端接口约定与网页端 JS bundle 整理**。
> 说明：接口以飞牛音乐服务实际响应为准。
> 少量字段（歌词项、播放源响应）为合理推断，代码中以「待实机确认」标注。

## 基础信息

- 服务：飞牛音乐服务器（fnOS NAS 上的飞牛音乐 Web 服务，`/music` 路径）。
- **API 基础路径：`{origin}/music/api/v1/`**（v2 通道为 `/music/api/v2`；国际版 `/music/api/intl/v1`）。
  - 之前误用 `/music/api/`（缺 `/v1`），服务器对未注册路径回退 SPA index.html。
- 端口：跟随 fnOS Web 端口（HTTP 5666 / HTTPS 5667）。
- 响应信封：`{ code, msg, data }`；`code ∈ {0, 200}` 为成功，其余为业务错误（`msg` 为错误信息）。

## 请求签名（不需要）

早期版本内嵌了网页端 bundle 里的 `authx` 签名（API_SECRET / API_KEY + nonce/timestamp/md5）。
**2026-10-28 服务端实测：登录与播放流不带 authx 同样成功**，签名不是必需项。
因此主进程桥不再保留客户端标识、签名或协议实现（`UPSTREAMS.md` 的「不保留」承诺成立），
请求只带 `Cookie: music-token={userToken}`。

## 认证（登录 + 会话）

- 登录：`POST /music/api/v1/user/password-login`
  - 请求体：`{ "username": 账号, "password": sha256(明文密码), "deviceId": 32位hex }`
  - deviceId：首次登录由主进程生成（随机 32 位小写 hex），之后**持久复用**（存于主进程配置），不在 NAS 上堆积设备。
  - 响应：`data: { userToken, user }`。
- 会话认证：后续请求带 `Cookie: music-token={userToken}`（网页端 `credentials:'include'` 自动携带）。
  - 渲染进程无法设置 Cookie 受限头 → 桌面端由主进程桥写入。
- 登出：`POST /music/api/v1/user/logout`。
- 当前用户：`GET /music/api/v1/user/me`。

## 核心接口（方法来自接口注册表）

| 模块 | 路径 | 方法 | 参数 | 响应要点 |
| --- | --- | --- | --- | --- |
| 搜索歌曲 | `/music/api/v1/search/track` | GET | `q`（关键词）、`page`、`size` | `{ total, list }` |
| 搜索专辑/歌手/歌单 | `/music/api/v1/search/album` `/search/artist` `/search/playlist` | GET | `q,page,size` | `{ total, list }` |
| 搜索建议 | `/music/api/v1/search/suggest` | GET | `q` | - |
| 歌曲元数据 | `/music/api/v1/track/metadata` | GET | `trackGUID` | 歌曲对象 |
| 歌曲列表 | `/music/api/v1/track/list` | GET | 分页 | `{ total, list }` |
| 播放源 | `/music/api/v1/track/stream` | GET | `guid`、可选 `quality` | 播放源（url 可能为 `hls://{fileId}?quality=`） |
| 转码 | `/music/api/v1/track/transcode` | POST | - | - |
| 歌词 | `/music/api/v1/lyric/list` | GET | `trackGUID` | `{ list, preferred }` |
| 专辑列表/详情 | `/music/api/v1/album/list` `/album/detail` | GET | 分页 / id | `{ total, list }` / 专辑 |
| 歌手列表/详情 | `/music/api/v1/artist/list` `/artist/detail` | GET | - | - |
| 歌单列表/详情 | `/music/api/v1/playlist/list` `/playlist/detail` | GET | 分页 / id | `{ total, list }` |
| 收藏 | `/music/api/v1/favorite-track/create` `/delete` `/list` | POST/GET | `trackGUID` / 分页 | `{ total, list }` |
| 播放历史 | `/music/api/v1/play-history/list` | GET | - | - |
| 封面 | `{origin}/music/api/v1/static/cover?coverId={id}` | GET | 可加 `size` | 图片 |

播放流补充接口（位于根路径，不签名）：
- `GET {origin}/api/stream/unified?fileId={fileId}&quality={original|...}` → `{ playlistUrl, profile:{channels} }`（m3u8 播放列表）
- `GET {origin}/api/stream/hls?fileId=&bitrate=&format=aac` → `{ playlistUrl }`
- `GET {origin}/api/stream/info?fileId=|url=` → `{ duration }`

## 播放与封面：`folia-fnmusic://` 自定义协议（主进程 protocol.handle）

桌面端不设本地 HTTP 端口，播放/封面经自定义协议服务：

- 地址形态：`folia-fnmusic://stream/<trackGUID>?k=<一次性key>`（播放）与 `folia-fnmusic://cover/<coverId>?size=`（封面）。
- URL 上只有歌曲/封面 id，不带服务器地址与任何凭据：`base` 与 `music-token` 由主进程
  每次请求实时从加密配置读取（渲染进程只发操作、不读写凭据）。
- 播放 URL 的一次性 key 由主进程在 `stream` 操作时签发（本次运行内，上限 512 个）；
  协议请求校验 key 与 id 匹配，页面内容不能拿任意 id 来取歌。
- scheme 注册为 `corsEnabled` 且响应带 `Access-Control-Allow-Origin: *`：
  `<audio crossOrigin="anonymous">` 与带 `crossOrigin` 读封面像素的 `<img>` 都能读（CORS 不再拦）。
- 自签名 HTTPS 证书只对私网地址（localhost / 私网 IP 段 / `*.local`）放行；
  公网 FN Connect 中继有正规证书，保留证书校验。
- 歌曲对象只保存 `coverId`，显示时生成协议封面地址：重启、历史队列、账户快照里的歌封面依然有效。

## 歌曲对象字段（网页端映射器确认）

```
guid          歌曲 id（接口参数统一用 trackGUID=guid；track/stream 用 guid）
title         标题
artists       [{ guid, name }]
album         { guid, name, coverId, artists, ... }
duration      毫秒
coverId       封面 id（→ /music/api/v1/static/cover?coverId=）
trackNo / discNo
audioSpec     { path, format, bitDepth, bitrate(bps), channel, codec, sampleRate, size }
isFavorite / isCue
createdAt / updatedAt     Unix 秒
```

专辑：`{ guid, name, artists, coverId, trackCount, originalReleaseYear|originalReleaseDate }`；
歌手：`{ guid, name, coverId, albumCount, trackCount }`。

## 已验证/未验证清单

- [x] 基础路径 `/music/api/v1`（含 `/v1`）
- [x] 信封 `{code,msg,data}`，成功码 0/200
- [x] 登录接口路径、参数（username/sha256 密码/deviceId）、响应 `{userToken,user}`
- [x] 搜索参数 `q/page/size`、响应 `{total,list}`
- [x] 歌词参数 `trackGUID`、响应 `{list,preferred}`
- [x] 歌曲字段映射（网页端映射器）
- [x] 播放流 `/track/stream` 参数为 `guid`（网页端请求实据）
- [x] 封面路径 `/music/api/v1/static/cover?coverId=&size=`（实机验证：封面可显示）
- [x] 无需 authx 签名即可登录/播放（2026-10-28 服务端实测）
- [ ] 歌词单项字段名（lyric/lyrics/content？）——代码已做多候选兜底
- [ ] `/track/stream` 的响应结构（source.url? playUrl?）——代码已做多候选兜底
- [ ] `userToken` 是否可作为其他头传递（当前用 Cookie，主进程桥可写）

## 实机验证命令（更新版）

在 Windows PowerShell（纯 ASCII 注意编码）或任意终端，对 `http://192.168.x.x:5666` 运行：

```bash
# 1. 登录（密码先做 sha256；登录/播放流无需 authx 签名）
curl -s -X POST "http://192.168.x.x:5666/music/api/v1/user/password-login" \
  -H "Content-Type: application/json" \
  -d '{"username":"你的账号","password":"<sha256hex>","deviceId":"<32hex>"}'
# 2. 带 Cookie 搜索
curl -s "http://192.168.x.x:5666/music/api/v1/search/track?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=1&size=5" \
  -H "Cookie: music-token=<userToken>"
# 3. 歌词
curl -s "http://192.168.x.x:5666/music/api/v1/lyric/list?trackGUID=<guid>" -H "Cookie: music-token=<userToken>"
# 4. 封面
curl -s -o cover.jpg "http://192.168.x.x:5666/music/api/v1/static/cover?coverId=<coverId>&size=600" -H "Cookie: music-token=<userToken>"
# 5. 播放源（guid 参数）
curl -s "http://192.168.x.x:5666/music/api/v1/track/stream?guid=<guid>" -H "Cookie: music-token=<userToken>"
```

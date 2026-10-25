# 飞牛音乐服务器协议

> 状态：**接口路径、请求签名、登录流程、核心字段依据飞牛音乐服务端接口约定整理**。
> 说明：接口以飞牛音乐服务实际响应为准。
> 少量字段（歌词项、播放源响应、track/stream 参数）为合理推断，代码中以「待实机确认」标注。

## 基础信息

- 服务：飞牛音乐服务器（fnOS NAS 上的飞牛音乐 Web 服务，`/music` 路径）。
- **API 基础路径：`{origin}/music/api/v1/`**（v2 通道为 `/music/api/v2`；国际版 `/music/api/intl/v1`）。
  - 之前误用 `/music/api/`（缺 `/v1`），服务器对未注册路径回退 SPA index.html。
- 端口：跟随 fnOS Web 端口（HTTP 5666 / HTTPS 5667）。
- 响应信封：`{ code, msg, data }`；`code ∈ {0, 200}` 为成功，其余为业务错误（`msg` 为错误信息）。

## 请求签名 authx（每个请求必带）

飞牛音乐前端对所有 API 请求附加 `authx` 头，服务端校验签名（防重放：nonce + timestamp）。

```
authx: nonce={6位随机数100000-999999}&timestamp={Date.now()毫秒}&sign={md5}

sign = md5("NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
          + "_" + pathname            // 完整路径，如 /music/api/v1/user/password-login
          + "_" + nonce
          + "_" + timestamp
          + "_" + bodyHash
          + "_" + apiKey)

apiKey = "6D5602D4-A342-4799-A0F0-BB795E7167D0"   // bundle 内 XOR(185) 混淆，已还原
bodyHash(GET)  = md5(decodeURIComponent(排序后的 key=value&串))   // 按键名排序，值用原始字符串
bodyHash(POST) = md5(JSON.stringify(body))                        // 键顺序与请求体一致
```

实现：主进程桥 `electron/fnmusic/fnmusicApiBridge.cjs`（Node crypto，含完整签名）。

## 认证（登录 + 会话）

- 登录：`POST /music/api/v1/user/password-login`
  - 请求体：`{ "username": 账号, "password": sha256(明文密码), "deviceId": 32位hex }`
  - deviceId：网页端为随机 32 位小写 hex（uuid 去横线或随机 hex），持久化复用。
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
| 播放源 | `/music/api/v1/track/stream` | GET | `trackGUID` | 播放源（url 可能为 `hls://{fileId}?quality=`） |
| 转码 | `/music/api/v1/track/transcode` | POST | - | - |
| 歌词 | `/music/api/v1/lyric/list` | GET | `trackGUID` | `{ list, preferred }` |
| 专辑列表/详情 | `/music/api/v1/album/list` `/album/detail` | GET | 分页 / id | `{ total, list }` / 专辑 |
| 歌手列表/详情 | `/music/api/v1/artist/list` `/artist/detail` | GET | - | - |
| 歌单列表/详情 | `/music/api/v1/playlist/list` `/playlist/detail` | GET | - | - |
| 收藏 | `/music/api/v1/favorite-track/create` `/delete` `/list` | POST/GET | `trackGUID` | - |
| 播放历史 | `/music/api/v1/play-history/list` | GET | - | - |
| 封面 | `{origin}/static/cover?coverId={id}` | GET | 可加 `size` | 图片 |

播放流补充接口（位于根路径，**不签名**）：
- `GET {origin}/api/stream/unified?fileId={fileId}&quality={original|...}` → `{ playlistUrl, profile:{channels} }`（m3u8 播放列表）
- `GET {origin}/api/stream/hls?fileId=&bitrate=&format=aac` → `{ playlistUrl }`
- `GET {origin}/api/stream/info?fileId=|url=` → `{ duration }`

## 歌曲对象字段（网页端映射器确认）

```
guid          歌曲 id（接口参数统一用 trackGUID=guid）
title         标题
artists       [{ guid, name }]
album         { guid, name, coverId, artists, ... }
duration      毫秒
coverId       封面 id（→ /static/cover?coverId=）
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
- [x] authx 签名算法与常量（secret/apiKey/排序/JSON 序列化）
- [x] 登录接口路径、参数（username/sha256 密码/deviceId）、响应 `{userToken,user}`
- [x] 搜索参数 `q/page/size`、响应 `{total,list}`
- [x] 歌词参数 `trackGUID`、响应 `{list,preferred}`
- [x] 歌曲字段映射（Sj 映射器）
- [ ] 歌词单项字段名（lyric/lyrics/content？）——代码已做多候选兜底
- [ ] `/track/stream` 的响应结构（source.url? playUrl?）——代码已做多候选兜底
- [ ] `userToken` 是否可作为其他头传递（当前用 Cookie，主进程桥可写）

## 实机验证命令（更新版）

在 Windows PowerShell（纯 ASCII 注意编码）或任意终端，对 `http://192.168.x.x:5666` 运行：

```bash
# 1. 登录（密码先做 sha256）
curl -s -X POST "http://192.168.x.x:5666/music/api/v1/user/password-login" \
  -H "Content-Type: application/json" \
  -H "authx: nonce=123456&timestamp=$(date +%s%3N)&sign=__计算见文档__" \
  -d '{"username":"你的账号","password":"<sha256hex>","deviceId":"<32hex>"}'
# 2. 带 Cookie 搜索
curl -s "http://192.168.x.x:5666/music/api/v1/search/track?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=1&size=5" \
  -H "Cookie: music-token=<userToken>"
# 3. 歌词
curl -s "http://192.168.x.x:5666/music/api/v1/lyric/list?trackGUID=<guid>" -H "Cookie: music-token=<userToken>"
```

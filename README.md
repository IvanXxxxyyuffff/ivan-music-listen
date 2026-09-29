# Ivan Music 收听页（分享落地页）

别人点开分享链接就能听歌的那一页。纯静态、零依赖、零构建：把本目录三个文件
（`index.html` / `app.js` / `style.css`）原样放到公开仓 **`ivan-music-listen`** 的**根目录**，
在该仓 Settings → Pages 里把 Source 设为 `main` / `(root)` 即可，Pages 根就是本目录，
不需要任何构建步骤或环境变量。发布后的地址是
`https://ivanxxxxyyuffff.github.io/ivan-music-listen/`。

链接格式（App 侧 `shareUrlOf()` 生成）：

```
https://ivanxxxxyyuffff.github.io/ivan-music-listen/?t=<source>|<id>
```

- `<source>` 是 App 内部音源代号：`wy` / `tx` / `kg` / `kw` / `mg`；
- `<id>` 是**平台自己的歌曲 id**（网易云数字 id、QQ 的 songmid、酷狗的 hash…）；
- `|` 会被 URL 编码成 `%7C`（裸竖线会被部分 IM 的链接嗅探截断）。
- 链接里**只有稳定标识**，不含流地址、不含配额参数 —— 流地址会过期，贴出去第二天就是死链。

可选增强参数（App 目前不发，页面支持，将来加字段不用改这一页）：
`&n=<歌名>` `&a=<歌手>` `&c=<封面地址>`。

## 取流规则（与 App 同一套）

1. `wy`：先问主源 `music-api.gdstudio.xyz/api.php?types=url&source=netease&br=320`，
   拿不到再退 `br=128`；然后依次问 meting 节点（`?server=netease&type=url&id=`）。
2. `tx`：依次问 meting 节点（`?server=tencent&type=url&id=<songmid>`），顺序 m3 → m1 → m2。
3. `kg` / `kw` / `mg`：**没有可用取流端**（见下），页面直接给中文错误态。

## 实测结论（2026-09-29，本机直连）

| 端点 | 结果 | CORS |
|---|---|---|
| `meting.mikus.ink/api`（m1） | **522 Origin Connection Time-out**（源站挂了，重试 3 次都一样） | — |
| `api.injahow.cn/meting/`（m2） | 302 → 音源 CDN，正常 | 302 带 `Access-Control-Allow-Origin: *` |
| `api.moeyao.cn/meting/`（m3） | 302 → 音源 CDN，正常 | 302 带 `Access-Control-Allow-Origin: *` |
| `music-api.gdstudio.xyz/api.php` | JSON 正常（`types=url` / `pic` / `lyric`） | `access-control-allow-origin: *` |
| 音源 CDN（m70x.music.126.net） | 206 Partial Content，`Accept-Ranges: bytes` | **无 ACAO** |

两条由此定下来的实现约束：

- **取流不能走 `fetch`。** 节点的 302 本身有 CORS 头，但跟到最后的 CDN 响应**没有** →
  `fetch` 会在最终响应上被判 CORS 失败。所以节点地址是**直接当 `<audio src>`** 用的，
  媒体元素不走 CORS 检查，浏览器自己跟 302。同理，`HEAD`/`Range` 量 Content-Length 这条路
  在浏览器里也走不通 —— 「哪条候选能用」只能靠 `loadedmetadata` / `error` / 超时来判。
- **`type=cover` 只有 m3 认「歌曲 id」。** `?server=netease&type=cover&id=<歌曲id>` 实测
  302 → 200 `image/jpg`（90×90）；m2 的 `type=pic&id=<歌曲id>` 是 **404**（它要的是封面 id，
  分享链接里没有）。

## 已知限制

- **m1 现在是死的**（522）。它留在节点表里、排在最前，失败得很快（~1s），随时可能回来。
- **GD 的 `api.php` 只认 `source=netease`**：`kuwo` / `kugou` / `tencent` 一律回
  `{"detail":"Value of \`source\` is not supported."}`（比 `topics/music-api.md` 记的更窄）。
- **`kg` / `kw` / `mg` 的分享链接在网页上播不了。** 这些源在网页端没有取流端，
  而「跨源兜底重搜网易云」需要**歌名**，分享链接里只有 `source|id`。
  要打通得让 App 把 `&n=<歌名>&a=<歌手>` 一起带上（页面已支持，不用改这一页）。
- **tencent 在 https 页面上只有 m3 这条路能用**：m2 回的是 `http://aqqmusic.tc.qq.com/...`，
  会被混合内容拦掉（代码里因此把 m3 排在 tencent 的第一位）。
- **自动播放可能被浏览器拦下**：页面会先取流、后 `play()`；被拦时流已经就绪，
  界面上给一句「点一下播放键」，点一次即可。
- **残流（会员曲静默降级）只能近似拦**：GD 的 JSON 同时给了 `br` 和 `size`，
  就用「实际时长 vs 声明字节数换算出的时长」互校（低于 60% 判残流、换下一条）；
  拿不到声明的节点退回「短于 20 秒判残流」。浏览器里拿不到真实字节数，
  做不到 App 那种 `Range: bytes=0-0` 的精确尺子。
- **播到一半断流会换线续播**（回到原位置继续），不是跳过这首歌 —— 与 App 的第二道防线一致。
- **封面是 90×90**（m3 代理口固定尺寸，尺寸参数被忽略），放大显示会糊；没有封面时显示音乐砖。

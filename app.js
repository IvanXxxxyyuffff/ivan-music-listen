/* Ivan Music 收听页。
 *
 * 输入：`?t=<source>|<id>`（App 侧 shareUrlOf() 生成，`|` 编码成 %7C）。
 * 输出：能出声的 <audio>。
 *
 * 三条设计约束（都是实测逼出来的，别随手改）：
 *
 * 1) **取流不能靠 fetch。** 节点回的是 302，跳转目标是音源 CDN，而 CDN 响应里
 *    没有 Access-Control-Allow-Origin（实测 m2/m3 的 302 本身有 ACAO:*，
 *    但跟到最后的 mp3 没有）→ fetch 会在最终响应上被判 CORS 失败。
 *    所以：节点地址**直接当 <audio src>** 用 —— 媒体元素不走 CORS 检查，
 *    浏览器自己跟 302。GD 那条路是 JSON 接口（ACAO:*），才用 fetch。
 *
 * 2) **能不能播只能问 <audio>。** 同理，别指望用 HEAD/Range 去量 Content-Length
 *    （量不到）。判定 = loadedmetadata / error / 超时。
 *
 * 3) **残流要拦。** 公共取流端对会员曲会静默降级成一小段。浏览器里拿不到
 *    字节数，就用「声明字节数 ↔ 实际时长」互校（GD 的 JSON 同时给了 br 和 size），
 *    拿不到声明时退回「短于 20 秒当残流」。
 */
(function () {
  'use strict';

  var GD_BASE = 'https://music-api.gdstudio.xyz/api.php';

  /* 节点表唯一真源是 App 的 data/remote/MetingNodes.kt（pool），顺序 = 尝试顺序。
   * ⚠️ 实测 2026-09-29：m1（meting.mikus.ink）持续 522「源站连接超时」，
   *    留在表里是因为它随时可能回来；它失败得很快（~1s），不拖慢整体。 */
  var METING_NODES = [
    { id: 'm1', base: 'https://meting.mikus.ink/api' },
    { id: 'm2', base: 'https://api.injahow.cn/meting/' },
    { id: 'm3', base: 'https://api.moeyao.cn/meting/' }
  ];

  /* 封面：只有 m3 的 type=cover 认「歌曲 id」。
   * m1/m2 的 type=pic 要的是**封面 id**，拿歌曲 id 去问是 404（实测）。 */
  var COVER_NODE = METING_NODES[2];

  /* App 内部代号 → 后端代号。直接拿 wy 打后端会全 400。 */
  var SOURCE_MAP = { wy: 'netease', tx: 'tencent', kg: 'kugou', kw: 'kuwo', mg: 'migu' };
  var SOURCE_LABEL = {
    netease: '网易云音乐', tencent: 'QQ 音乐', kugou: '酷狗音乐',
    kuwo: '酷我音乐', migu: '咪咕音乐'
  };

  var META_TIMEOUT_MS = 9000;   // 单个候选：从设 src 到 loadedmetadata 的上限
  var JSON_TIMEOUT_MS = 8000;   // GD JSON 接口上限
  var STALL_GRACE_MS = 6000;    // 播到一半断流：等这么久还没数据就换线续播
  var SHORT_SECONDS = 20;       // 无声明时的残流下限
  var SIZE_RATIO = 0.6;         // 有声明时：实际时长 < 声明时长×0.6 判残流

  var el = {
    audio: document.getElementById('audio'),
    play: document.getElementById('play'),
    bar: document.getElementById('bar'),
    progress: document.getElementById('progress'),
    cur: document.getElementById('cur'),
    dur: document.getElementById('dur'),
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    chip: document.getElementById('chip'),
    cover: document.getElementById('cover'),
    tile: document.getElementById('tile'),
    status: document.getElementById('status'),
    hint: document.getElementById('hint'),
    glow: document.getElementById('glow')
  };

  var state = {
    source: '',        // 后端代号
    id: '',
    cands: [],         // 候选取流方式
    idx: -1,
    gen: 0,            // 代次：换候选后旧回调一律作废
    ready: false,      // 已经拿到可用流
    resumeAt: 0,       // 换线续播要回到的位置
    stallTimer: 0,
    seeking: false
  };

  // ---------------- 链接解析 ----------------

  function parseTrack() {
    var q = new URLSearchParams(location.search);
    var raw = (q.get('t') || '').trim();
    if (!raw) return null;
    // 兼容 `source|id` 与误写的 `source:id`
    var m = raw.split('|');
    if (m.length < 2) m = raw.split(':');
    if (m.length < 2) return null;
    var src = (m[0] || '').trim().toLowerCase();
    var id = m.slice(1).join('|').trim();
    if (!id) return null;
    var backend = SOURCE_MAP[src] || src;
    return {
      source: backend,
      id: id,
      // 可选增强参数：App 目前不发，页面支持，将来加字段不用改这一页
      name: (q.get('n') || '').trim(),
      artist: (q.get('a') || '').trim(),
      cover: (q.get('c') || '').trim()
    };
  }

  // ---------------- 候选取流方式 ----------------

  function metingCandidate(node, server, id) {
    var url = node.base + '?server=' + server + '&type=url&id=' + encodeURIComponent(id);
    return {
      label: node.id + ' · ' + (SOURCE_LABEL[server] || server),
      // 节点自己 302 到 CDN，交给 <audio> 跟跳转
      resolve: function () { return Promise.resolve({ url: url }); }
    };
  }

  function gdCandidate(id, br) {
    var url = GD_BASE + '?types=url&source=netease&id=' + encodeURIComponent(id) + '&br=' + br;
    return {
      label: 'gd · ' + br + 'k',
      resolve: function () {
        return fetchJson(url, JSON_TIMEOUT_MS).then(function (o) {
          var u = o && typeof o.url === 'string' ? o.url : '';
          if (!u) throw new Error('gd empty');
          return { url: u, br: typeof o.br === 'number' ? o.br : br, size: o.size || 0 };
        });
      }
    };
  }

  function candidatesFor(source, id) {
    var list = [];
    /* GD 的 api.php 只认 source=netease —— 实测 kuwo/kugou/tencent 都回
     * {"detail":"Value of `source` is not supported."}（比文档记的更窄）。 */
    if (source === 'netease') {
      list.push(gdCandidate(id, 320));   // 主源精确档位：真·完整文件
      list.push(gdCandidate(id, 128));
    }
    /* meting：netease 全节点可用；tencent 走 songmid。
     * ⚠️ tencent 的节点顺序**不是**表里的顺序：实测 m2 对 tencent 回的是
     *    **http** 的 aqqmusic 地址（`http://aqqmusic.tc.qq.com/...`），在 https
     *    页面会被混合内容拦掉；m3 回的是 https，实测 206 + Content-Range 正常
     *    （3,017,443 字节）。所以 tencent 先问 m3，省掉一次注定失败的跳转。 */
    var order = source === 'tencent'
      ? [METING_NODES[2], METING_NODES[0], METING_NODES[1]]
      : METING_NODES;
    if (source === 'netease' || source === 'tencent') {
      for (var i = 0; i < order.length; i++) {
        list.push(metingCandidate(order[i], source, id));
      }
    }
    return list;
  }

  function fetchJson(url, timeoutMs) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    return fetch(url, { signal: ctl ? ctl.signal : undefined, mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { clearTimeout(timer); return j; })
      .catch(function () { clearTimeout(timer); return null; });
  }

  // ---------------- 取流 → 试播 ----------------

  /* 设 src 并等 loadedmetadata。这一步不需要用户手势（只是加载元数据），
   * 所以自动播放被拦也不会影响「哪条候选能用」的判定。 */
  function loadMeta(url) {
    return new Promise(function (resolve) {
      var a = el.audio;
      var done = false;
      var timer = 0;
      function finish(ok, reason) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.removeEventListener('loadedmetadata', onMeta);
        a.removeEventListener('error', onErr);
        resolve({ ok: ok, reason: reason || '', duration: ok ? a.duration : 0 });
      }
      function onMeta() { finish(true); }
      function onErr() { finish(false, 'error'); }
      // 先清掉上一条候选、再挂监听 —— 反过来的话，上一条的 error 会被算到这一条头上
      try {
        a.removeAttribute('src');
        a.load();
      } catch (e) { /* 忽略：下面紧接着就赋新值 */ }
      a.src = url;
      a.load();
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('error', onErr);
      timer = setTimeout(function () { finish(false, 'timeout'); }, META_TIMEOUT_MS);
    });
  }

  /* 残流判定：有声明（GD 给了 br + size）→ 实际时长不许明显短于声明时长；
   * 没声明 → 只拦「短得不像一首歌」的。 */
  function isSuspect(hit, duration) {
    if (!duration || !isFinite(duration)) return false;   // 有些流拿不到 duration，不因此拉黑
    if (hit && hit.size > 0 && hit.br > 0) {
      var declared = hit.size * 8 / (hit.br * 1000);
      if (declared > 5 && duration < declared * SIZE_RATIO) return true;
    }
    return duration < SHORT_SECONDS;
  }

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle('is-error', !!isError);
  }

  function setPlayState(s) { el.play.dataset.state = s; }

  function attempt(i) {
    var gen = ++state.gen;
    state.idx = i;
    if (i >= state.cands.length) return giveUp();
    var cand = state.cands[i];
    setStatus('正在取流（' + cand.label + '）…');
    setPlayState('loading');

    return cand.resolve().then(function (hit) {
      if (gen !== state.gen) return;
      if (!hit || !hit.url) throw new Error('empty');
      return loadMeta(hit.url).then(function (meta) {
        if (gen !== state.gen) return;
        if (!meta.ok || isSuspect(hit, meta.duration)) throw new Error('bad');
        state.ready = true;
        state.active = hit;
        renderDuration(meta.duration);
        setStatus('已连接 · ' + cand.label);
        startPlayback();
      });
    }).catch(function () {
      if (gen !== state.gen) return;
      attempt(i + 1);
    });
  }

  function startPlayback() {
    var p = el.audio.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        el.hint.textContent = '';
      }).catch(function () {
        // 自动播放被浏览器拦下：流是好的，点一下就行
        setPlayState('paused');
        el.hint.textContent = '浏览器拦了自动播放，点一下播放键';
      });
    }
  }

  function giveUp() {
    state.ready = false;
    setPlayState('paused');
    el.play.disabled = true;
    setStatus('链接失效 / 暂时取不到这首歌', true);
    el.hint.textContent = '可以回 App 里重发一次分享链接。';
  }

  // ---------------- 播放中：换线续播 ----------------

  function armStallWatch() {
    clearTimeout(state.stallTimer);
    if (!state.ready || el.audio.paused) return;
    state.stallTimer = setTimeout(function () {
      if (state.ready && !el.audio.paused && el.audio.readyState < 3) {
        resumeWithNext();
      }
    }, STALL_GRACE_MS);
  }

  /* 播到一半断流/翻车：**换线续播**，不是跳过这首歌（文档里的第二道防线）。 */
  function resumeWithNext() {
    if (!state.ready) return;
    if (state.idx + 1 >= state.cands.length) return;   // 没有下一条，保持现状
    state.resumeAt = el.audio.currentTime || 0;
    state.ready = false;
    clearTimeout(state.stallTimer);
    attempt(state.idx + 1);
  }

  // ---------------- 界面 ----------------

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    var s = Math.floor(sec % 60);
    var m = Math.floor(sec / 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function renderDuration(d) {
    el.dur.textContent = fmt(d);
  }

  function renderProgress() {
    var a = el.audio;
    var d = a.duration;
    if (!isFinite(d) || d <= 0) return;
    var pct = Math.min(100, (a.currentTime / d) * 100);
    el.bar.style.width = pct + '%';
    el.cur.textContent = fmt(a.currentTime);
    el.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  function renderCover(url) {
    if (!url) return;
    el.cover.onload = function () {
      el.cover.hidden = false;
      el.tile.style.display = 'none';
      sampleAccent(url);
    };
    el.cover.onerror = function () { el.cover.hidden = true; };
    el.cover.src = url;
  }

  /* 从封面取两个色当光晕。跨域图片读像素会被 canvas 污染 —— 所以整段 try 住，
   * 读不到就保留默认色（封面本身照样显示）。 */
  function sampleAccent(url) {
    try {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = c.height = 12;
          var g = c.getContext('2d');
          g.drawImage(img, 0, 0, 12, 12);
          var d = g.getImageData(0, 0, 12, 12).data;
          var r = 0, gg = 0, b = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
          }
          r = Math.round(r / n); gg = Math.round(gg / n); b = Math.round(b / n);
          el.glow.style.setProperty('--glow-a', 'rgba(' + r + ',' + gg + ',' + b + ',0.42)');
          el.glow.style.setProperty('--glow-b', 'rgba(' + gg + ',' + b + ',' + r + ',0.26)');
        } catch (e) { /* 跨域受限，用默认色 */ }
      };
      img.src = url;
    } catch (e) { /* 同上 */ }
  }

  // ---------------- 事件 ----------------

  function wire() {
    el.play.addEventListener('click', function () {
      if (!state.ready) return;
      if (el.audio.paused) {
        el.audio.play().then(function () { el.hint.textContent = ''; }).catch(function () {});
      } else {
        el.audio.pause();
      }
    });

    el.audio.addEventListener('play', function () { setPlayState('playing'); armStallWatch(); });
    el.audio.addEventListener('pause', function () { setPlayState('paused'); clearTimeout(state.stallTimer); });
    el.audio.addEventListener('timeupdate', renderProgress);
    el.audio.addEventListener('waiting', armStallWatch);
    el.audio.addEventListener('playing', function () {
      clearTimeout(state.stallTimer);
      if (state.resumeAt > 0) {
        try { el.audio.currentTime = state.resumeAt; } catch (e) { /* 忽略 */ }
        state.resumeAt = 0;
      }
    });
    el.audio.addEventListener('ended', function () {
      setPlayState('paused');
      el.bar.style.width = '0%';
      el.cur.textContent = '0:00';
    });
    // 播到一半的硬失败：换线续播
    el.audio.addEventListener('error', function () {
      if (state.ready) resumeWithNext();
    });

    // 拖动进度
    function seekTo(clientX) {
      var box = el.progress.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      var d = el.audio.duration;
      if (isFinite(d) && d > 0) {
        el.audio.currentTime = ratio * d;
        renderProgress();
      }
    }
    el.progress.addEventListener('pointerdown', function (e) {
      state.seeking = true;
      el.progress.setPointerCapture && el.progress.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });
    el.progress.addEventListener('pointermove', function (e) { if (state.seeking) seekTo(e.clientX); });
    el.progress.addEventListener('pointerup', function () { state.seeking = false; });
    el.progress.addEventListener('pointercancel', function () { state.seeking = false; });
    el.progress.addEventListener('keydown', function (e) {
      var d = el.audio.duration;
      if (!isFinite(d) || d <= 0) return;
      if (e.key === 'ArrowRight') { el.audio.currentTime = Math.min(d, el.audio.currentTime + 5); renderProgress(); }
      if (e.key === 'ArrowLeft') { el.audio.currentTime = Math.max(0, el.audio.currentTime - 5); renderProgress(); }
    });
  }

  // ---------------- 启动 ----------------

  function boot() {
    wire();
    var t = parseTrack();
    if (!t) {
      el.play.disabled = true;
      el.title.textContent = '链接不完整';
      el.artist.textContent = '缺少歌曲标识';
      setStatus('链接格式应为 ?t=<源>|<歌曲 id>', true);
      return;
    }

    state.source = t.source;
    state.id = t.id;

    el.title.textContent = t.name || '分享的歌曲';
    el.artist.textContent = t.artist || (SOURCE_LABEL[t.source] || t.source) + ' · ' + t.id;
    el.chip.textContent = SOURCE_LABEL[t.source] || t.source;
    el.chip.hidden = false;
    document.title = (t.name ? t.name + ' · ' : '') + 'Ivan Music';

    // 封面：m3 的 type=cover 认歌曲 id；拿不到就退回音乐砖
    var cover = t.cover || (COVER_NODE.base + '?server=' + encodeURIComponent(t.source) +
      '&type=cover&id=' + encodeURIComponent(t.id));
    renderCover(cover);

    state.cands = candidatesFor(t.source, t.id);
    if (!state.cands.length) {
      el.play.disabled = true;
      setStatus('这个音源的分享链接暂时没法在网页上播放', true);
      el.hint.textContent = '在 App 里换一首（或换网易云/QQ 音源的曲目）再分享。';
      return;
    }
    attempt(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

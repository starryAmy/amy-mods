// tw-ticker: 在 Claude 工作時，於輸入框上方顯示台股自選股報價，以及 PTT Stock 版盤中閒聊的彈幕
// 報價來源：證交所「基本市況報導」網站（非正式 API，僅供個人使用）
// 彈幕來源：PTT 網頁版 Stock 版當日「盤中閒聊」推文，收盤後改用「盤後閒聊」（只顯示內容，不顯示帳號）

import { parsePushes, findDailyThread, findPrevPage, strWidth, clipWidth, renderLane, stepLanes } from './danmaku.js'

const BASE = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
const PTT_INDEX = 'https://www.ptt.cc/bbs/Stock/index.html'
const PTT_INIT = { headers: { Cookie: 'over18=1' } }
const INDEX_CH = 'tse_t00.tw' // 發行量加權股價指數，固定顯示在最前面
const DEFAULT_LIST = ['2330', '0050']
const POLL_MS = 60_000 // 報價：每分鐘最多一次
const DM_POLL_MS = 90_000 // 彈幕：每 90 秒最多抓一次推文
const DM_RECHECK_MS = 10 * 60_000 // 每 10 分鐘重新確認一次今天的閒聊串（可能開了續集）
const FRAME_MS = 300 // 彈幕每 0.3 秒移動一格
const LANES = 2
const GAP = 6 // 同一軌道兩則彈幕之間至少空幾格
const MAX_ITEM_W = 60 // 單則彈幕最長幾格（PTT 推文最長約 48 格，所以一般不會截）
const MAX_QUEUE = 80
const FIRST_BATCH = 15 // 剛開啟時先放最近幾則
const POOL_SIZE = 50 // 沒有新推文時，從最近幾則輪播
const TW_OFFSET_MS = 8 * 3600 * 1000 // 台灣時間 UTC+8

// ---------- 狀態 ----------
let watchlist = [...DEFAULT_LIST]
let pinned = false
let working = false
let marketOpen = false
let quotes = []
let index = null // 加權指數，格式同 quotes
let lastFetch = 0
let lastError = ''
let fetching = false

let danmakuOn = false
let laneWidth = 0 // 寬度上限；0 = 用滿整個 band 寬度
let bandColumns = 0 // 上次畫 band 時的可用寬度，0 = 還不知道
let blocklist = []
let lanes = Array.from({ length: LANES }, () => [])
let queue = [] // 新推文，優先播
let pool = [] // 最近 POOL_SIZE 則，queue 空了就從這裡輪播
let poolIdx = 0
let dmFetching = false
let dmLastFetch = 0
let dmStatus = ''
let threadUrl = ''
let threadKey = '' // 日期 + 盤中/盤後，例如 "2026/10/07 盤後閒聊"
let threadCheckedAt = 0
let seen = -1 // 已經看過幾則推文；-1 代表這串還沒讀過

// ---------- 小工具 ----------

function num(s) {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

function fmt(n) {
  return n == null ? '-' : String(Number(n.toFixed(2)))
}

function twParts(ms) {
  const d = new Date(ms + TW_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    mo: String(d.getUTCMonth() + 1).padStart(2, '0'),
    da: String(d.getUTCDate()).padStart(2, '0'),
    hh: String(d.getUTCHours()).padStart(2, '0'),
    mm: String(d.getUTCMinutes()).padStart(2, '0'),
    day: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

function twTime(ms) {
  const p = twParts(ms)
  return p.hh + ':' + p.mm
}

function twDate(ms) {
  const p = twParts(ms)
  return p.y + '/' + p.mo + '/' + p.da
}

// 台股交易時間：週一到週五 09:00–13:30（台灣時間），未處理國定假日
function isMarketOpen(ms) {
  const p = twParts(ms)
  return p.day >= 1 && p.day <= 5 && p.minutes >= 9 * 60 && p.minutes <= 13 * 60 + 30
}

function toQuote(r) {
  const prev = num(r.y)
  const last = num(r.z) ?? num((r.b || '').split('_')[0]) ?? prev
  const change = last != null && prev ? last - prev : 0
  const pct = prev ? (change / prev) * 100 : 0
  return { code: r.c, name: r.n, last, change, pct }
}

// 推文 → 彈幕。推=紅、噓=綠、→=預設色；提到自選股的推文用黃色粗體標亮
function toItems(pushes) {
  const keys = [...watchlist, ...quotes.map((q) => q.name)].filter(Boolean)
  const items = []
  for (const p of pushes) {
    if (blocklist.some((w) => p.text.includes(w))) continue
    if (/^https?:\/\/\S+$/.test(p.text)) continue // 只有網址的推文跳過
    const text = clipWidth(p.text, MAX_ITEM_W)
    const hot = keys.some((k) => p.text.includes(k))
    const item = { text, w: strWidth(text), bold: hot }
    if (hot) item.color = 'yellow'
    else if (p.kind === '推') item.color = 'red'
    else if (p.kind === '噓') item.color = 'green'
    items.push(item)
  }
  return items
}

function enqueue(pushes) {
  queue.push(...toItems(pushes))
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE) // 推文太多就只留最新的
}

function addToPool(pushes) {
  pool = [...pool, ...toItems(pushes)].slice(-POOL_SIZE)
}

// queue 空了就從 pool 補一則；一次只補一則，新推文進來時能馬上插播
function refillFromPool() {
  if (queue.length > 0 || pool.length === 0) return
  queue.push(pool[poolIdx % pool.length])
  poolIdx = (poolIdx + 1) % pool.length
}

function effectiveWidth() {
  if (bandColumns <= 0) return laneWidth || 80 // 還不知道 band 多寬時先用 80
  return laneWidth ? Math.min(laneWidth, bandColumns) : bandColumns
}

function resetLanes() {
  lanes = Array.from({ length: LANES }, () => [])
  queue = []
}

// ---------- 報價 ----------

async function refresh($) {
  if (fetching) return
  fetching = true
  try {
    const channels = [INDEX_CH, ...watchlist.flatMap((c) => ['tse_' + c + '.tw', 'otc_' + c + '.tw'])].join('|')
    const url = BASE + '?json=1&delay=0&ex_ch=' + encodeURIComponent(channels)
    const res = await $.http.fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = JSON.parse(res.text)
    const rows = Array.isArray(data.msgArray) ? data.msgArray : []
    quotes = watchlist
      .map((code) => rows.find((r) => r.c === code))
      .filter(Boolean)
      .map(toQuote)
    const indexRow = rows.find((r) => r.c === 't00')
    index = indexRow ? { ...toQuote(indexRow), name: '加權' } : null
    lastError = ''
    lastFetch = await $.clock.now()
  } catch (err) {
    lastError = String((err && err.message) || err)
  } finally {
    fetching = false
    $.ui.invalidate('ui.render')
  }
}

async function tick($, force) {
  const now = await $.clock.now()
  marketOpen = isMarketOpen(now)
  if (!force && !(working || pinned)) return
  if (!force && !marketOpen && (index || quotes.length > 0)) return
  if (!force && now - lastFetch < POLL_MS - 5_000) return
  await refresh($)
}

// ---------- 彈幕 ----------

async function findThread($, today, keyword) {
  let url = PTT_INDEX
  for (let i = 0; i < 2 && url; i++) {
    const res = await $.http.fetch(url, PTT_INIT)
    if (!res.ok) throw new Error('PTT HTTP ' + res.status)
    const hit = findDailyThread(res.text, today, keyword)
    if (hit) return hit
    url = findPrevPage(res.text)
  }
  return null
}

// 現在該看哪一串：盤中 → 盤中閒聊；平日收盤後 → 盤後閒聊；其他時間（開盤前、週末）不抓
function chatKind(ms) {
  if (isMarketOpen(ms)) return '盤中閒聊'
  const p = twParts(ms)
  if (p.day >= 1 && p.day <= 5 && p.minutes > 13 * 60 + 30) return '盤後閒聊'
  return null
}

async function danmakuTick($, force) {
  if (!danmakuOn || dmFetching) return
  const now = await $.clock.now()
  if (!force && !(working || pinned)) return
  const kind = chatKind(now) || (force ? '盤中閒聊' : null)
  if (!kind) return
  if (!force && now - dmLastFetch < DM_POLL_MS - 5_000) return
  dmFetching = true
  dmLastFetch = now
  try {
    const key = twDate(now) + ' ' + kind
    if (threadKey !== key) {
      // 換日或盤中 → 盤後：清掉上一串的彈幕，不再輪播舊推文
      threadKey = key
      threadUrl = ''
      seen = -1
      pool = []
      queue = []
    }
    if (!threadUrl || now - threadCheckedAt > DM_RECHECK_MS) {
      const found = await findThread($, twDate(now), kind)
      threadCheckedAt = now
      if (!found) {
        if (!threadUrl) {
          // 盤後閒聊還沒開串就空白；盤中閒聊還沒開串才提示
          dmStatus = kind === '盤中閒聊' ? '今天的盤中閒聊還沒出現' : ''
          return
        }
      } else if (found.url !== threadUrl) {
        threadUrl = found.url
        seen = -1
      }
    }
    const res = await $.http.fetch(threadUrl, PTT_INIT)
    if (!res.ok) throw new Error('PTT HTTP ' + res.status)
    const pushes = parsePushes(res.text)
    if (seen < 0 || pushes.length < seen) {
      pool = []
      addToPool(pushes.slice(-POOL_SIZE))
      enqueue(pushes.slice(-FIRST_BATCH))
    } else {
      enqueue(pushes.slice(seen))
      addToPool(pushes.slice(seen))
    }
    seen = pushes.length
    dmStatus = '' // 正常時不顯示則數，省空間；只有出錯或還沒開串時才顯示
  } catch (err) {
    dmStatus = '⚠ ' + String((err && err.message) || err)
  } finally {
    dmFetching = false
    $.ui.invalidate('ui.render')
  }
}

// ---------- 設定 ----------

async function saveSettings($) {
  await $.store.set('watchlist', watchlist)
  await $.store.set('pinned', pinned)
  await $.store.set('danmaku', danmakuOn)
  await $.store.set('laneMax', laneWidth)
  await $.store.set('blocklist', blocklist)
}

async function loadSettings($) {
  const savedList = await $.store.get('watchlist')
  if (Array.isArray(savedList)) watchlist = savedList
  const savedPinned = await $.store.get('pinned')
  if (typeof savedPinned === 'boolean') pinned = savedPinned
  const savedDm = await $.store.get('danmaku')
  if (typeof savedDm === 'boolean') danmakuOn = savedDm
  const savedWidth = await $.store.get('laneMax') // 舊的 laneWidth 預設存了 80，不沿用
  if (typeof savedWidth === 'number') laneWidth = savedWidth
  const savedBlock = await $.store.get('blocklist')
  if (Array.isArray(savedBlock)) blocklist = savedBlock
}

// ---------- 註冊 hooks ----------

export function register(on) {
  on('session.start', async ($, e, next) => {
    await loadSettings($)

    // 報價與推文的輪詢；tick 自己決定要不要真的發請求
    $.clock.every(30_000, async () => {
      await tick($, false)
      await danmakuTick($, false)
    })

    // 彈幕動畫：只有在顯示中才移動與重畫
    $.clock.every(FRAME_MS, () => {
      if (!danmakuOn || !(working || pinned)) return
      refillFromPool()
      if (stepLanes(lanes, queue, effectiveWidth(), GAP)) $.ui.invalidate('ui.render')
    })

    if (pinned) {
      tick($, true).catch(() => {})
      danmakuTick($, true).catch(() => {})
    }

    try {
      await $.command.register({
        name: 'twstock',
        description: '台股跑馬燈：add/remove 代號、pin 常駐、refresh 更新、danmaku 彈幕、block/unblock 過濾字詞',
        argumentHint: '[add|remove|pin|refresh|danmaku|block|unblock] ...',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('無法註冊 /twstock：' + String(err))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    working = true
    $.ui.invalidate('ui.render')
    tick($, false).catch(() => {})
    danmakuTick($, false).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    working = false
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'twstock' }, async ($, e) => {
    const [sub = '', ...rest] = (e.args || '').trim().split(/\s+/).filter(Boolean)
    const codes = rest.map((c) => c.toUpperCase()).filter((c) => /^[0-9A-Z]{4,6}$/.test(c))
    const action = sub.toLowerCase()

    if (action === 'add') {
      watchlist = [...new Set([...watchlist, ...codes])]
      await saveSettings($)
      tick($, true).catch(() => {})
      $.ui.toast('自選股：' + watchlist.join(', '))
    } else if (action === 'remove' || action === 'rm') {
      watchlist = watchlist.filter((c) => !codes.includes(c))
      quotes = quotes.filter((q) => watchlist.includes(q.code))
      await saveSettings($)
      $.ui.invalidate('ui.render')
      $.ui.toast('自選股：' + (watchlist.join(', ') || '（空）'))
    } else if (action === 'pin') {
      pinned = !pinned
      await saveSettings($)
      if (pinned) {
        tick($, true).catch(() => {})
        danmakuTick($, true).catch(() => {})
      }
      $.ui.invalidate('ui.render')
      $.ui.toast(pinned ? '跑馬燈：常駐顯示' : '跑馬燈：只在 Claude 工作時顯示')
    } else if (action === 'refresh') {
      tick($, true).catch(() => {})
      danmakuTick($, true).catch(() => {})
      $.ui.toast('正在更新…')
    } else if (action === 'danmaku' || action === 'dm') {
      const w = parseInt(rest[1], 10)
      const widthArg = (rest[0] || '').toLowerCase() === 'width'
      if (widthArg && (rest[1] || '').toLowerCase() === 'full') {
        laneWidth = 0
        await saveSettings($)
        $.ui.toast('彈幕寬度：用滿整個畫面')
      } else if (widthArg && w >= 30 && w <= 300) {
        laneWidth = w
        await saveSettings($)
        $.ui.toast('彈幕寬度上限：' + w + ' 格（不超過畫面寬度）')
      } else {
        danmakuOn = !danmakuOn
        if (!danmakuOn) resetLanes()
        await saveSettings($)
        if (danmakuOn) danmakuTick($, true).catch(() => {})
        $.ui.toast(danmakuOn ? '💬 彈幕：開啟' : '💬 彈幕：關閉')
      }
      $.ui.invalidate('ui.render')
    } else if (action === 'block') {
      blocklist = [...new Set([...blocklist, ...rest])]
      queue = queue.filter((it) => !blocklist.some((w) => it.text.includes(w)))
      pool = pool.filter((it) => !blocklist.some((w) => it.text.includes(w)))
      await saveSettings($)
      $.ui.toast('過濾字詞：' + blocklist.length + ' 個')
    } else if (action === 'unblock') {
      blocklist = blocklist.filter((w) => !rest.includes(w))
      await saveSettings($)
      $.ui.toast('過濾字詞：' + blocklist.length + ' 個')
    } else {
      $.ui.toast(
        '自選股：' + (watchlist.join(', ') || '（空）') +
          (pinned ? ' · 常駐' : ' · 工作時顯示') +
          (danmakuOn ? ' · 彈幕開' : ' · 彈幕關') +
          (lastFetch ? ' · ' + twTime(lastFetch) + ' 更新' : ''),
      )
    }
    // 只用 toast 回覆，不寫進對話，Claude 不會讀到
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(working || pinned)) return next(e)
    if (!index && quotes.length === 0 && !lastError && !danmakuOn) return next(e)

    // 彈幕一行若比 band 寬，引擎會把每一段都縮短並加「…」，所以寬度要跟著 band
    if (e.props.bodyColumns > 0) bandColumns = e.props.bodyColumns

    const { Box, Text } = $.ui.resolve(e)

    // 台股習慣：紅漲綠跌；指數不顯示代號
    const items = [...(index ? [{ ...index, code: '' }] : []), ...quotes].map((q) => {
      const arrow = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '─'
      const label = q.code ? q.code + ' ' + q.name : q.name
      const props = {
        children: [label + ' ' + fmt(q.last) + ' ' + arrow + Math.abs(q.pct).toFixed(2) + '%'],
      }
      if (q.change > 0) props.color = 'red'
      if (q.change < 0) props.color = 'green'
      return Text(props)
    })

    const status = lastError ? '⚠ ' + lastError : !lastFetch ? '' : marketOpen ? twTime(lastFetch) : '收盤'
    const tail = [status, danmakuOn && dmStatus ? '💬 ' + dmStatus : ''].filter(Boolean).join(' · ')

    const rows = [
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [Text({ bold: true, children: ['📈 台股'] }), ...items, Text({ dimColor: true, children: [tail || ' '] })],
      }),
    ]

    if (danmakuOn) {
      for (const lane of lanes) {
        const segs = renderLane(lane, effectiveWidth())
        const children = segs.length
          ? segs.map((seg) => {
              const props = { wrap: 'truncate', children: [seg.text] }
              if (seg.color) props.color = seg.color
              if (seg.bold) props.bold = true
              return Text(props)
            })
          : [Text({ children: [' '] })]
        rows.push(Box({ flexDirection: 'row', children }))
      }
    }

    // 保留其他 mod 畫在 band 上的內容
    const others = await next(e)
    return Box({ flexDirection: 'column', children: [...rows, others].filter(Boolean) })
  })
}

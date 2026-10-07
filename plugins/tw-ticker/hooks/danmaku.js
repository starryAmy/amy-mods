// danmaku.js：PTT 解析與彈幕軌道的純函式（這個檔案不呼叫任何 mods API）

const PTT_ORIGIN = 'https://www.ptt.cc'

// ---------- HTML 小工具 ----------

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, g) => {
    const k = g.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    if (k === 'nbsp') return ' '
    const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
  })
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '')
}

// ---------- PTT 解析 ----------

// 在看板列表頁找當天的閒聊串，ymd 例如 "2026/10/07"，keyword 為「盤中閒聊」或「盤後閒聊」
export function findDailyThread(html, ymd, keyword = '盤中閒聊') {
  const re = /<a href="(\/bbs\/Stock\/M\.[^"]+\.html)">([^<]*)<\/a>/g
  let found = null
  for (const m of html.matchAll(re)) {
    const title = decodeEntities(m[2]).trim()
    if (title.startsWith('Re:') || title.startsWith('Fw:')) continue
    if (title.includes(ymd) && title.includes(keyword)) {
      found = { url: PTT_ORIGIN + m[1], title } // 取最後一個符合的
    }
  }
  return found
}

// 列表頁的「‹ 上頁」連結
export function findPrevPage(html) {
  const m = html.match(/href="(\/bbs\/Stock\/index\d+\.html)"[^>]*>[^<]*上頁/)
  return m ? PTT_ORIGIN + m[1] : null
}

// 解析文章裡的推文，只保留推噓符號和內容，不保留帳號
export function parsePushes(html) {
  const out = []
  const re = /<div class="push">([\s\S]*?)<\/div>/g
  for (const m of html.matchAll(re)) {
    const tag = m[1].match(/push-tag">([^<]*)</)
    const content = m[1].match(/push-content">([\s\S]*?)<\/span>/)
    if (!tag || !content) continue
    const text = decodeEntities(stripTags(content[1]))
      .replace(/^:\s?/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    out.push({ kind: tag[1].trim(), text })
  }
  return out
}

// ---------- 顯示寬度（中文字在終端機佔兩格） ----------

export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0 // 組合用符號
  if (cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function strWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}

// 截到最多 maxW 格，超過的話結尾加 …
export function clipWidth(s, maxW) {
  if (strWidth(s) <= maxW) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > maxW - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// 取出字串第 from 到 to 格（不含 to），被切一半的寬字元補空白
function sliceCols(s, from, to) {
  let out = ''
  let col = 0
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0))
    const a = col
    const b = col + w
    col = b
    if (b <= from && w > 0) continue
    if (a >= to) break
    if (a >= from && b <= to) out += ch
    else out += ' '.repeat(Math.max(0, Math.min(b, to) - Math.max(a, from)))
  }
  return out
}

// ---------- 彈幕軌道 ----------

// item: { text, w, color, bold, x }，x 是左緣所在的欄位
export function renderLane(lane, width) {
  const segs = []
  let col = 0
  const sorted = [...lane].sort((a, b) => a.x - b.x)
  for (const it of sorted) {
    const start = Math.max(it.x, col)
    if (start >= width) break
    const end = Math.min(it.x + it.w, width)
    if (end <= start) continue
    if (start > col) segs.push({ text: ' '.repeat(start - col) })
    segs.push({ text: sliceCols(it.text, start - it.x, end - it.x), color: it.color, bold: it.bold })
    col = end
  }
  return segs
}

// 每一幀：全部往左移一格、移除跑出畫面的、最多補一則新的進來
// 回傳 true 代表畫面有變，需要重畫
export function stepLanes(lanes, queue, width, gap) {
  let changed = false
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].length === 0) continue
    for (const it of lanes[i]) it.x -= 1
    lanes[i] = lanes[i].filter((it) => it.x + it.w > 0)
    changed = true
  }
  if (queue.length > 0) {
    // 找右邊空間最多的軌道放新彈幕，讓各軌道錯開
    let best = -1
    let bestRoom = -Infinity
    for (let i = 0; i < lanes.length; i++) {
      const last = lanes[i].reduce((a, b) => (!a || b.x > a.x ? b : a), null)
      const room = last ? width - (last.x + last.w) : Infinity
      if (room >= gap && room > bestRoom) {
        best = i
        bestRoom = room
      }
    }
    if (best >= 0) {
      lanes[best].push({ ...queue.shift(), x: width })
      changed = true
    }
  }
  return changed
}

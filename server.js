const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API =
  "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_101";
const CACHE_TTL_MS = 1200; // Cache 1.2s để phản hồi nhanh, không nghẽn request
const HISTORY_FILE = path.join(__dirname, "history_vgmn101.json");

let cache = {
  data: null,
  expiresAt: 0,
};

// Lưu lịch sử các phiên đã quan sát: { sid, v1, v2, bc1, bc2, sign }
let sessionHistory = loadHistory();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      if (Array.isArray(raw)) return raw.slice(-200);
    }
  } catch (_) {}
  return [];
}

function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(sessionHistory.slice(-200), null, 2),
      "utf8"
    );
  } catch (_) {}
}

function parseSides(bs = []) {
  // Quy ước phổ biến: eid = 1 hoặc eid = 2 là hai cửa (Tài/Xỉu)
  // Sắp xếp theo eid tăng dần để chuẩn hóa ổn định
  const sorted = [...bs].sort((a, b) => Number(a.eid ?? 0) - Number(b.eid ?? 0));
  const s1 = sorted[0] || { eid: 1, v: 0, bc: 0 };
  const s2 = sorted[1] || { eid: 2, v: 0, bc: 0 };

  const v1 = Number(s1.v ?? 0);
  const v2 = Number(s2.v ?? 0);
  const bc1 = Number(s1.bc ?? 0);
  const bc2 = Number(s2.bc ?? 0);

  return { s1, s2, v1, v2, bc1, bc2 };
}

function recordSession(sid, metrics) {
  const { v1, v2, bc1, bc2 } = metrics;
  const totalV = v1 + v2;
  const ratio1 = totalV > 0 ? v1 / totalV : 0.5;
  const sign = ratio1 >= 0.5 ? "T" : "X";

  const idx = sessionHistory.findIndex((item) => Number(item.sid) === Number(sid));
  const entry = { sid: Number(sid), v1, v2, bc1, bc2, sign };

  if (idx >= 0) {
    sessionHistory[idx] = entry;
  } else {
    sessionHistory.push(entry);
    sessionHistory.sort((a, b) => a.sid - b.sid);
    if (sessionHistory.length > 200) {
      sessionHistory = sessionHistory.slice(-200);
    }
  }
  saveHistory();
}

function buildPrediction(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  if (!item || item.sid === undefined) {
    throw new Error("Không tìm thấy sid trong dữ liệu trả về");
  }

  const sid = Number(item.sid);
  const { v1, v2, bc1, bc2 } = parseSides(item.bs);

  // Ghi nhận phiên hiện tại vào chuỗi lịch sử quan sát
  recordSession(sid, { v1, v2, bc1, bc2 });

  // Chuỗi pattern từ các phiên đã lưu (tối đa 12 phiên gần nhất)
  const seqArr = sessionHistory.map((h) => h.sign);
  const recentPattern =
    seqArr.length > 0 ? seqArr.slice(-12).join("") : v1 >= v2 ? "T" : "X";

  // 1. Tín hiệu dòng tiền & lượt cược của phiên sid hiện tại
  const totalV = Math.max(v1 + v2, 1);
  const totalBc = Math.max(bc1 + bc2, 1);
  const moneyShareT = v1 / totalV;
  const moneyShareX = v2 / totalV;
  const betShareT = bc1 / totalBc;
  const betShareX = bc2 / totalBc;

  // Cán cân dòng tiền nghiêng về cửa nào (kết hợp v và bc)
  const flowT = moneyShareT * 0.7 + betShareT * 0.3;
  const flowX = moneyShareX * 0.7 + betShareX * 0.3;

  // 2. Tín hiệu khớp pattern lịch sử đã tích lũy (nếu có >= 4 phiên)
  let patScoreT = 0.5;
  let patScoreX = 0.5;
  let patternNote = "";

  if (seqArr.length >= 4) {
    const seqStr = seqArr.join("");
    let matched = false;

    for (const len of [4, 3, 2]) {
      if (seqStr.length <= len) continue;
      const suffix = seqStr.slice(-len);
      let cT = 0;
      let cX = 0;

      for (let i = 0; i <= seqStr.length - len - 2; i++) {
        if (seqStr.slice(i, i + len) === suffix) {
          const nxt = seqStr[i + len];
          if (nxt === "T") cT++;
          else if (nxt === "X") cX++;
        }
      }

      if (cT + cX > 0) {
        patScoreT = cT / (cT + cX);
        patScoreX = cX / (cT + cX);
        patternNote = `Khớp mẫu ${suffix} (${cT + cX} lần -> ${cT}T/${cX}X)`;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const tCount = seqArr.slice(-12).filter((c) => c === "T").length;
      const xCount = seqArr.slice(-12).length - tCount;
      patScoreT = tCount / Math.max(tCount + xCount, 1);
      patScoreX = xCount / Math.max(tCount + xCount, 1);
      patternNote = `Chuỗi ${recentPattern} (${tCount}T/${xCount}X)`;
    }
  } else {
    patternNote = `Đang tích lũy chuỗi (${recentPattern})`;
  }

  // Kết hợp trọng số: có chuỗi lịch sử thì 55% dòng tiền phiên + 45% pattern; ít dữ liệu thì ưu tiên dòng tiền phiên
  const hasRichHistory = seqArr.length >= 4;
  const finalT = hasRichHistory ? flowT * 0.55 + patScoreT * 0.45 : flowT;
  const finalX = hasRichHistory ? flowX * 0.55 + patScoreX * 0.45 : flowX;

  const prediction = finalT >= finalX ? "T" : "X";
  const topScore = Math.max(finalT, finalX);
  const sumScore = Math.max(finalT + finalX, 0.0001);

  const confidence = Number(
    Math.min(89, Math.max(51, (topScore / sumScore) * 100)).toFixed(1)
  );

  const diffPct = Math.abs(moneyShareT - moneyShareX) * 100;
  const reason = `Phiên ${sid} có lệch tiền cửa 1/cửa 2 là ${diffPct.toFixed(
    1
  )}% (v1=${v1}, v2=${v2}, bc1=${bc1}, bc2=${bc2}); ${patternNote}.`;

  return {
    phien_du_doan: sid,
    du_doan: prediction,
    do_tin_cay: `${confidence}%`,
    patten: recentPattern,
    ly_do: reason,
  };
}

async function fetchAndPredict() {
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(SOURCE_API, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      throw new Error(`API gốc trả về status ${res.status}`);
    }
    const json = await res.json();
    const result = buildPrediction(json);

    cache = {
      data: result,
      expiresAt: now + CACHE_TTL_MS,
    };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/vanhoa", async (req, res) => {
  try {
    const data = await fetchAndPredict();
    res.json(data);
  } catch (err) {
    res.status(502).json({
      error: "Không thể lấy hoặc phân tích dữ liệu từ API gốc",
      detail: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoint: "/vanhoa",
    tracked_sessions: sessionHistory.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

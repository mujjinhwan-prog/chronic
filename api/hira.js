// api/hira.js  —  Vercel Edge Function (심평원 Open API 중계)
// 인증키는 Vercel 환경변수 DATA_GO_KR_KEY 에만 저장되고 브라우저에는 노출되지 않습니다.
// 호출 예) /api/hira?svc=basis&sidoCd=110000&dgsbjtCd=01&pageNo=1
//         /api/hira?svc=top5&ykiho=...

export const config = { runtime: "edge", regions: ["icn1"] }; // 서울 리전에서 호출

const SERVICES = {
  basis: {
    url: "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList",
    params: ["pageNo", "numOfRows", "sidoCd", "sgguCd", "emdongNm", "clCd", "dgsbjtCd", "yadmNm"],
    ttl: 86400, // 기관 목록: 하루 캐시
  },
  top5: {
    url: "https://apis.data.go.kr/B551182/hospDiagInfoService1/getClinicTop5List1",
    params: ["ykiho"],
    ttl: 604800, // 상위질병: 일주일 캐시 (1년치 집계라 자주 안 바뀜)
  },
};

const ALLOWED = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);

function cors(origin) {
  const ok = !ALLOWED.length || ALLOWED.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

// <item>…</item> 블록을 {태그: 값} 객체 배열로 변환
function parseXml(xml) {
  const text = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const pick = (tag) => { const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? text(m[1]) : ""; };
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = text(f[2]);
    items.push(o);
  }
  return {
    resultCode: pick("resultCode") || pick("returnReasonCode"),
    resultMsg: pick("resultMsg") || pick("returnAuthMsg") || pick("errMsg"),
    totalCount: Number(pick("totalCount") || 0),
    items,
  };
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = { ...cors(origin), "Content-Type": "application/json; charset=utf-8" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const q = new URL(req.url).searchParams;
  const svc = SERVICES[q.get("svc")];
  if (!svc) return new Response(JSON.stringify({ error: "svc는 basis 또는 top5" }), { status: 400, headers });

  let key = process.env.DATA_GO_KR_KEY || "";
  if (!key) return new Response(JSON.stringify({ error: "Vercel 환경변수 DATA_GO_KR_KEY가 없습니다." }), { status: 500, headers });
  if (key.includes("%")) key = decodeURIComponent(key); // Encoding 키를 넣어도 동작하도록

  const up = new URL(svc.url);
  up.searchParams.set("serviceKey", key);
  for (const p of svc.params) if (q.get(p)) up.searchParams.set(p, q.get(p));
  if (!up.searchParams.get("pageNo")) up.searchParams.set("pageNo", "1");
  if (!up.searchParams.get("numOfRows")) up.searchParams.set("numOfRows", "10");

  try {
    const r = await fetch(up.toString(), { headers: { Accept: "application/xml" } });
    const body = await r.text();
    const data = parseXml(body);
    const ok = r.ok && (!data.resultCode || data.resultCode === "00" || data.resultCode === "0000");
    if (!ok) {
      return new Response(JSON.stringify({ error: data.resultMsg || `HTTP ${r.status}`, code: data.resultCode, raw: body.slice(0, 300) }), { status: 502, headers });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...headers, "Cache-Control": `public, s-maxage=${svc.ttl}, stale-while-revalidate=86400` },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
  }
}

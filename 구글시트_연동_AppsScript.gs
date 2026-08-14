/**
 * 박람회 현장점검 — Apps Script 통합 웹앱 (입력 폼 + 분석·보고서 + 시트 축적)
 * 작성일: 2026-08-14
 *
 * ── 이 스크립트 하나로 되는 것 ────────────────────────────────
 *  · 웹앱 링크(/exec) 하나가 입력 폼과 분석·보고서 페이지를 모두 제공(호스팅)
 *  · 입력 데이터를 연결된 구글 시트에 온라인 축적(upsert, 중복 행 방지)
 *  · 국세청 사업자등록 상태조회 중계(verify)
 *  · 시트 데이터 집계·보고서(stats/rows) 제공
 *
 * ── 설치(배포는 PC에서 1회) ──────────────────────────────────
 * 1) 구글 스프레드시트 새로 만들기 → 확장 프로그램 › Apps Script
 * 2) 파일 3개 구성:
 *      - 이 코드를 기본 파일(Code.gs)에 붙여넣기
 *      - HTML 파일 추가(＋ › HTML) 이름 'form'   → '박람회_현장점검_양식.html' 전체 붙여넣기
 *      - HTML 파일 추가(＋ › HTML) 이름 'report' → '분석보고서.html' 전체 붙여넣기
 *    ※ 파일명은 반드시 form / report (확장자 .html 자동)
 * 3) 스크립트 속성에 인증키 저장(⚙ 프로젝트 설정 › 스크립트 속성):
 *      - NTS_API_KEY  : 공공데이터포털 Decoding 인증키(사업자 조회용, 없어도 저장은 동작)
 *      - GITHUB_TOKEN : 파인그레인드 PAT, 해당 저장소 Contents=Read/Write(정합성 원장 커밋용)
 *    ※ 인증키·토큰을 코드에 직접 넣지 말 것(공개 저장소 노출 위험).
 * 4) 배포 › 새 배포 › 유형 "웹 앱"
 *      실행 계정: 나 / 액세스 권한: 모든 사용자   ← 반드시
 * 5) 생성된 웹 앱 URL(…/exec)이 곧 접속 링크.
 *      · …/exec            → 입력 폼
 *      · …/exec?page=report → 분석·보고서 대시보드
 *    재배포 시 "새 버전"으로 배포해야 변경이 반영됨.
 *
 * ── 동작 요약 ────────────────────────────────────────────────
 *  doGet  : page=report → 보고서 HTML, 그 외 → 폼 HTML (api=ping 이면 JSON 상태)
 *  doPost : 정적/파일 호스팅(fetch) 하위호환 — ping/upsert/verify/stats/rows
 *  api*   : GAS 내장 폼이 google.script.run 으로 직접 호출하는 함수(동일 로직)
 * ─────────────────────────────────────────────────────────────
 */

// 공공데이터포털 Decoding 인증키(사업자 조회용)는 코드에 두지 말 것(공개 저장소 노출 위험).
// Apps Script: 프로젝트 설정 › 스크립트 속성 › NTS_API_KEY 에 저장. 없으면 조회 기능만 비활성(저장은 정상).
function ntsKey_() {
  try { return PropertiesService.getScriptProperties().getProperty('NTS_API_KEY') || ''; }
  catch (e) { return ''; }
}
var SHEET_NAME = '박람회_업체';
var NTS_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';

// ── GitHub 정합성 원장 연동 ───────────────────────────────────
// 흐름: 클라이언트 → (여기서) 정합성 검증 → GitHub 저장소에 JSON 커밋(버전관리=원장)
//        → 검증 통과분만 구글 시트로 반영.
// ※ 토큰은 코드에 두지 말 것(저장소가 공개일 수 있음). Apps Script:
//    프로젝트 설정(⚙) › 스크립트 속성 › 속성 추가 → 이름 GITHUB_TOKEN / 값 <파인그레인드 PAT>
//    PAT 권한: 이 저장소의 Contents = Read and write 만.
// GITHUB_BRANCH 는 커밋 대상 브랜치(저장소 기본 브랜치로 맞출 것).
var GITHUB_OWNER  = 'Alfira0526';
var GITHUB_REPO   = 'Sample';
var GITHUB_BRANCH = 'claude/handoff-p0-tasks-5ep8hj';
var GITHUB_PATH   = 'data/fair-data.json';
var ALLOWED_TYPES = ['예식장','스드메/드메','본식스냅/DVD','예복·한복·예물','신혼여행','기타'];

var HEADERS = ['최종수정','레코드ID','업체명','부스','유형','사업자번호','사업자상태','과세유형',
               '대관료(만원)','1인식대(원)','보증인원','최소지출(만원)','점검답변','위험신호','메모'];

/* ── 라우팅 ─────────────────────────────────────────────── */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.api === 'ping') {
    return ContentService.createTextOutput(JSON.stringify(ping_()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var file = (p.page === 'report') ? 'report' : 'form';
  var title = (file === 'report') ? '박람회 분석·보고서' : '박람회 현장점검';
  return HtmlService.createHtmlOutputFromFile(file)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* 정적/파일 호스팅(fetch) 하위호환. GAS 내장 폼은 doPost 대신 api* 함수를 직접 호출함 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'ping')        out = ping_();
    else if (req.action === 'upsert') out = upsert_(req.rows);
    else if (req.action === 'submit') out = apiSubmit(req.rows);
    else if (req.action === 'verify') out = verify_(req.bno);
    else if (req.action === 'stats')  out = getStats_();
    else if (req.action === 'rows')   out = getRows_();
    else out = { ok: false, error: 'unknown action' };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ── google.script.run 진입점(GAS 내장 폼·보고서용) ───────── */
function apiPing()        { return ping_(); }
function apiUpsert(rows)  { return upsert_(rows); }
function apiSubmit(rows)  { return submit_(rows); }
function apiVerify(bno)   { return verify_(bno); }
function apiStats()       { return getStats_(); }
function apiRows()        { return getRows_(); }

/* ── 시트 ───────────────────────────────────────────────── */
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    try {
      sh = ss.insertSheet(SHEET_NAME);
      sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
        .setFontWeight('bold').setBackground('#12161c').setFontColor('#ffffff');
      sh.setFrozenRows(1);
      sh.setColumnWidth(13, 420);   // 점검답변
      sh.setColumnWidth(15, 260);   // 메모
    } catch (e) {
      // 동시 호출(예: 보고서의 stats+rows 병렬)이 같은 시트를 만들려는 경쟁 → 이미 생성된 것 사용
      sh = ss.getSheetByName(SHEET_NAME);
      if (!sh) throw e;
    }
  }
  return sh;
}

function ping_() {
  var sh = sheet_();
  return { ok: true, sheet: sh.getParent().getName(), rows: Math.max(0, sh.getLastRow() - 1), apiKey: !!ntsKey_() };
}

/**
 * 동일 업체 재저장 대응.
 * 매칭 우선순위: 레코드ID → 사업자번호(숫자만) → 없으면 신규 행
 */
function upsert_(rows) {
  if (!rows || !rows.length) return { ok: true, updated: 0, inserted: 0 };
  var sh = sheet_();
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];

  var byId = {}, byBno = {};
  for (var r = 0; r < data.length; r++) {
    var id = String(data[r][1] || '');
    var bno = String(data[r][5] || '').replace(/[^0-9]/g, '');
    if (id) byId[id] = r + 2;
    if (bno && bno.length === 10 && !byBno[bno]) byBno[bno] = r + 2;
  }

  var updated = 0, inserted = 0, now = new Date();
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i];
    var bno2 = String(v['사업자번호'] || '').replace(/[^0-9]/g, '');
    var line = [now, v.id || '', v['업체명'] || '', v['부스'] || '', v['유형'] || '',
                v['사업자번호'] || '', v['사업자상태'] || '', v['과세유형'] || '',
                v['대관료만원'] || '', v['일인식대'] || '', v['보증인원'] || '',
                v['최소지출만원'] || '', v['점검답변'] || '', v['위험신호'] || '', v['메모'] || ''];

    var target = (v.id && byId[v.id]) || (bno2.length === 10 && byBno[bno2]) || 0;
    if (target) {
      sh.getRange(target, 1, 1, HEADERS.length).setValues([line]);
      updated++;
    } else {
      sh.appendRow(line);
      var newRow = sh.getLastRow();
      if (v.id) byId[v.id] = newRow;
      if (bno2.length === 10) byBno[bno2] = newRow;
      inserted++;
    }
  }
  return { ok: true, updated: updated, inserted: inserted };
}

/**
 * 국세청 사업자등록 상태조회.
 * 응답 b_stt: 계속사업자 / 휴업자 / 폐업자
 * tax_type : 부가가치세 일반과세자 · 간이과세자 · 면세사업자 등
 * [확인필요] API 규격·엔드포인트는 공공데이터포털 문서 기준으로 최종 확인할 것
 */
function verify_(bno) {
  var API_KEY = ntsKey_();
  if (!API_KEY) return { ok: false, error: 'NTS_API_KEY 미설정 — 스크립트 속성에 공공데이터포털 인증키 입력 필요' };
  var b = String(bno || '').replace(/[^0-9]/g, '');
  if (b.length !== 10) return { ok: false, error: '사업자번호 10자리 아님' };

  var url = NTS_URL + '?serviceKey=' + encodeURIComponent(API_KEY);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ b_no: [b] }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) return { ok: false, error: 'API HTTP ' + code };

  var body = JSON.parse(res.getContentText());
  var d = body && body.data && body.data[0];
  if (!d) return { ok: false, error: '응답 데이터 없음' };
  if (d.b_stt_cd === '' && d.tax_type && String(d.tax_type).indexOf('등록되지') >= 0) {
    return { ok: true, status: '등록되지 않은 사업자번호', taxType: '', endDt: '' };
  }
  return {
    ok: true,
    status: d.b_stt || '상태 미확인',
    taxType: d.tax_type || '',
    endDt: d.end_dt || ''
  };
}

/* ── 조회·집계(분석·보고서용) ─────────────────────────────── */
function getRows_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i], o = {};
    for (var c = 0; c < HEADERS.length; c++) {
      o[HEADERS[c]] = (r[c] instanceof Date) ? Utilities.formatDate(r[c], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : r[c];
    }
    if (o['업체명'] || o['사업자번호']) out.push(o);
  }
  return { ok: true, rows: out };
}

/**
 * 시트 데이터 집계.
 * 반환: 총건수, 유형별 분포, 예식장 최소지출(목록·min/max/avg),
 *       위험신호(총합·1개이상 업체·3개이상 업체), 사업자검증 현황
 */
function getStats_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
  var stats = {
    ok: true, total: 0, byType: {}, halls: [], hallSummary: null,
    risk: { total: 0, withAny: 0, with3: 0 },
    verify: { '계속': 0, '휴업': 0, '폐업': 0, '기타': 0, '미확인': 0 },
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    sheet: sh.getParent().getName()
  };
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var name = String(r[2] || ''), bno = String(r[5] || '');
    if (!name && !bno) continue;
    stats.total++;

    var type = String(r[4] || '기타');
    stats.byType[type] = (stats.byType[type] || 0) + 1;

    if (type === '예식장') {
      var ms = Number(r[11]);
      if (!isNaN(ms) && ms > 0) stats.halls.push({ name: name || '미입력', minSpend: ms });
    }

    var risk = String(r[13] || '');
    var rc = risk ? risk.split('/').filter(function (s) { return s.replace(/\s/g, ''); }).length : 0;
    stats.risk.total += rc;
    if (rc >= 1) stats.risk.withAny++;
    if (rc >= 3) stats.risk.with3++;

    var st = String(r[6] || '');
    if (!st) stats.verify['미확인']++;
    else if (st.indexOf('계속') >= 0) stats.verify['계속']++;
    else if (st.indexOf('휴업') >= 0) stats.verify['휴업']++;
    else if (st.indexOf('폐업') >= 0) stats.verify['폐업']++;
    else stats.verify['기타']++;
  }
  var spends = stats.halls.map(function (h) { return h.minSpend; });
  if (spends.length) {
    var sum = spends.reduce(function (a, b) { return a + b; }, 0);
    stats.hallSummary = { count: spends.length, min: Math.min.apply(null, spends), max: Math.max.apply(null, spends), avg: Math.round(sum / spends.length) };
  }
  stats.halls.sort(function (a, b) { return a.minSpend - b.minSpend; });
  return stats;
}

/* ══ 정합성 검증 → GitHub 원장 → 구글 시트 파이프라인 ══════════ */

/**
 * 제출 진입점. 순서:
 *  1) 정합성 검증(validateRows_) — 통과분만 진행
 *  2) GitHub 저장소에 검증 데이터 커밋(버전관리 원장). 토큰 설정 시 강제 게이트,
 *     미설정 시 경고와 함께 통과(시트 저장은 유지)
 *  3) 구글 시트로 반영(upsert_)
 */
function submit_(rows) {
  var v = validateRows_(rows);
  if (!v.valid.length) return { ok: false, error: '정합성 검증 실패 — 유효 레코드 없음', invalid: v.errors };
  var gh;
  try {
    gh = publishGithub_(v.valid);
  } catch (e) {
    // 토큰이 설정되어 GitHub 게이트가 켜진 상태에서 커밋 실패 → 시트에 쓰지 않음(정합성 우선)
    return { ok: false, stage: 'github', error: String(e), invalid: v.errors };
  }
  var up = upsert_(v.valid);
  return { ok: true, updated: up.updated, inserted: up.inserted, invalid: v.errors, github: gh };
}

/** 스키마·규칙 검증. 반환 {valid:[...], errors:[{id,name,errors:[]}]} */
function validateRows_(rows) {
  var valid = [], errors = [];
  if (!rows || !rows.length) return { valid: valid, errors: errors };
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i] || {}, errs = [];
    var name = String(v['업체명'] || '').trim();
    var bno = String(v['사업자번호'] || '').replace(/[^0-9]/g, '');
    if (!name && !bno) errs.push('업체명·사업자번호 모두 없음');
    if (bno && bno.length !== 10) errs.push('사업자번호 10자리 아님');
    if (v['유형'] && ALLOWED_TYPES.indexOf(v['유형']) < 0) errs.push('유형 값 오류: ' + v['유형']);
    ['대관료만원', '일인식대', '보증인원', '최소지출만원'].forEach(function (k) {
      if (v[k] !== '' && v[k] != null && isNaN(Number(v[k]))) errs.push(k + ' 숫자 아님');
    });
    if (!v.id) errs.push('레코드 id 없음');
    if (errs.length) errors.push({ id: v.id || '', name: name, errors: errs });
    else valid.push(v);
  }
  return { valid: valid, errors: errors };
}

function ghToken_() {
  try { return PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') || ''; }
  catch (e) { return ''; }
}
function ghHeaders_() {
  return {
    'Authorization': 'token ' + ghToken_(),
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'wedding-fair-appscript',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}
function ghApiUrl_() {
  return 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_PATH;
}
/** 현재 파일 {sha, data} 반환. 없으면 {sha:null, data:null} */
function ghGetFile_() {
  var res = UrlFetchApp.fetch(ghApiUrl_() + '?ref=' + encodeURIComponent(GITHUB_BRANCH),
    { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 404) return { sha: null, data: null };
  if (code !== 200) throw new Error('GitHub GET ' + code + ' ' + res.getContentText());
  var body = JSON.parse(res.getContentText());
  var data = null;
  if (body.content) {
    var txt = Utilities.newBlob(Utilities.base64Decode(String(body.content).replace(/\s/g, ''))).getDataAsString('UTF-8');
    try { data = JSON.parse(txt); } catch (e) { data = null; }
  }
  return { sha: body.sha, data: data };
}
function ghPutFile_(jsonString, sha, message) {
  var payload = { message: message, content: Utilities.base64Encode(jsonString, Utilities.Charset.UTF_8), branch: GITHUB_BRANCH };
  if (sha) payload.sha = sha;
  var res = UrlFetchApp.fetch(ghApiUrl_(),
    { method: 'put', headers: ghHeaders_(), contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 201) throw new Error('GitHub PUT ' + code + ' ' + res.getContentText());
  var body = JSON.parse(res.getContentText());
  return { fileSha: body.content && body.content.sha, commitSha: body.commit && body.commit.sha };
}

/** 시트 행 형태(v) → 원장 venue 레코드 */
function rowToVenue_(v) {
  var hall = Number(v['대관료만원']) || 0, meal = Number(v['일인식대']) || 0, guar = Number(v['보증인원']) || 0;
  var isHall = (v['유형'] === '예식장' && meal > 0 && guar > 0);
  return {
    id: v.id || '', name: v['업체명'] || '', type: v['유형'] || '', biz: v['사업자번호'] || '',
    bstt: v['사업자상태'] || '', booth: v['부스'] || '',
    hallMinSpend: isHall ? Math.round((hall * 10000 + meal * guar) / 10000) : null,
    updated: new Date().toISOString()
  };
}
function buildBudgetFeed_(venues) {
  var halls = venues.filter(function (x) { return x.type === '예식장' && Number(x.hallMinSpend) > 0; });
  var s = halls.map(function (h) { return Number(h.hallMinSpend); });
  return {
    updated: new Date().toISOString(), count: halls.length,
    minSpend: s.length ? Math.min.apply(null, s) : null,
    maxSpend: s.length ? Math.max.apply(null, s) : null,
    venues: halls.map(function (h) { return { name: h.name || '미입력', spend: Number(h.hallMinSpend) }; })
  };
}
/** 검증 통과분을 원장(data/fair-data.json)에 누적 upsert 후 커밋 */
function publishGithub_(validRows) {
  if (!ghToken_()) return { committed: false, reason: 'GITHUB_TOKEN 미설정(스크립트 속성) — 원장 커밋 생략, 시트만 저장' };
  var cur = ghGetFile_();
  var dataset = (cur.data && cur.data.venues) ? cur.data
    : { schema: 'wedding-fair/v1', updated: '', count: 0, venues: [], budgetFeed: null };

  var byId = {}, byBno = {};
  dataset.venues.forEach(function (x, idx) {
    if (x.id) byId[x.id] = idx;
    var b = String(x.biz || '').replace(/[^0-9]/g, '');
    if (b.length === 10) byBno[b] = idx;
  });
  validRows.forEach(function (v) {
    var ven = rowToVenue_(v);
    var b = String(ven.biz || '').replace(/[^0-9]/g, '');
    var idx = (ven.id && byId[ven.id] != null) ? byId[ven.id]
      : ((b.length === 10 && byBno[b] != null) ? byBno[b] : -1);
    if (idx >= 0) { dataset.venues[idx] = ven; }
    else {
      dataset.venues.push(ven);
      var ni = dataset.venues.length - 1;
      if (ven.id) byId[ven.id] = ni;
      if (b.length === 10) byBno[b] = ni;
    }
  });
  dataset.updated = new Date().toISOString();
  dataset.count = dataset.venues.length;
  dataset.budgetFeed = buildBudgetFeed_(dataset.venues);

  var json = JSON.stringify(dataset, null, 2);
  var put = ghPutFile_(json, cur.sha, 'data: fair-data.json 갱신 (' + dataset.count + '곳, 검증완료)');
  return { committed: true, fileSha: put.fileSha, commitSha: put.commitSha, count: dataset.count };
}

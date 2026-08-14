/**
 * 박람회 현장점검 양식 ↔ 구글 시트 연동 스크립트
 * 작성일: 2026-08-14
 *
 * ── 설치 순서 ──────────────────────────────────────────────
 * 1) 구글 스프레드시트 새로 만들기
 * 2) 확장 프로그램 › Apps Script → 이 코드 전체를 붙여넣기
 * 3) 아래 API_KEY 에 공공데이터포털 인증키 입력 (사업자번호 조회용)
 *    - data.go.kr 접속 → "국세청_사업자등록정보 진위확인 및 상태조회 서비스" 검색
 *    - 활용신청 → 마이페이지에서 "일반 인증키(Decoding)" 복사
 *    - 승인까지 수 분~1일 소요될 수 있음 [확인필요 — 즉시 승인 여부는 서비스별 상이]
 *    - 키를 넣지 않아도 시트 저장 기능은 정상 작동함
 * 4) 배포 › 새 배포 › 유형 "웹 앱"
 *      실행 계정: 나
 *      액세스 권한: 모든 사용자      ← 반드시 이 값
 * 5) 생성된 웹 앱 URL(…/exec)을 HTML 양식의 "연동 설정"에 붙여넣기
 *
 * ── 동작 ──────────────────────────────────────────────────
 * upsert : 레코드 id 우선, 없으면 사업자번호로 기존 행을 찾아 덮어씀 (중복 행 방지)
 * verify : 국세청 사업자등록 상태조회 API 중계 (CORS 회피 + 키 노출 방지)
 * ping   : 연결 상태 확인
 * ─────────────────────────────────────────────────────────
 */

var API_KEY = '4b5cba233308ce9653610e67190d860a30c78771b96e6e0bdb61dca68dc94e4c';   // 공공데이터포털 Decoding 인증키
// ※ 비밀정보. 이 파일을 타인에게 공유하거나 공개 저장소에 올리지 말 것.
// ※ 유출 우려 시 공공데이터포털 마이페이지에서 재발급할 것.
var SHEET_NAME = '박람회_업체';
var NTS_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';

var HEADERS = ['최종수정','레코드ID','업체명','부스','유형','사업자번호','사업자상태','과세유형',
               '대관료(만원)','1인식대(원)','보증인원','최소지출(만원)','점검답변','위험신호','메모'];

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'ping')        out = ping_();
    else if (req.action === 'upsert') out = upsert_(req.rows);
    else if (req.action === 'verify') out = verify_(req.bno);
    else out = { ok: false, error: 'unknown action' };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* GET 으로도 연결 확인 가능 */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(ping_()))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#12161c').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(13, 420);   // 점검답변
    sh.setColumnWidth(15, 260);   // 메모
  }
  return sh;
}

function ping_() {
  var sh = sheet_();
  return { ok: true, sheet: sh.getParent().getName(), rows: Math.max(0, sh.getLastRow() - 1), apiKey: !!API_KEY };
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
  if (!API_KEY) return { ok: false, error: 'API_KEY 미설정 — 스크립트 상단에 인증키 입력 필요' };
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

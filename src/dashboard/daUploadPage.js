/**
 * 자동리포트 BETA 화면. 서버 값은 JSON으로 넘기고, 화면 스크립트는 파일 값을 항상 escape해 표시한다.
 */
const PAGE_SCRIPT = String.raw`
(function(){
  var CFG = window.BETA_CFG;
  if (!CFG.accountId) return;
  var state = null;
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function num(n){ return Math.round(Number(n)||0).toLocaleString('ko-KR'); }
  function ymd(d){ return d.toISOString().slice(0,10); }
  function kstToday(){ var k = new Date(Date.now()+9*3600*1000); return new Date(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate())); }
  function lastMonth(){ var t=kstToday(); return [ymd(new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()-1,1))), ymd(new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),0)))]; }
  function lastWeek(){ var t=kstToday(); var dow=t.getUTCDay(); var sun=new Date(t.getTime()-(dow===0?7:dow)*86400000); return [ymd(new Date(sun.getTime()-6*86400000)), ymd(sun)]; }
  function range(){ return { since: $('da-since').value, until: $('da-until').value }; }
  function qs(extra){ var r=range(); var q='accountId='+encodeURIComponent(CFG.accountId)+'&since='+r.since+'&until='+r.until; return extra ? q+'&'+extra : q; }
  function msg(text, kind){ var el=$('da-msg'); el.innerHTML = text ? '<div class="alert '+(kind==='err'?'alert-err':'alert-ok')+'" style="margin:0 0 12px;line-height:1.6">'+esc(text)+'</div>' : ''; }
  function setPeriod(a,b){ $('da-since').value=a; $('da-until').value=b; refresh(); }

  // ── 탭 ──
  window.betaTab = function(name){
    ['sa','da'].forEach(function(t){
      $('beta-tab-'+t).style.display = t===name ? '' : 'none';
      var b=$('beta-btn-'+t); if (b) b.classList.toggle('active', t===name);
    });
    try { localStorage.setItem('betaReportTab', name); } catch(e) {}
  };
  var savedTab = 'da'; try { savedTab = localStorage.getItem('betaReportTab') || 'da'; } catch(e) {}
  window.betaTab(savedTab);
  window.betaSaExcel = function(type, btn){ download('/smart-sa/api/report/download-excel?type='+type+'&accountId='+encodeURIComponent(CFG.accountId), btn); };

  // ── 상태 표시 ──
  async function refresh(){
    var r=range();
    if (!r.since || !r.until) return;
    try {
      var res = await fetch('/smart-sa/api/da-upload/state?'+qs());
      var j = await res.json();
      if (!j.ok) { msg(j.error,'err'); return; }
      state = j;
      render();
    } catch(e) { msg('상태를 불러오지 못했습니다: '+e.message,'err'); }
  }
  function render(){
    var s=state;
    $('da-period-type').textContent = s.typeLabel+' 리포트로 생성됩니다';
    // 파일 목록
    var rows = s.files.map(function(f){
      var warn = (f.warnings||[]).map(function(w){ return '<div style="color:#b45309;font-size:11px;margin-top:2px">⚠ '+esc(w)+'</div>'; }).join('');
      return '<tr><td style="word-break:break-all"><b>'+esc(f.fileName)+'</b>'+warn+'</td>'
        +'<td><span class="badge '+(f.kind==='product'?'badge-blue':'badge-green')+'">'+(f.kind==='product'?'상품 성과':'성과')+'</span></td>'
        +'<td style="font-size:12px;color:#64748b">'+esc(f.dims||'-')+'</td>'
        +'<td style="text-align:right">'+num(f.rows)+'</td>'
        +'<td style="text-align:right">₩'+num(f.cost)+'</td>'
        +'<td style="text-align:right">'+num(f.buy)+'</td>'
        +'<td style="text-align:right">₩'+num(f.sales)+'</td>'
        +'<td style="text-align:center"><button class="btn btn-outline btn-sm" onclick="betaDelete('+f.id+')">삭제</button></td></tr>';
    }).join('');
    $('da-files').innerHTML = s.files.length
      ? '<table><thead><tr><th>파일</th><th>보고서</th><th>구성</th><th style="text-align:right">행</th><th style="text-align:right">총비용</th><th style="text-align:right">구매완료 수</th><th style="text-align:right">구매완료 매출</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>'
      : '<div class="empty">이 기간에 올린 파일이 없습니다.</div>';
    // 경고
    $('da-warnings').innerHTML = (s.warnings||[]).map(function(w){ return '<div class="alert" style="background:#fffbeb;color:#92400e;border:1px solid #fde68a;margin:10px 0 0;font-size:12.5px;line-height:1.6">⚠ '+esc(w)+'</div>'; }).join('');
    // 포함 항목
    $('da-coverage').innerHTML = s.coverage.map(function(c){
      return '<div style="display:flex;gap:8px;align-items:baseline;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:12.5px">'
        +'<span class="badge '+(c.have?'badge-green':'badge-gray')+'" style="min-width:48px;text-align:center">'+(c.have?'포함':'미포함')+'</span>'
        +'<b style="min-width:110px">'+esc(c.label)+'</b><span style="color:#64748b">'+esc(c.how)+'</span></div>';
    }).join('');
    // 요약
    var t=s.total;
    $('da-total').innerHTML = t
      ? '요약 기준 합계: 총비용 <b>₩'+num(t.cost)+'</b> · 구매완료 <b>'+num(t.buy)+'건</b> · 구매완료 매출 <b>₩'+num(t.sales)+'</b> · ROAS <b>'+t.roas.toFixed(2)+'%</b>'
      : '<span style="color:#b45309">성과 보고서 파일을 올리면 리포트를 만들 수 있습니다. 상품 성과 보고서만으로는 요약을 만들지 않습니다.</span>';
    // 비교
    var prevTxt = s.prev.since+' ~ '+s.prev.until;
    $('da-prev').innerHTML = s.prev.hasPerf
      ? '✅ '+esc(s.cmpLabel)+'('+esc(prevTxt)+') 원본이 있어 비교가 포함됩니다.'
      : 'ℹ '+esc(s.cmpLabel)+'('+esc(prevTxt)+') 원본이 없어 DA 비교는 빠집니다. <a href="#" onclick="betaGoPrev();return false" style="color:#6366f1;font-weight:600">그 기간 원본 올리기</a>';
    // 출력 버튼
    ['da','combined'].forEach(function(m){
      var enabled = s.hasReport && (m==='da' || s.hasSa);
      Array.prototype.forEach.call(document.querySelectorAll('[data-out="'+m+'"]'), function(b){ b.disabled=!enabled; b.style.opacity=enabled?'':'.45'; });
      var last = s.lastSend[m];
      $('da-last-'+m).textContent = last ? '최근 발송: '+last.created_at.slice(0,16)+' UTC · '+last.recipients : '';
    });
    $('da-combined-note').textContent = s.hasSa ? 'SA 데이터를 네이버에서 가져오므로 수 분 걸릴 수 있습니다.' : '이 광고주는 SA가 꺼져 있어 통합 리포트를 만들 수 없습니다.';
    $('da-recipients').textContent = s.recipients || '미등록 (광고주 설정에서 등록)';
    // 자동리포트 연동
    $('da-auto').innerHTML = s.auto.map(function(a){
      var period=a.since===a.until?a.since:a.since+' ~ '+a.until;
      var status, act='';
      if (!a.on) status='<span class="badge badge-gray">자동 발송 OFF</span>';
      else if (a.sent) status='<span class="badge badge-green">이번 주기 발송 완료</span>';
      else if (!a.wait) status='<span class="badge badge-gray">SA만 자동 발송</span>';
      else if (a.ready) status='<span class="badge badge-blue">발송 예약됨</span><div style="font-size:11px;color:#64748b;margin-top:3px">예정 시각이 지나면 다음 정각에 SA+DA로 발송</div>';
      else if (a.hasPerf) status='<span class="badge" style="background:#fef3c7;color:#92400e">확정 대기</span><div style="font-size:11px;color:#64748b;margin-top:3px">파일 '+a.files+'건 업로드됨</div>';
      else status='<span class="badge" style="background:#fef3c7;color:#92400e">DA 업로드 대기</span><div style="font-size:11px;color:#64748b;margin-top:3px">확정 전까지 자동 발송 보류</div>';
      if (a.on && a.wait && !a.sent) {
        act = a.ready
          ? '<button class="btn btn-outline btn-sm" onclick="betaReady(\''+a.type+'\',true)">예약 취소</button>'
          : '<button class="btn btn-primary btn-sm" '+(a.hasPerf?'':'disabled style="opacity:.45"')+' onclick="betaReady(\''+a.type+'\',false)">업로드 완료, 자동리포트 발송</button>';
        if (!a.hasPerf) act += ' <button class="btn btn-outline btn-sm" onclick="betaUseRange(\''+a.since+'\',\''+a.until+'\')">이 기간으로 업로드</button>';
      }
      var toggle = a.on
        ? '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-size:12.5px"><input type="checkbox" '+(a.wait?'checked':'')+' '+(a.sent?'disabled':'')+' onchange="betaWait(\''+a.type+'\',this)" style="width:15px;height:15px"> DA 업로드 후 발송</label>'
        : '-';
      return '<tr><td><b>'+a.label+'</b></td><td style="font-size:12.5px;white-space:nowrap">'+esc(period)+'</td><td>'+toggle+'</td><td>'+status+'</td><td>'+act+'</td></tr>';
    }).join('');
    // 이력
    $('da-periods').innerHTML = s.periods.length ? s.periods.map(function(p){
      return '<button class="btn btn-outline btn-sm" style="margin:0 6px 6px 0" onclick="betaUseRange(\''+p.since+'\',\''+p.until+'\')">'+esc(p.since)+' ~ '+esc(p.until)+' · '+p.files+'건</button>';
    }).join('') : '<span style="color:#94a3b8;font-size:12.5px">아직 없습니다.</span>';
  }

  // ── 업로드 ──
  function toB64(buf){ var bytes=new Uint8Array(buf), out='', chunk=0x8000; for (var i=0;i<bytes.length;i+=chunk) out+=String.fromCharCode.apply(null, bytes.subarray(i,i+chunk)); return btoa(out); }
  async function encodeFile(file){
    var raw = await file.arrayBuffer();
    if (window.CompressionStream) {
      var stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
      return { data: toB64(await new Response(stream).arrayBuffer()), gz: true };
    }
    return { data: toB64(raw), gz: false };
  }
  async function uploadOne(file){
    var enc = await encodeFile(file);
    if (enc.data.length > 4300000) return { ok:false, error:'파일이 너무 큽니다. 분석 단위나 기간 단위를 줄여 내려받아 주세요.' };
    var r = range();
    var res = await fetch('/smart-sa/api/da-upload/file', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ accountId: CFG.accountId, since:r.since, until:r.until, fileName:file.name, data:enc.data, gz:enc.gz }) });
    return res.json();
  }
  window.betaFiles = async function(fileList){
    var files = Array.prototype.slice.call(fileList||[]);
    if (!files.length) return;
    var r=range();
    if (!r.since||!r.until||r.since>r.until) { msg('기간을 먼저 선택해 주세요.','err'); return; }
    var lines=[], hasErr=false;
    for (var i=0;i<files.length;i++) {
      var f=files[i];
      msg('업로드 중... ('+(i+1)+'/'+files.length+') '+f.name);
      try {
        var j = await uploadOne(f);
        if (!j.ok && j.detected && confirm(j.error+'\n\n기간을 파일 기준('+j.detected.since+' ~ '+j.detected.until+')으로 바꿔 다시 올릴까요?')) {
          $('da-since').value=j.detected.since; $('da-until').value=j.detected.until;
          j = await uploadOne(f);
        }
        if (j.ok) lines.push('✅ '+f.name+' ('+(j.kind==='product'?'상품 성과':'성과')+', '+num(j.rows)+'행'+(j.replaced?', 기존 파일 교체':'')+')');
        else { hasErr=true; lines.push('❌ '+f.name+': '+j.error); }
      } catch(e) { hasErr=true; lines.push('❌ '+f.name+': '+e.message); }
    }
    msg(lines.join('  /  '), hasErr?'err':'ok');
    $('da-input').value='';
    refresh();
  };
  window.betaDelete = async function(id){
    if (!confirm('이 파일을 삭제할까요?')) return;
    var res = await fetch('/smart-sa/api/da-upload/file/'+id+'?accountId='+encodeURIComponent(CFG.accountId), { method:'DELETE' });
    var j = await res.json();
    if (!j.ok) msg(j.error,'err'); else { msg('삭제했습니다.'); refresh(); }
  };
  window.betaGoPrev = function(){ setPeriod(state.prev.since, state.prev.until); window.scrollTo({top:0,behavior:'smooth'}); };
  window.betaUseRange = function(a,b){ setPeriod(a,b); window.scrollTo({top:0,behavior:'smooth'}); };

  // ── 출력 ──
  window.betaPreview = function(mode){ window.open('/smart-sa/api/da-upload/preview?'+qs('mode='+mode), '_blank'); };
  async function download(url, btn){
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled=true; btn.textContent='생성 중...'; }
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      var name = 'report.xlsx';
      var cd = res.headers.get('Content-Disposition')||'';
      var m = cd.match(/filename\*=UTF-8''([^;]+)/); if (m) name = decodeURIComponent(m[1]);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    } catch(e) { msg('엑셀 생성 실패: '+e.message,'err'); }
    if (btn) { btn.disabled=false; btn.textContent=old; }
  }
  window.betaExcel = function(mode, btn){ download('/smart-sa/api/da-upload/excel?'+qs('mode='+mode), btn); };
  window.betaSend = async function(mode, btn){
    var r=range(); var label = mode==='combined'?'SA+DA 통합':'DA 단독';
    if (!state.recipients) { msg('수신 이메일이 없습니다. 광고주 설정에서 등록해 주세요.','err'); return; }
    if (!confirm(label+' 리포트를 광고주에게 발송합니다.\n\n기간: '+r.since+' ~ '+r.until+'\n수신: '+state.recipients+'\n\n진행할까요?')) return;
    var old=btn.textContent; btn.disabled=true; btn.textContent='발송 중...';
    async function post(confirmResend){
      var res = await fetch('/smart-sa/api/da-upload/send', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ accountId: CFG.accountId, since:r.since, until:r.until, mode:mode, confirmResend:confirmResend }) });
      return res.json();
    }
    try {
      var j = await post(false);
      if (!j.ok && j.needConfirm && confirm(j.error)) j = await post(true);
      if (j.ok) msg(label+' 리포트: '+j.message);
      else if (!j.needConfirm) msg('발송 실패: '+j.error,'err');
      else msg('발송을 취소했습니다.');
    } catch(e) { msg('발송 실패: '+e.message,'err'); }
    btn.disabled=false; btn.textContent=old;
    refresh();
  };

  // ── 자동리포트 연동 ──
  window.betaWait = async function(type, el){
    if (el.checked && !confirm('이 광고주의 해당 자동리포트는 DA 업로드를 확정할 때까지 발송되지 않습니다.\n\n켤까요?')) { el.checked=false; return; }
    var res = await fetch('/smart-sa/api/da-upload/wait', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ accountId: CFG.accountId, type:type, on:el.checked }) });
    var j = await res.json();
    if (!j.ok) msg(j.error,'err');
    refresh();
  };
  window.betaReady = async function(type, cancel){
    var a = state.auto.filter(function(x){ return x.type===type; })[0];
    if (!cancel && !confirm(a.label+' 자동리포트를 SA+DA로 발송 예약합니다.\n\n기간: '+a.since+' ~ '+a.until+'\n수신: '+state.recipients+'\n\n예정 시각이 지나면 다음 정각에 발송됩니다. 진행할까요?')) return;
    var res = await fetch('/smart-sa/api/da-upload/ready', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ accountId: CFG.accountId, type:type, cancel:!!cancel }) });
    var j = await res.json();
    if (!j.ok) msg(j.error,'err'); else msg(cancel?'발송 예약을 취소했습니다.':'발송 예약했습니다.');
    refresh();
  };

  // ── 초기화 ──
  $('da-last-month').onclick=function(){ var p=lastMonth(); setPeriod(p[0],p[1]); };
  $('da-last-week').onclick=function(){ var p=lastWeek(); setPeriod(p[0],p[1]); };
  $('da-since').onchange=refresh; $('da-until').onchange=refresh;
  var zone=$('da-drop');
  zone.ondragover=function(e){ e.preventDefault(); zone.style.background='#eef2ff'; };
  zone.ondragleave=function(){ zone.style.background=''; };
  zone.ondrop=function(e){ e.preventDefault(); zone.style.background=''; window.betaFiles(e.dataTransfer.files); };
  var p=lastMonth(); setPeriod(p[0],p[1]);
})();
`;

function renderBetaPage({ account, escHtml, guide }) {
  if (!account) {
    return '<div class="alert alert-info">좌측 상단에서 광고주를 선택해 주세요.</div>';
  }
  const cfg = JSON.stringify({ accountId: account.id }).replace(/</g, '\\u003c');
  return `
    <div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#3730a3;line-height:1.6">
      <b>BETA</b> · 테스트용 화면입니다. 기존 자동리포트 메뉴와 자동 발송은 그대로이며, 관리자에게만 보입니다.
      아래 메일 발송과 자동리포트 연동은 실제 광고주 수신 이메일로 나가니 주의해 주세요.
    </div>
    <p style="color:#64748b;font-size:13px;margin-bottom:12px">현재 광고주: <strong>${escHtml(account.name)}</strong></p>

    <div class="tab-bar" style="margin-bottom:16px">
      <button class="tab-btn dash-tab" id="beta-btn-sa" onclick="betaTab('sa')">🔍 SA 리포트</button>
      <button class="tab-btn dash-tab" id="beta-btn-da" onclick="betaTab('da')">📺 DA 리포트</button>
    </div>

    <div id="beta-tab-sa" style="display:none">
      <div class="card"><div class="card-body" style="font-size:13px;line-height:1.7">
        ${account.has_sa === false ? '이 광고주는 SA가 활성화되지 않았습니다.' : `
        <p style="margin-bottom:12px">SA 리포트는 네이버 API로 자동 수집합니다. 데이터와 자동 발송은 기존과 같습니다.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          <button class="btn btn-outline btn-sm" onclick="betaSaExcel('daily',this)">일간 엑셀</button>
          <button class="btn btn-outline btn-sm" onclick="betaSaExcel('weekly',this)">주간 엑셀</button>
          <button class="btn btn-outline btn-sm" onclick="betaSaExcel('monthly',this)">월간 엑셀</button>
        </div>
        <a href="/smart-sa/reports" style="color:#6366f1;font-weight:600">기간 선택·메일 발송·시트 설정은 자동리포트 메뉴에서 →</a>`}
      </div></div>
    </div>

    <div id="beta-tab-da" style="display:none">
      <div id="da-msg"></div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">1. 기간 선택</span><span id="da-period-type" style="font-size:12px;color:#64748b;margin-left:auto"></span></div>
        <div class="card-body">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:2px">시작일</label><input type="date" id="da-since" style="width:160px"></div>
            <div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:2px">종료일</label><input type="date" id="da-until" style="width:160px"></div>
            <button class="btn btn-outline btn-sm" id="da-last-month">지난달</button>
            <button class="btn btn-outline btn-sm" id="da-last-week">지난주</button>
          </div>
          <p style="margin:10px 0 0;font-size:12px;color:#b45309">GFA에서 조회한 기간과 똑같이 선택해 주세요. 기간 단위가 '전체'인 파일에는 날짜가 없어 자동으로 확인할 수 없습니다.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">2. GFA 원본 업로드</span></div>
        <div class="card-body">
          <div id="da-drop" style="border:2px dashed #cbd5e1;border-radius:10px;padding:22px;text-align:center;margin-bottom:14px">
            <div style="font-size:13px;color:#475569;margin-bottom:8px">CSV 또는 xlsx 파일을 끌어다 놓거나 선택하세요 (여러 개 가능)</div>
            <input type="file" id="da-input" multiple accept=".csv,.xlsx,.tsv,.txt" onchange="betaFiles(this.files)" style="max-width:320px">
            <div style="font-size:12px;color:#64748b;margin-top:8px">구매완료 수 · 구매완료 전환매출액 열이 꼭 있어야 합니다. 같은 구성의 파일을 다시 올리면 교체됩니다.</div>
          </div>
          <div id="da-files"></div>
          <div id="da-warnings"></div>
          <p id="da-total" style="margin:12px 0 4px;font-size:13px"></p>
          <p id="da-prev" style="margin:0 0 12px;font-size:12.5px;color:#475569"></p>
          <details open>
            <summary style="cursor:pointer;font-size:13px;font-weight:600;margin-bottom:6px">리포트 포함 항목 (올린 보고서에 따라 달라집니다)</summary>
            <div id="da-coverage"></div>
          </details>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">3. 리포트 만들기</span><span style="font-size:12px;color:#64748b;margin-left:auto">수신: <span id="da-recipients"></span></span></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">
            <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <h3 style="font-weight:700;margin-bottom:4px">DA 단독 리포트</h3>
              <p style="font-size:12px;color:#64748b;margin-bottom:12px">업로드한 데이터만으로 만듭니다.</p>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn btn-outline btn-sm" data-out="da" onclick="betaPreview('da')">미리보기</button>
                <button class="btn btn-outline btn-sm" data-out="da" onclick="betaExcel('da',this)">엑셀 다운로드</button>
                <button class="btn btn-primary btn-sm" data-out="da" onclick="betaSend('da',this)">메일 발송</button>
              </div>
              <div id="da-last-da" style="font-size:11px;color:#64748b;margin-top:8px"></div>
            </div>
            <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px">
              <h3 style="font-weight:700;margin-bottom:4px">SA+DA 통합 리포트</h3>
              <p style="font-size:12px;color:#64748b;margin-bottom:12px">두 매체를 합친 통합 요약 시트 + SA 시트 + DA 시트. <span id="da-combined-note"></span></p>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn btn-outline btn-sm" data-out="combined" onclick="betaPreview('combined')">미리보기</button>
                <button class="btn btn-outline btn-sm" data-out="combined" onclick="betaExcel('combined',this)">엑셀 다운로드</button>
                <button class="btn btn-primary btn-sm" data-out="combined" onclick="betaSend('combined',this)">메일 발송</button>
              </div>
              <div id="da-last-combined" style="font-size:11px;color:#64748b;margin-top:8px"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">4. 자동리포트에 DA 포함</span></div>
        <div class="card-body">
          <p style="font-size:12.5px;color:#475569;margin-bottom:10px;line-height:1.6">'DA 업로드 후 발송'을 켜면 해당 자동리포트를 보류합니다. 대상 기간 원본을 올리고 확정하면, 예정 시각이 지난 뒤 다음 정각에 SA+DA 통합 리포트로 한 번 발송됩니다.</p>
          <table>
            <thead><tr><th>유형</th><th>대상 기간</th><th>설정</th><th>상태</th><th></th></tr></thead>
            <tbody id="da-auto"></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">업로드한 기간</span></div>
        <div class="card-body" id="da-periods"></div>
      </div>
    </div>

    <script>window.BETA_CFG = ${cfg};</script>
    <script>${PAGE_SCRIPT}</script>
  `;
}

module.exports = { renderBetaPage };

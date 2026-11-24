/**
 * 보안 계층 초기화 (앱 시작 시 1회)
 *  - 감사 로그·시도 제한 테이블 준비
 *  - 암호화 키 확인 후, 평문으로 남은 민감정보를 백그라운드에서 암호화
 */
const guard = require('./guard');
const secretBox = require('./secretBox');

async function initSecurity() {
  const { pool } = require('../db/database');
  try { await guard.ensureSchema(pool); } catch (e) { console.warn('보안 테이블 준비 실패:', e.message); }
  try {
    const st = await secretBox.initSecretBox(pool);
    console.log(`🔐 민감정보 암호화: ${st.active ? '사용' : '꺼짐'} — ${st.reason}`);
    if (st.active) secretBox.sealPlaintextRows(pool).catch(e => console.warn('민감정보 암호화 실패:', e.message));
  } catch (e) { console.warn('암호화 초기화 실패:', e.message); }
}

module.exports = { initSecurity };

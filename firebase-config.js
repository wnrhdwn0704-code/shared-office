/* =========================================================================
 * 합동 비서실 — Firebase 웹앱 설정
 * -------------------------------------------------------------------------
 * 아래 값을 Firebase 콘솔에서 복사해 그대로 붙여넣으면 됩니다.
 *
 *   1) https://console.firebase.google.com 접속 → 프로젝트 만들기
 *   2) 프로젝트 개요 화면에서 웹 앱(</>) 추가
 *   3) "SDK 설정 및 구성"에 나오는 firebaseConfig 값을 복사
 *   4) 왼쪽 메뉴 Build > Realtime Database 에서 데이터베이스 만들기
 *      (위치: 싱가포르 asia-southeast1 권장)
 *   5) 아래 값들을 채우고 저장
 *
 * ⚠️ 이 파일은 GitHub Public 저장소에 그대로 공개됩니다.
 *    여기 들어가는 값(apiKey, databaseURL 등)은 웹앱을 식별하는 공개 정보이며,
 *    Firebase 보안은 아래 파일이 아니라 "Realtime Database 보안 규칙"으로 지킵니다.
 *    카드번호·비밀번호 같은 개인 키를 이 파일에 넣지 마세요.
 * ========================================================================= */

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCtuwfW7YinvmHjtEtztxMvTgi29Ps5Msk",
  authDomain: "shared-office-8347e.firebaseapp.com",
  databaseURL: "https://shared-office-8347e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "shared-office-8347e",
  storageBucket: "shared-office-8347e.firebasestorage.app",
  messagingSenderId: "645735882954",
  appId: "1:645735882954:web:ada18f3b5871ef81c91433"
};

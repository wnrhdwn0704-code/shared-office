/* 합동 비서실 — 알림 전용 서비스 워커
 *  - 페이지에서 new Notification()을 쓸 수 없는 브라우저(안드로이드 크롬 등)에서
 *    등록된 서비스 워커로 시스템 알림을 띄운다.
 *  - 캐시·오프라인 처리는 하지 않는다(앱 파일은 항상 네트워크에서 받는다).
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.indexOf(target.split('#')[0]) === 0 && 'focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Web Push on this device. The service worker (sw.js) shows the notification; the backend keeps the subscription and
// pushes when a session finishes, stops with an error, or waits for an answer.
const base = () => new URL('.', location.href).href;

async function api(path, body) {
  const cfg = await (await fetch(`${base()}api/config`, { cache: 'no-store' })).json();
  const r = await fetch(`${base()}api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-mc-key': cfg.key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
  return r.json();
}

const keyBytes = (b64url) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (a, b) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);

// iOS offers Web Push only to a web app added to the home screen (iOS 16.4+), never to a Safari tab.
export function pushSupport() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !standalone) return { ok: false, why: '홈 화면에 추가한 앱에서 켤 수 있습니다' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return { ok: false, why: '이 브라우저는 푸시 알림을 지원하지 않습니다' };
  if (Notification.permission === 'denied') return { ok: false, why: '알림이 차단되어 있습니다. 브라우저나 시스템 설정에서 허용해 주세요' };
  return { ok: true, why: '' };
}

export async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration(base());
  return reg ? reg.pushManager.getSubscription() : null;
}

// Called straight from the tap: iOS asks for permission only inside a user gesture.
export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('알림을 허용하지 않았습니다');
  const reg = await navigator.serviceWorker.register(`${base()}sw.js`);
  await navigator.serviceWorker.ready;
  const key = keyBytes((await api('push')).publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key (push.json recreated) can no longer receive; replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('push/subscribe', { subscription: sub.toJSON() });
  return sub;
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export async function testPush() {
  const sub = await currentSub();
  if (!sub) throw new Error('이 기기는 푸시 알림이 꺼져 있습니다');
  return api('push/test', { endpoint: sub.endpoint });
}

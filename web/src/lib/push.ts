import { notifyApi } from '../api/client'

/** What this browser can do about notifications. */
export type PushState = 'unsupported' | 'denied' | 'off' | 'on'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul'

async function registration() {
  return navigator.serviceWorker.register('/sw.js')
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Asks for permission, subscribes this browser and tells the server. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  const { enabled, publicKey } = await notifyApi.pushKey()
  if (!enabled || !publicKey) throw new Error('이 서버에서는 브라우저 알림을 보낼 수 없어요')
  if ((await Notification.requestPermission()) !== 'granted') return Notification.permission === 'denied' ? 'denied' : 'off'
  const reg = await registration()
  await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await notifyApi.subscribe(sub.toJSON(), browserTimezone())
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await notifyApi.unsubscribe(sub.endpoint).catch(() => {})
    await sub.unsubscribe()
  }
  return 'off'
}

let refreshed = false

/** Once per page load: keeps the worker registered (and up to date) when notifications are on. */
export async function refreshPush() {
  if (refreshed || !pushSupported() || Notification.permission !== 'granted') return
  refreshed = true
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  if (sub) await notifyApi.subscribe(sub.toJSON(), browserTimezone()).catch(() => {})
}

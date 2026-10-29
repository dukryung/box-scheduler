export const dateText = (iso: string | null) => {
  if (!iso) return '–'
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

export const dateTimeText = (iso: string | null) => {
  if (!iso) return '–'
  const d = new Date(iso)
  return `${dateText(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "3분 전", "2일 전" — for last-seen columns. */
export const ago = (iso: string | null) => {
  if (!iso) return '–'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`
  return dateText(iso)
}

/** A short device label from a user agent. */
export const deviceText = (ua: string) => {
  if (!ua) return '알 수 없는 기기'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40)
}

export const ACTION_LABEL: Record<string, string> = {
  login: '로그인',
  'login-failed': '로그인 실패',
  'totp-failed': '인증 코드 실패',
  'totp-enabled': '2단계 인증 설정',
  'password-changed': '비밀번호 변경',
  'user-suspend': '사용자 정지',
  'user-restore': '정지 해제',
  'user-delete': '사용자 삭제',
  'user-signout': '강제 로그아웃',
  'user-reset-link': '재설정 링크 발급',
  'admin-create': '관리자 생성',
  'admin-update': '관리자 변경',
  'admin-reset': '관리자 초기화',
  'admin-disable': '관리자 중지',
  'admin-enable': '관리자 사용',
  'service-ai': '서비스 AI 설정',
  // From before the admin layer (app-account admins)
  role: '권한 변경',
  suspend: '사용자 정지',
  restore: '정지 해제',
  delete: '사용자 삭제',
  'reset-link': '재설정 링크 발급',
  'owner-move': '소유자 데이터 이전',
}

export const AI_FEATURE: Record<string, string> = { plan: 'AI 일정 제안', revise: 'AI 제안 수정', breakdown: '업무 나누기', request: '말로 요청하기', tidy: '음성 정리' }

export const btn = {
  primary: 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40',
  secondary:
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink-2 hover:bg-subtle disabled:opacity-40',
  danger: 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-danger px-3.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40',
  ghost: 'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm text-ink-2 hover:bg-subtle',
}

export const field =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-accent'

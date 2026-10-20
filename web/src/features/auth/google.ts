import { useEffect, useState } from 'react'
import { authApi } from '../../api/client'

let cached: Promise<boolean> | null = null
/** Whether the server has Google sign-in set up (asked once per page load). */
export function useGoogleEnabled() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    cached ??= authApi.providers().then((p) => p.google, () => false)
    void cached.then(setOn)
  }, [])
  return on
}

const ERRORS: Record<string, string> = {
  google_cancel: 'Google 로그인을 취소했어요.',
  google_state: 'Google 로그인이 만료됐어요. 다시 시도해 주세요.',
  google_failed: 'Google에서 계정을 확인하지 못했어요. 다시 시도해 주세요.',
  google_off: 'Google 로그인이 아직 설정되지 않았어요.',
  google_email_exists: '이 이메일로 가입된 계정이 이미 있어요. 비밀번호로 로그인한 뒤 설정에서 Google을 연결해 주세요.',
  setup_done: '소유자 계정은 이미 만들어졌어요. 로그인해 주세요.',
  suspended: '이용이 정지된 계정이에요.',
  too_many: '가입 시도가 너무 많아요. 잠시 후 다시 해 주세요.',
}
export const googleError = (code: string | null) => (code ? (ERRORS[code] ?? '로그인하지 못했어요. 다시 시도해 주세요.') : null)

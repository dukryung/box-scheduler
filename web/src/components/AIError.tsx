import { Link } from 'react-router'

/** An AI error; when no AI is connected yet, it links to 설정 → AI 연결. */
export function AIError({ error }: { error: string }) {
  const needsSetup = error.includes('AI 연결') || error.includes('AI를 연결')
  return (
    <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-3 text-sm text-danger">
      {error}
      {needsSetup && (
        <>
          {' '}
          <Link to="/settings" className="font-semibold underline">
            설정 열기
          </Link>
        </>
      )}
    </p>
  )
}

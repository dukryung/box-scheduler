import { describe, expect, it } from 'vitest'
import { cleanTranscript } from './transcript'

describe('cleanTranscript', () => {
  it('drops standalone fillers and extra spaces', () => {
    expect(cleanTranscript('음 헬스장   8시로 어 미뤄줘')).toBe('헬스장 8시로 미뤄줘')
    expect(cleanTranscript('저기, 그러니까 내일 3시에 치과 넣어줘.')).toBe('내일 3시에 치과 넣어줘')
  })

  it('keeps words that only start with a filler syllable', () => {
    expect(cleanTranscript('어머니 생신 저녁 7시에 추가해줘')).toBe('어머니 생신 저녁 7시에 추가해줘')
    expect(cleanTranscript('그 회의 취소해줘')).toBe('회의 취소해줘')
  })

  it('tidies punctuation spacing', () => {
    expect(cleanTranscript('코드 리뷰 완료했어 , 그리고 헬스장 미뤄줘 ')).toBe('코드 리뷰 완료했어, 그리고 헬스장 미뤄줘')
  })
})

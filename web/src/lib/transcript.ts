// Fillers people say while thinking; dropped when they stand alone as a word.
const FILLERS = new Set(['음', '음…', '음음', '어', '어…', '아', '그', '저', '저기', '뭐지', '뭐냐', '그러니까', '그니까', '약간', '이제'])

/**
 * Tidies a speech transcript before it goes into the request field:
 * drops filler words, collapses spaces, removes stray punctuation spacing.
 */
export function cleanTranscript(text: string): string {
  const words = text
    .replace(/[.。]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => !FILLERS.has(w.replace(/[,.…]+$/u, '')))
  return words
    .join(' ')
    .replace(/\s+([,.?!])/gu, '$1')
    .replace(/^[,\s]+|[,\s]+$/gu, '')
}

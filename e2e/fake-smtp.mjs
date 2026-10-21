// A tiny SMTP server for tests: accepts every message (no TLS, no auth) and keeps it.
import { createServer } from 'node:net'

export function startFakeSMTP(port = 3197) {
  const inbox = []
  const server = createServer((sock) => {
    let data = null
    let msg = { from: '', to: [] }
    let buf = ''
    sock.write('220 fake-smtp ready\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (data !== null) {
          if (line === '.') {
            const raw = data.join('\n')
            const subject = decodeSubject(raw.match(/^Subject: (.*)$/m)?.[1] ?? '')
            inbox.push({ ...msg, subject, raw, link: raw.match(/https?:\/\/[^\s"<]+\/invite\/[A-Za-z0-9_-]+/)?.[0] })
            data = null
            msg = { from: '', to: [] }
            sock.write('250 queued\r\n')
          } else data.push(line.startsWith('..') ? line.slice(1) : line)
          continue
        }
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-smtp\r\n250 SIZE 10000000\r\n')
        else if (cmd === 'MAIL') (msg.from = line), sock.write('250 ok\r\n')
        else if (cmd === 'RCPT') msg.to.push(line.match(/<(.*)>/)?.[1] ?? ''), sock.write('250 ok\r\n')
        else if (cmd === 'DATA') (data = []), sock.write('354 go ahead\r\n')
        else if (cmd === 'QUIT') sock.end('221 bye\r\n')
        else sock.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(port, () => resolve({ inbox, server })))
}

// "=?utf-8?q?...?=" words, as Go's mime.QEncoding writes them.
function decodeSubject(s) {
  // Whitespace between two encoded words is not part of the text (RFC 2047).
  s = s.replace(/\?=\s+=\?/g, '?==?')
  return s.replace(/=\?utf-8\?q\?(.*?)\?=/gi, (_, q) =>
    Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
  )
}

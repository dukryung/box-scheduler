// A stand-in push service for tests: subscriptions made here point the API at
// http://host.docker.internal:3196/push/<id>; it receives each Web Push
// message, decrypts it (RFC 8291, aes128gcm) with the subscription's keys and
// keeps the JSON payload. Paths under /gone/ answer 410 like an expired one.
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

export function startFakePush(port = 3196) {
  const subs = new Map() // id → { ecdh, auth, pub }
  const received = [] // { id, payload, headers }
  let n = 0

  const decrypt = (sub, body) => {
    const salt = body.subarray(0, 16)
    const idlen = body[20]
    const asPublic = body.subarray(21, 21 + idlen)
    const cipher = body.subarray(21 + idlen)
    const secret = sub.ecdh.computeSecret(asPublic)
    const prkKey = hmac(sub.auth, secret)
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), sub.pub, asPublic, Buffer.from([1])]))
    const prk = hmac(salt, ikm)
    const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
    const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(cipher.subarray(cipher.length - 16))
    let plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()])
    let end = plain.length - 1
    while (end >= 0 && plain[end] === 0) end--
    plain = plain.subarray(0, end) // drop the 0x02 delimiter and padding
    return JSON.parse(plain.toString('utf8'))
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const [, kind, id] = req.url.split('/')
      if (kind === 'gone') {
        received.push({ id, gone: true })
        res.writeHead(410).end()
        return
      }
      const sub = subs.get(id)
      if (kind !== 'push' || !sub) {
        res.writeHead(404).end()
        return
      }
      try {
        received.push({ id, payload: decrypt(sub, Buffer.concat(chunks)), headers: req.headers })
        res.writeHead(201).end()
      } catch (e) {
        received.push({ id, error: String(e) })
        res.writeHead(400).end()
      }
    })
  })
  server.listen(port)

  return {
    server,
    received,
    /** A browser-like subscription whose messages come back here. */
    subscription(kind = 'push') {
      const id = `s${++n}`
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      const auth = randomBytes(16)
      subs.set(id, { ecdh, auth, pub: ecdh.getPublicKey() })
      return { id, endpoint: `http://host.docker.internal:${port}/${kind}/${id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } }
    },
    async waitFor(pred, ms = 8000) {
      for (let t = 0; t < ms; t += 100) {
        const hit = received.find(pred)
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    },
  }
}

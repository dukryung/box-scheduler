// Stand-in for Google's OAuth endpoints in tests. The browser visits /auth (which
// redirects straight back), and the API server calls /token from inside Docker.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const CLIENT_ID = 'e2e-client'
const CLIENT_SECRET = 'e2e-secret'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * Starts the fake on port. Before each sign-in, set `fake.next` to the Google
 * account to answer with ({ sub, email, name, verified? }) or { cancel: true }.
 */
export function startFakeGoogle(port = 3199) {
  const codes = new Map()
  const fake = { next: null, tokenCalls: 0, server: null }
  fake.server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    if (url.pathname === '/auth') {
      const q = url.searchParams
      const back = new URL(q.get('redirect_uri'))
      back.searchParams.set('state', q.get('state'))
      if (!fake.next || fake.next.cancel || q.get('client_id') !== CLIENT_ID) {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = randomBytes(12).toString('hex')
        codes.set(code, { ...fake.next, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { Location: back.toString() }).end()
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      fake.tokenCalls++
      let body = ''
      for await (const chunk of req) body += chunk
      const f = new URLSearchParams(body)
      const c = codes.get(f.get('code'))
      codes.delete(f.get('code'))
      const pkce = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge
      if (!c || f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET || !pkce || f.get('redirect_uri') !== c.redirect) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid_grant"}')
        return
      }
      const claims = {
        iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce: c.nonce,
        sub: c.sub, email: c.email, email_verified: c.verified ?? true, name: c.name ?? '',
      }
      const idToken = `${b64({ alg: 'none' })}.${b64(claims)}.`
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: idToken, access_token: 'x' }))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => fake.server.listen(port, () => resolve(fake)))
}

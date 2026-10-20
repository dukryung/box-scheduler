// Stand-ins for an account's own AI in tests: an OpenAI-compatible local server
// (/v1/models, /v1/chat/completions) and the Anthropic Messages API (/anthropic/v1/messages).
// Answers follow the requested JSON schema; tidy answers are tagged [local] or [anthropic]
// so tests can tell which AI a feature used.
import { createServer } from 'node:http'

export const GOOD_KEY = 'sk-ant-e2e-good-key-0042'
// slow:1b takes 2 seconds per answer (for queue tests); qwen3 answers think first.
export const LOCAL_MODELS = ['qwen3:8b', 'llama3.2:3b', 'slow:1b']

function answer(schema, prompt, who) {
  const props = schema?.properties ?? {}
  if ('text' in props) return { text: `[${who}] ${prompt.replace(/(^|\s)(음|어|그)(?=\s)/g, '').trim()}` }
  if ('ops' in props) return { reply: `${who} 응답`, clarification: '', ops: [] }
  if ('tasks' in props) return { tasks: [], notes: `${who} 계획` }
  return {}
}

export function startFakeAI(port = 3198) {
  const fake = { calls: [], server: null }
  fake.server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : {}
    const json = (status, v) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    const path = new URL(req.url, 'http://x').pathname

    if (path === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data: LOCAL_MODELS.map((id) => ({ id, object: 'model' })) })
    if (path === '/v1/chat/completions') {
      fake.calls.push({ who: 'local', model: body.model })
      if (!LOCAL_MODELS.includes(body.model)) return json(404, { error: { message: `model "${body.model}" not found` } })
      const schema = body.response_format?.json_schema?.schema
      const prompt = body.messages?.find((m) => m.role === 'user')?.content ?? ''
      if (body.model === 'slow:1b') await new Promise((r) => setTimeout(r, 2000))
      let content = JSON.stringify(answer(schema, prompt.replace(/ \/no_think$/, ''), 'local'))
      if (body.model.startsWith('qwen3')) content = `<think>생각 중</think>\n${content}`
      fake.calls.push({ who: 'local-done', model: body.model, auth: req.headers.authorization ?? '' })
      return json(200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
    }
    if (path === '/anthropic/v1/messages') {
      fake.calls.push({ who: 'anthropic', model: body.model })
      if (req.headers['x-api-key'] !== GOOD_KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
      const prompt = body.messages?.[0]?.content?.[0]?.text ?? ''
      const text = JSON.stringify(answer(body.output_config?.format?.schema, prompt, 'anthropic'))
      return json(200, {
        id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    json(404, { error: { message: 'not found' } })
  })
  return new Promise((resolve) => fake.server.listen(port, () => resolve(fake)))
}

/**
 * Dump river's raw SSE frames for one request, without the decoder in between.
 *
 * Exists because guessing the framing produced two wrong fixes: the usage frame
 * is the one place where river's actual bytes disagree with what the docs
 * suggest, and every layer between `fetch` and the decoder can plausibly be
 * blamed. Printing the frames settles it.
 *
 *   RIVERAI_API_KEY=... node --import tsx tools/dump-frames.ts
 */

import process from 'node:process'

const key = process.env.RIVERAI_API_KEY?.trim()
if (key === undefined || key === '') {
  console.error('RIVERAI_API_KEY is not set.')
  process.exit(2)
}

const body = {
  model: process.env.RIVER_MODEL ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
  stream: true,
  max_tokens: 32,
}

const response = await fetch('https://api.river.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  },
  body: JSON.stringify(body),
})

console.log(`status ${response.status} ${response.statusText}`)
console.log('--- headers ---')
for (const [name, value] of response.headers) console.log(`${name}: ${value}`)
console.log('--- frames ---')
if (response.body === null) {
  console.log('no body')
  process.exit(1)
}

const decoder = new TextDecoder()
let index = 0
for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
  const text = decoder.decode(piece, { stream: true })
  console.log(`[chunk ${index++} ${text.length}b] ${JSON.stringify(text)}`)
}
console.log('--- end ---')

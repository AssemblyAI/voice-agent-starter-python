// Lifecycle tests for the browser client, run against the real client code
// with fake browser APIs. No microphone, network or API key needed.
//
//   node --test test/browser-client.test.mjs
//
// CLIENT_SOURCE=<path> points it at another app.js or server.mjs.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

function clientPath() {
  if (process.env.CLIENT_SOURCE) return process.env.CLIENT_SOURCE
  // The Python starter serves app.js; the JS starter embeds it in server.mjs.
  const app = fileURLToPath(new URL('../deployment/browser/app.js', import.meta.url))
  return existsSync(app) ? app : fileURLToPath(new URL('../deployment/browser/server.mjs', import.meta.url))
}

function clientCode(file) {
  const text = readFileSync(file, 'utf8')
  if (!file.endsWith('.mjs')) return text
  // Same text server.mjs serves as /app.js: the clientApp function, called.
  const start = text.indexOf('function clientApp() {')
  const end = text.indexOf('\n}\n\n// --- page', start)
  assert.ok(start >= 0 && end > start, `no clientApp in ${file}`)
  return '(' + text.slice(start, end + 2) + ')();'
}

const CODE = clientCode(clientPath())

class Element {
  constructor() {
    this.children = []
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.disabled = false
    this.scrollTop = this.scrollHeight = this.clientHeight = 0
    const classes = new Set()
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    }
  }
  get firstChild() { return this.children[0] }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1) }
  addEventListener() {}
  querySelector(selector) {
    const name = selector.slice(1)
    for (const child of this.children) {
      if (child.className.split(' ').includes(name)) return child
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
}

function page({ token = true, failMic = false, failWorklet = 0, holdClose = false } = {}) {
  const elements = new Map()
  const sockets = [], contexts = [], tracks = [], nodes = [], timers = []
  const pendingCloses = []
  let addModuleCalls = 0

  class FakeWebSocket {
    constructor(url) { this.url = String(url); this.readyState = 0; this.sent = []; sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    // A browser delivers close later, as an event; tests fire it when they choose.
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.onopen?.() }
    receive(type, extra = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...extra }) }) }
    types() { return this.sent.map((event) => event.type) }
  }

  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; contexts.push(this) }
    get audioWorklet() {
      return {
        addModule: async () => {
          addModuleCalls += 1
          if (addModuleCalls === failWorklet) throw new Error('worklet failed')
        },
      }
    }
    resume() { return Promise.resolve() }
    close() {
      this.state = 'closed'
      return holdClose ? new Promise((resolve) => pendingCloses.push(resolve)) : Promise.resolve()
    }
    createMediaStreamSource() { return { connect() {} } }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name) { this.name = name; this.port = { onmessage: null, postMessage() {} }; nodes.push(this) }
    connect() {}
  }

  const sandbox = {
    AGENT: { id: 'agent-test', name: 'Test agent' },
    document: {
      getElementById: (id) => elements.get(id) ?? elements.set(id, new Element()).get(id),
      createElement: () => new Element(),
      body: new Element(),
    },
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [],
        addEventListener() {},
        getUserMedia: async () => {
          if (failMic) throw new Error('permission denied')
          const track = { readyState: 'live', stop() { this.readyState = 'ended' } }
          tracks.push(track)
          return { getTracks: () => [track] }
        },
      },
    },
    fetch: async () => ({ ok: token, json: async () => ({ token: 'test-token' }) }),
    WebSocket: FakeWebSocket,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    URL: Object.assign(function (url) { return new URL(url) }, { createObjectURL: () => 'blob:test', revokeObjectURL() {} }),
    Blob: class {},
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval: () => 1,
    clearInterval() {},
    performance,
    btoa,
    atob,
    console,
  }
  sandbox.window = sandbox
  vm.runInNewContext(CODE, sandbox)

  const $ = sandbox.document.getElementById
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  const click = async () => { $('btn').onclick(); await settle() }
  const live = async () => {
    await click()
    const socket = sockets.at(-1)
    socket.open()
    socket.receive('session.ready', { session_id: 'session-' + sockets.length })
    await settle()
    return socket
  }
  const capture = () => nodes.filter((node) => node.name === 'capture').at(-1)
  const released = () => tracks.every((t) => t.readyState === 'ended') && contexts.every((c) => c.state === 'closed')
  const idle = () => !$('btn').disabled && $('btn').textContent === 'Start call'
  const inCall = () => !$('btn').disabled && $('btn').textContent === 'End call'
  const releaseCloses = async () => { pendingCloses.splice(0).forEach((resolve) => resolve()); await settle() }
  return { $, sockets, contexts, tracks, timers, settle, click, live, capture, released, idle, inCall, releaseCloses }
}

test('server session.ended releases the mic and both audio contexts', async () => {
  const p = page()
  const socket = await p.live()
  socket.receive('session.ended')
  await p.settle()
  assert.equal(p.contexts.length, 2)
  assert.ok(p.released())
  assert.equal(socket.readyState, 3)
  assert.ok(p.idle())
})

test('a remote close releases everything', async () => {
  const p = page()
  const socket = await p.live()
  socket.readyState = 3
  socket.onclose()
  await p.settle()
  assert.ok(p.released())
  assert.ok(p.idle())
})

test('a socket error releases everything and shows the error', async () => {
  const p = page()
  const socket = await p.live()
  socket.onerror()
  await p.settle()
  assert.ok(p.released())
  assert.ok(p.idle())
  assert.equal(p.$('status-text').textContent, 'connection failed')
})

test('a failed token request leaves nothing open', async () => {
  const p = page({ token: false })
  await p.click()
  assert.equal(p.contexts.length, 0)
  assert.equal(p.sockets.length, 0)
  assert.ok(p.idle())
  assert.match(p.$('status-text').textContent, /token/)
})

test('a refused microphone closes the contexts already opened', async () => {
  const p = page({ failMic: true })
  await p.click()
  assert.equal(p.contexts.length, 2)
  assert.ok(p.released())
  assert.ok(p.idle())
})

test('a capture worklet failure stops the granted microphone', async () => {
  const p = page({ failWorklet: 2 })
  await p.click()
  assert.equal(p.tracks.length, 1)
  assert.ok(p.released())
  assert.ok(p.idle())
})

test('a new call waits until the previous contexts have closed', async () => {
  const p = page({ holdClose: true })
  const socket = await p.live()
  socket.receive('session.ended')
  await p.settle()
  assert.ok(p.tracks.every((t) => t.readyState === 'ended'))
  assert.ok(p.$('btn').disabled)
  await p.click()
  assert.equal(p.sockets.length, 1)
  await p.releaseCloses()
  assert.ok(p.idle())
  await p.live()
  assert.equal(p.sockets.length, 2)
})

test('End call sends session.end and releases everything', async () => {
  const p = page()
  const socket = await p.live()
  await p.click()
  assert.deepEqual(socket.types().slice(-1), ['session.end'])
  assert.ok(p.released())
  assert.ok(p.idle())
  assert.ok(p.timers.some((timer) => timer.ms === 3000))
  socket.receive('session.ended')
  socket.onclose()
  await p.settle()
  assert.ok(p.idle())
})

test('late events from the previous socket cannot end the next call', async () => {
  const p = page()
  const first = await p.live()
  first.receive('session.ended')
  await p.settle()
  const second = await p.live()
  assert.notEqual(second, first)
  first.onclose()
  first.onerror()
  first.receive('reply.started')
  first.receive('session.ended')
  await p.settle()
  assert.ok(p.inCall())
  assert.equal(p.$('status-text').textContent, 'listening')
  assert.equal(p.tracks.at(-1).readyState, 'live')
  assert.ok(p.contexts.slice(-2).every((c) => c.state === 'running'))
})

test('the previous call\'s capture cannot send audio on the next socket', async () => {
  const p = page()
  const first = await p.live()
  const oldCapture = p.capture()
  first.receive('session.ended')
  await p.settle()
  const second = await p.live()
  oldCapture.port.onmessage({ data: new Int16Array(240).buffer })
  assert.ok(!second.types().includes('input.audio'))
  p.capture().port.onmessage({ data: new Int16Array(240).buffer })
  assert.ok(second.types().includes('input.audio'))
})

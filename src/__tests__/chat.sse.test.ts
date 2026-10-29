import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { apiService } from '../services/api';

// SSE transport (VITE_CHAT_TRANSPORT=sse) — used where WebSockets aren't available (Vercel).
// chat.ts reads the env at import time, so it is imported after stubbing.

let initChat: typeof import('../chat').initChat;

beforeAll(async () => {
  vi.stubEnv('VITE_CHAT_TRANSPORT', 'sse');
  ({ initChat } = await import('../chat'));
});

function renderChatPage() {
  document.body.innerHTML = `
    <div id="chatSessionsList"></div>
    <button id="newChatBtn"></button>
    <button id="newChatBtnEmpty"></button>
    <div id="chatEmptyState"></div>
    <div id="chatNewSessionForm" style="display:none">
      <select id="llmProviderSelect"><option value="claude">Claude</option></select>
      <input id="llmModelInput" type="text" value="" />
      <button id="createSessionBtn"></button>
      <button id="cancelNewSessionBtn"></button>
    </div>
    <div id="chatActive" style="display:none">
      <span id="chatTitle"></span>
      <span id="chatProviderBadge"></span>
      <button id="deleteSessionBtn"></button>
      <div id="chatMessages"></div>
      <textarea id="chatInput"></textarea>
      <button id="chatSendBtn" disabled></button>
      <div id="chatStatus"></div>
    </div>
  `;
}

// Builds a streaming Response whose body yields the given chunks in order.
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const SESSION = { id: 7, title: 'Chat', llm_provider: 'claude', llm_model: null, created_at: '' };
const WebSocketSpy = vi.fn();

async function openSession() {
  vi.spyOn(apiService, 'chatListSessions').mockResolvedValue({ data: [SESSION] });
  vi.spyOn(apiService, 'chatGetSession').mockResolvedValue({ data: { session: SESSION, messages: [] } });
  initChat();
  await vi.waitFor(() => expect(document.querySelector('.chat-session-item')).not.toBeNull());
  (document.querySelector('.chat-session-item') as HTMLElement).click();
  await vi.waitFor(() =>
    expect((document.getElementById('chatSendBtn') as HTMLButtonElement).disabled).toBe(false));
}

function sendText(text: string) {
  (document.getElementById('chatInput') as HTMLTextAreaElement).value = text;
  (document.getElementById('chatSendBtn') as HTMLElement).click();
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketSpy);
  localStorage.setItem('auth_token', 'test-token');
  renderChatPage();
});

describe('SSE chat transport', () => {
  it('SSE1: opening a session enables send without opening a WebSocket', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await openSession();
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });

  it('SSE2: send() POSTs to the session message endpoint with auth and provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: {"type":"done"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    await openSession();
    sendText('Hello');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/chat\/sessions\/7\/message$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toMatchObject({ message: 'Hello', llm_provider: 'claude' });
  });

  it('SSE3: tokens split across network chunks accumulate into one assistant bubble', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"token","content":"Hel"}\n\ndata: {"type":"tok',
      'en","content":"lo"}\n\n',
      'data: {"type":"done"}\n\n',
    ])));
    await openSession();
    sendText('Hi');

    await vi.waitFor(() =>
      expect((document.getElementById('chatSendBtn') as HTMLButtonElement).disabled).toBe(false));
    expect(document.querySelectorAll('.chat-bubble-assistant')).toHaveLength(1);
    expect(document.querySelector('.chat-bubble-assistant .chat-bubble-text')!.textContent).toBe('Hello');
  });

  it('SSE4: an HTTP error surfaces its detail and re-enables send', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'No Anthropic API key configured' }), { status: 400 })));
    await openSession();
    sendText('Hi');

    await vi.waitFor(() =>
      expect(document.getElementById('chatStatus')!.textContent).toContain('No Anthropic API key configured'));
    expect((document.getElementById('chatSendBtn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('SSE5: a stream that closes without done/error unlocks the input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(['data: {"type":"token","content":"x"}\n\n'])));
    await openSession();
    sendText('Hi');

    await vi.waitFor(() =>
      expect(document.getElementById('chatStatus')!.textContent).toContain('Response ended unexpectedly'));
    expect((document.getElementById('chatSendBtn') as HTMLButtonElement).disabled).toBe(false);
  });
});

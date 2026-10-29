import { animate, stagger } from 'motion';
import { apiService } from './services/api';
import { router } from './router';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8001';
const WS_BASE = API_BASE
  .replace(/^https/, 'wss')
  .replace(/^http/, 'ws');

// Serverless hosts (Vercel) can't hold WebSockets open, so there chat streams
// each reply over SSE from POST /api/chat/sessions/{id}/message instead.
const USE_SSE = import.meta.env.VITE_CHAT_TRANSPORT === 'sse';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;


// ── Types ─────────────────────────────────────────────────────────────────────

interface Session {
  id: number;
  title: string | null;
  llm_provider: string;
  llm_model: string | null;
  created_at: string;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

// Optional config passed to ChatManager to scope it to a different set of DOM IDs.
// All fields are optional — omitting config uses the /chat page's default IDs.
interface ChatManagerConfig {
  idPrefix?:       string; // e.g. 'agent-' scopes all getElementById lookups
  sessionsList?:   string;
  emptyState?:     string;
  newSessionForm?: string;
  activePanel?:    string;
}

interface AgentPanelOpts {
  getEditMode?:    () => boolean;
  getCanvasState?: () => any;
}


// ── 21st.dev component helpers ────────────────────────────────────────────────

export function typingIndicatorHTML(): string {
  return `<span class="typing-indicator" aria-label="AI is typing" role="status">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </span>`;
}

export function providerBadgeHTML(provider: string): string {
  const map: Record<string, { label: string; cls: string }> = {
    claude: { label: 'Claude', cls: 'provider-pill--claude' },
    openai: { label: 'GPT',    cls: 'provider-pill--openai' },
    gemini: { label: 'Gemini', cls: 'provider-pill--gemini' },
  };
  const { label, cls } = map[provider] ?? { label: esc(provider), cls: 'provider-pill--default' };
  return `<span class="provider-pill ${cls}">${label}</span>`;
}


// ── workflow_session_map helpers ──────────────────────────────────────────────

function getWorkflowSessionMap(): Record<string, { name: string; sessions: number[]; latest: number }> {
  try { return JSON.parse(localStorage.getItem('workflow_session_map') || '{}'); } catch { return {}; }
}

function recordWorkflowSession(workflowId: string, workflowName: string, sessionId: number): void {
  const map = getWorkflowSessionMap();
  const entry = map[workflowId] ?? { name: workflowName, sessions: [], latest: 0 };
  if (!entry.sessions.includes(sessionId)) entry.sessions.push(sessionId);
  entry.latest  = sessionId;
  entry.name    = workflowName;
  map[workflowId] = entry;
  localStorage.setItem('workflow_session_map', JSON.stringify(map));
}

function removeWorkflowSession(workflowId: string, sessionId: number): void {
  const map = getWorkflowSessionMap();
  if (!map[workflowId]) return;
  map[workflowId].sessions = map[workflowId].sessions.filter(s => s !== sessionId);
  if (map[workflowId].latest === sessionId) {
    map[workflowId].latest = map[workflowId].sessions[map[workflowId].sessions.length - 1] ?? 0;
  }
  if (!map[workflowId].sessions.length) delete map[workflowId];
  localStorage.setItem('workflow_session_map', JSON.stringify(map));
}


// ── ChatManager ───────────────────────────────────────────────────────────────

class ChatManager {
  private ws: WebSocket | null = null;
  private sseAbort: AbortController | null = null;
  private activeSessionId: number | null = null;
  private isStreaming = false;
  private pendingBubble: HTMLElement | null = null;
  private pendingBubbleText: HTMLElement | null = null;
  private editTypingIndicator: HTMLElement | null = null;
  private activeSession: Session | null = null;
  private cfg: Required<ChatManagerConfig>;

  constructor(cfg: ChatManagerConfig = {}) {
    const p = cfg.idPrefix ?? '';
    this.cfg = {
      idPrefix:       p,
      sessionsList:   cfg.sessionsList   ?? p + 'chatSessionsList',
      emptyState:     cfg.emptyState     ?? p + 'chatEmptyState',
      newSessionForm: cfg.newSessionForm ?? p + 'chatNewSessionForm',
      activePanel:    cfg.activePanel    ?? p + 'chatActive',
    };
  }

  getActiveSessionId(): number | null { return this.activeSessionId; }


  // ── Instance-level DOM helpers ────────────────────────────────────────────────

  private _elByName(name: string): HTMLElement | null {
    return document.getElementById(this.cfg.idPrefix + name);
  }

  private _setStatus(msg: string, isError: boolean): void {
    const node = this._elByName('chatStatus');
    if (!node) return;
    node.innerHTML = '';
    node.textContent = msg;
    node.style.color = isError ? 'var(--error)' : 'var(--text-secondary)';
  }

  private _appendBubble(role: 'user' | 'assistant', content: string): HTMLElement | null {
    const box = this._elByName('chatMessages');
    if (!box) return null;
    const div = document.createElement('div');
    div.className = `chat-bubble chat-bubble-${role}`;
    div.innerHTML = `
      <div class="chat-bubble-avatar">${role === 'user' ? 'You' : 'AI'}</div>
      <div class="chat-bubble-body">
        <div class="chat-bubble-text">${esc(content)}</div>
      </div>`;
    box.appendChild(div);
    if (!reducedMotion()) {
      animate(div, { opacity: [0, 1], y: [8, 0] }, { duration: 0.2, easing: 'ease-out' });
    }
    return div;
  }

  private _appendProposalBubble(summary: string, workflowState: any): void {
    const box = this._elByName('chatMessages');
    if (!box) return;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble--assistant chat-bubble--proposal';
    bubble.innerHTML = `
      <div class="proposal-summary">${esc(summary)}</div>
      <div class="proposal-actions">
        <button class="btn btn-primary btn-sm proposal-apply-btn">Apply to Canvas</button>
        <button class="btn btn-outline btn-sm proposal-discard-btn">Discard</button>
      </div>
      <div class="proposal-done" style="display:none;font-size:0.8rem;color:var(--text-secondary)"></div>
    `;

    const resolveActions = (label: string) => {
      const actions = bubble.querySelector('.proposal-actions') as HTMLElement | null;
      if (actions) actions.style.display = 'none';
      const done = bubble.querySelector('.proposal-done') as HTMLElement | null;
      if (done) { done.style.display = ''; done.textContent = label; }
    };

    bubble.querySelector('.proposal-apply-btn')?.addEventListener('click', () => {
      resolveActions('Applied to canvas');
      document.dispatchEvent(new CustomEvent('agent:apply-workflow', { detail: workflowState }));
    });
    bubble.querySelector('.proposal-discard-btn')?.addEventListener('click', () => resolveActions('Discarded'));

    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;

    if (!reducedMotion()) {
      animate(bubble, { opacity: [0, 1], y: [8, 0] }, { duration: 0.2, easing: 'ease-out' });
    }
  }

  private _showPanel(which: 'empty' | 'new-session' | 'active'): void {
    const targets: Record<string, string> = {
      empty:         this.cfg.emptyState,
      'new-session': this.cfg.newSessionForm,
      active:        this.cfg.activePanel,
    };
    Object.entries(targets).forEach(([key, id]) => {
      const node = document.getElementById(id);
      if (node) node.style.display = key === which ? '' : 'none';
    });
  }

  private _startTypingAnimation(): void {
    const statusEl = this._elByName('chatStatus');
    if (!statusEl) return;
    const dots = statusEl.querySelectorAll<HTMLElement>('.typing-dot');
    if (!dots.length || reducedMotion()) return;
    animate(dots, { y: [0, -6, 0] }, { duration: 0.6, repeat: Infinity, delay: stagger(0.2), easing: 'ease-in-out' });
  }


  // ── Session list ─────────────────────────────────────────────────────────────

  async loadSessions(): Promise<void> {
    const list = document.getElementById(this.cfg.sessionsList);
    if (!list) return;

    const { data, error } = await apiService.chatListSessions();

    const skeletons = list.querySelectorAll<HTMLElement>('.skeleton-session-item');
    if (skeletons.length && !reducedMotion()) {
      await animate(skeletons, { opacity: [1, 0] }, { duration: 0.15, easing: 'ease-in' }).finished;
    }

    if (error) {
      list.innerHTML = `<div class="chat-error">Failed to load: ${esc(error)}</div>`;
      return;
    }

    const sessions: Session[] = data || [];
    if (!sessions.length) {
      list.innerHTML = `<div class="chat-empty-hint">No conversations yet</div>`;
      return;
    }

    // Build reverse map: sessionId → workflowName
    const wfMap = getWorkflowSessionMap();
    const sessionToWorkflow: Record<number, string> = {};
    for (const [, entry] of Object.entries(wfMap)) {
      for (const sid of entry.sessions) sessionToWorkflow[sid] = entry.name;
    }

    list.innerHTML = sessions
      .map(s => {
        const wfLabel = sessionToWorkflow[s.id]
          ? `<div class="chat-session-workflow-label">Workflow: ${esc(sessionToWorkflow[s.id])}</div>`
          : '';
        return `
          <div class="chat-session-item ${s.id === this.activeSessionId ? 'active' : ''}"
               data-session-id="${s.id}">
            <div class="chat-session-title">${esc(s.title || 'New Conversation')}</div>
            <div class="chat-session-meta">
              ${providerBadgeHTML(s.llm_provider)}
            </div>
            ${wfLabel}
          </div>
        `;
      })
      .join('');

    const items = list.querySelectorAll<HTMLElement>('.chat-session-item');
    if (items.length && !reducedMotion()) {
      animate(items, { opacity: [0, 1], x: [-12, 0] }, { duration: 0.25, delay: stagger(0.06), easing: 'ease-out' });
    }

    items.forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt(item.dataset.sessionId || '0', 10);
        if (id) this.openSession(id);
      });
    });
  }


  // ── Open session ──────────────────────────────────────────────────────────────

  async openSession(id: number): Promise<boolean> {
    this.closeWS();
    this.activeSessionId = id;
    this._showPanel('active');

    const { data, error } = await apiService.chatGetSession(id);
    if (error) { this._setStatus(`Error: ${error}`, true); return false; }

    const { session, messages } = data as { session: Session; messages: Message[] };
    this.activeSession = session;

    const titleEl = this._elByName('chatTitle');
    if (titleEl) titleEl.textContent = session.title || 'Conversation';

    const badgeEl = this._elByName('chatProviderBadge');
    if (badgeEl) {
      badgeEl.innerHTML = providerBadgeHTML(session.llm_provider);
      if (!reducedMotion()) {
        animate(badgeEl, { opacity: [0, 1], scale: [0.85, 1] }, { duration: 0.18, easing: 'ease-out' });
      }
    }

    const box = this._elByName('chatMessages');
    if (!box) return false;
    box.innerHTML = '';
    messages.forEach(m => this._appendBubble(m.role, m.content));
    box.scrollTop = box.scrollHeight;

    // agent-panel only: agentChipsState is outside the idPrefix scheme intentionally
    const chipsEl = document.getElementById('agentChipsState');
    if (chipsEl) {
      const hasMsgs = !!this._elByName('chatMessages')?.querySelector('.chat-bubble');
      chipsEl.style.display = hasMsgs ? 'none' : '';
    }

    this.connectWS(id);
    await this.loadSessions();
    return true;
  }


  // ── WebSocket lifecycle ───────────────────────────────────────────────────────

  private connectWS(sessionId: number): void {
    const token = localStorage.getItem('auth_token');
    if (!token) { router.navigate('/login'); return; }

    if (USE_SSE) {
      // Nothing to hold open — each send() is its own streaming request.
      this._setStatus('Connected', false);
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;
      return;
    }

    const url =`${WS_BASE}/api/chat/ws/${sessionId}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._setStatus('Connected', false);
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;
    };

    this.ws.onmessage = (evt) => {
      try { this.handleMsg(JSON.parse(evt.data)); } catch { /* malformed */ }
    };

    this.ws.onclose = (evt) => {
      const msg = evt.code === 4001 ? 'Auth error — please log in again'
                : evt.code === 4004 ? 'Session not found'
                : 'Disconnected';
      this._setStatus(msg, true);
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = true;
      this.isStreaming = false;
    };

    this.ws.onerror = () => this._setStatus('Connection error', true);
  }

  private handleMsg(msg: { type: string; content?: string; detail?: string; summary?: string; workflow_state?: any }): void {
    if (msg.type === 'token') {
      if (!this.pendingBubble) {
        this.pendingBubble = this._appendBubble('assistant', '');
        this.pendingBubbleText = this.pendingBubble?.querySelector('.chat-bubble-text') as HTMLElement | null ?? null;
      }
      if (this.pendingBubbleText) this.pendingBubbleText.textContent += msg.content ?? '';
      const box = this._elByName('chatMessages');
      if (box) box.scrollTop = box.scrollHeight;

    } else if (msg.type === 'done') {
      this.pendingBubble = null;
      this.pendingBubbleText = null;
      this.isStreaming = false;
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;
      const statusEl = this._elByName('chatStatus');
      if (statusEl) statusEl.innerHTML = '';
      this.loadSessions();

    } else if (msg.type === 'error') {
      this.editTypingIndicator?.remove();
      this.editTypingIndicator = null;
      this._setStatus(`Error: ${msg.detail}`, true);
      this.isStreaming = false;
      this.pendingBubble = null;
      this.pendingBubbleText = null;
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;

    } else if (msg.type === 'workflow_proposal') {
      this.editTypingIndicator?.remove();
      this.editTypingIndicator = null;
      this.isStreaming = false;
      const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;
      this._appendProposalBubble(msg.summary as string, msg.workflow_state as any);
    }
  }

  private closeWS(): void {
    this.ws?.close();
    this.ws = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.pendingBubble = null;
    this.isStreaming = false;
    this.editTypingIndicator?.remove();
    this.editTypingIndicator = null;
  }


  // ── Send ──────────────────────────────────────────────────────────────────────

  private _canSend(): boolean {
    if (USE_SSE) return this.activeSessionId !== null;
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private _transmit(payload: Record<string, unknown>): void {
    if (USE_SSE) { void this._postSSE(payload); return; }
    this.ws?.send(JSON.stringify(payload));
  }

  // Streams one reply over SSE, feeding each `data:` event to handleMsg exactly
  // like a WebSocket frame. fetch() is used instead of EventSource because
  // EventSource can't POST or send an Authorization header.
  private async _postSSE(payload: Record<string, unknown>): Promise<void> {
    const sessionId = this.activeSessionId;
    const token = localStorage.getItem('auth_token');
    if (!sessionId || !token) { router.navigate('/login'); return; }

    const abort = new AbortController();
    this.sseAbort = abort;

    try {
      const res = await fetch(`${API_BASE}/api/chat/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'include',
        signal: abort.signal,
        body: JSON.stringify({
          llm_provider: this.activeSession?.llm_provider,
          llm_model:    this.activeSession?.llm_model ?? undefined,
          ...payload,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        const detail = res.status === 401 ? 'Auth error — please log in again'
                     : typeof err.detail === 'string' ? err.detail
                     : `HTTP ${res.status}`;
        this.handleMsg({ type: 'error', detail });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { this.handleMsg(JSON.parse(line.slice(5).trim())); } catch { /* malformed */ }
          }
        }
      }

      // Stream closed without a terminal event — unlock the input.
      if (this.isStreaming && this.sseAbort === abort) {
        this.handleMsg({ type: 'error', detail: 'Response ended unexpectedly' });
      }
    } catch {
      if (!abort.signal.aborted) this.handleMsg({ type: 'error', detail: 'Connection error' });
    } finally {
      if (this.sseAbort === abort) this.sseAbort = null;
    }
  }

  send(text: string): void {
    if (!this._canSend() || this.isStreaming || !text.trim()) return;
    this._appendBubble('user', text);
    const box = this._elByName('chatMessages');
    if (box) box.scrollTop = box.scrollHeight;
    this.isStreaming = true;
    const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = true;

    const statusEl = this._elByName('chatStatus');
    if (statusEl) {
      statusEl.innerHTML = typingIndicatorHTML();
      this._startTypingAnimation();
    }

    this._transmit({
      message: text,
      llm_provider: this.activeSession?.llm_provider,
      llm_model:    this.activeSession?.llm_model ?? undefined,
    });
  }

  sendEdit(text: string, canvasState: any): void {
    if (!this._canSend() || this.isStreaming) return;
    this.isStreaming = true;
    const sendBtn = this._elByName('chatSendBtn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = true;

    this._appendBubble('user', text);

    const box = this._elByName('chatMessages');
    if (box) {
      const ind = document.createElement('div');
      ind.className = 'chat-bubble chat-bubble--assistant typing-wrap';
      ind.innerHTML = typingIndicatorHTML();
      box.appendChild(ind);
      box.scrollTop = box.scrollHeight;
      this.editTypingIndicator = ind;
    }

    this._transmit({
      message:      text,
      edit_mode:    true,
      canvas_state: canvasState,
    });
  }


  // ── Create / delete session ───────────────────────────────────────────────────

  async createSession(provider: string, model: string): Promise<number | undefined> {
    const { data, error } = await apiService.chatCreateSession(provider, model || undefined);
    if (error) { alert(`Failed: ${error}`); return undefined; }
    const newId = (data as Session).id;
    await this.openSession(newId);
    return newId;
  }

  async deleteActive(): Promise<void> {
    if (!this.activeSessionId) return;
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    const { error } = await apiService.chatDeleteSession(this.activeSessionId);
    if (error) { alert(`Delete failed: ${error}`); return; }
    this.closeWS();
    this.activeSessionId = null;
    this._showPanel('empty');
    await this.loadSessions();
  }

  destroy(): void { this.closeWS(); }
}


// ── /chat page init ───────────────────────────────────────────────────────────

let _mgr: ChatManager | null = null;

export function initChat(): void {
  _mgr?.destroy();
  _mgr = new ChatManager();
  const mgr = _mgr;

  el('newChatBtn')?.addEventListener('click', () => showPanel('new-session'));
  el('newChatBtnEmpty')?.addEventListener('click', () => showPanel('new-session'));
  el('cancelNewSessionBtn')?.addEventListener('click', () => showPanel('empty'));

  el('createSessionBtn')?.addEventListener('click', async () => {
    const provider = (el('llmProviderSelect') as HTMLSelectElement).value;
    const model    = (el('llmModelInput') as HTMLInputElement).value.trim();
    await mgr.createSession(provider, model);
  });

  el('deleteSessionBtn')?.addEventListener('click', () => mgr.deleteActive());

  el('chatSendBtn')?.addEventListener('click', () => {
    const ta = el('chatInput') as HTMLTextAreaElement;
    const text = ta.value.trim();
    if (text) { ta.value = ''; resetTA(ta); mgr.send(text); }
  });

  el('chatInput')?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      const ta = ke.target as HTMLTextAreaElement;
      const text = ta.value.trim();
      if (text) { ta.value = ''; resetTA(ta); mgr.send(text); }
    }
  });

  el('chatInput')?.addEventListener('input', (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  mgr.loadSessions();
}


// ── Agent panel init ──────────────────────────────────────────────────────────

let _agentMgr: ChatManager | null = null;
let _agentEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

export function initAgentPanel(opts: AgentPanelOpts = {}): void {
  _agentMgr?.destroy();
  _agentMgr = null;

  const workflowId   = localStorage.getItem('current_workflow_id');
  const workflowName = localStorage.getItem('current_workflow_name') ?? 'Workflow Chat';

  if (!workflowId) return; // autoName() creates one on page load; bail silently if still in flight

  _agentMgr = new ChatManager({
    idPrefix:       'agent-',
    sessionsList:   'agentSessionPopoverList',
    emptyState:     'agentSavePrompt',
    newSessionForm: 'agent-newSessionForm',
    activePanel:    'agent-chatMessages',
  });
  const mgr = _agentMgr;

  // ── Input wiring ──
  const inputEl = document.getElementById('agent-chatInput') as HTMLTextAreaElement | null;
  if (inputEl) inputEl.disabled = false;

  const doSend = () => {
    if (!inputEl) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = ''; resetTA(inputEl);

    const chips = document.getElementById('agentChipsState');
    if (chips) chips.style.display = 'none';

    if (opts.getEditMode?.()) {
      mgr.sendEdit(text, opts.getCanvasState?.() ?? {});
    } else {
      mgr.send(text);
    }
  };

  document.getElementById('agent-chatSendBtn')?.addEventListener('click', doSend);

  inputEl?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      doSend();
    }
  });

  inputEl?.addEventListener('input', (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    const sendBtn = document.getElementById('agent-chatSendBtn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = !ta.value.trim();
  });

  // ── Session history popover ──
  const popover = document.getElementById('agentSessionPopover');
  let outsideClickListener: ((e: MouseEvent) => void) | null = null;

  const closePopover = () => {
    if (popover) popover.style.display = 'none';
    if (outsideClickListener) {
      document.removeEventListener('click', outsideClickListener);
      outsideClickListener = null;
    }
  };

  const openPopover = async () => {
    if (!popover) return;
    popover.style.display = '';

    const list = document.getElementById('agentSessionPopoverList');
    if (list) {
      list.innerHTML = `<div style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--text-secondary)">Loading…</div>`;
    }

    const { data } = await apiService.chatListSessions();
    const allSessions: Session[] = (data as Session[]) || [];
    const workflowSessionIds = new Set(getWorkflowSessionMap()[workflowId]?.sessions ?? []);
    const sessions = allSessions.filter(s => workflowSessionIds.has(s.id));

    if (list) {
      if (!sessions.length) {
        list.innerHTML = `<div style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--text-secondary)">No conversations yet</div>`;
      } else {
        list.innerHTML = sessions.map(s => `
          <button class="agent-session-item ${s.id === mgr.getActiveSessionId() ? 'agent-session-item--active' : ''}"
                  data-session-id="${s.id}">
            <span class="agent-session-item-title">${esc(s.title || 'New Conversation')}</span>
            ${providerBadgeHTML(s.llm_provider)}
          </button>
        `).join('');

        const items = list.querySelectorAll<HTMLElement>('.agent-session-item');
        if (!reducedMotion()) {
          animate(items, { opacity: [0, 1], x: [-8, 0] }, { duration: 0.2, delay: stagger(0.05), easing: 'ease-out' });
        }

        items.forEach(item => {
          item.addEventListener('click', () => {
            const id = parseInt(item.dataset.sessionId || '0', 10);
            if (!id) return;
            closePopover();
            showAgentZone('messages');
            recordWorkflowSession(workflowId, workflowName, id);
            mgr.openSession(id);
            sessionStorage.setItem(`agent_session_${workflowId}`, String(id));
          });
        });
      }
    }

    // Dismiss on outside click (deferred so this click doesn't immediately close it)
    setTimeout(() => {
      outsideClickListener = (e: MouseEvent) => {
        const panel = document.getElementById('agent-panel');
        if (panel && !panel.contains(e.target as Node)) closePopover();
      };
      document.addEventListener('click', outsideClickListener);
    }, 0);
  };

  document.getElementById('agentHistoryBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover && popover.style.display !== 'none') {
      closePopover();
    } else {
      openPopover();
    }
  });

  if (_agentEscapeHandler) document.removeEventListener('keydown', _agentEscapeHandler);
  _agentEscapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && popover && popover.style.display !== 'none') closePopover();
  };
  document.addEventListener('keydown', _agentEscapeHandler);

  // ── New conversation form ──
  document.getElementById('agentNewConversationBtn')?.addEventListener('click', () => {
    closePopover();
    showAgentZone('new-session');
  });

  document.getElementById('agentCreateSessionBtn')?.addEventListener('click', async () => {
    const provider = (document.getElementById('agentProviderSelect') as HTMLSelectElement | null)?.value || 'claude';
    const model    = ((document.getElementById('agentModelInput') as HTMLInputElement | null)?.value || '').trim();
    const { data, error } = await apiService.chatCreateSession(provider, model || undefined);
    if (error || !data) { alert(`Failed to create session: ${esc(error || 'Unknown error')}`); return; }
    const newId = (data as Session).id;
    sessionStorage.setItem(`agent_session_${workflowId}`, String(newId));
    recordWorkflowSession(workflowId, workflowName, newId);
    // Restore Cancel for future "New conversation" flows
    const cancelBtn = document.getElementById('agentCancelNewSessionBtn');
    if (cancelBtn) cancelBtn.style.display = '';
    showAgentZone('messages');
    const chips = document.getElementById('agentChipsState');
    if (chips) chips.style.display = '';
    mgr.openSession(newId);
  });

  document.getElementById('agentCancelNewSessionBtn')?.addEventListener('click', () => {
    showAgentZone('messages');
  });

  // ── Auto-open session ──
  const sessionKey  = `agent_session_${workflowId}`;
  const cachedIdStr = sessionStorage.getItem(sessionKey);

  const showNewSessionForm = () => {
    showAgentZone('new-session');
    const cancelBtn = document.getElementById('agentCancelNewSessionBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
  };

  const clearStaleSession = (id: number) => {
    sessionStorage.removeItem(sessionKey);
    removeWorkflowSession(workflowId, id);
  };

  (async () => {
    if (cachedIdStr) {
      // Fast path: sessionStorage has an ID — verify it still exists
      const cachedId = parseInt(cachedIdStr, 10);
      showAgentZone('messages');
      const ok = await mgr.openSession(cachedId);
      if (!ok) {
        clearStaleSession(cachedId);
        showNewSessionForm();
      }
    } else {
      const mapEntry = getWorkflowSessionMap()[workflowId];
      if (mapEntry?.latest) {
        // Refresh path: restore most recent session from persistent map
        sessionStorage.setItem(sessionKey, String(mapEntry.latest));
        showAgentZone('messages');
        const ok = await mgr.openSession(mapEntry.latest);
        if (!ok) {
          clearStaleSession(mapEntry.latest);
          showNewSessionForm();
        }
      } else {
        // First time for this workflow — prompt user to create a session
        showNewSessionForm();
      }
    }
  })();
}

export function destroyAgentPanel(): void {
  _agentMgr?.destroy();
  _agentMgr = null;
  if (_agentEscapeHandler) {
    document.removeEventListener('keydown', _agentEscapeHandler);
    _agentEscapeHandler = null;
  }
}


// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showPanel(which: 'empty' | 'new-session' | 'active'): void {
  const map: Record<string, string> = {
    empty:          'chatEmptyState',
    'new-session':  'chatNewSessionForm',
    active:         'chatActive',
  };
  ['chatEmptyState', 'chatNewSessionForm', 'chatActive'].forEach(id => {
    const node = el(id);
    if (!node) return;
    node.style.display = id === map[which] ? '' : 'none';
  });

  if (!reducedMotion()) {
    if (which === 'new-session') {
      const form = el('chatNewSessionForm');
      if (form) animate(form, { opacity: [0, 1], y: [10, 0] }, { duration: 0.18, easing: 'ease-out' });
    }
    if (which === 'active') {
      const active = el('chatActive');
      if (active) animate(active, { opacity: [0, 1], scale: [0.98, 1] }, { duration: 0.2, easing: 'ease-out' });
    }
  }
}

// Toggles the three mutually exclusive zones inside the agent panel
function showAgentZone(zone: 'messages' | 'new-session'): void {
  const zones: Record<string, string> = {
    messages:      'agent-chatMessages',
    'new-session': 'agent-newSessionForm',
  };
  Object.entries(zones).forEach(([key, id]) => {
    const node = document.getElementById(id);
    if (node) node.style.display = key === zone ? '' : 'none';
  });
}

export function esc(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resetTA(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
}

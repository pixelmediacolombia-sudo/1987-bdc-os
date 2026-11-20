"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { MessageSquare, RefreshCw, Search, Send, ShieldAlert } from "lucide-react";

type Dealer = { id: string; name: string };
type Conversation = {
  id: string; contactId: string; name: string; phone?: string; email?: string;
  channel: string; state: string; preview: string; direction?: string | null;
  lastMessageAt?: string | null; leadLevel: string; qualification: Record<string, unknown>;
};
type Message = { id: string; direction: string; sender_type: string; content: string; created_at: string };
type Dashboard = { status: string; updatedAt: string; user: { name: string; role: string }; dealers: Dealer[]; selectedDealerId: string; dealer: Dealer | null; conversations: Conversation[] };

const channelName: Record<string, string> = { messenger: "Messenger", facebook: "Messenger", fb: "Messenger", instagram: "Instagram", ig: "Instagram", whatsapp: "WhatsApp" };
const factNames: Record<string, string> = { vehicle_category: "Vehículo", vehicle_model_interest: "Modelo", vehicle_use: "Uso", down_payment_declared: "Enganche declarado", first_time_buyer: "Primera compra", has_trade_in: "Vehículo para intercambio" };

function formatDate(value?: string | null) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  return Number.isNaN(+date) ? "Sin fecha" : new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function BdcDashboard() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [dealerId, setDealerId] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function refresh(nextDealerId = dealerId) {
    setLoading(true);
    try {
      const query = nextDealerId ? `?dealerId=${encodeURIComponent(nextDealerId)}` : "";
      const response = await fetch(`/mi-dia/api/dashboard${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? "Inicia sesión en BDC OS para revisar conversaciones." : "No se pudieron cargar las conversaciones.");
      setDashboard(payload as Dashboard);
      setDealerId(payload.selectedDealerId);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo conectar con BDC OS.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(conversationId: string) {
    setSelected(conversationId);
    try {
      const response = await fetch(`/mi-dia/api/conversations/${encodeURIComponent(conversationId)}/messages`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error("No se pudo abrir esta conversación.");
      setMessages(payload.messages as Message[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la conversación.");
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    try {
      const response = await fetch(`/mi-dia/api/conversations/${encodeURIComponent(selected)}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: draft }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error === "messaging_not_configured" ? "Conecta los canales de Meta de este dealer para enviar mensajes." : "Meta no aceptó el mensaje.");
      setDraft("");
      setError("Mensaje enviado. La conversación se actualizará cuando Meta confirme la entrega.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo enviar el mensaje.");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => { void refresh(""); }, []);
  useEffect(() => {
    if (!selected || !dashboard?.conversations.some(item => item.id === selected)) return;
    void loadMessages(selected);
    // Load only when the selected conversation or dealer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, dealerId]);

  const visible = useMemo(() => (dashboard?.conversations ?? []).filter(item => `${item.name} ${item.phone ?? ""} ${item.preview} ${channelName[item.channel.toLowerCase()] ?? item.channel}`.toLowerCase().includes(search.toLowerCase())), [dashboard, search]);
  const active = dashboard?.conversations.find(item => item.id === selected);
  const facts = Object.entries(active?.qualification ?? {}).filter(([key, value]) => factNames[key] && value !== null && value !== undefined && value !== "");

  return <main className="bdc-shell">
    <header className="bdc-header"><div className="bdc-brand"><span>BDC</span><small>OS · OPERACIONES</small></div><div className="bdc-heading"><span>MENSAJERÍA Y CALIFICACIÓN</span><h1>Conversaciones</h1><p>Mensajes recibidos por Facebook, Instagram y WhatsApp.</p></div><div className="bdc-actions">{dashboard?.dealers.length ? <select aria-label="Dealer" value={dealerId} onChange={event => { setSelected(""); setMessages([]); void refresh(event.target.value); }}>{dashboard.dealers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select> : null}<button type="button" className="bdc-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "bdc-spin" : ""}/>Actualizar</button></div></header>
    {error && <div className="bdc-notice" role="status"><ShieldAlert size={16}/>{error}</div>}
    <section className="bdc-layout">
      <aside className="bdc-inbox"><div className="bdc-inbox-top"><div><strong>Bandeja</strong><span>{dashboard?.conversations.length ?? 0} conversaciones</span></div><label><Search size={15}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar contacto o mensaje"/></label></div>
        <div className="bdc-conversation-list">{visible.map(item => <button type="button" key={item.id} onClick={() => void loadMessages(item.id)} className={`bdc-conversation ${selected === item.id ? "selected" : ""}`}><span className="bdc-avatar">{item.name.slice(0, 1).toUpperCase()}</span><span className="bdc-conversation-body"><span className="bdc-conversation-title"><strong>{item.name}</strong><small>{formatDate(item.lastMessageAt)}</small></span><span className="bdc-conversation-meta"><span>{channelName[item.channel.toLowerCase()] ?? item.channel}</span><b className={`lead lead-${item.leadLevel.toLowerCase()}`}>Lead {item.leadLevel}</b></span><span className="bdc-preview">{item.preview}</span></span></button>)}{!loading && visible.length === 0 && <div className="bdc-empty">No hay conversaciones para mostrar.</div>}</div>
      </aside>
      <article className="bdc-thread">{active ? <><header className="bdc-thread-header"><div><span className="bdc-avatar large">{active.name.slice(0, 1).toUpperCase()}</span><div><h2>{active.name}</h2><p>{channelName[active.channel.toLowerCase()] ?? active.channel}{active.phone ? ` · ${active.phone}` : ""}</p></div></div><span className={`lead lead-${active.leadLevel.toLowerCase()}`}>Lead {active.leadLevel}</span></header><div className="bdc-facts">{facts.length ? facts.map(([key, value]) => <div key={key}><small>{factNames[key]}</small><strong>{String(value)}</strong></div>) : <span>La calificación aparecerá conforme avance la conversación.</span>}</div><div className="bdc-messages">{messages.map(message => <div key={message.id} className={`bdc-message ${message.direction === "outbound" ? "outbound" : ""}`}><p>{message.content}</p><small>{message.sender_type} · {formatDate(message.created_at)}</small></div>)}{messages.length === 0 && <div className="bdc-empty"><MessageSquare size={24}/><span>Sin mensajes registrados todavía.</span></div>}</div><form className="bdc-composer" onSubmit={sendMessage}><textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={4000} placeholder="Escribe una respuesta…"/><button type="submit" disabled={!draft.trim() || sending}><Send size={16}/>{sending ? "Enviando" : "Enviar"}</button></form></> : <div className="bdc-thread-empty"><MessageSquare size={36}/><h2>Selecciona una conversación</h2><p>Verás el historial de mensajes y la calificación del lead aquí.</p></div>}</article>
    </section>
    <footer className="bdc-footer">{dashboard ? `Sesión: ${dashboard.user.name} · ${dashboard.dealer?.name ?? "BDC OS"} · Actualizado ${formatDate(dashboard.updatedAt)}` : "BDC OS"}</footer>
  </main>;
}

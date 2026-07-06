const MEMORY_TTL_MS = 30 * 60 * 1000;
const MAX_EXCHANGES = 6;

interface Exchange {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface StoredConversation {
  exchanges: Exchange[];
  lastActivity: number;
}

const conversations = new Map<string, StoredConversation>();

function gc(): void {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.lastActivity > MEMORY_TTL_MS) {
      conversations.delete(key);
    }
  }
}

export function recordExchange(accountId: string, role: "user" | "assistant", text: string): void {
  let conv = conversations.get(accountId);
  if (!conv) {
    conv = { exchanges: [], lastActivity: Date.now() };
    conversations.set(accountId, conv);
  }
  conv.exchanges.push({ role, text, timestamp: Date.now() });
  conv.lastActivity = Date.now();
  if (conv.exchanges.length > MAX_EXCHANGES * 2) {
    conv.exchanges = conv.exchanges.slice(-MAX_EXCHANGES * 2);
  }
  if (Math.random() < 0.1) gc();
}

export function getConversationHistory(accountId: string): Exchange[] {
  const conv = conversations.get(accountId);
  if (!conv) return [];
  if (Date.now() - conv.lastActivity > MEMORY_TTL_MS) {
    conversations.delete(accountId);
    return [];
  }
  return conv.exchanges;
}

export function clearConversationMemory(accountId: string): void {
  conversations.delete(accountId);
}

export interface HcomEvent {
  id?: number;
  ts?: string;
  timestamp?: string;
  type?: string;
  instance?: string;
  data?: Record<string, unknown>;
}

export interface HcomMessageFields {
  from?: string;
  text?: string;
  intent?: string;
}

/**
 * hcom emits naive ISO timestamps as UTC. JavaScript otherwise interprets an
 * offset-less date-time as local time, which breaks comparisons with Date.now
 * and registry timestamps.
 */
export function eventTimeMs(raw: HcomEvent | string | number | undefined): number | null {
  const value = typeof raw === "object" && raw !== null
    ? raw.ts ?? raw.timestamp
    : raw;
  if (value === undefined || value === null || value === "") return null;

  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;

  const text = String(value).trim();
  const withUtc = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(withUtc);
  return Number.isFinite(parsed) ? parsed : null;
}

export function eventTimestamp(event: HcomEvent): string | undefined {
  return event.ts ?? event.timestamp;
}

export function eventData(event: HcomEvent): Record<string, unknown> {
  return event.data ?? (event as unknown as Record<string, unknown>);
}

export function messageFields(event: HcomEvent): HcomMessageFields {
  const data = eventData(event);
  return {
    from: typeof data.from === "string" ? data.from : undefined,
    text: typeof data.text === "string" ? data.text : undefined,
    intent: typeof data.intent === "string" ? data.intent : undefined,
  };
}

export function parseHcomEvents(stdout: string): HcomEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as HcomEvent;
        return event && typeof event === "object" ? [event] : [];
      } catch {
        return [];
      }
    });
}

export function newestEvent<T extends HcomEvent>(events: T[]): T | undefined {
  return events.reduce<T | undefined>((newest, event) => {
    if (!newest) return event;
    const eventMs = eventTimeMs(event);
    const newestMs = eventTimeMs(newest);
    if (eventMs !== null && (newestMs === null || eventMs > newestMs)) return event;
    if (eventMs === newestMs && (event.id ?? 0) > (newest.id ?? 0)) return event;
    if (eventMs === null && newestMs === null && (event.id ?? 0) > (newest.id ?? 0)) return event;
    return newest;
  }, undefined);
}

export function eventBelongsTo(event: HcomEvent, agentName: string): boolean {
  return event.instance === agentName || messageFields(event).from === agentName;
}

/**
 * An inbound non-ack message is a pending dispatch candidate. The mention
 * query supplies the target boundary; the sender check prevents self-events
 * from becoming dispatches when hcom returns a broad result.
 */
export function isInboundDispatchEvent(event: HcomEvent, agentName: string): boolean {
  const { from, intent, text } = messageFields(event);
  if (event.type !== "message" && !(event.type === undefined && from && text)) return false;
  return Boolean(from && from !== agentName && intent !== "ack");
}

export function isAgentMessageEvent(event: HcomEvent, agentName: string): boolean {
  const { from, text } = messageFields(event);
  return Boolean(
    (event.type === "message" || (event.type === undefined && from && text)) &&
      from === agentName,
  );
}

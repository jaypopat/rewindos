import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ask,
  askNewSession,
  type AskResponse,
  type ScreenshotRef,
} from "@/lib/api";

let nextMsgId = 0;

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  references?: ScreenshotRef[];
}

interface AskTokenPayload {
  session_id: string;
  token: string;
  done: boolean;
}

interface AskDonePayload {
  session_id: string;
  full_response: string;
}

interface AskErrorPayload {
  session_id: string;
  error: string;
}

interface AskContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  sessionId: string | null;
  sendMessage: (text: string) => Promise<void>;
  newSession: () => Promise<void>;
}

const AskContext = createContext<AskContextValue | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  // Listen to Tauri events — registered once for the lifetime of the app
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      listen<AskTokenPayload>("ask-token", (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return;

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !event.payload.done) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + event.payload.token },
            ];
          }
          return prev;
        });
      }),
    );

    unlisteners.push(
      listen<AskDonePayload>("ask-done", (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return;

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, content: event.payload.full_response },
            ];
          }
          return prev;
        });
        setIsStreaming(false);
      }),
    );

    unlisteners.push(
      listen<AskErrorPayload>("ask-error", (event) => {
        if (event.payload.session_id !== sessionIdRef.current) return;
        setError(event.payload.error);
        setIsStreaming(false);
      }),
    );

    return () => {
      for (const unlistener of unlisteners) {
        unlistener.then((fn) => fn());
      }
    };
  }, []);

  // Lazily create a session on first use
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const id = await askNewSession();
    setSessionId(id);
    sessionIdRef.current = id;
    return id;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreamingRef.current || !text.trim()) return;

      const sid = await ensureSession();

      setError(null);
      setIsStreaming(true);

      // Add user message + empty assistant placeholder
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId++, role: "user", content: text },
        { id: nextMsgId++, role: "assistant", content: "" },
      ]);

      try {
        const response: AskResponse = await ask(sid, text);
        // Attach references to the assistant placeholder
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, references: response.references },
            ];
          }
          return prev;
        });
      } catch (e) {
        setError(String(e));
        setIsStreaming(false);
        // Remove the empty assistant placeholder
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.content === "") {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }
    },
    [ensureSession],
  );

  const newSession = useCallback(async () => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    try {
      const id = await askNewSession();
      setSessionId(id);
      sessionIdRef.current = id;
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return (
    <AskContext.Provider
      value={{ messages, isStreaming, error, sessionId, sendMessage, newSession }}
    >
      {children}
    </AskContext.Provider>
  );
}

export function useAskChat() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskChat must be used within AskProvider");
  return ctx;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, askNewSession, type AskResponse, type ScreenshotRef } from "@/lib/api";

export interface ChatMessage {
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

export function useAskStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Initialize session on mount
  useEffect(() => {
    askNewSession().then(setSessionId).catch((e) => setError(String(e)));
  }, []);

  // Listen to Tauri events
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

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId || isStreaming || !text.trim()) return;

      setError(null);
      setIsStreaming(true);

      // Add user message + empty assistant placeholder
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "" },
      ]);

      try {
        const response: AskResponse = await ask(sessionId, text);
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
    [sessionId, isStreaming],
  );

  const newSession = useCallback(async () => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    try {
      const id = await askNewSession();
      setSessionId(id);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return { messages, isStreaming, error, sessionId, sendMessage, newSession };
}

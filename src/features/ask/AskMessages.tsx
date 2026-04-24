import { Streamdown } from "streamdown";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { toUIMessages } from "@/lib/chat-messages";
import type { ChatMessageRow } from "@/lib/api";
import type { ToolUIPart } from "ai";

interface AskMessagesProps {
  rows: ChatMessageRow[];
}

export function AskMessages({ rows }: AskMessagesProps) {
  const messages = toUIMessages(rows);

  return (
    <Conversation className="flex-1 min-h-0">
      <ConversationContent>
        {messages.map((m) => (
          <Message from={m.role} key={m.id}>
            <MessageContent>
              {m.parts.map((part, i) => {
                const key = `${m.id}-${i}`;
                const anyPart = part as Record<string, unknown>;
                const type = anyPart.type;

                if (type === "text") {
                  return (
                    <Streamdown key={key}>
                      {(anyPart.text as string) ?? ""}
                    </Streamdown>
                  );
                }

                if (type === "reasoning") {
                  return (
                    <Reasoning key={key}>
                      <ReasoningTrigger />
                      <ReasoningContent>
                        {(anyPart.text as string) ?? ""}
                      </ReasoningContent>
                    </Reasoning>
                  );
                }

                if (typeof type === "string" && type.startsWith("tool-")) {
                  const toolType = type as ToolUIPart["type"];
                  const state = anyPart.state as ToolUIPart["state"];
                  const output = anyPart.output;
                  const errorText = anyPart.errorText as string | undefined;
                  return (
                    <Tool key={key} defaultOpen={false}>
                      <ToolHeader type={toolType} state={state} />
                      <ToolContent>
                        <ToolInput input={anyPart.input} />
                        {output !== undefined && (
                          <ToolOutput output={output} errorText={errorText} />
                        )}
                      </ToolContent>
                    </Tool>
                  );
                }

                return null;
              })}
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

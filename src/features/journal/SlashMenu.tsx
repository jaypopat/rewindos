import { useState, useEffect, useCallback, useRef, type MutableRefObject } from "react";
import { Extension } from "@tiptap/core";
import { type Editor, ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  CodeSquare,
  Minus,
} from "lucide-react";

// ── Slash command items ──

interface SlashItem {
  title: string;
  icon: React.ReactNode;
  command: (editor: Editor) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Heading 1",
    icon: <Heading1 className="size-4" />,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    icon: <Heading2 className="size-4" />,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    icon: <Heading3 className="size-4" />,
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    title: "Bullet List",
    icon: <List className="size-4" />,
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    title: "Ordered List",
    icon: <ListOrdered className="size-4" />,
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    title: "Task List",
    icon: <ListChecks className="size-4" />,
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    title: "Quote",
    icon: <Quote className="size-4" />,
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    title: "Code Block",
    icon: <CodeSquare className="size-4" />,
    command: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    icon: <Minus className="size-4" />,
    command: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

// ── Shared type for keydown ref ──

type KeyDownHandler = (e: KeyboardEvent) => boolean;

// ── Dropdown component ──

interface SlashMenuDropdownProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  keyDownRef: MutableRefObject<KeyDownHandler | null>;
}

function SlashMenuDropdown({ items, command, keyDownRef }: SlashMenuDropdownProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // Scroll selected item into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (items[selectedIndex]) command(items[selectedIndex]);
        return true;
      }
      return false;
    },
    [items, selectedIndex, command],
  );

  // Expose onKeyDown to the suggestion renderer via shared ref
  useEffect(() => {
    keyDownRef.current = onKeyDown;
    return () => {
      keyDownRef.current = null;
    };
  }, [onKeyDown, keyDownRef]);

  if (items.length === 0) {
    return (
      <div className="journal-slash-menu">
        <div className="journal-slash-empty">No results</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="journal-slash-menu">
      {items.map((item, index) => (
        <button
          key={item.title}
          type="button"
          className={`journal-slash-item ${index === selectedIndex ? "is-selected" : ""}`}
          onClick={() => command(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {item.icon}
          <span>{item.title}</span>
        </button>
      ))}
    </div>
  );
}

// ── Suggestion render adapter ──

function createSuggestionRenderer() {
  let renderer: ReactRenderer<SlashMenuDropdownProps> | null = null;
  let popup: HTMLDivElement | null = null;
  const keyDownRef: MutableRefObject<KeyDownHandler | null> = { current: null };

  return {
    onStart(props: SuggestionProps<SlashItem>) {
      popup = document.createElement("div");
      popup.style.position = "absolute";
      popup.style.zIndex = "50";
      document.body.appendChild(popup);

      renderer = new ReactRenderer(SlashMenuDropdown, {
        props: {
          items: props.items,
          command: props.command,
          keyDownRef,
        },
        editor: props.editor,
      });

      if (popup && renderer.element) {
        popup.appendChild(renderer.element);
      }

      updatePosition(props);
    },

    onUpdate(props: SuggestionProps<SlashItem>) {
      renderer?.updateProps({
        items: props.items,
        command: props.command,
      });
      updatePosition(props);
    },

    onKeyDown(props: SuggestionKeyDownProps) {
      if (props.event.key === "Escape") {
        cleanup();
        return true;
      }
      return keyDownRef.current?.(props.event) ?? false;
    },

    onExit() {
      cleanup();
    },
  };

  function updatePosition(props: SuggestionProps<SlashItem>) {
    if (!popup) return;
    const rect = props.clientRect?.();
    if (!rect) return;
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
  }

  function cleanup() {
    renderer?.destroy();
    renderer = null;
    if (popup) {
      popup.remove();
      popup = null;
    }
  }
}

// ── Tiptap extension ──

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        items: ({ query }: { query: string }) => {
          const q = query.toLowerCase();
          return SLASH_ITEMS.filter((item) =>
            item.title.toLowerCase().includes(q),
          );
        },
        command: ({ editor, range, props }: { editor: Editor; range: any; props: SlashItem }) => {
          // Delete the "/" trigger text, then run the command
          editor.chain().focus().deleteRange(range).run();
          props.command(editor);
        },
        render: createSuggestionRenderer,
      } satisfies Partial<SuggestionOptions<SlashItem>>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

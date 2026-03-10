import { useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from "react";
import { type Editor, useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import CharacterCount from "@tiptap/extension-character-count";
import { SlashCommand } from "./SlashMenu";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  Highlighter,
  Link as LinkIcon,
} from "lucide-react";

export interface JournalEditorHandle {
  editor: Editor | null;
}

interface JournalEditorProps {
  content: string;
  onUpdate: (json: string) => void;
  className?: string;
}

export const JournalEditor = forwardRef<JournalEditorHandle, JournalEditorProps>(
  function JournalEditor({ content, onUpdate, className }, ref) {
    const extensions = useMemo(
      () => [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: 'Start writing, or type "/" for commands...',
        }),
        SlashCommand,
        Typography,
        Highlight.configure({ multicolor: true }),
        Link.configure({ autolink: true, linkOnPaste: true, openOnClick: false }),
        Underline,
        CharacterCount,
      ],
      [],
    );

    const initialContent = useMemo(() => {
      if (!content) return "";
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }, []);

    const editor = useEditor({
      extensions,
      content: initialContent,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "max-w-none focus:outline-none min-h-[200px]",
        },
      },
      onUpdate: ({ editor }) => {
        onUpdate(JSON.stringify(editor.getJSON()));
      },
    });

    useImperativeHandle(ref, () => ({ editor }), [editor]);

    // Sync external content changes (e.g., date navigation).
    useEffect(() => {
      if (!editor) return;
      const currentJson = JSON.stringify(editor.getJSON());
      if (currentJson !== content) {
        try {
          const parsed = content ? JSON.parse(content) : "";
          editor.commands.setContent(parsed, { emitUpdate: false });
        } catch {
          editor.commands.setContent(content, { emitUpdate: false });
        }
      }
    }, [content, editor]);

    const setLink = useCallback(() => {
      if (!editor) return;
      const previousUrl = editor.getAttributes("link").href;
      const url = window.prompt("URL", previousUrl);
      if (url === null) return;
      if (url === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }, [editor]);

    if (!editor) return null;

    return (
      <div className={className}>
        {/* BubbleMenu — appears on text selection */}
        <BubbleMenu
          editor={editor}
          className="journal-bubble-menu"
        >
          <BubbleButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            title="Bold (Ctrl+B)"
          >
            <Bold className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            title="Italic (Ctrl+I)"
          >
            <Italic className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            active={editor.isActive("underline")}
            title="Underline (Ctrl+U)"
          >
            <UnderlineIcon className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            active={editor.isActive("strike")}
            title="Strikethrough"
          >
            <Strikethrough className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            active={editor.isActive("code")}
            title="Inline code"
          >
            <Code className="size-3.5" />
          </BubbleButton>
          <div className="journal-bubble-divider" />
          <BubbleButton
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            active={editor.isActive("highlight")}
            title="Highlight"
          >
            <Highlighter className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            onClick={setLink}
            active={editor.isActive("link")}
            title="Link"
          >
            <LinkIcon className="size-3.5" />
          </BubbleButton>
        </BubbleMenu>

        <EditorContent editor={editor} />
      </div>
    );
  },
);

/* ── Inline sub-components ── */

function BubbleButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`journal-bubble-btn ${active ? "is-active" : ""}`}
    >
      {children}
    </button>
  );
}

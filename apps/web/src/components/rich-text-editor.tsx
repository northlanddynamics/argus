import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { CaseSummary } from "@/lib/cases";
import { cn } from "@/lib/utils";

const isAllowedUri = (url: string) => /^(https?:|mailto:)/i.test(url);

/** Exactly what the Case Summary accepts on the server: paragraphs, headings, bullet lists, bold, italic, links. */
const extensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    orderedList: false,
    strike: false,
    underline: false,
    heading: { levels: [2, 3] },
    link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri },
  }),
];

const proseClass =
  "max-w-none text-sm leading-relaxed outline-none [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:text-primary [&_a]:underline";

/** The Case Summary, editable with a toolbar or read-only. */
export function RichTextEditor({
  value,
  onChange,
  editable = true,
  label,
  className,
}: {
  value: CaseSummary;
  onChange?: (value: CaseSummary) => void;
  editable?: boolean;
  label: string;
  className?: string;
}) {
  const editor = useEditor({
    extensions,
    content: value,
    editable,
    editorProps: { attributes: { class: cn(proseClass, editable && "min-h-40"), "aria-label": label, role: "textbox" } },
    onUpdate: ({ editor: updated }) => onChange?.(updated.getJSON() as CaseSummary),
  });

  // Follows `value` when it is replaced from outside (e.g. loading the current version).
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      list: e?.isActive("bulletList") ?? false,
      link: e?.isActive("link") ?? false,
      heading: e?.isActive("heading", { level: 2 }) ?? false,
    }),
  });

  const setLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const href = window.prompt("Link address (https://…)");
    if (!href) return;
    if (!isAllowedUri(href)) {
      window.alert("Links must start with http://, https:// or mailto:");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };

  return (
    <div className={className}>
      {editable && editor && (
        <div className="mb-3 flex flex-wrap gap-1 border-b pb-3" role="toolbar" aria-label="Formatting">
          <ToolButton label="Bold" pressed={active?.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </ToolButton>
          <ToolButton label="Italic" pressed={active?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </ToolButton>
          <ToolButton label="Bullet list" pressed={active?.list} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            • List
          </ToolButton>
          <ToolButton label="Link" pressed={active?.link} onClick={setLink}>
            Link
          </ToolButton>
          <ToolButton label="Heading" pressed={active?.heading} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            Heading
          </ToolButton>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolButton({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant={pressed ? "secondary" : "outline"} size="sm" aria-label={label} aria-pressed={pressed} onClick={onClick}>
      {children}
    </Button>
  );
}

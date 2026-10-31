import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { caseQuery } from "@/lib/cases";
import {
  discussionKey,
  discussionQuery,
  type MessageView,
  mentionableQuery,
  messageBody,
  messageParts,
  type Person,
  typedText,
} from "@/lib/discussion";
import { roleLabel } from "@/lib/roles";
import { promotedSources, timelineQuery } from "@/lib/timeline";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { PromoteDialog } from "@/routes/cases/timeline-entry-form";

/** The Discussion: the conversation among the people working the Case. Shown beside the Timeline. */
export function CaseDiscussion() {
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const { data: c } = useQuery(caseQuery(number));
  const messages = useQuery(discussionQuery(number));
  const timeline = useQuery(timelineQuery(number));
  const promoted = promotedSources(timeline.data);
  const [editing, setEditing] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<MessageView | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: discussionKey(number) });

  const post = useMutation({
    mutationFn: async (body: string) => {
      const res = await api.cases[":number"].discussion.$post({ param: { number: String(number) }, json: { body } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not send the message"));
    },
    onSuccess: refresh,
  });

  if (!c) return null;
  const readOnly = c.status === "closed";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Discussion</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ol className="grid gap-4" aria-label="Messages">
          {messages.data?.map((m) =>
            editing === m.id ? (
              <li key={m.id}>
                <EditMessage number={number} message={m} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <Message
                key={m.id}
                number={number}
                message={m}
                readOnly={readOnly}
                promoted={promoted.has(m.id)}
                onEdit={() => setEditing(m.id)}
                onPromote={() => setPromoting(m)}
              />
            ),
          )}
          {messages.data?.length === 0 && <li className="text-sm text-muted-foreground">No messages yet.</li>}
        </ol>
        {!readOnly && (
          <Composer
            number={number}
            label="Message"
            submitLabel="Send"
            pending={post.isPending}
            error={post.error?.message}
            onSubmit={(body, reset) => post.mutate(body, { onSuccess: reset })}
          />
        )}
        {promoting && (
          <PromoteDialog
            number={number}
            source={{ kind: "discussion_message", id: promoting.id }}
            occurredAt={promoting.postedAt}
            body={typedText(promoting.body ?? "", promoting.mentions)}
            onClose={() => setPromoting(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Message({
  number,
  message: m,
  readOnly,
  promoted,
  onEdit,
  onPromote,
}: {
  number: number;
  message: MessageView;
  readOnly: boolean;
  /** On the Timeline already. */
  promoted: boolean;
  onEdit: () => void;
  onPromote: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const retract = useMutation({
    mutationFn: async () => {
      const res = await api.cases[":number"].discussion[":id"].retract.$post({ param: { number: String(number), id: m.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not retract the message"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: discussionKey(number) }),
  });
  return (
    <li className="grid gap-1 border-b pb-4 last:border-b-0" aria-label={`Message from ${m.author.name}`}>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold">{m.author.name}</span>
        <time className="text-xs text-muted-foreground" dateTime={m.postedAt}>
          {new Date(m.postedAt).toLocaleString()}
        </time>
        {m.editedAt && !m.retractedAt && <span className="text-xs text-muted-foreground">· edited</span>}
        {promoted && <span className="text-xs text-muted-foreground">· on the Timeline</span>}
      </div>
      {m.body === null ? (
        <p className="text-sm text-muted-foreground italic">Retracted by {m.author.name}. The original is kept in the Audit Log.</p>
      ) : (
        <p className="text-sm whitespace-pre-wrap">
          {messageParts(m.body, m.mentions).map((part, i) =>
            typeof part === "string" ? (
              part
            ) : (
              <span key={i} className="rounded bg-sky-100 px-0.5 font-medium text-sky-900">
                @{part.name}
              </span>
            ),
          )}
        </p>
      )}
      {!readOnly && m.body !== null && (
        <div className="flex gap-2">
          {!promoted && (
            <Button variant="outline" size="sm" onClick={onPromote}>
              Promote to Timeline
            </Button>
          )}
          {m.can.edit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          {m.can.retract &&
            (confirming ? (
              <>
                <Button variant="destructive" size="sm" disabled={retract.isPending} onClick={() => retract.mutate()}>
                  Retract message
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Retract
              </Button>
            ))}
        </div>
      )}
      {retract.error && (
        <Alert variant="destructive">
          <AlertDescription>{retract.error.message}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

function EditMessage({ number, message, onDone }: { number: number; message: MessageView; onDone: () => void }) {
  const queryClient = useQueryClient();
  const edit = useMutation({
    mutationFn: async (body: string) => {
      const res = await api.cases[":number"].discussion[":id"].$patch({ param: { number: String(number), id: message.id }, json: { body } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save the message"));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: discussionKey(number) });
      onDone();
    },
  });
  return (
    <Composer
      number={number}
      label="Edit message"
      submitLabel="Save"
      initial={{ text: typedText(message.body ?? "", message.mentions), picked: message.mentions }}
      pending={edit.isPending}
      error={edit.error?.message}
      onSubmit={(body) => edit.mutate(body)}
      onCancel={onDone}
    />
  );
}

/** The "@query" being typed just before the caret, if any. */
const mentionQuery = (text: string, caret: number) => /(?:^|\s)@([^\s@<>]*)$/.exec(text.slice(0, caret))?.[1] ?? null;

/**
 * A message box. Typing "@" offers the people who can see the Case; picking one writes "@Name",
 * which becomes a mention when the message is sent.
 */
function Composer({
  number,
  label,
  submitLabel,
  initial = { text: "", picked: [] },
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  number: number;
  label: string;
  submitLabel: string;
  initial?: { text: string; picked: readonly Person[] };
  pending: boolean;
  error?: string;
  onSubmit: (body: string, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial.text);
  const [picked, setPicked] = useState<readonly Person[]>(initial.picked);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const people = useQuery({ ...mentionableQuery(number), enabled: query !== null });

  /** Whose name, or any word of it, starts with what's typed after "@". */
  const offered =
    query === null
      ? []
      : (people.data ?? []).filter((p) => p.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(query.toLowerCase())));

  const track = (value: string, caret: number) => {
    setText(value);
    setQuery(mentionQuery(value, caret));
    setHighlight(0);
  };

  const pick = (person: Person) => {
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const start = text.slice(0, caret).lastIndexOf("@");
    const inserted = `@${person.name} `;
    const next = text.slice(0, start) + inserted + text.slice(caret);
    setText(next);
    setPicked((list) => (list.some((p) => p.id === person.id) ? list : [...list, person]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  const submit = () => {
    if (!text.trim() || pending) return;
    onSubmit(messageBody(text, picked), () => {
      setText("");
      setPicked([]);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (offered.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(offered[highlight] ?? offered[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="relative grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        ref={box}
        aria-label={label}
        placeholder="Write a message. Type @ to mention someone who can see this Case."
        value={text}
        maxLength={10_000}
        onChange={(e) => track(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query !== null && offered.length > 0 && (
        <ul
          role="listbox"
          aria-label="People who can see this Case"
          className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-lg border bg-popover text-sm shadow-md"
        >
          {offered.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === highlight}
              className={`cursor-pointer px-3 py-1.5 ${i === highlight ? "bg-accent" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              @{p.name} <span className="text-muted-foreground">· {roleLabel[p.role]}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending || !text.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

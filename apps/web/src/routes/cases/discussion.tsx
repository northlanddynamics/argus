import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Audience, Visibility } from "@/components/visibility";
import { api, errorMessage } from "@/lib/api";
import { canMarkInternal, canParticipate, caseQuery, isReadOnly } from "@/lib/cases";
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
import { personRoleLabel } from "@/lib/roles";
import { instant } from "@/lib/when";
import { promotedSources, timelineQuery } from "@/lib/timeline";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { QUIET_ACTION } from "@/routes/cases/rail";
import { PromoteDialog } from "@/routes/cases/timeline-entry-form";

/**
 * The Discussion: the conversation among the people working the Case, Guests included. Shown beside
 * the Timeline. Members may post Internal messages, which Guests never see.
 */
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
    mutationFn: async ({ body, internal }: { body: string; internal: boolean }) => {
      const res = await api.cases[":number"].discussion.$post({ param: { number: String(number) }, json: { body, internal } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not send the message"));
    },
    // Not awaited: the composer clears as soon as the message is accepted, not after the refetch, which the live signal may beat.
    onSuccess: () => void refresh(),
  });

  if (!c) return null;
  const readOnly = isReadOnly(c);
  const participating = canParticipate(c);
  return (
    <section className="grid min-w-0 gap-4" aria-label="Discussion">
      <div className="flex min-h-8 items-center">
        <h2 className="text-lg font-semibold">Discussion</h2>
      </div>
      <Card>
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
                participating={participating}
                canMark={canMarkInternal(c)}
                promoted={promoted.has(m.id)}
                onEdit={() => setEditing(m.id)}
                onPromote={() => setPromoting(m)}
              />
            ),
          )}
          {messages.data?.length === 0 && <li className="text-sm text-muted-foreground">No messages yet.</li>}
        </ol>
        {participating && (
          <Composer
            number={number}
            label="Message"
            submitLabel="Send"
            offerInternal={canMarkInternal(c)}
            pending={post.isPending}
            error={post.error?.message}
            onSubmit={(body, reset, internal) => post.mutate({ body, internal }, { onSuccess: reset })}
          />
        )}
        {promoting && (
          <PromoteDialog
            number={number}
            source={{ kind: "discussion_message", id: promoting.id }}
            occurredAt={promoting.postedAt}
            body={typedText(promoting.body ?? "", promoting.mentions)}
            internal={promoting.internal}
            onClose={() => setPromoting(null)}
          />
        )}
      </CardContent>
      </Card>
    </section>
  );
}

function Message({
  number,
  message: m,
  readOnly,
  participating,
  canMark,
  promoted,
  onEdit,
  onPromote,
}: {
  number: number;
  message: MessageView;
  /** The viewer can't change the Case beyond taking part (a Guest), or it's Closed. */
  readOnly: boolean;
  /** The viewer can post, edit and retract their own messages. */
  participating: boolean;
  /** The viewer can mark it Internal or show it to Guests. */
  canMark: boolean;
  /** On the Timeline already. */
  promoted: boolean;
  onEdit: () => void;
  onPromote: () => void;
}) {
  const queryClient = useQueryClient();
  const retract = useMutation({
    mutationFn: async () => {
      const res = await api.cases[":number"].discussion[":id"].retract.$post({ param: { number: String(number), id: m.id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not retract the message"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: discussionKey(number) }),
  });
  return (
    <li className="group/row grid gap-1 border-b pb-4 last:border-b-0" aria-label={`Message from ${m.author.name}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-semibold">{m.author.name}</span>
        {m.falcon && (
          <Badge variant="outline">
            Synced from Falcon
          </Badge>
        )}
        <time className="text-xs text-muted-foreground" dateTime={m.postedAt}>
          {instant(m.postedAt)}
        </time>
        {m.editedAt && !m.retractedAt && <span className="text-xs text-muted-foreground">· edited</span>}
        {promoted && <span className="text-xs text-muted-foreground">· on the Timeline</span>}
        {(m.internal || canMark) && m.body !== null && (
          <Visibility
            number={number}
            item={{ kind: "discussion_message", id: m.id }}
            internal={m.internal}
            label={`message from ${m.author.name}`}
            canMark={canMark}
          />
        )}
      </div>
      {m.body === null ? (
        <p className="text-sm text-muted-foreground italic">Retracted by {m.author.name}.</p>
      ) : (
        <p className="text-sm whitespace-pre-wrap">
          {messageParts(m.body, m.mentions).map((part, i) =>
            typeof part === "string" ? (
              part
            ) : (
              <span key={i} className="rounded bg-mention px-0.5 font-medium text-mention-foreground">
                @{part.name}
              </span>
            ),
          )}
        </p>
      )}
      {participating && m.body !== null && (
        <div className="-ml-2 flex flex-wrap gap-1">
          {!readOnly && !promoted && (
            <Button variant="ghost" size="sm" className={QUIET_ACTION} onClick={onPromote}>
              Promote to Timeline
            </Button>
          )}
          {m.can.edit && (
            <Button variant="ghost" size="sm" className={QUIET_ACTION} onClick={onEdit}>
              Edit
            </Button>
          )}
          {m.can.retract && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className={QUIET_ACTION}>
                  Retract
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Retract your message?</AlertDialogTitle>
                  <AlertDialogDescription>Others see that it was retracted.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" disabled={retract.isPending} onClick={() => retract.mutate()}>
                    Retract message
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
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
      initial={{ text: typedText(message.body ?? "", message.mentions), picked: message.mentions, internal: message.internal }}
      offerInternal={false}
      pending={edit.isPending}
      error={edit.error?.message}
      onSubmit={(body) => edit.mutate(body)}
      onCancel={onDone}
    />
  );
}

/** The modifier that sends a message with Enter: ⌘ on Apple devices, Ctrl elsewhere. */
const SEND_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** The "@query" being typed just before the caret, if any. */
const mentionQuery = (text: string, caret: number) => /(?:^|\s)@([^\s@<>]*)$/.exec(text.slice(0, caret))?.[1] ?? null;

/**
 * A message box. Typing "@" offers the people who can see the Case (no Guests on an Internal
 * message); picking one writes "@Name", which becomes a mention when the message is sent. With
 * `offerInternal`, the message can be sent as Internal.
 */
function Composer({
  number,
  label,
  submitLabel,
  initial = { text: "", picked: [], internal: false },
  offerInternal,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  number: number;
  label: string;
  submitLabel: string;
  initial?: { text: string; picked: readonly Person[]; internal: boolean };
  offerInternal: boolean;
  pending: boolean;
  error?: string;
  onSubmit: (body: string, reset: () => void, internal: boolean) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial.text);
  const [picked, setPicked] = useState<readonly Person[]>(initial.picked);
  const [internal, setInternal] = useState(initial.internal);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const people = useQuery({ ...mentionableQuery(number), enabled: query !== null });

  /** Whose name, or any word of it, starts with what's typed after "@". */
  const offered =
    query === null
      ? []
      : (people.data ?? [])
          .filter((p) => !internal || p.role !== "guest")
          .filter((p) => p.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(query.toLowerCase())));

  const picking = query !== null && offered.length > 0;

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
    onSubmit(
      messageBody(text, picked),
      () => {
        setText("");
        setPicked([]);
        setInternal(false);
      },
      internal,
    );
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
        // The mention picker is a listbox the caret stays out of, so the highlighted person is announced from here.
        aria-autocomplete="list"
        aria-controls={picking ? listId : undefined}
        aria-activedescendant={picking ? `${listId}-${highlight}` : undefined}
        placeholder={`Write a message. Type @ to mention someone who can see this Case; ${SEND_KEY}+Enter sends.`}
        value={text}
        maxLength={10_000}
        onChange={(e) => track(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {picking && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People who can see this Case"
          className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-lg border bg-popover text-sm shadow-md"
        >
          {offered.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              className={`cursor-pointer px-3 py-1.5 ${i === highlight ? "bg-accent" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              @{p.name} <span className="text-muted-foreground">· {personRoleLabel[p.role]}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {offerInternal && (
          <Field orientation="horizontal" className="mr-auto w-auto">
            <Checkbox id={`${label}-internal`} checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
            <FieldContent>
              <FieldLabel htmlFor={`${label}-internal`}>Internal</FieldLabel>
              <FieldDescription className="text-xs">Hidden from Guests</FieldDescription>
            </FieldContent>
          </Field>
        )}
        {offerInternal && <Audience number={number} internal={internal} />}
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {/* Outline until there's something to send, so an empty box doesn't carry the page's strongest button. */}
        <Button type="submit" variant={text.trim() ? "default" : "outline"} disabled={pending || !text.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

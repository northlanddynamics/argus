import { useMutation, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { type CaseView, caseKey, casesKey } from "@/lib/cases";
import { tagLabel } from "@/lib/tags";

/** Case page · Tags: adding and removing them. */
export function TagsPanel({ number, tags, readOnly }: { number: number; tags: string[]; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const show = (next: string[]) => {
    queryClient.setQueryData(caseKey(number), (c: CaseView | null | undefined) => (c ? { ...c, tags: next } : c));
    void queryClient.invalidateQueries({ queryKey: casesKey, predicate: ({ queryKey }) => typeof queryKey[1] !== "number" });
  };

  const add = useMutation({
    mutationFn: async (tag: string) => {
      const res = await api.cases[":number"].tags.$post({ param: { number: String(number) }, json: { tag } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not add the Tag"));
      const body = await res.json();
      if (!("tags" in body)) throw new Error("Could not add the Tag");
      return body.tags;
    },
    onSuccess: (next) => {
      show(next);
      setDraft("");
    },
  });

  const remove = useMutation({
    mutationFn: async (tag: string) => {
      // Stored Tags are already URL-safe apart from letters outside ASCII.
      const res = await api.cases[":number"].tags[":tag"].$delete({ param: { number: String(number), tag: encodeURIComponent(tag) } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not remove the Tag"));
      const body = await res.json();
      if (!("tags" in body)) throw new Error("Could not remove the Tag");
      return body.tags;
    },
    onSuccess: show,
  });

  const onAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim()) add.mutate(draft);
  };

  const error = add.error ?? remove.error;
  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle className="text-xs tracking-widest text-muted-foreground uppercase">Tags</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {tags.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {tags.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="gap-1">
                  {tagLabel(tag)}
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${tagLabel(tag)}`}
                      className="-mr-1 size-4 rounded-full hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(tag)}
                    >
                      <XIcon />
                    </Button>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No Tags yet.</p>
        )}
        {!readOnly && (
          <form className="flex gap-2" onSubmit={onAdd}>
            <Input aria-label="New Tag" placeholder="#tag" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} />
            <Button type="submit" variant="outline" size="sm" disabled={add.isPending || !draft.trim()}>
              + Tag
            </Button>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

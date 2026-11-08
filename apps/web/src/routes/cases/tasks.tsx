import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { RowIconButton } from "@/components/row-icon-button";
import { Visibility } from "@/components/visibility";
import { canMarkInternal, canParticipate, caseKey, caseQuery, isReadOnly } from "@/lib/cases";
import { type TaskView, tasksKey, tasksQuery } from "@/lib/tasks";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { TaskDialog } from "@/routes/cases/task-dialog";

/** Case · Tasks: who owns what, when it's due, what's done, and (for Members) what Guests can see. */
export function CaseTasksPage() {
  const { me } = useRouteContext({ from: "/_app/cases/$number" });
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const { data: c } = useQuery(caseQuery(number));
  const tasks = useQuery(tasksQuery(number));
  /** The open dialog: a Task being edited, "new", or none. */
  const [editing, setEditing] = useState<TaskView | "new" | null>(null);

  const setDone = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const res = await api.cases[":number"].tasks[":id"].done.$put({ param: { number: String(number), id }, json: { done } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not change the Task"));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tasksKey(number) });
      void queryClient.invalidateQueries({ queryKey: caseKey(number), exact: true });
    },
  });

  if (!c) return null;
  const readOnly = isReadOnly(c);
  const participating = canParticipate(c);
  /** Guests see only what isn't Internal, so they get no Visibility column. */
  const membersView = c.can.markInternal;
  const columns = membersView ? 6 : 5;
  const list = tasks.data ?? [];
  // On a wide page the columns take set widths and the last one takes the slack, so Owner, Due and Edit stay beside the title.
  return (
    <Card className="@container">
      <CardHeader>
        <CardTitle>
          Tasks{" "}
          <span className="font-normal text-muted-foreground">
            {list.filter((t) => t.done).length} of {list.length} done
          </span>
        </CardTitle>
        {!readOnly && (
          <CardAction>
            <Button onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden />
              New Task
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {setDone.error && (
          <Alert variant="destructive">
            <AlertDescription>{setDone.error.message}</AlertDescription>
          </Alert>
        )}
        <Table className="@3xl:table-fixed">
          {/* Set widths, so the columns hold still as Tasks are added and done. On a wide page the Task
              column stops at 36rem and the last one takes the slack, keeping Owner, Due and Edit beside the title. */}
          <colgroup>
            <col className="@3xl:w-14" />
            <col className="@7xl:w-[36rem]" />
            <col className="@3xl:w-48" />
            <col className="@3xl:w-44" />
            {membersView && <col className="@3xl:w-44" />}
            <col className="@3xl:w-12 @7xl:w-auto" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Done</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Due</TableHead>
              {membersView && <TableHead>Visibility</TableHead>}
              <TableHead>
                <span className="sr-only">Edit</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((t) => (
              <TableRow key={t.id} data-testid={`task-${t.title}`} className="group/row">
                <TableCell>
                  <Checkbox
                    aria-label={`${t.title} done`}
                    checked={t.done}
                    disabled={!participating || setDone.isPending}
                    onCheckedChange={(checked) => setDone.mutate({ id: t.id, done: checked === true })}
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="font-medium">{t.title}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                </TableCell>
                <TableCell className="truncate" title={t.owner.name}>
                  {t.owner.name}
                  {t.owner.id === me.user.id && me.guest ? " (you)" : ""}
                </TableCell>
                <TableCell className="tabular-nums">
                  {t.overdue ? (
                    <Badge variant="outline" className="border-overdue-border text-overdue">
                      Overdue · {t.dueDate}
                    </Badge>
                  ) : (
                    (t.dueDate ?? <span className="text-muted-foreground">—</span>)
                  )}
                </TableCell>
                {membersView && (
                  <TableCell>
                    <Visibility
                      number={number}
                      item={{ kind: "task", id: t.id }}
                      internal={t.internal}
                      label={t.title}
                      canMark={canMarkInternal(c)}
                    />
                  </TableCell>
                )}
                <TableCell className="text-right @7xl:text-left">
                  {!readOnly && (
                    <RowIconButton label="Edit Task" aria-label={`Edit ${t.title}`} onClick={() => setEditing(t)}>
                      <PencilIcon />
                    </RowIconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {tasks.data?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns} className="text-muted-foreground">
                  No Tasks yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {editing && (
        <TaskDialog
          // A fresh form for each Task opened.
          key={editing === "new" ? "new" : editing.id}
          number={number}
          task={editing === "new" ? null : editing}
          defaultOwnerId={me.user.id}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

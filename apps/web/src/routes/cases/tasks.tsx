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
import { byUrgency, type TaskView, tasksKey, tasksQuery } from "@/lib/tasks";
import { useContainerWidth } from "@/hooks/use-container-width";
import { cn } from "@/lib/utils";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { TaskDialog } from "@/routes/cases/task-dialog";

/** A column that gives way on a narrow card: no width and no padding until it has room. */
const from2xl = "overflow-hidden px-0 @2xl:px-2";
const from4xl = "overflow-hidden px-0 @4xl:px-2";

/** When a Task is due: an Overdue badge, the date, or `none`. */
const due = (t: TaskView, none: string) =>
  t.overdue ? (
    <Badge variant="outline" className="border-overdue-border text-overdue">
      Overdue · {t.dueDate}
    </Badge>
  ) : (
    (t.dueDate ?? <span className="text-muted-foreground">{none}</span>)
  );

/** Case · Tasks: who owns what, when it's due, what's done, and (for Members) what Guests can see. */
export function CaseTasksPage() {
  const { me } = useRouteContext({ from: "/_app/cases/$number" });
  const number = useCaseNumber();
  const queryClient = useQueryClient();
  const { data: c } = useQuery(caseQuery(number));
  const tasks = useQuery(tasksQuery(number));
  /** The open dialog: a Task being edited, "new", or none. */
  const [editing, setEditing] = useState<TaskView | "new" | null>(null);
  const { ref, fits } = useContainerWidth<HTMLDivElement>();

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
  /** Open Tasks first, most urgent first, as on the Overview; done ones after, as listed. */
  const list = (tasks.data ?? []).toSorted((a, b) => Number(a.done) - Number(b.done) || (a.done ? 0 : byUrgency(a, b)));
  const owner = (t: TaskView) => `${t.owner.name}${t.owner.id === me.user.id && me.guest ? " (you)" : ""}`;
  const visibility = (t: TaskView) => (
    <Visibility number={number} item={{ kind: "task", id: t.id }} internal={t.internal} label={t.title} canMark={canMarkInternal(c)} quiet />
  );
  // On a wide page the columns take set widths and the last one takes the slack, so Owner, Due and Edit stay beside the title.
  return (
    <Card ref={ref} className="@container">
      <CardHeader className="items-center">
        <CardTitle>
          Tasks{" "}
          <span className="font-normal text-muted-foreground">
            {list.filter((t) => t.done).length} of {list.length} done
          </span>
        </CardTitle>
        {!readOnly && (
          <CardAction className="row-span-1 self-center">
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
        <Table className="table-fixed">
          {/* Set widths, a share of the table never below a minimum, so the columns hold still as Tasks are
              added and done and grow with the screen; the Task takes the rest. On a narrow card Owner and
              Due, then Visibility, give way and show under the title instead. */}
          <colgroup>
            <col className="w-14" />
            <col />
            <col className="w-0 @2xl:w-36 @4xl:w-44 @7xl:w-[13.75%]" />
            <col className="w-0 @2xl:w-40 @7xl:w-[12.5%]" />
            {membersView && <col className="w-0 @4xl:w-44 @7xl:w-[13.75%]" />}
            <col className="w-12" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Done</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className={from2xl}>{fits("2xl") && "Owner"}</TableHead>
              <TableHead className={from2xl}>{fits("2xl") && "Due"}</TableHead>
              {membersView && <TableHead className={from4xl}>{fits("4xl") && "Visibility"}</TableHead>}
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
                <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
                  <div className="font-medium">{t.title}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                  {/* What the columns that have given way hold, under the title. */}
                  {(!fits("2xl") || (membersView && !fits("4xl"))) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {!fits("2xl") && (
                        <>
                          <span>{owner(t)}</span>
                          <span className="tabular-nums">{due(t, "No due date")}</span>
                        </>
                      )}
                      {membersView && !fits("4xl") && visibility(t)}
                    </div>
                  )}
                </TableCell>
                <TableCell className={cn(from2xl, "truncate")} title={t.owner.name}>
                  {fits("2xl") && owner(t)}
                </TableCell>
                <TableCell className={cn(from2xl, "tabular-nums")}>{fits("2xl") && due(t, "—")}</TableCell>
                {membersView && <TableCell className={from4xl}>{fits("4xl") && visibility(t)}</TableCell>}
                <TableCell className="text-right">
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

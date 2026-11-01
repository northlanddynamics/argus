import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { caseKey, caseQuery, isReadOnly } from "@/lib/cases";
import { type TaskView, tasksKey, tasksQuery } from "@/lib/tasks";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { TaskDialog } from "@/routes/cases/task-dialog";

/** Case · Tasks: who owns what, when it's due, and what's done. */
export function CaseTasksPage() {
  const { me } = useRouteContext({ from: "/cases/$number" });
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
  const list = tasks.data ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>
          Tasks{" "}
          <span className="font-normal text-muted-foreground">
            {list.filter((t) => t.done).length} of {list.length} done
          </span>
        </CardTitle>
        {!readOnly && <Button onClick={() => setEditing("new")}>+ New Task</Button>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {setDone.error && (
          <Alert variant="destructive">
            <AlertDescription>{setDone.error.message}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Done</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Due</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((t) => (
              <TableRow key={t.id} data-testid={`task-${t.title}`}>
                <TableCell>
                  <Checkbox
                    aria-label={`${t.title} done`}
                    checked={t.done}
                    disabled={readOnly || setDone.isPending}
                    onCheckedChange={(checked) => setDone.mutate({ id: t.id, done: checked === true })}
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="font-medium">{t.title}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                </TableCell>
                <TableCell>{t.owner.name}</TableCell>
                <TableCell>
                  {t.overdue ? (
                    <Badge variant="outline" className="border-red-300 text-red-700">
                      Overdue · {t.dueDate}
                    </Badge>
                  ) : (
                    (t.dueDate ?? "—")
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!readOnly && (
                    <Button variant="outline" size="sm" aria-label={`Edit ${t.title}`} onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {tasks.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
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

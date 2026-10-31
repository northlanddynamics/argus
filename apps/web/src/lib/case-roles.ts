import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const caseRoleCatalogKey = ["organization", "case-roles"] as const;

/** The Organization's Case Roles, active first; every Member can read it. */
export const caseRoleCatalogQuery = queryOptions({
  queryKey: caseRoleCatalogKey,
  queryFn: async () => {
    const res = await api.organization["case-roles"].$get();
    if (!res.ok) throw new Error("Could not load the Case Roles");
    return (await res.json()).caseRoles;
  },
});

export type CaseRoleEntry = Awaited<ReturnType<typeof caseRoleCatalogQuery.queryFn & {}>>[number];

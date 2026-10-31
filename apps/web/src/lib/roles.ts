export type OrgRole = "owner" | "admin" | "analyst";

export const roleLabel: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", analyst: "Analyst" };

/** Owners and Admins manage the Organization's settings. */
export const canManage = (role: string | undefined) => role === "owner" || role === "admin";

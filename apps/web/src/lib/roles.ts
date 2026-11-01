export type OrgRole = "owner" | "admin" | "analyst";

export const roleLabel: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", analyst: "Analyst" };

/** Owners and Admins manage the Organization's settings. */
export const canManage = (role: string | undefined) => role === "owner" || role === "admin";

/** Someone who can see a Case: a Member by role, or a Guest. */
export const personRoleLabel: Record<OrgRole | "guest", string> = { ...roleLabel, guest: "Guest" };

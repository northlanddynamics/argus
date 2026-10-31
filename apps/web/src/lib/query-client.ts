import { QueryClient } from "@tanstack/react-query";

/** The SPA's one query cache, shared by the router and the live connection. */
export const queryClient = new QueryClient();

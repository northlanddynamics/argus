import { z } from "zod";

/** A facet's values in a query: one (`?severity=high`) or several (`?severity=high&severity=critical`). */
export const oneOrMore = <T extends z.ZodType>(value: T) =>
  z
    .union([value, z.array(value)])
    .transform((v): z.output<T>[] => (Array.isArray(v) ? v : [v]))
    .optional();

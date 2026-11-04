import { useEffect, useRef, useState } from "react";

/** Cases whose `updatedAt` moved since the list last loaded, for a moment, so a row that moves can be followed. */
export function useJustChanged(cases: { number: number; updatedAt: string }[] | undefined) {
  const seen = useRef<Map<number, string> | null>(null);
  const [changed, setChanged] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!cases) return;
    const before = seen.current;
    seen.current = new Map(cases.map((c) => [c.number, c.updatedAt]));
    if (!before) return;
    const moved = new Set(cases.filter((c) => before.has(c.number) && before.get(c.number) !== c.updatedAt).map((c) => c.number));
    if (moved.size === 0) return;
    setChanged(moved);
    const clear = setTimeout(() => setChanged(new Set()), 2000);
    return () => clearTimeout(clear);
  }, [cases]);
  return changed;
}

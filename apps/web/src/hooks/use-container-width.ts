import { useCallback, useLayoutEffect, useState } from "react";

/** Tailwind's container sizes, in rem: `fits("2xl")` holds where `@2xl:` classes apply. */
const SIZES = { md: 28, xl: 36, "2xl": 42, "3xl": 48, "4xl": 56, "5xl": 64, "6xl": 72, "7xl": 80 } as const;

/**
 * The width of an `@container` element, for content that moves between places as it changes (a
 * table cell's value shown under the row's subject once its column has given way). Column widths
 * stay in CSS; this only decides where a value is rendered, so it is in the page once. Pass `ref`
 * to the element that carries `@container`.
 */
export function useContainerWidth<E extends HTMLElement>() {
  const [el, ref] = useState<E | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    // The content box, as container queries measure it.
    const measure = () => {
      const style = getComputedStyle(el);
      const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
      setWidth(el.getBoundingClientRect().width - edges.reduce((sum, edge) => sum + parseFloat(style[edge]), 0));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const fits = useCallback(
    (size: keyof typeof SIZES) => width >= SIZES[size] * parseFloat(getComputedStyle(document.documentElement).fontSize),
    [width],
  );
  return { ref, fits };
}

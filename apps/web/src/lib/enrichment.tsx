import { useQuery } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ObservableType } from "api/observables/vocabulary";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { meQuery } from "@/lib/api";

/**
 * The Enrichment panel's state (`docs/wireframes/enrichment-panel.md`): which Observable it shows,
 * the values followed to get there, and the list it was opened from, so ↑ ↓ can step through it.
 *
 * The value shown is kept in the URL (`?enrichment=ip:185.220.101.4`), so a reload or a pasted link
 * reopens it, and following a link to another page (which carries no such search) closes it. The
 * list is read from the page itself: every value that can open the panel carries
 * `data-enrichment="type:value"`, and the nearest `[data-enrichment-list]` around the value it was
 * opened from bounds the list, in the order the page shows it.
 */

const ENRICHABLE = ["ip", "md5", "sha1", "sha256", "domain", "email", "url"] as const satisfies readonly ObservableType[];
export type EnrichableType = (typeof ENRICHABLE)[number];
export type EnrichmentTarget = { type: EnrichableType; value: string };

/** Whether Argus has a source to look an Observable of `type` up in: IPinfo for IPs, VirusTotal for the rest. */
export const hasEnrichment = (type: string): type is EnrichableType => (ENRICHABLE as readonly string[]).includes(type);

export const enrichmentKey = (t: EnrichmentTarget) => `${t.type}:${t.value}`;

export function parseEnrichmentKey(key: unknown): EnrichmentTarget | null {
  if (typeof key !== "string") return null;
  const at = key.indexOf(":");
  const type = key.slice(0, at);
  const value = key.slice(at + 1);
  return at > 0 && value && hasEnrichment(type) ? { type, value } : null;
}

/** `from` is the element it was opened from, for its list and to return focus to; by default, the value where the page shows it. */
type OpenOptions = { from?: Element | null; focus?: boolean };

type Panel = {
  /** False for Guests: Argus never spends the Organization's quota or a Member's key for them. */
  available: boolean;
  current: EnrichmentTarget | null;
  currentKey: string | null;
  /** The values followed to reach `current`, oldest first; Back returns to the last. */
  history: EnrichmentTarget[];
  /** Bumped when the panel should take focus (opened from the keyboard). */
  focusRequest: number;
  open: (target: EnrichmentTarget, options?: OpenOptions) => void;
  /** Opens the panel on `target` if it shows `target`'s not already, and closes it if it does. */
  toggle: (target: EnrichmentTarget, options?: OpenOptions) => void;
  follow: (target: EnrichmentTarget) => void;
  back: () => void;
  /** The list it was opened from, and where `current` is in it; null when `current` isn't in one. */
  position: () => { index: number; count: number } | null;
  step: (delta: 1 | -1) => void;
  close: () => void;
};

const none = () => {};

/** Outside the app frame (no `EnrichmentProvider`) there is no panel, so nothing offers to open it. */
const NO_PANEL: Panel = {
  available: false,
  current: null,
  currentKey: null,
  history: [],
  focusRequest: 0,
  open: none,
  toggle: none,
  follow: none,
  back: none,
  position: () => null,
  step: none,
  close: none,
};

const EnrichmentContext = createContext<Panel>(NO_PANEL);

export const useEnrichmentPanel = () => useContext(EnrichmentContext);

/** The values in the list around the one the panel was opened from, each once, in page order. */
function listed(list: Element | null) {
  if (!list?.isConnected) return [];
  const elements = new Map<string, Element>();
  for (const el of list.querySelectorAll("[data-enrichment]")) {
    const key = el.getAttribute("data-enrichment")!;
    if (!elements.has(key)) elements.set(key, el);
  }
  return [...elements];
}

export function EnrichmentProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useQuery(meQuery).data;
  const available = !!me?.organization;
  const raw = useRouterState({ select: (s) => (s.location.search as Record<string, unknown>).enrichment });
  const current = useMemo(() => (available ? parseEnrichmentKey(raw) : null), [available, raw]);
  const currentKey = current && enrichmentKey(current);
  const [history, setHistory] = useState<EnrichmentTarget[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const list = useRef<Element | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const show = useCallback(
    (target: EnrichmentTarget | null) =>
      void router.navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, enrichment: target ? enrichmentKey(target) : undefined })) as never,
        replace: true,
        resetScroll: false,
      }),
    [router],
  );

  const panel = useMemo<Panel>(() => {
    const open = (target: EnrichmentTarget, { from: given, focus }: OpenOptions = {}) => {
      if (!available) return;
      // Opened from somewhere that isn't the value itself (a row's menu): the value as the page shows it.
      const from = given ?? document.querySelector(`[data-enrichment="${CSS.escape(enrichmentKey(target))}"]`);
      list.current = from?.closest("[data-enrichment-list]") ?? null;
      opener.current = from instanceof HTMLElement ? from : null;
      setHistory([]);
      if (focus) setFocusRequest((n) => n + 1);
      show(target);
    };
    const close = () => {
      setHistory([]);
      show(null);
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    const position = () => {
      if (!currentKey || history.length) return null;
      const keys = listed(list.current).map(([key]) => key);
      const index = keys.indexOf(currentKey);
      return index < 0 ? null : { index, count: keys.length };
    };
    return {
      available,
      current,
      currentKey,
      history,
      focusRequest,
      open,
      toggle: (target, options) => (currentKey === enrichmentKey(target) ? close() : open(target, options)),
      follow: (target) => {
        if (current) setHistory((h) => [...h, current]);
        show(target);
      },
      back: () => {
        const previous = history.at(-1);
        if (!previous) return;
        setHistory(history.slice(0, -1));
        show(previous);
      },
      position,
      step: (delta) => {
        const at = position();
        if (!at) return;
        const next = listed(list.current)[at.index + delta];
        if (!next) return;
        next[1].scrollIntoView({ block: "nearest" });
        show(parseEnrichmentKey(next[0]));
      },
      close,
    };
  }, [available, current, currentKey, history, focusRequest, show]);

  return <EnrichmentContext.Provider value={panel}>{children}</EnrichmentContext.Provider>;
}

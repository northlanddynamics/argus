import { useQuery } from "@tanstack/react-query";
import type { Map as MapboxMap } from "mapbox-gl";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { mapboxQuery } from "@/lib/mapbox";
import { cn } from "@/lib/utils";

/**
 * Where IPinfo places an IP, on a Mapbox map: a marker at its coordinates and, when IPinfo says how
 * far off they may be, a circle of that radius. Drawn only when the Organization has set a Mapbox
 * token (Settings · Integrations); mapbox-gl is loaded on first use, so pages without a map don't carry it.
 */

/** A circle of `km` around a point, as a GeoJSON polygon (Mapbox has no geographic circle). */
function circle(lng: number, lat: number, km: number, steps = 64) {
  const dx = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const dy = km / 110.574;
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [lng + dx * Math.cos(a), lat + dy * Math.sin(a)];
  });
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [ring] } };
}

/** A zoom that fits the accuracy circle with some room, or a city's view without one. */
const zoomFor = (km: number | null) => (km ? Math.max(1, Math.min(12, Math.log2(40_000 / km) - 1.5)) : 9);

export function IpMap({
  latitude,
  longitude,
  accuracyRadius,
  interactive = true,
  className,
}: {
  latitude: number;
  longitude: number;
  accuracyRadius: number | null;
  /** Off in the hover card, where dragging the map would fight the pointer that keeps it open. */
  interactive?: boolean;
  className?: string;
}) {
  const { data } = useQuery(mapboxQuery);
  const token = data?.token ?? null;
  const { resolvedTheme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token || !container.current) return;
    const node = container.current;
    let map: MapboxMap | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [{ default: mapboxgl }] = await Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")]);
        if (cancelled) return;
        mapboxgl.accessToken = token;
        map = new mapboxgl.Map({
          container: node,
          style: resolvedTheme === "dark" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11",
          center: [longitude, latitude],
          zoom: zoomFor(accuracyRadius),
          interactive,
          scrollZoom: false,
          attributionControl: false,
        });
        map.addControl(new mapboxgl.AttributionControl({ compact: true }));
        if (interactive) map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
        new mapboxgl.Marker({ color: "#e11d48", scale: 0.7 }).setLngLat([longitude, latitude]).addTo(map);
        map.on("error", (e) => {
          // A refused token or an unreachable Mapbox: say so rather than leave a blank box.
          if ((e.error as { status?: number } | undefined)?.status === 401) setFailed(true);
        });
        map.on("load", () => {
          if (!map || !accuracyRadius) return;
          map.addSource("accuracy", { type: "geojson", data: circle(longitude, latitude, accuracyRadius) });
          map.addLayer({ id: "accuracy-fill", type: "fill", source: "accuracy", paint: { "fill-color": "#e11d48", "fill-opacity": 0.08 } });
          map.addLayer({ id: "accuracy-line", type: "line", source: "accuracy", paint: { "line-color": "#e11d48", "line-opacity": 0.5, "line-width": 1 } });
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [token, latitude, longitude, accuracyRadius, interactive, resolvedTheme]);

  if (!token) return null;
  if (failed) return <p className="text-xs text-muted-foreground">Couldn't draw the map: Mapbox refused the token or couldn't be reached.</p>;
  return (
    <div
      ref={container}
      role="img"
      aria-label={`Map of ${latitude}, ${longitude}${accuracyRadius ? `, within ${accuracyRadius} km` : ""}`}
      className={cn("h-48 w-full overflow-hidden rounded-md border bg-muted", className)}
      data-testid="ip-map"
    />
  );
}

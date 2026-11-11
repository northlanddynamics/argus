import type { CenterAction } from "api/action-center/vocabulary";
import { ShieldIcon } from "lucide-react";
import ciscoUmbrella from "@/assets/providers/cisco-umbrella.svg";
import crowdstrike from "@/assets/providers/crowdstrike.svg";
import ipinfo from "@/assets/providers/ipinfo.svg";
import mimecast from "@/assets/providers/mimecast.svg";
import virustotal from "@/assets/providers/virustotal.svg";
import { cn } from "@/lib/utils";

/** The logo of the Provider that runs each action; null for the marks Argus makes itself. */
const logoOf: Record<CenterAction, string | null> = {
  detect: crowdstrike,
  prevent: crowdstrike,
  contain: crowdstrike,
  lift_containment: crowdstrike,
  block_sender: mimecast,
  block_domain: mimecast,
  add_to_destination_list: ciscoUmbrella,
  umbrella_check: ciscoUmbrella,
  ip_lookup: ipinfo,
  hash_lookup: virustotal,
  domain_url_lookup: virustotal,
  mark_important: null,
  ignore: null,
};

/**
 * The logo of what runs `action`: the Provider's on a white tile, so dark marks hold up in the dark
 * theme, or Argus's shield as the sidebar shows it. Decorative: the card names the Provider beside it.
 */
export function ActionLogo({ action, className }: { action: CenterAction; className?: string }) {
  const src = logoOf[action];
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 flex-none place-items-center rounded-md",
        src ? "border bg-white p-1.5" : "bg-sidebar-primary text-sidebar-primary-foreground",
        className,
      )}
    >
      {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" draggable={false} /> : <ShieldIcon className="size-4" />}
    </span>
  );
}

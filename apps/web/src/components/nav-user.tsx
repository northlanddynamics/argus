import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, KeyRoundIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeSubmenu } from "@/components/theme-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { authClient, type Me } from "@/lib/api";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** The signed-in person, with Your settings and adding a passkey (Members only), and signing out. */
export function NavUser({ me }: { me: Me }) {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [passkey, setPasskey] = useState<"idle" | "pending" | "added" | "failed">("idle");
  const { name, email } = me.user;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/sign-in" });
  };
  const addPasskey = async () => {
    setPasskey("pending");
    const result = await authClient.passkey.addPasskey();
    setPasskey(result?.error ? "failed" : "added");
  };

  const who = (
    <>
      <Avatar>
        <AvatarFallback>{initials(name || email)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs">{email}</span>
      </div>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="rail"
              aria-label="Account"
            >
              {who}
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "top" : "right"} align="end" sideOffset={4}>
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{who}</div>
            <DropdownMenuSeparator />
            {me.organization && (
              <DropdownMenuItem asChild>
                <Link to="/account">
                  <SettingsIcon />
                  Your settings
                </Link>
              </DropdownMenuItem>
            )}
            {!me.guest && (
              <DropdownMenuItem
                disabled={passkey === "pending" || passkey === "added"}
                onSelect={(e) => {
                  e.preventDefault();
                  void addPasskey();
                }}
              >
                <KeyRoundIcon />
                {passkey === "added" ? "Passkey added" : passkey === "failed" ? "Passkey not added, try again" : "Add a passkey"}
              </DropdownMenuItem>
            )}
            <ThemeSubmenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

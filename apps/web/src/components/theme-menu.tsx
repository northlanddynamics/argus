import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

const themes = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

/** Light, dark, or following the device: a submenu for an account menu. Remembered per browser. */
export function ThemeSubmenu() {
  const { theme = "system", setTheme } = useTheme();
  const current = themes.find((t) => t.value === theme) ?? themes[0];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <current.icon />
        Theme
        <span className="ml-auto pl-4 text-xs text-muted-foreground">{current.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {themes.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value}>
              <t.icon />
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import themes from "@/config/terminalThemes.json";

export const TERMINAL_THEME_KEY = "phi.terminal.theme";
const THEME_CHANGED = "phi:terminal-theme-changed";
const validTheme = (value: string | null) =>
  value === "auto" || themes.some((theme) => theme.id === value);

export function useTerminalTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem(TERMINAL_THEME_KEY);
      return stored && validTheme(stored) ? stored : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const changed = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (validTheme(value)) setTheme(value);
    };
    window.addEventListener(THEME_CHANGED, changed);
    return () => window.removeEventListener(THEME_CHANGED, changed);
  }, []);
  return [
    theme,
    (value: string) => {
      if (!validTheme(value)) return;
      setTheme(value);
      window.dispatchEvent(new CustomEvent(THEME_CHANGED, { detail: value }));
      try {
        localStorage.setItem(TERMINAL_THEME_KEY, value);
      } catch {
        /* Still apply for this session. */
      }
    },
  ] as const;
}

export function TerminalThemeMenu() {
  const { t } = useTranslation();
  const [value, onChange] = useTerminalTheme();
  const label = (id: string, name: string) =>
    t(`terminal.themes.${id}`, { defaultValue: name });
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{t("terminal.theme")}</span>
        <span aria-hidden="true">›</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("terminal.themeAll")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
              <DropdownMenuRadioItem value="auto">
                <span className="ps-5">{t("terminal.themeAuto")}</span>
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {themes.map((theme) => (
                <DropdownMenuRadioItem key={theme.id} value={theme.id}>
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-3 ps-5">
                    <span>{label(theme.id, theme.name)}</span>
                    <span
                      aria-hidden="true"
                      className="flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-1"
                      style={{ backgroundColor: `#${theme.background}` }}
                    >
                      {[
                        theme.foreground,
                        theme.palette[1],
                        theme.palette[2],
                        theme.palette[4],
                      ].map((color, index) => (
                        <span
                          key={index}
                          className="size-2 rounded-full"
                          style={{ backgroundColor: `#${color}` }}
                        />
                      ))}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

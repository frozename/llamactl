import { useUIStore } from "@/stores/ui-store";

export function useCommandPaletteOpen(): [boolean, (open: boolean) => void] {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  return [open, setOpen];
}

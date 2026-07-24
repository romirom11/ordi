import { FolderKanban } from 'lucide-react';
import { cn } from '../ui';

/** Deterministic hue from a project seed (key or id), matching the Avatar palette feel. */
const HUES = [211, 262, 330, 16, 42, 152, 190, 280, 100, 350];

export function projectHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length]!;
}

export function projectColor(seed: string): string {
  return `hsl(${projectHue(seed)} 58% 52%)`;
}

/** Colored rounded square with the FolderKanban glyph – Linear-style project avatar. */
export function ProjectIcon({ seed, size = 24, radius = 6, className }: {
  seed: string; size?: number; radius?: number; className?: string;
}) {
  const hue = projectHue(seed);
  return (
    <span
      className={cn('grid shrink-0 place-items-center text-white', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(140deg, hsl(${hue} 62% 56%), hsl(${hue} 58% 46%))`,
      }}
      aria-hidden
    >
      <FolderKanban size={Math.round(size * 0.58)} strokeWidth={2.2} />
    </span>
  );
}

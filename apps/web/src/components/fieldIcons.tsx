/**
 * The curated icon set for custom fields and field groups. Stored as the
 * lucide name; an unknown or empty name renders the caller's fallback. The
 * set is deliberately small – a scrollable dump of a thousand icons helps
 * nobody pick "t-shirt size".
 */
import type { ComponentType, ReactNode } from 'react';
import {
  User, Users, Mail, Phone, Send, MessageCircle, AtSign, Cake, Heart, Star,
  Home, MapPin, Globe, Briefcase, GraduationCap, BookOpen, FileText, Link2,
  Tag, Shirt, Coffee, Utensils, Car, Plane, Bike, Calendar, Clock,
  CreditCard, Banknote, Shield, Key, Laptop, Smartphone, Headphones, Camera,
  Music, Gamepad2, Dumbbell, Palette, Gift, Award, Sparkles, SlidersHorizontal,
} from 'lucide-react';
import { DropdownMenu, useMenuClose } from './overlays';
import { cn } from './ui';

export const FIELD_ICONS: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  user: User, users: Users, mail: Mail, phone: Phone, send: Send,
  'message-circle': MessageCircle, 'at-sign': AtSign, cake: Cake, heart: Heart,
  star: Star, home: Home, 'map-pin': MapPin, globe: Globe, briefcase: Briefcase,
  'graduation-cap': GraduationCap, 'book-open': BookOpen, 'file-text': FileText,
  link: Link2, tag: Tag, shirt: Shirt, coffee: Coffee, utensils: Utensils,
  car: Car, plane: Plane, bike: Bike, calendar: Calendar, clock: Clock,
  'credit-card': CreditCard, banknote: Banknote, shield: Shield, key: Key,
  laptop: Laptop, smartphone: Smartphone, headphones: Headphones, camera: Camera,
  music: Music, gamepad: Gamepad2, dumbbell: Dumbbell, palette: Palette,
  gift: Gift, award: Award, sparkles: Sparkles,
};

/** Render a stored icon name; unknown/empty names fall back (or to nothing). */
export function FieldIcon({ name, size = 14, className, fallback = null }: {
  name?: string | null; size?: number; className?: string; fallback?: ReactNode;
}) {
  const Icon = name ? FIELD_ICONS[name] : undefined;
  if (!Icon) return <>{fallback}</>;
  return <Icon size={size} className={className} />;
}

/** A compact grid picker: the trigger shows the current icon (or a slider glyph). */
export function IconPicker({ value, onChange, disabled }: {
  value?: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu
      align="start"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted-foreground',
            'transition-colors duration-150 hover:border-border-strong hover:text-foreground',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <FieldIcon name={value} size={15} fallback={<SlidersHorizontal size={15} className="text-faint" />} />
        </button>
      }
    >
      <IconGrid value={value} onChange={onChange} />
    </DropdownMenu>
  );
}

function IconGrid({ value, onChange }: { value?: string | null; onChange: (icon: string | null) => void }) {
  const close = useMenuClose();
  const pick = (icon: string | null) => { onChange(icon); close(); };
  return (
    <div className="grid w-56 grid-cols-7 gap-0.5 p-1">
      <button
        type="button"
        onClick={() => pick(null)}
        title="–"
        className={cn(
          'grid h-7 w-7 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground',
          !value && 'bg-primary/10 text-primary',
        )}
      >
        –
      </button>
      {Object.entries(FIELD_ICONS).map(([name, Icon]) => (
        <button
          key={name}
          type="button"
          title={name}
          onClick={() => pick(name)}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
            value === name && 'bg-primary/10 text-primary',
          )}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

/**
 * The ordi product mark — distinct from a customer's workspace logo (which is
 * uploaded in Settings and shown in the sidebar).
 *
 * Every product-branded surface renders this component: login, the setup
 * wizard, the invite screen and the desktop instance gate. To swap in the real
 * artwork, replace the SVG below (or point `src` at an imported asset) — this
 * is the only file that needs to change.
 */
import { cn } from './ui';

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" role="img">
        <title>ordi</title>
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="3" />
      </svg>
    </span>
  );
}

/** Mark + wordmark, for headers of product-branded pages. */
export function BrandLockup({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight">ordi</span>
    </span>
  );
}

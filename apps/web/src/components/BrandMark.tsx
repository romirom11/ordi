/**
 * The ordi product mark – distinct from a customer's workspace logo (which is
 * uploaded in Settings and shown in the sidebar).
 *
 * This is the artwork the desktop app already ships as its application icon
 * (apps/desktop/src-tauri/icons): a navy squircle with a white ring. It is
 * redrawn as SVG rather than loaded from that PNG so it stays crisp at 22px in
 * the desktop gate and 40px on login, and costs no request on the pre-auth
 * pages. Colour and geometry were measured off the icon – keep them in step if
 * the icon is ever redrawn.
 *
 * Every product-branded surface renders this component: login, the setup
 * wizard, the invite screen and the desktop instance gate.
 */
import { cn } from './ui';

/** Icon background, sampled from the shipped app icon. */
const BRAND_NAVY = '#283b6b';

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      className={cn('shrink-0 shadow-sm', className)}
      // The rect's own rx scales with the viewBox; this rounds the shadow too.
      style={{ borderRadius: size * 0.22 }}
    >
      <title>ordi</title>
      <rect width="32" height="32" rx="7" fill={BRAND_NAVY} />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" strokeWidth="4.2" />
    </svg>
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

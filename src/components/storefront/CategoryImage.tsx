'use client';
/**
 * <CategoryImage> — Item 17.
 *
 * Renders a category tile / thumbnail image with a designed fallback.
 * Same fall-through pattern as <BrandLogo>: real image → coloured
 * tile with the category initials.
 *
 * Aspect ratio defaults to 4:3 (category tile sizing); pass
 * `aspect="square"` or `aspect="banner"` for variants used in
 * navigation icons and category-page banners respectively.
 */
import { useState } from 'react';
import { colorFromString, initialsFor } from '@/lib/assets/colorFromString';

interface Props {
  imageUrl: string | null | undefined;
  name:     string;
  aspect?:  'tile' | 'square' | 'banner';
  className?: string;
}

const ASPECT_CLS: Record<NonNullable<Props['aspect']>, string> = {
  tile:   'aspect-[4/3]',
  square: 'aspect-square',
  banner: 'aspect-[16/5]',
};

export default function CategoryImage({ imageUrl, name, aspect = 'tile', className }: Props) {
  const [broken, setBroken] = useState(false);
  const showFallback = !imageUrl || imageUrl.trim() === '' || broken;
  const palette = colorFromString(name);
  const initials = initialsFor(name, 1);

  const wrapperCls = `relative w-full overflow-hidden rounded-lg ${ASPECT_CLS[aspect]} ${className ?? ''}`;

  if (showFallback) {
    // CSS gradient based on the deterministic hue → looks like a
    // designed placeholder rather than a grey box. The big initial in
    // the centre keeps the tile recognisable.
    return (
      <div
        role="img"
        aria-label={`${name} category`}
        className={`${wrapperCls} grid place-items-center text-white`}
        style={{
          background: `linear-gradient(135deg, hsl(${palette.hue}, 65%, 55%), hsl(${(palette.hue + 30) % 360}, 65%, 45%))`,
        }}
      >
        <span className="text-5xl font-extrabold drop-shadow-md">{initials}</span>
      </div>
    );
  }
  return (
    <div className={wrapperCls}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={`${name} category`}
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

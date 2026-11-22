import { useEffect, useState } from 'react';

const initials = (title: string) =>
  title
    .split(/[\s:–-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase();

/** Cover image; without an image (or when it fails to load) the title itself is the cover. `small` shows only the initials. */
export default function GameCover({
  src,
  title,
  className = '',
  small = false,
}: {
  src: string | null | undefined;
  title: string;
  className?: string;
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={`gcover ${small ? 'small' : ''} ${className}`.trim()} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span className="gcover-title">{small ? initials(title) : title}</span>
      )}
    </span>
  );
}

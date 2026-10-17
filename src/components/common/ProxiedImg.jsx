import React from 'react';
import { resolveDriveImageUrl, handleDriveImageError } from '../../utils/driveHelper';
import { useProxiedFileUrl } from '../../utils/cfAttachments';

/**
 * <img> for an attachment / Drive URL. Cloudflare mode : a project Drive file is read through GET /api/files/:id (blob: URL), nothing is requested
 * from Drive while it loads, and if the proxy refuses it the original Drive-URL logic is used. Other modes : state 'off' = identical to the old
 * `<img src={resolveDriveImageUrl(att, size)} onError={handleDriveImageError}>`.
 */
export default function ProxiedImg({ att, size = 'w400', urlInput, ...rest }) {
  const proxied = useProxiedFileUrl(att, { imagesOnly: true });
  // urlInput : the exact value the caller used to pass to resolveDriveImageUrl (keeps non-cloudflare behaviour identical)
  const src = proxied.url || (proxied.state === 'loading' ? undefined : resolveDriveImageUrl(urlInput !== undefined ? urlInput : att, size));
  return (
    <img
      {...rest}
      referrerPolicy="no-referrer"
      src={src}
      onError={(e) => { if (!proxied.url) handleDriveImageError(e, att); }}
    />
  );
}

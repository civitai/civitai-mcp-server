/**
 * Image ingestion (scanning) as Civitai reports it on `image.get`'s `ingestion`
 * field.
 *
 * A new image row starts `Pending` and stays hidden from the public REST
 * `/api/v1/images` search until its scan lands: that search only returns
 * scanned images with a rating. So right after `create_post`, `get_image` on a
 * just-attached image finds nothing on REST although the image exists. Treating
 * that as "not found" is what made a client delete fresh posts.
 *
 * `Pending` is a fresh upload waiting for its scan; `Rescan` is one queued for
 * another scan; `PendingManualAssignment` is waiting for a moderator to rate it
 * (the site shows its owner "This image is waiting to be rated"). None of the
 * three is a missing image. `Error`, `Blocked` and `NotFound` are failures, not
 * a wait, so they are not reported as processing: see `isBlockedImage` and
 * `FAILED_INGESTION_STATES`.
 */
export const PROCESSING_INGESTION_STATES: readonly string[] = [
  'Pending',
  'Rescan',
  'PendingManualAssignment',
];

/** Whether an `image.get` ingestion value means the image is still being processed. */
export function isProcessingIngestion(ingestion: unknown): boolean {
  return typeof ingestion === 'string' && PROCESSING_INGESTION_STATES.includes(ingestion);
}

/** The site's rating for an image removed under its terms of service. */
const BLOCKED_NSFW_LEVEL = 32;

/**
 * Whether an `image.get` answer is a blocked image, by the site's own rule: any
 * one of a `Blocked` ingestion, the Blocked rating, or a `blockedFor` reason. A
 * scan error or a rescan moves `ingestion` off `Blocked` but leaves the other
 * two, so a block wins over every ingestion state, processing included. The
 * reason itself is never passed on: the site shows its owner the same notice
 * whatever the cause.
 */
export function isBlockedImage(image: {
  ingestion?: unknown;
  nsfwLevel?: unknown;
  blockedFor?: unknown;
}): boolean {
  return (
    image.ingestion === 'Blocked' ||
    image.nsfwLevel === BLOCKED_NSFW_LEVEL ||
    image.blockedFor != null
  );
}

/**
 * Ingestion states where the scan failed, so the image stays hidden from other
 * users. `Error`: the scan could not finish; the site retries it a bounded
 * number of times, so it can still turn visible, but nothing on `image.get`
 * says whether retries remain. `NotFound`: the site could not load the image
 * file to scan it, and a later clean scan does not lift that.
 */
export const FAILED_INGESTION_STATES: readonly string[] = ['Error', 'NotFound'];

/** Whether an `image.get` ingestion value means the image's scan failed. */
export function isFailedIngestion(ingestion: unknown): boolean {
  return typeof ingestion === 'string' && FAILED_INGESTION_STATES.includes(ingestion);
}

/** What get_image tells a client about each failed ingestion state. */
export const FAILED_ADVICE: Readonly<Record<string, string>> = {
  Error:
    'Civitai could not finish scanning it and retries for a while; if it is still failed later, upload the image again.',
  NotFound: 'Civitai could not load the image file to scan it; upload the image again.',
};

/** What get_image tells a client about a blocked image. */
export const BLOCKED_ADVICE =
  'A blocked image is not visible to other users, and waiting will not change that.';

/** The instruction both create_post and get_image give a client about a processing image. */
export const PROCESSING_ADVICE =
  'Images become visible once scanning finishes. Do not delete the post; ' +
  'call get_image again later.';

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
 * a wait, so they are not reported as processing.
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

/** The instruction both create_post and get_image give a client about a processing image. */
export const PROCESSING_ADVICE =
  'Images become visible once scanning finishes. Do not delete the post; ' +
  'call get_image again later.';

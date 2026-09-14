import { verifyManifest } from './records.mjs';
import { validateSelection } from './selection.mjs';
import { requiredPermissions, assertPermissionSubset } from './permissions.mjs';

/**
 * Build gate for the submission coordination entry. Between "spec frozen" and
 * "generate", re-verify that the actual source still matches the frozen
 * SourceSnapshot, that the catalog belongs to that snapshot, that the selection
 * is valid for the catalog, and that the frozen ceiling covers the required
 * permissions. Any drift refuses the build before candidate bytes are written.
 */
export async function prepareBuild({ sourceDir, snapshot, catalog, selection, origin }) {
  await verifyManifest(sourceDir, snapshot.file_manifest);
  if (catalog.source_digest !== snapshot.source_id) throw new Error('CATALOG_SNAPSHOT_MISMATCH');
  validateSelection(catalog, selection);
  assertPermissionSubset(selection.permission_ceiling, requiredPermissions(catalog, selection, origin));
  return true;
}

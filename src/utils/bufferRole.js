/**
 * Phase 3 (FR-01) : the purchasing checker role "พี่สุ" (roleId BUFFER, level 2).
 * The role is told apart by roleId (never by level) so it can be cut out of the reviewer / approver rules.
 * Dependency-free on purpose : workflowEngine, workspaceService and notificationService all import it.
 */
export const isBufferRole = (user) => {
  if (!user || typeof user !== 'object') return false;
  if (user.isBuffer === true) return true;
  return [user.roleId, user.role_id, user.id, user.canonicalRole, user.positionKey, user.role]
    .some((v) => typeof v === 'string' && v.trim().toUpperCase() === 'BUFFER');
};

export default isBufferRole;

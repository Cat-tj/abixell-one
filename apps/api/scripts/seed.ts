/**
 * Checkpoint 0B demo/testing seed.
 *
 * Creates one demo Tenant with a minimal but complete Identity &
 * Organization structure so the vertical slice (Tenant -> Legal Entity ->
 * Organization Unit -> User -> Auth -> RBAC -> Audit) can be exercised
 * from the thin frontend or integration tests without hand-crafting data
 * through the API every time.
 *
 * Idempotent: safe to re-run, skips creation if the demo Tenant already
 * exists.
 *
 * Usage: npm run seed -w apps/api
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pool } from "../src/infrastructure/persistence/db.js";
import { hashPassword } from "../src/infrastructure/security/password.js";

const DEMO_TENANT_CODE = "demo-gs";

async function main() {
  const existing = await pool.query("SELECT id FROM tenants WHERE code = $1", [
    DEMO_TENANT_CODE,
  ]);
  if (existing.rows[0]) {
    console.log(`Seed skipped: tenant '${DEMO_TENANT_CODE}' already exists.`);
    await pool.end();
    return;
  }

  const tenant = (
    await pool.query(
      `INSERT INTO tenants (code, name) VALUES ($1, $2) RETURNING id`,
      [DEMO_TENANT_CODE, "Demo Enterprise Client"],
    )
  ).rows[0];

  const legalEntity = (
    await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenant.id, "Demo Legal Entity Pte Ltd"],
    )
  ).rows[0];

  const headOffice = (
    await pool.query(
      `INSERT INTO organization_units (tenant_id, legal_entity_id, parent_id, name, unit_type)
       VALUES ($1, $2, NULL, $3, $4) RETURNING id`,
      [tenant.id, legalEntity.id, "Head Office", "Head Office"],
    )
  ).rows[0];

  const siteA = (
    await pool.query(
      `INSERT INTO organization_units (tenant_id, legal_entity_id, parent_id, name, unit_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant.id, legalEntity.id, headOffice.id, "Site A", "Site"],
    )
  ).rows[0];

  // Checkpoint 0F / ADR-0010: ADMIN is marked is_full_access = true —
  // its intent is "every permission that exists", so
  // scripts/sync-role-permissions.ts can keep it in sync with new
  // Product Core permissions on a LIVE tenant without ever deleting
  // data, replacing the reseed pattern this exact role hit in 0C/0D/0E.
  const adminRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name, is_full_access) VALUES ($1, 'ADMIN', 'Administrator', true) RETURNING id`,
      [tenant.id],
    )
  ).rows[0];

  const supervisorRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'SUPERVISOR', 'Site Supervisor') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];

  const allPermissions = (await pool.query(`SELECT id FROM permissions`)).rows;
  for (const p of allPermissions) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
      [adminRole.id, p.id],
    );
  }

  // Supervisor: read-only. No *.create/*.manage permissions — proves the
  // backend rejects create/manage attempts from this role, not just
  // hides the button.
  const readOnlyPermissionCodes = [
    "organization_unit.read",
    "user.read",
    "tenant.read",
    "config.read",
  ];
  const readOnlyPermissions = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [
      readOnlyPermissionCodes,
    ])
  ).rows;
  for (const p of readOnlyPermissions) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
      [supervisorRole.id, p.id],
    );
  }

  // Checkpoint 0D demo roles: WORKFLOW_REVIEWER (Site A scope) and
  // WORKFLOW_MANAGER (tenant-wide) — proves Workflow Assignment routing
  // to a role+scope "queue" (not a pre-picked user) and the hierarchical
  // Escalation target, reusing the same Site A / Head Office structure
  // Checkpoints 0B/0C already demonstrate Data Scope and Configuration
  // Scope with.
  const workflowReviewerRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'WORKFLOW_REVIEWER', 'Workflow Reviewer') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const workflowManagerRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'WORKFLOW_MANAGER', 'Workflow Manager') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  // Checkpoint 0E: also grant the two demo Workflow roles read access to
  // their own Notifications and Documents — they are exactly the kind of
  // recipient/attachment-reader these Shared Services exist for, and
  // without this permission the events fired during the Workflow demo
  // (e.g. workflow.assigned) create real `notifications` rows the demo
  // user still can't view via the API — a real gap, not a nitpick.
  const workflowPermissionCodes = [
    "workflow.instance.read",
    "workflow.instance.act",
    "notification.read",
    "document.read",
  ];
  const workflowPermissions = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [workflowPermissionCodes])
  ).rows;
  for (const p of workflowPermissions) {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      workflowReviewerRole.id,
      p.id,
    ]);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      workflowManagerRole.id,
      p.id,
    ]);
  }

  const adminPasswordHash = await hashPassword("admin123!");
  const admin = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'admin@demo.local', $2, 'Demo Administrator') RETURNING id`,
      [tenant.id, adminPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
     VALUES ($1, $2, 'tenant')`,
    [admin.id, adminRole.id],
  );

  const supervisorPasswordHash = await hashPassword("Supervisor12345!");
  const supervisor = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'supervisor@demo.local', $2, 'Demo Site Supervisor') RETURNING id`,
      [tenant.id, supervisorPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments
       (user_id, role_id, scope_type, scope_organization_unit_id)
     VALUES ($1, $2, 'organization_unit', $3)`,
    [supervisor.id, supervisorRole.id, siteA.id],
  );

  const workflowReviewerPasswordHash = await hashPassword("Reviewer12345!");
  const workflowReviewer = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'reviewer@demo.local', $2, 'Demo Workflow Reviewer') RETURNING id`,
      [tenant.id, workflowReviewerPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments
       (user_id, role_id, scope_type, scope_organization_unit_id)
     VALUES ($1, $2, 'organization_unit', $3)`,
    [workflowReviewer.id, workflowReviewerRole.id, siteA.id],
  );

  const workflowManagerPasswordHash = await hashPassword("Manager12345!");
  const workflowManager = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'manager@demo.local', $2, 'Demo Workflow Manager') RETURNING id`,
      [tenant.id, workflowManagerPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
     VALUES ($1, $2, 'tenant')`,
    [workflowManager.id, workflowManagerRole.id],
  );

  // Epic 1 (§4.1 C) demo fixture — separation of duties. This user holds TWO
  // Roles with DIFFERENT Data Scopes: CREATOR tenant-wide, APPROVER scoped to
  // Site A. Before §4.1, authorization read the union of every assignment, so
  // switching context changed only what the UI showed. After §4.1 the active
  // Role is server-side session state: signed in as APPROVER, the tenant-wide
  // reach CREATOR would have granted is gone, and vice versa. The integration
  // suite signs in as this user to pin exactly that.
  const creatorRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'CREATOR', 'Creator') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const approverRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'APPROVER', 'Approver') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const dualPermissions = (
    await pool.query(`SELECT id, code FROM permissions WHERE code = ANY($1)`, [
      [
        "organization_unit.read",
        "user.read",
        "tenant.read",
        "config.read",
      ],
    ])
  ).rows;
  const dualRoleIds = [creatorRole.id, approverRole.id];
  for (const roleId of dualRoleIds) {
    for (const p of dualPermissions) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, p.id],
      );
    }
  }

  const dualPasswordHash = await hashPassword("Dual12345!");
  const dual = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'dual@demo.local', $2, 'Demo Dual Role') RETURNING id`,
      [tenant.id, dualPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
     VALUES ($1, $2, 'tenant')`,
    [dual.id, creatorRole.id],
  );
  await pool.query(
    `INSERT INTO user_role_assignments
       (user_id, role_id, scope_type, scope_organization_unit_id)
     VALUES ($1, $2, 'organization_unit', $3)`,
    [dual.id, approverRole.id, siteA.id],
  );

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, NULL, 'tenant.seeded', 'tenant', $1, $2)`,
    [tenant.id, JSON.stringify({ source: "seed script" })],
  );

  // --- Checkpoint 0C: Configuration & Metadata demo data ---------------------
  // Demonstrates that Module Activation, Feature Flags (with Configuration
  // Scope precedence), Terminology, Reference Data, and Numbering are all
  // genuinely tenant-specific -- nothing here is hardcoded in Product Core,
  // it is all rows created for THIS demo tenant against the Product Core
  // catalog seeded by the migration.

  // Note: Module Activation is not seeded by default. Use the API
  // (PUT /config/modules/<code> with {"isActive":true}) after a seed to
  // activate modules on demand. This allows clean DB state and explicit
  // per-session activation without durability gaps.

  // Feature Flag: set a tenant-wide value, then override it at Site A to
  // prove Configuration Scope precedence (Organization Unit > Tenant).
  const offlineFlag = (
    await pool.query(`SELECT id FROM feature_flags WHERE code = 'offline_field_mode'`)
  ).rows[0];
  if (offlineFlag) {
    await pool.query(
      `INSERT INTO tenant_feature_flags
         (tenant_id, feature_flag_id, scope_type, scope_organization_unit_id, is_enabled)
       VALUES ($1, $2, 'tenant', NULL, false)`,
      [tenant.id, offlineFlag.id],
    );
    await pool.query(
      `INSERT INTO tenant_feature_flags
         (tenant_id, feature_flag_id, scope_type, scope_organization_unit_id, is_enabled)
       VALUES ($1, $2, 'organization_unit', $3, true)`,
      [tenant.id, offlineFlag.id, siteA.id],
    );
  }

  // Terminology: rename "Organization Unit" to a client-specific term to
  // prove UI labels come from Terminology, not hardcoded strings.
  const orgUnitTerm = (
    await pool.query(`SELECT id FROM terminology_keys WHERE code = 'organization_unit.label'`)
  ).rows[0];
  if (orgUnitTerm) {
    await pool.query(
      `INSERT INTO tenant_terminology_overrides (tenant_id, terminology_key_id, value)
       VALUES ($1, $2, 'Site')`,
      [tenant.id, orgUnitTerm.id],
    );
  }

  // Reference Data: seed two Priority Level items for this tenant. The
  // Epic-2 Wave-2 trigger already seeds low/medium/high/critical as core
  // items on tenant creation, so these are additive only where absent.
  const priorityType = (
    await pool.query(`SELECT id FROM reference_data_types WHERE code = 'priority_level'`)
  ).rows[0];
  if (priorityType) {
    await pool.query(
      `INSERT INTO tenant_reference_data_items
         (tenant_id, reference_data_type_id, code, label, sort_order)
       VALUES ($1, $2, 'high', 'High', 1), ($1, $2, 'low', 'Low', 2)
       ON CONFLICT (tenant_id, reference_data_type_id, code) DO NOTHING`,
      [tenant.id, priorityType.id],
    );
  }

  // Numbering: a tenant-specific ticket numbering sequence, e.g.
  // TCK-2026-00001, proving numbering patterns are per-tenant configuration.
  await pool.query(
    `INSERT INTO numbering_sequences (tenant_id, code, pattern, current_sequence)
     VALUES ($1, 'demo_ticket', 'TCK-{YYYY}-{SEQ:5}', 0)`,
    [tenant.id],
  );

  // --- Checkpoint 0D: Workflow & Approval Engine demo definition --------------
  // A single, fully published Workflow Definition proving every required
  // capability end-to-end against the generic `demo_transactions` object
  // ONLY (no Complaint/Survey/Procurement business logic, per explicit
  // Founder instruction): Versioning (this is version 1, published +
  // current), Step/State (REVIEW/REVISE/COMPLETE/REJECTED), Transition
  // (approve/reject/return/resubmit), Condition (category=high_risk
  // routes to WORKFLOW_MANAGER instead of the default WORKFLOW_REVIEWER),
  // Assignment (role+scope AND specific_user types both used), Approval
  // (approve -> COMPLETE), Reject (reject -> REJECTED), Return (return ->
  // REVISE -> resubmit loops back to REVIEW), Escalation (4h SLA on
  // REVIEW, escalates to WORKFLOW_MANAGER tenant-wide), SLA-ready hook
  // (sla_hours -> due_at), Notification-ready hook (fires on every
  // assign/approve/reject/return/escalate/complete).
  const workflowDefinition = (
    await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description, created_by)
       VALUES ($1, 'demo_approval_workflow', 'Demo Generic Approval Workflow', 'demo_transaction',
               'Checkpoint 0D engine-proof workflow — routes a generic dummy transaction through Review, with Condition-based dynamic assignment, Escalation, and a Return/Resubmit rework loop.',
               $2)
       RETURNING id`,
      [tenant.id, admin.id],
    )
  ).rows[0];

  const workflowVersion = (
    await pool.query(
      `INSERT INTO workflow_versions (workflow_definition_id, version_number, status, is_current, created_by, published_at)
       VALUES ($1, 1, 'published', true, $2, now())
       RETURNING id`,
      [workflowDefinition.id, admin.id],
    )
  ).rows[0];

  const reviewStep = (
    await pool.query(
      `INSERT INTO workflow_steps
         (workflow_version_id, code, name, step_type, is_initial, is_terminal, sla_hours, sequence_order)
       VALUES ($1, 'REVIEW', 'Review', 'approval', true, false, 4, 1)
       RETURNING id`,
      [workflowVersion.id],
    )
  ).rows[0];
  const reviseStep = (
    await pool.query(
      `INSERT INTO workflow_steps
         (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'REVISE', 'Revise', 'task', false, false, 2)
       RETURNING id`,
      [workflowVersion.id],
    )
  ).rows[0];
  const completeStep = (
    await pool.query(
      `INSERT INTO workflow_steps
         (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'COMPLETE', 'Complete', 'end', false, true, 'approved', 3)
       RETURNING id`,
      [workflowVersion.id],
    )
  ).rows[0];
  const rejectedStep = (
    await pool.query(
      `INSERT INTO workflow_steps
         (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'REJECTED', 'Rejected', 'end', false, true, 'rejected', 4)
       RETURNING id`,
      [workflowVersion.id],
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO workflow_transitions (workflow_version_id, from_step_id, to_step_id, action_code, name, sort_order)
     VALUES
       ($1, $2, $4, 'approve', 'Approve', 1),
       ($1, $2, $5, 'reject', 'Reject', 2),
       ($1, $2, $3, 'return', 'Return for revision', 3),
       ($1, $3, $2, 'resubmit', 'Resubmit after revision', 1)`,
    [workflowVersion.id, reviewStep.id, reviseStep.id, completeStep.id, rejectedStep.id],
  );

  // Condition-based dynamic routing (doc 04 "Dynamic Routing"): a
  // high_risk transaction skips the local Reviewer and goes straight to
  // the tenant-wide Manager; everything else defaults to the Site-scoped
  // Reviewer. Rules are evaluated in sort_order — first match wins.
  await pool.query(
    `INSERT INTO workflow_assignment_rules
       (workflow_step_id, sort_order, condition_expression, assignment_type, role_code, organization_unit_strategy)
     VALUES
       ($1, 1, $2, 'role', 'WORKFLOW_MANAGER', 'tenant'),
       ($1, 2, NULL, 'role', 'WORKFLOW_REVIEWER', 'submitter_unit')`,
    [reviewStep.id, JSON.stringify({ field: "category", operator: "eq", value: "high_risk" })],
  );
  // REVISE is routed back to whoever originally started the instance —
  // proves the 'specific_user' assignment type, distinct from role+scope.
  await pool.query(
    `INSERT INTO workflow_assignment_rules
       (workflow_step_id, sort_order, assignment_type, specific_user_source)
     VALUES ($1, 1, 'specific_user', 'submitter')`,
    [reviseStep.id],
  );

  // Escalation hook: REVIEW's 4-hour SLA, if exceeded, reassigns to
  // WORKFLOW_MANAGER tenant-wide (a Site-level task escalating up the
  // Organization Hierarchy, per doc 04's "Escalate jika lewat SLA").
  await pool.query(
    `INSERT INTO workflow_escalation_rules
       (workflow_step_id, escalate_after_hours, escalate_to_role_code, escalate_to_organization_unit_strategy, note)
     VALUES ($1, 4, 'WORKFLOW_MANAGER', 'tenant', 'SLA exceeded at Review — escalate to tenant-wide Workflow Manager')`,
    [reviewStep.id],
  );

  // --- Checkpoint 0E: Notification Templates + Integration Endpoints ---------
  // Notification Templates are Tenant Configuration (doc 06) — these three
  // prove the Notification Engine actually renders and delivers against
  // the Workflow events 0D/0E now publish (workflow.assigned on Assignment
  // creation, workflow.completed on terminal Step, workflow.escalated on
  // the Scheduler-driven sweep), without any business-module involvement.
  await pool.query(
    `INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
     VALUES
       ($1, 'workflow.assigned', 'in_app', 'New task assigned',
        'A workflow task (instance {{workflowInstanceId}}) has been assigned to you.'),
       ($1, 'workflow.completed', 'in_app', 'Workflow completed',
        'Your submission (instance {{workflowInstanceId}}) has been {{terminalStatus}}.'),
       ($1, 'workflow.escalated', 'in_app', 'Task escalated to you',
        'A workflow task at step {{stepCode}} was escalated to your role after its SLA was exceeded.')`,
    [tenant.id],
  );

  // Integration Boundary demo data (doc 07): one active outbound Endpoint
  // (proves the EventBus wildcard subscriber logs a stub dispatch per
  // Domain Event) and one active inbound Endpoint with a generated
  // webhook secret (proves the signed webhook receiver end-to-end via
  // `curl` — see docs/implementation-notes.md for a worked example).
  await pool.query(
    `INSERT INTO integration_endpoints (tenant_id, code, name, direction, base_url, is_active)
     VALUES ($1, 'demo-erp-sync', 'Demo ERP Sync (outbound stub)', 'outbound', 'https://example-erp.local/api', true)`,
    [tenant.id],
  );
  const inboundWebhookSecret = "demo-webhook-secret-0e";
  await pool.query(
    `INSERT INTO integration_endpoints (tenant_id, code, name, direction, webhook_secret, is_active)
     VALUES ($1, 'demo-inbound', 'Demo Inbound Webhook', 'inbound', $2, true)`,
    [tenant.id, inboundWebhookSecret],
  );

  // --- Checkpoint 1A: Customer Experience Foundation demo data ---------------
  // Proves the full 1A E2E target end to end: Customer -> Contact ->
  // Contract/Project/Site -> Service Assigned -> Customer User login ->
  // Data Scope Applied. `ownerOrganizationUnitId = siteA` means the
  // existing SUPERVISOR (Site A org-unit scope) and WORKFLOW_MANAGER/
  // ADMIN (tenant-wide) can all reach this Customer through
  // `RbacService.requireCustomerContextScope`'s org-unit branch; the new
  // Customer User below reaches it through the `customer` scope branch
  // instead — two different Data Scope axes converging on the same
  // authorization decision, per ADR-0011.
  const customer = (
    await pool.query(
      `INSERT INTO customers (tenant_id, code, name, owner_organization_unit_id)
       VALUES ($1, 'CUST-001', 'PT Demo Client Indonesia', $2) RETURNING id`,
      [tenant.id, siteA.id],
    )
  ).rows[0];

  const customerContact = (
    await pool.query(
      `INSERT INTO customer_contacts (tenant_id, customer_id, name, email, phone, is_primary)
       VALUES ($1, $2, 'Budi Santoso', 'budi.santoso@democlient.local', '+62-811-0000-0001', true)
       RETURNING id`,
      [tenant.id, customer.id],
    )
  ).rows[0];

  const contract = (
    await pool.query(
      `INSERT INTO contracts (tenant_id, customer_id, code, name, start_date, status)
       VALUES ($1, $2, 'CTR-2026-001', 'Demo Service Agreement 2026', '2026-01-01', 'active')
       RETURNING id`,
      [tenant.id, customer.id],
    )
  ).rows[0];

  const project = (
    await pool.query(
      `INSERT INTO projects (tenant_id, customer_id, contract_id, code, name)
       VALUES ($1, $2, $3, 'PRJ-001', 'Site Operations Support') RETURNING id`,
      [tenant.id, customer.id, contract.id],
    )
  ).rows[0];

  const customerSite = (
    await pool.query(
      `INSERT INTO sites (tenant_id, customer_id, project_id, code, name, address)
       VALUES ($1, $2, $3, 'SITE-001', 'Demo Client Site 1', 'Jl. Demo No. 1, Jakarta')
       RETURNING id`,
      [tenant.id, customer.id, project.id],
    )
  ).rows[0];

  const service = (
    await pool.query(
      `INSERT INTO services (tenant_id, code, name, description)
       VALUES ($1, 'SVC-GENERAL', 'General Services', 'Dummy Service catalog entry — Client Configuration, not Product Core content')
       RETURNING id`,
      [tenant.id],
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO customer_service_links
       (tenant_id, customer_id, service_id, contract_id, project_id, site_id, internal_pic_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenant.id, customer.id, service.id, contract.id, project.id, customerSite.id, supervisor.id],
  );

  // CUSTOMER_USER role: read-only over its own Customer's foundation
  // data. Deliberately does NOT include any `document.*` permission —
  // Document access for entityType='customer' goes entirely through the
  // Entity Authorization Resolver (ADR-0012), not this permission catalog
  // (the Checkpoint 1A binding decision: "attachment tidak memiliki
  // independent business authorization yang terpisah dari parent
  // business entity").
  const customerUserRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'CUSTOMER_USER', 'Customer User') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const customerUserPermissionCodes = [
    "customer.read",
    "contract.read",
    "project.read",
    "site.read",
    "service.read",
    // Notification read — the Customer portal surfaces task notifications on
    // the role dashboard; without this the notifications block omits itself.
    "notification.read",
  ];
  const customerUserPermissions = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [
      customerUserPermissionCodes,
    ])
  ).rows;
  for (const p of customerUserPermissions) {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      customerUserRole.id,
      p.id,
    ]);
  }

  const customerUserPasswordHash = await hashPassword("CustomerUser12345!");
  const customerUser = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'customeruser@democlient.local', $2, 'Demo Customer User') RETURNING id`,
      [tenant.id, customerUserPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_customer_id)
     VALUES ($1, $2, 'customer', $3)`,
    [customerUser.id, customerUserRole.id, customer.id],
  );

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, NULL, 'customer.seeded', 'customer', $2, $3)`,
    [tenant.id, customer.id, JSON.stringify({ source: "seed script", code: "CUST-001" })],
  );

  // --- Checkpoint 1B: Generic Customer Complaint Engine demo data ------------
  // Proves "Workflow tidak boleh hardcoded di Complaint Service" literally:
  // every Step/Transition/Assignment Rule/Escalation Rule/SLA below is
  // ordinary Tenant Configuration data for `entity_type='complaint'`,
  // created through the exact same generic Workflow Engine tables 0D/0E
  // already ship — ComplaintService only knows the Definition CODE
  // (`complaint_lifecycle`), never the Step graph itself.
  const complaintWorkflowDefinition = (
    await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description, created_by)
       VALUES ($1, 'complaint_lifecycle', 'Customer Complaint Lifecycle', 'complaint',
               'Checkpoint 1B demo lifecycle — Draft -> Submitted -> Acknowledged -> Assigned -> Investigation -> Corrective Action -> Verification -> Customer Confirmation -> Closed, with Reject/Cancel/Escalate paths. 100% Tenant Configuration, zero hardcoded state machine in ComplaintService.',
               $2)
       RETURNING id`,
      [tenant.id, admin.id],
    )
  ).rows[0];

  const complaintWorkflowVersion = (
    await pool.query(
      `INSERT INTO workflow_versions (workflow_definition_id, version_number, status, is_current, created_by, published_at)
       VALUES ($1, 1, 'published', true, $2, now())
       RETURNING id`,
      [complaintWorkflowDefinition.id, admin.id],
    )
  ).rows[0];

  const stepDraft = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'DRAFT', 'Draft', 'task', true, false, 1) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepSubmitted = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sla_hours, sequence_order)
       VALUES ($1, 'SUBMITTED', 'Submitted', 'task', false, false, 4, 2) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepAcknowledged = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'ACKNOWLEDGED', 'Acknowledged', 'task', false, false, 3) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepAssigned = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sla_hours, sequence_order)
       VALUES ($1, 'ASSIGNED', 'Assigned', 'task', false, false, 8, 4) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepInvestigation = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sla_hours, sequence_order)
       VALUES ($1, 'IN_INVESTIGATION', 'In Investigation', 'task', false, false, 48, 5) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepCorrectiveAction = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'CORRECTIVE_ACTION', 'Corrective Action', 'task', false, false, 6) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepVerification = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'VERIFICATION', 'Verification', 'approval', false, false, 7) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepCustomerConfirmation = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'CUSTOMER_CONFIRMATION', 'Customer Confirmation', 'approval', false, false, 8) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepClosed = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'CLOSED', 'Closed', 'end', false, true, 'approved', 9) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepRejected = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'REJECTED', 'Rejected', 'end', false, true, 'rejected', 10) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];
  const stepCancelled = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'CANCELLED', 'Cancelled', 'end', false, true, 'cancelled', 11) RETURNING id`,
      [complaintWorkflowVersion.id],
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO workflow_transitions (workflow_version_id, from_step_id, to_step_id, action_code, name, sort_order)
     VALUES
       ($1, $2,  $3,  'submit',                   'Submit',                     1),
       ($1, $2,  $12, 'cancel',                    'Cancel',                     2),
       ($1, $3,  $4,  'acknowledge',                'Acknowledge',                1),
       ($1, $3,  $11, 'reject',                    'Reject',                     2),
       ($1, $4,  $5,  'assign',                    'Assign',                     1),
       ($1, $5,  $6,  'start_investigation',       'Start Investigation',        1),
       ($1, $6,  $7,  'submit_corrective_action',  'Submit Corrective Action',   1),
       ($1, $7,  $8,  'submit_for_verification',   'Submit for Verification',    1),
       ($1, $8,  $9,  'verify',                    'Verify',                     1),
       ($1, $9,  $10, 'confirm',                   'Customer Confirm & Close',   1)`,
    [
      complaintWorkflowVersion.id,
      stepDraft.id,
      stepSubmitted.id,
      stepAcknowledged.id,
      stepAssigned.id,
      stepInvestigation.id,
      stepCorrectiveAction.id,
      stepVerification.id,
      stepCustomerConfirmation.id,
      stepClosed.id,
      stepRejected.id,
      stepCancelled.id,
    ],
  );

  // Assignment Rules. DRAFT / CUSTOMER_CONFIRMATION route back to the
  // Customer User who submitted the Complaint (`specific_user`/`submitter`
  // — the same mechanism the 0D demo workflow's REVISE step uses).
  // Internal steps route to COMPLAINT_HANDLER via `submitter_unit` (the
  // Customer's own `ownerOrganizationUnitId`, passed as `organizationUnitId`
  // in `contextData` by ComplaintService.create). ASSIGNED demonstrates
  // Condition-based dynamic routing (doc 04): severity=critical skips the
  // local Handler and goes straight to the tenant-wide COMPLAINT_MANAGER.
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, specific_user_source)
     VALUES ($1, 1, 'specific_user', 'submitter')`,
    [stepDraft.id],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
     VALUES ($1, 1, 'role', 'COMPLAINT_HANDLER', 'submitter_unit')`,
    [stepSubmitted.id],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
     VALUES ($1, 1, 'role', 'COMPLAINT_HANDLER', 'submitter_unit')`,
    [stepAcknowledged.id],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules
       (workflow_step_id, sort_order, condition_expression, assignment_type, role_code, organization_unit_strategy)
     VALUES
       ($1, 1, $2, 'role', 'COMPLAINT_MANAGER', 'tenant'),
       ($1, 2, NULL, 'role', 'COMPLAINT_HANDLER', 'submitter_unit')`,
    [stepAssigned.id, JSON.stringify({ field: "severity", operator: "eq", value: "critical" })],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
     VALUES ($1, 1, 'role', 'COMPLAINT_HANDLER', 'submitter_unit')`,
    [stepInvestigation.id],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
     VALUES ($1, 1, 'role', 'COMPLAINT_HANDLER', 'submitter_unit')`,
    [stepCorrectiveAction.id],
  );
  // Verification is independent QA — the tenant-wide COMPLAINT_MANAGER,
  // never the same Handler who ran the investigation.
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
     VALUES ($1, 1, 'role', 'COMPLAINT_MANAGER', 'tenant')`,
    [stepVerification.id],
  );
  await pool.query(
    `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, specific_user_source)
     VALUES ($1, 1, 'specific_user', 'submitter')`,
    [stepCustomerConfirmation.id],
  );

  // Escalation: if Investigation exceeds its 48h SLA, escalate to the
  // tenant-wide COMPLAINT_MANAGER — proves the SLA/Escalation E2E target
  // ("SLA escalation" negative/positive path) without any Complaint-
  // specific Scheduler code (reuses the same sweep 0D/0E already run).
  await pool.query(
    `INSERT INTO workflow_escalation_rules
       (workflow_step_id, escalate_after_hours, escalate_to_role_code, escalate_to_organization_unit_strategy, note)
     VALUES ($1, 48, 'COMPLAINT_MANAGER', 'tenant', 'Investigation SLA exceeded — escalate to tenant-wide Complaint Manager')`,
    [stepInvestigation.id],
  );

  // Notification Templates for the Complaint Event Catalog (doc section 33)
  // — reuses the exact same generic Notification Engine as 0E/1A, nothing
  // Complaint-specific in the engine itself.
  await pool.query(
    `INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
     VALUES
       ($1, 'complaint.submitted', 'in_app', 'Complaint submitted',
        'Complaint {{complaintNumber}} has been submitted and is awaiting acknowledgement.'),
       ($1, 'complaint.assigned', 'in_app', 'Complaint assigned to you',
        'Complaint {{complaintNumber}} has been assigned to you for investigation.'),
       ($1, 'complaint.closed', 'in_app', 'Complaint closed',
        'Complaint {{complaintNumber}} has been closed.'),
       ($1, 'complaint.escalated', 'in_app', 'Complaint escalated to you',
        'Complaint at step {{stepCode}} was escalated to your role after its SLA was exceeded.'),
       ($1, 'complaint.reopened', 'in_app', 'Complaint reopened',
        'Complaint {{complaintNumber}} has been reopened.')`,
    [tenant.id],
  );

  // Reference Data: Complaint Category and Severity catalogs (Priority
  // deliberately REUSES the existing generic `priority_level` items seeded
  // above — proving Priority and Severity are two distinct concepts/
  // catalogs, per the explicit Founder instruction, not the same field
  // twice).
  const categoryType = (
    await pool.query(`SELECT id FROM reference_data_types WHERE code = 'complaint_category'`)
  ).rows[0];
  if (categoryType) {
    await pool.query(
      `INSERT INTO tenant_reference_data_items (tenant_id, reference_data_type_id, code, label, sort_order)
       VALUES
         ($1, $2, 'service_quality', 'Service Quality', 1),
         ($1, $2, 'safety', 'Safety', 2),
         ($1, $2, 'billing', 'Billing', 3),
         ($1, $2, 'facility', 'Facility', 4)`,
      [tenant.id, categoryType.id],
    );
  }
  const severityType = (
    await pool.query(`SELECT id FROM reference_data_types WHERE code = 'complaint_severity'`)
  ).rows[0];
  if (severityType) {
    await pool.query(
      `INSERT INTO tenant_reference_data_items (tenant_id, reference_data_type_id, code, label, sort_order)
       VALUES
         ($1, $2, 'critical', 'Critical', 1),
         ($1, $2, 'major', 'Major', 2),
         ($1, $2, 'minor', 'Minor', 3)`,
      [tenant.id, severityType.id],
    );
  }

  // Numbering: CMP-{YYYY}-{SEQ:5} — tenant-configurable Complaint numbering,
  // exactly like `demo_ticket` above (Checkpoint 0C mechanism, no new code).
  await pool.query(
    `INSERT INTO numbering_sequences (tenant_id, code, pattern, current_sequence)
     VALUES ($1, 'complaint_number', 'CMP-{YYYY}-{SEQ:5}', 0)`,
    [tenant.id],
  );

  // COMPLAINT_HANDLER: internal investigator, Site A org-unit scope (same
  // hierarchical Data Scope axis as SUPERVISOR/WORKFLOW_REVIEWER, ADR-0009)
  // — reaches the demo Customer's Complaints via
  // `CustomerService.canAccessForDocument`'s org-unit branch. Deliberately
  // does NOT include `workflow.instance.read`: `ComplaintService.get`/`act`/
  // `reopen` all go through the trusted-caller `getInstanceForEntityOwner`,
  // so this role never needs the broad, Tenant-wide "read every Workflow
  // Instance" permission just to do its job (see decision-log.md).
  const complaintHandlerRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'COMPLAINT_HANDLER', 'Complaint Handler') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const complaintManagerRole = (
    await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'COMPLAINT_MANAGER', 'Complaint Manager') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const complaintHandlerPermissionCodes = [
    "complaint.read",
    "complaint.manage",
    "workflow.instance.act",
    "customer.read",
    "notification.read",
  ];
  const complaintHandlerPermissions = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [
      complaintHandlerPermissionCodes,
    ])
  ).rows;
  for (const p of complaintHandlerPermissions) {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      complaintHandlerRole.id,
      p.id,
    ]);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      complaintManagerRole.id,
      p.id,
    ]);
  }
  // COMPLAINT_MANAGER additionally gets `workflow.instance.manage` so the
  // Founder can also exercise manual Escalation/administration during
  // Founder Review, on top of its tenant-wide Verification/Escalation
  // routing target role above.
  const workflowManagePermission = (
    await pool.query(`SELECT id FROM permissions WHERE code = 'workflow.instance.manage'`)
  ).rows[0];
  if (workflowManagePermission) {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      complaintManagerRole.id,
      workflowManagePermission.id,
    ]);
  }
  // Checkpoint 1C.5 (FD-1C-02): COMPLAINT_MANAGER is the demo tenant's
  // management persona — grant it Management Dashboard visibility. Generic
  // permission; the grant here is demo configuration, not a Core assumption.
  const dashboardReadPermission = (
    await pool.query(`SELECT id FROM permissions WHERE code = 'complaint.dashboard.read'`)
  ).rows[0];
  if (dashboardReadPermission) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [complaintManagerRole.id, dashboardReadPermission.id],
    );
  }

  const complaintHandlerPasswordHash = await hashPassword("Handler12345!");
  const complaintHandler = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'handler@demo.local', $2, 'Demo Complaint Handler') RETURNING id`,
      [tenant.id, complaintHandlerPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_organization_unit_id)
     VALUES ($1, $2, 'organization_unit', $3)`,
    [complaintHandler.id, complaintHandlerRole.id, siteA.id],
  );

  const complaintManagerPasswordHash = await hashPassword("ComplaintManager12345!");
  const complaintManagerUser = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'complaintmanager@demo.local', $2, 'Demo Complaint Manager') RETURNING id`,
      [tenant.id, complaintManagerPasswordHash],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
     VALUES ($1, $2, 'tenant')`,
    [complaintManagerUser.id, complaintManagerRole.id],
  );

  // Grant the existing CUSTOMER_USER role the permissions it needs to
  // submit/track/confirm its own Complaints. Deliberately NOT
  // `workflow.instance.read` — same reasoning as COMPLAINT_HANDLER above,
  // and it prevents a Customer User from browsing every Workflow Instance
  // in the tenant via the raw `/workflow/*` routes (see decision-log.md).
  const customerUserComplaintPermissionCodes = [
    "complaint.read",
    "complaint.manage",
    "workflow.instance.start",
    "workflow.instance.act",
    // Checkpoint 1D.1: a Customer User can respond to surveys assigned to
    // them (e.g. a satisfaction survey). survey.manage/results stay with
    // internal/admin roles (ADMIN via sync) — never granted here.
    "survey.respond",
  ];
  const customerUserComplaintPermissions = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [
      customerUserComplaintPermissionCodes,
    ])
  ).rows;
  for (const p of customerUserComplaintPermissions) {
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
      customerUserRole.id,
      p.id,
    ]);
  }

  // --- Checkpoint 1C: Catering Vertical Foundation demo data ------------------
  // The catering vertical is seeded INTO demo-gs so one tenant shows the whole
  // system (identity, workflows, complaints, catering, accounting). The
  // FASE-0 pilot script `seed-pilot-catering.ts` stays on its own branch for
  // staging init — this section is a pure-SQL adaptation of the same fixture,
  // without the FastifyInstance/HTTP calls that script uses. Catering roles are
  // strictly additive: no existing demo role code is touched.
  const cateringOrgUnit = (
    await pool.query(
      `INSERT INTO organization_units (tenant_id, legal_entity_id, parent_id, name, unit_type)
       VALUES ($1, $2, $3, 'Catering Operations', 'Site') RETURNING id`,
      [tenant.id, legalEntity.id, headOffice.id],
    )
  ).rows[0];

  // Service pack activation: the catering module is opt-in per tenant
  // (Checkpoint 0C deliberately does not activate modules by default), so the
  // vertical needs its pack flag explicitly set here.
  await pool.query(
    `INSERT INTO service_pack_activations (tenant_id, pack_code, is_active, activated_by)
     VALUES ($1, 'catering', true, $2)
     ON CONFLICT (tenant_id, pack_code) DO UPDATE SET is_active = true`,
    [tenant.id, admin.id],
  );

  // Catering roles (COORD_OPS / EXEC_OPS / VERIFY_OPS / BILL_OPS) with the
  // pilot's permission sets, kept separate from the demo roles above.
  const cateringRolePermissionCodes: Record<string, string[]> = {
    COORD_OPS: [
      "service_operations.read",
      "service_operations.manage",
      "service_operations.configure",
      "customer.read",
      "workflow.instance.start",
      "workflow.instance.act",
    ],
    EXEC_OPS: ["service_operations.read", "service_operations.execute", "workflow.instance.act"],
    VERIFY_OPS: ["service_operations.read", "service_operations.verify", "workflow.instance.act"],
    BILL_OPS: ["service_operations.read", "service_operations.billing.manage", "customer.read"],
  };
  const cateringRoleIds: Record<string, string> = {};
  for (const [code, permissionCodes] of Object.entries(cateringRolePermissionCodes)) {
    const role = (
      await pool.query(`INSERT INTO roles (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [
        tenant.id,
        code,
      ])
    ).rows[0];
    cateringRoleIds[code] = role.id;
    const permissions = (
      await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [permissionCodes])
    ).rows;
    if (permissions.length !== permissionCodes.length) {
      throw new Error(
        `catering role ${code}: expected ${permissionCodes.length} permissions, found ${permissions.length}`,
      );
    }
    for (const p of permissions) {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
        role.id,
        p.id,
      ]);
    }
  }

  // Catering users — same demo-fixture password pattern as the accounts above.
  const cateringUsers = [
    { roleCode: "COORD_OPS", email: "coord@demo.local", fullName: "Demo Coordinator Ops", password: "Coord12345!" },
    { roleCode: "EXEC_OPS", email: "exec@demo.local", fullName: "Demo Executor Ops", password: "Exec12345!" },
    { roleCode: "VERIFY_OPS", email: "verify@demo.local", fullName: "Demo Verifier Ops", password: "Verify12345!" },
    { roleCode: "BILL_OPS", email: "bill@demo.local", fullName: "Demo Billing Ops", password: "Bill12345!" },
  ];
  for (const u of cateringUsers) {
    const passwordHash = await hashPassword(u.password);
    const user = (
      await pool.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.id, u.email, passwordHash, u.fullName],
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
       VALUES ($1, $2, 'tenant')`,
      [user.id, cateringRoleIds[u.roleCode]],
    );
  }

  // Catering numbering: WO-00001 / INV-00001 — the same tenant-configurable
  // mechanism as `demo_ticket` and `complaint_number` above.
  await pool.query(
    `INSERT INTO numbering_sequences (tenant_id, code, pattern, current_sequence)
     VALUES ($1, 'work_order', 'WO-{SEQ:5}', 0), ($1, 'customer_invoice', 'INV-{SEQ:5}', 0),
            ($1, 'work_request', 'WR-{SEQ:5}', 0), ($1, 'work_order_serving', 'SRV-{SEQ:5}', 0)`,
    [tenant.id],
  );

  // Catering workflow definition: Work Order Lifecycle (PLANNED →
  // IN_PROGRESS → DONE → CLOSED). Steps/transitions/assignment rules are
  // ordinary tenant configuration rows, exactly like complaint_lifecycle
  // above — nothing catering-specific is hardcoded in the engine.
  const cateringWorkflowDefinition = (
    await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description, created_by)
       VALUES ($1, 'service_operations_work_order', 'Work Order Lifecycle', 'work_order',
               'Checkpoint 1C catering work-order lifecycle — PLANNED -> IN_PROGRESS -> DONE -> CLOSED.',
               $2)
       RETURNING id`,
      [tenant.id, admin.id],
    )
  ).rows[0];
  const cateringWorkflowVersion = (
    await pool.query(
      `INSERT INTO workflow_versions (workflow_definition_id, version_number, status, is_current, created_by, published_at)
       VALUES ($1, 1, 'published', true, $2, now()) RETURNING id`,
      [cateringWorkflowDefinition.id, admin.id],
    )
  ).rows[0];
  const stepPlanned = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'PLANNED', 'Planned', 'task', true, false, 1) RETURNING id`,
      [cateringWorkflowVersion.id],
    )
  ).rows[0];
  const stepInProgress = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'IN_PROGRESS', 'In Progress', 'task', false, false, 2) RETURNING id`,
      [cateringWorkflowVersion.id],
    )
  ).rows[0];
  const stepDone = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, sequence_order)
       VALUES ($1, 'DONE', 'Done', 'approval', false, false, 3) RETURNING id`,
      [cateringWorkflowVersion.id],
    )
  ).rows[0];
  const stepWoClosed = (
    await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sequence_order)
       VALUES ($1, 'CLOSED', 'Closed', 'end', false, true, 'approved', 4) RETURNING id`,
      [cateringWorkflowVersion.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO workflow_transitions (workflow_version_id, from_step_id, to_step_id, action_code, name, sort_order)
     VALUES
       ($1, $2, $3, 'start', 'Start', 1),
       ($1, $3, $4, 'complete', 'Complete', 1),
       ($1, $4, $5, 'verify', 'Verify', 1)`,
    [cateringWorkflowVersion.id, stepPlanned.id, stepInProgress.id, stepDone.id, stepWoClosed.id],
  );
  for (const stepId of [stepPlanned.id, stepInProgress.id, stepDone.id]) {
    await pool.query(
      `INSERT INTO workflow_assignment_rules (workflow_step_id, sort_order, assignment_type, role_code, organization_unit_strategy)
       VALUES ($1, 1, 'role', 'COORD_OPS', 'tenant')`,
      [stepId],
    );
  }

  // Catering customer + site (served by the Catering Operations unit above —
  // kept separate from CUST-001/SITE-001, which belong to the complaint demo).
  const cateringCustomer = (
    await pool.query(
      `INSERT INTO customers (tenant_id, code, name, owner_organization_unit_id)
       VALUES ($1, 'CUST-CATER', 'Demo Catering Client', $2) RETURNING id`,
      [tenant.id, cateringOrgUnit.id],
    )
  ).rows[0];
  const cateringSite = (
    await pool.query(
      `INSERT INTO sites (tenant_id, customer_id, code, name)
       VALUES ($1, $2, 'SITE-CATER', 'Demo Catering Site') RETURNING id`,
      [tenant.id, cateringCustomer.id],
    )
  ).rows[0];

  const cateringService = (
    await pool.query(
      `INSERT INTO services (tenant_id, code, name, description)
       VALUES ($1, 'SVC-CATERING', 'Catering Service', 'Catering vertical demo service — seeded for the unified demo tenant')
       RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO service_definitions (tenant_id, code, name, description, created_by)
     VALUES ($1, 'catering_demo_service', 'Catering Demo Service', 'Work-order template for the catering vertical demo', $2)`,
    [tenant.id, admin.id],
  );
  await pool.query(
    `INSERT INTO customer_service_links (tenant_id, customer_id, service_id, site_id)
     VALUES ($1, $2, $3, $4)`,
    [tenant.id, cateringCustomer.id, cateringService.id, cateringSite.id],
  );

  // Units of measure + conversion (K4 simple factor): 1 KG = 1000 G.
  const kgUnit = (
    await pool.query(
      `INSERT INTO units_of_measure (tenant_id, code, name, base_unit_code, category)
       VALUES ($1, 'KG', 'Kilogram', 'KG', 'mass') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  const gUnit = (
    await pool.query(
      `INSERT INTO units_of_measure (tenant_id, code, name, base_unit_code, category)
       VALUES ($1, 'G', 'Gram', 'G', 'mass') RETURNING id`,
      [tenant.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO unit_conversions (tenant_id, from_unit_id, to_unit_id, factor, effective_from)
     VALUES ($1, $2, $3, 1000::numeric(18,6), '2020-01-01')`,
    [tenant.id, kgUnit.id, gUnit.id],
  );

  // Items + one valuation layer (100 KG @ 12.000 IDR/KG) — the layer the
  // recipe costing below reads.
  const riceItem = (
    await pool.query(
      `INSERT INTO items (tenant_id, code, name, unit_of_measure, unit_of_measure_id)
       VALUES ($1, 'RICE', 'Rice', 'KG', $2) RETURNING id`,
      [tenant.id, kgUnit.id],
    )
  ).rows[0];
  const cookedRiceItem = (
    await pool.query(
      `INSERT INTO items (tenant_id, code, name, unit_of_measure, unit_of_measure_id)
       VALUES ($1, 'COOKED-RICE', 'Cooked Rice', 'KG', $2) RETURNING id`,
      [tenant.id, kgUnit.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO scm_valuation_layers
       (tenant_id, item_id, received_date, original_quantity, remaining_quantity,
        unit_cost, effective_unit_cost, total_value)
     VALUES ($1, $2, CURRENT_DATE, 100, 100, 12000, 12000, 1200000)`,
    [tenant.id, riceItem.id],
  );

  // Menu + recipe + ingredient (500 G rice → 2 KG cooked rice).
  const TODAY = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO catering_menus (tenant_id, code, name, effective_from, created_by, updated_by)
     VALUES ($1, 'MENU-DEMO', 'Demo Lunch Menu', $2::date, $3, $3)`,
    [tenant.id, TODAY, admin.id],
  );
  const cateringRecipe = (
    await pool.query(
      `INSERT INTO catering_recipes
         (tenant_id, code, name, output_item_id, output_quantity, output_unit_id, effective_from, created_by, updated_by)
       VALUES ($1, 'RC-COOKED-RICE', 'Cooked Rice Recipe', $2, 2, $3, $4::date, $5, $5)
       RETURNING id`,
      [tenant.id, cookedRiceItem.id, kgUnit.id, TODAY, admin.id],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO catering_recipe_ingredients (tenant_id, recipe_id, item_id, quantity, unit_id, sort_order)
     VALUES ($1, $2, $3, 500, $4, 0)`,
    [tenant.id, cateringRecipe.id, riceItem.id, gUnit.id],
  );

  // --- Checkpoint 1D: Accounting Foundation demo data -------------------------
  // The catering vertical posts to the Accounting Kernel (work-order cost →
  // invoice → tax), so the demo tenant needs the same accounting foundation
  // the pilot seed builds: a non-login kernel actor, one open period, a COA,
  // five GL accounts, and the three posting rules. Migrations seed posting
  // rules for existing tenants only; a fresh tenant needs them here.
  // Kernel actor is a service account: it never logs in. Store a real bcrypt
  // hash of an unguessable throwaway secret (never printed, never recorded)
  // instead of a placeholder, so the row can never be authenticated.
  const kernelActorHash = await hashPassword(
    randomBytes(32).toString("base64url"),
  );
  const kernelActor = (
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, 'kernel-actor@demo.local', $2, 'Accounting Kernel Actor') RETURNING id`,
      [tenant.id, kernelActorHash],
    )
  ).rows[0];

  const accountingPeriod = (
    await pool.query(
      `INSERT INTO accounting_periods
         (tenant_id, legal_entity_id, fiscal_year_code, period_code, period_name,
          period_type, date_from, date_to, status, created_by)
       VALUES ($1, $2, 'FY2026', 'OCT-2026', 'Oktober 2026', 'monthly',
               '2026-10-01', '2026-10-31', 'open', $3) RETURNING id`,
      [tenant.id, legalEntity.id, kernelActor.id],
    )
  ).rows[0];

  const coa = (
    await pool.query(
      `INSERT INTO chart_of_accounts
         (tenant_id, legal_entity_id, coa_version_code, coa_version_date, is_active, created_by)
       VALUES ($1, $2, 'FY2026', '2026-01-01', true, $3) RETURNING id`,
      [tenant.id, legalEntity.id, kernelActor.id],
    )
  ).rows[0];

  const glAccounts = [
    { code: "1210", name: "Accounts Receivable", cls: "ASSET", normal: "debit" },
    { code: "2410", name: "Tax Payable", cls: "LIABILITY", normal: "credit" },
    { code: "2500", name: "Accrued WO Cost", cls: "LIABILITY", normal: "credit" },
    { code: "4100", name: "Service Revenue", cls: "INCOME", normal: "credit" },
    { code: "6200", name: "WO Cost", cls: "EXPENSE", normal: "debit" },
  ];
  for (const acc of glAccounts) {
    await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name,
          account_class, normal_balance, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [tenant.id, legalEntity.id, coa.id, acc.code, acc.name, acc.cls, acc.normal, kernelActor.id],
    );
  }

  const postingRules = [
    {
      code: "RULE_WO_COST_ACCUMULATED",
      name: "WO Cost Accumulated",
      trigger: "work_order.cost_accumulated",
      legs: [
        { accountCode: "6200", side: "debit", amountExpression: "AMOUNT" },
        { accountCode: "2500", side: "credit", amountExpression: "AMOUNT" },
      ],
    },
    {
      code: "RULE_WO_INVOICED",
      name: "WO Invoiced",
      trigger: "work_order.invoiced",
      legs: [
        { accountCode: "1210", side: "debit", amountExpression: "AMOUNT" },
        { accountCode: "4100", side: "credit", amountExpression: "AMOUNT" },
      ],
    },
    {
      code: "RULE_WO_INVOICE_TAX",
      name: "WO Invoice Tax",
      trigger: "work_order.invoice_tax",
      legs: [
        { accountCode: "1210", side: "debit", amountExpression: "AMOUNT" },
        { accountCode: "2410", side: "credit", amountExpression: "AMOUNT" },
      ],
    },
  ];
  for (const rule of postingRules) {
    await pool.query(
      `INSERT INTO posting_rules
         (tenant_id, rule_code, rule_name, rule_version, trigger_event_type,
          accounting_formula, requires_approval, effective_date, is_active, created_by)
       VALUES ($1, $2, $3, 'v1', $4, $5::jsonb, false, '2026-01-01', true, $6)`,
      [tenant.id, rule.code, rule.name, rule.trigger, JSON.stringify(rule.legs), kernelActor.id],
    );
  }

  // Tenant markup parameter (15%) at level 'S' — System-level value, the
  // pilot's decimal default for invoice pricing.
  const markupParam = (
    await pool.query(`SELECT id FROM app_parameters WHERE code = $1`, [
      "service_operations.invoice.default_markup",
    ])
  ).rows[0];
  if (markupParam) {
    await pool.query(
      `INSERT INTO app_parameter_values (tenant_id, parameter_id, level, value, updated_by)
       VALUES ($1, $2, 'S', '0.15'::jsonb, $3)`,
      [tenant.id, markupParam.id, admin.id],
    );
  }

  // Activate every business module for the demo tenant — matches the new
  // tenant-creation default, so the demo application is usable immediately.
  await pool.query(
    `INSERT INTO tenant_module_activations (tenant_id, module_id, is_active, updated_by)
     SELECT $1, m.id, true, NULL
       FROM modules m
      WHERE m.code <> 'platform'
     ON CONFLICT (tenant_id, module_id) DO UPDATE SET is_active = true, updated_at = now()`,
    [tenant.id],
  );

  console.log("Seed complete:");
  console.log(`  Tenant code:        ${DEMO_TENANT_CODE}`);
  console.log(`  Legal Entity:       ${legalEntity.id}`);
  console.log(`  Organization Units: Head Office=${headOffice.id}, Site A=${siteA.id}`);
  console.log(`  Admin login:        admin@demo.local / Admin12345! (tenant-wide scope)`);
  console.log(
    `  Supervisor login:   supervisor@demo.local / Supervisor12345! (Site A scope only, read-only permissions)`,
  );
  console.log(
    `  Reviewer login:     reviewer@demo.local / Reviewer12345! (WORKFLOW_REVIEWER, Site A scope)`,
  );
  console.log(
    `  Manager login:      manager@demo.local / Manager12345! (WORKFLOW_MANAGER, tenant-wide scope)`,
  );
  console.log(
    `  Dual Role login:    dual@demo.local / Dual12345! (CREATOR tenant-wide + APPROVER Site A — Epic 1 §4.1 SoD fixture)`,
  );
  console.log(`  Workflow demo:      demo_approval_workflow v1 (published)`);
  console.log(`  Inbound webhook:    POST /integration/webhook/${DEMO_TENANT_CODE}/demo-inbound`);
  console.log(`    Signature header: X-Webhook-Signature = HMAC-SHA256(secret, rawBody) hex`);
  console.log(`    Secret (dev-only): ${inboundWebhookSecret}`);
  console.log(`  Customer demo:      ${customer.id} (CUST-001, owner org unit = Site A)`);
  console.log(
    `  Customer User login: customeruser@democlient.local / CustomerUser12345! (customer scope = CUST-001 only)`,
  );
  console.log(`  Complaint workflow:  complaint_lifecycle v1 (published)`);
  console.log(
    `  Handler login:       handler@demo.local / Handler12345! (COMPLAINT_HANDLER, Site A scope)`,
  );
  console.log(
    `  Complaint Mgr login: complaintmanager@demo.local / ComplaintManager12345! (COMPLAINT_MANAGER, tenant-wide scope)`,
  );
  console.log(`  Catering workflow:   service_operations_work_order v1 (published)`);
  console.log(`  Catering org unit:   Catering Operations=${cateringOrgUnit.id} (under Head Office)`);
  console.log(`  Catering customer:   ${cateringCustomer.id} (CUST-CATER) / site ${cateringSite.id} (SITE-CATER)`);
  console.log(`  Catering menu/recipe: MENU-DEMO / RC-COOKED-RICE (RICE 500 G -> COOKED-RICE 2 KG)`);
  console.log(`  Catering logins:`);
  console.log(`    coord@demo.local  / Coord12345!   (COORD_OPS)`);
  console.log(`    exec@demo.local   / Exec12345!    (EXEC_OPS)`);
  console.log(`    verify@demo.local / Verify12345!  (VERIFY_OPS)`);
  console.log(`    bill@demo.local   / Bill12345!    (BILL_OPS)`);
  console.log(`  Accounting:          period ${accountingPeriod.id} (OCT-2026, open), COA FY2026, 5 GL accounts, 3 posting rules`);
  console.log(`  Invoice markup:      service_operations.invoice.default_markup = 0.15`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

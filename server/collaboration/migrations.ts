import type { DatabaseSync } from "node:sqlite";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { applyTurnPartsMigration } from "./turn-sources.ts";

export const COLLABORATION_SCHEMA_VERSION = 41;

interface Migration {
  version: number;
  name: string;
  checksum: string;
  apply(database: DatabaseSync): void;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initialize-collaboration-ledger",
    checksum: "v1:collaboration-ledger-metadata",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_ledger_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format TEXT NOT NULL,
          source_baseline TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      database
        .prepare(
          "INSERT INTO collaboration_ledger_metadata " +
            "(singleton, format, source_baseline, created_at) VALUES (1, ?, ?, ?)",
        )
        .run("openmausbot-collaboration", OPENMAUSBOT_SOURCE_BASELINE, Date.now());
    },
  },
  {
    version: 2,
    name: "add-work-item-ingress",
    checksum: "v2:identity-conversation-event-work-item-outbox",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_principals (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'unresolved')),
          display_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_principal_aliases (
          source TEXT NOT NULL,
          alias_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source, alias_kind, scope_id, external_id)
        ) STRICT;
        CREATE INDEX collaboration_principal_alias_principal
          ON collaboration_principal_aliases(principal_id);

        CREATE TABLE collaboration_conversations (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE collaboration_conversation_aliases (
          source TEXT NOT NULL,
          external_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source, external_id)
        ) STRICT;

        CREATE TABLE collaboration_work_items (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('collecting', 'waiting_clarification', 'cancelled', 'accepted')),
          version INTEGER NOT NULL CHECK (version > 0),
          created_by TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX collaboration_work_items_conversation_status
          ON collaboration_work_items(conversation_id, status, updated_at DESC);

        CREATE TABLE collaboration_external_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          transport_message_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          kind TEXT NOT NULL CHECK (kind = 'message'),
          normalized_json TEXT NOT NULL,
          raw_hash TEXT NOT NULL,
          association_state TEXT NOT NULL CHECK (association_state IN ('created', 'associated', 'ambiguous', 'invalid_reference')),
          work_item_id TEXT REFERENCES collaboration_work_items(id),
          received_at INTEGER NOT NULL,
          UNIQUE (source, source_event_id)
        ) STRICT;
        CREATE INDEX collaboration_external_events_work_item
          ON collaboration_external_events(work_item_id, received_at);

        CREATE TABLE collaboration_work_item_events (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          external_event_id TEXT NOT NULL UNIQUE REFERENCES collaboration_external_events(id),
          event_type TEXT NOT NULL CHECK (event_type IN ('problem.reported', 'contribution.added')),
          payload_json TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_association_options (
          external_event_id TEXT NOT NULL REFERENCES collaboration_external_events(id),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          PRIMARY KEY (external_event_id, work_item_id)
        ) STRICT;

        CREATE TABLE collaboration_outbox (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('work_item', 'association')),
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('primary_status_card', 'association_choice_card', 'invalid_reference_card')),
          dedupe_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER
        ) STRICT;
        CREATE INDEX collaboration_outbox_pending
          ON collaboration_outbox(sent_at, created_at);
      `);
    },
  },
  {
    version: 3,
    name: "add-definition-and-planning",
    checksum: "v3:snapshots-frontier-fenced-plans-sequential-graph-outbox",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_items
          ADD COLUMN definition_status TEXT NOT NULL DEFAULT 'collecting'
          CHECK (definition_status IN (
            'collecting', 'waiting_clarification', 'planning', 'ready_for_execution', 'planning_failed'
          ));
        ALTER TABLE collaboration_work_items
          ADD COLUMN current_plan_revision INTEGER;

        CREATE TABLE collaboration_work_item_snapshots (
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          source_work_item_version INTEGER NOT NULL CHECK (source_work_item_version > 0),
          goal TEXT,
          goal_confirmed INTEGER NOT NULL CHECK (goal_confirmed IN (0, 1)),
          repository TEXT,
          facts_json TEXT NOT NULL,
          assumptions_json TEXT NOT NULL,
          acceptance_json TEXT NOT NULL,
          blocking_ambiguities_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_clarification_rounds (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          snapshot_revision INTEGER NOT NULL,
          questions_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (work_item_id, snapshot_revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_plan_revisions (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          snapshot_revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('published', 'planning_failed')),
          summary TEXT,
          proposal_hash TEXT,
          failure_json TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (work_item_id, revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_planning_attempts (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          snapshot_revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'failed', 'stale')),
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE (work_item_id, snapshot_revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_work_nodes (
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL CHECK (node_type IN ('analyze', 'modify', 'validate', 'report')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
          assigned_agent_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          input_evidence_json TEXT NOT NULL,
          instructions TEXT NOT NULL,
          read_scope_json TEXT NOT NULL,
          write_scope_json TEXT NOT NULL,
          deny_scope_json TEXT NOT NULL,
          commands_json TEXT NOT NULL,
          expected_artifacts_json TEXT NOT NULL,
          completion_definition TEXT NOT NULL,
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          budget_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (work_item_id, plan_revision, node_id),
          FOREIGN KEY (work_item_id, plan_revision)
            REFERENCES collaboration_plan_revisions(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_work_edges (
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind = 'blocks'),
          PRIMARY KEY (work_item_id, plan_revision, from_node_id, to_node_id),
          FOREIGN KEY (work_item_id, plan_revision, from_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id),
          FOREIGN KEY (work_item_id, plan_revision, to_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TABLE collaboration_plan_node_classifications (
          work_item_id TEXT NOT NULL,
          new_plan_revision INTEGER NOT NULL,
          previous_plan_revision INTEGER NOT NULL,
          previous_node_id TEXT NOT NULL,
          classification TEXT NOT NULL CHECK (classification IN ('valid', 'revalidate', 'obsolete')),
          reason TEXT NOT NULL,
          PRIMARY KEY (work_item_id, new_plan_revision, previous_plan_revision, previous_node_id),
          FOREIGN KEY (work_item_id, new_plan_revision)
            REFERENCES collaboration_plan_revisions(work_item_id, revision),
          FOREIGN KEY (work_item_id, previous_plan_revision, previous_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TRIGGER collaboration_snapshots_no_update
          BEFORE UPDATE ON collaboration_work_item_snapshots
          BEGIN SELECT RAISE(ABORT, 'work item snapshots are immutable'); END;
        CREATE TRIGGER collaboration_snapshots_no_delete
          BEFORE DELETE ON collaboration_work_item_snapshots
          BEGIN SELECT RAISE(ABORT, 'work item snapshots are immutable'); END;
        CREATE TRIGGER collaboration_plan_revisions_no_update
          BEFORE UPDATE ON collaboration_plan_revisions
          BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;
        CREATE TRIGGER collaboration_plan_revisions_no_delete
          BEFORE DELETE ON collaboration_plan_revisions
          BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;

        ALTER TABLE collaboration_outbox RENAME TO collaboration_outbox_v2;
        CREATE TABLE collaboration_outbox (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('work_item', 'association', 'plan')),
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'primary_status_card', 'association_choice_card', 'invalid_reference_card',
            'clarification_card', 'plan_status_card'
          )),
          dedupe_key TEXT NOT NULL UNIQUE,
          supersession_key TEXT,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          superseded_at INTEGER
        ) STRICT;
        INSERT INTO collaboration_outbox
          (id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind,
          dedupe_key, payload_json, created_at, sent_at)
        SELECT id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind,
               dedupe_key, payload_json, created_at, sent_at
        FROM collaboration_outbox_v2;
        DROP TABLE collaboration_outbox_v2;
        CREATE INDEX collaboration_outbox_pending
          ON collaboration_outbox(sent_at, created_at);
      `);
    },
  },
  {
    version: 4,
    name: "add-trusted-candidate-execution",
    checksum: "v4:runs-candidates-test-evidence-audit",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_nodes
          ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'not_started'
          CHECK (execution_status IN (
            'not_started', 'running', 'candidate_ready', 'invalid', 'needs_configuration', 'failed'
          ));

        CREATE TABLE collaboration_runs (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          agent_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'running', 'succeeded', 'failed', 'invalid', 'needs_configuration', 'timed_out'
          )),
          repository_path TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          result_sha TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          error TEXT,
          UNIQUE (work_item_id, plan_revision, node_id, attempt),
          FOREIGN KEY (work_item_id, plan_revision, node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TABLE collaboration_run_events (
          run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_type TEXT NOT NULL CHECK (event_type IN ('progress', 'warning', 'result')),
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, sequence)
        ) STRICT;

        CREATE TABLE collaboration_candidates (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES collaboration_runs(id),
          state TEXT NOT NULL CHECK (state IN (
            'target_tests_passed', 'test_failed', 'not_verified', 'invalid', 'needs_configuration'
          )),
          base_sha TEXT NOT NULL,
          result_sha TEXT,
          changed_paths_json TEXT NOT NULL,
          violations_json TEXT NOT NULL,
          quality_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_test_evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          command_id TEXT NOT NULL,
          argv_json TEXT NOT NULL,
          cwd TEXT NOT NULL,
          exit_code INTEGER,
          duration_ms INTEGER NOT NULL,
          stdout TEXT NOT NULL,
          stderr TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('target_passed', 'failed', 'timeout', 'output_limit')),
          created_at INTEGER NOT NULL,
          UNIQUE (run_id, command_id)
        ) STRICT;

        CREATE TABLE collaboration_audit_events (
          id TEXT PRIMARY KEY,
          run_id TEXT REFERENCES collaboration_runs(id),
          action TEXT NOT NULL,
          outcome TEXT NOT NULL,
          resource_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TRIGGER collaboration_candidates_no_update
          BEFORE UPDATE ON collaboration_candidates
          BEGIN SELECT RAISE(ABORT, 'candidate attempts are immutable'); END;
        CREATE TRIGGER collaboration_candidates_no_delete
          BEFORE DELETE ON collaboration_candidates
          BEGIN SELECT RAISE(ABORT, 'candidate attempts are immutable'); END;
        CREATE TRIGGER collaboration_test_evidence_no_update
          BEFORE UPDATE ON collaboration_test_evidence
          BEGIN SELECT RAISE(ABORT, 'test evidence is immutable'); END;
        CREATE TRIGGER collaboration_test_evidence_no_delete
          BEFORE DELETE ON collaboration_test_evidence
          BEGIN SELECT RAISE(ABORT, 'test evidence is immutable'); END;
      `);
    },
  },
  {
    version: 5,
    name: "add-single-owner-control",
    checksum: "v5:single-owner-action-tokens-control-state-acceptance",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_items
          ADD COLUMN control_state TEXT NOT NULL DEFAULT 'active'
          CHECK (control_state IN ('active', 'paused', 'cancelled', 'accepted'));
        ALTER TABLE collaboration_work_items ADD COLUMN accepted_candidate_sha TEXT;
        ALTER TABLE collaboration_work_items ADD COLUMN accepted_by TEXT;
        ALTER TABLE collaboration_work_items ADD COLUMN accepted_at INTEGER;
        ALTER TABLE collaboration_work_items ADD COLUMN cancelled_at INTEGER;
        ALTER TABLE collaboration_work_items ADD COLUMN paused_at INTEGER;

        ALTER TABLE collaboration_work_nodes
          ADD COLUMN control_state TEXT NOT NULL DEFAULT 'active'
          CHECK (control_state IN ('active', 'paused', 'cancelled'));
        ALTER TABLE collaboration_runs ADD COLUMN interrupt_requested_at INTEGER;

        ALTER TABLE collaboration_audit_events ADD COLUMN actor_principal_id TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN work_item_id TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN request_id TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN policy_rule TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN before_hash TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN after_hash TEXT;
        ALTER TABLE collaboration_audit_events ADD COLUMN error TEXT;

        CREATE TABLE collaboration_owner_bindings (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source = 'dingtalk'),
          sender_corp_id TEXT NOT NULL,
          sender_staff_id TEXT NOT NULL,
          generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          created_at INTEGER NOT NULL,
          revoked_at INTEGER,
          CHECK ((active = 1 AND revoked_at IS NULL) OR (active = 0 AND revoked_at IS NOT NULL))
        ) STRICT;
        CREATE UNIQUE INDEX collaboration_single_active_owner
          ON collaboration_owner_bindings(active) WHERE active = 1;
        CREATE TRIGGER collaboration_owner_bindings_no_delete
          BEFORE DELETE ON collaboration_owner_bindings
          BEGIN SELECT RAISE(ABORT, 'owner binding history is immutable'); END;

        CREATE TABLE collaboration_action_tokens (
          id TEXT PRIMARY KEY,
          token_version INTEGER NOT NULL CHECK (token_version = 1),
          token_hash TEXT NOT NULL UNIQUE,
          action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'retry', 'cancel', 'accept', 'reject')),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
          candidate_sha TEXT,
          owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          consumed_by_principal_id TEXT REFERENCES collaboration_principals(id),
          consumed_outcome TEXT CHECK (consumed_outcome IN ('allowed', 'denied')),
          decision_json TEXT,
          CHECK (expires_at > created_at),
          CHECK (
            (action IN ('accept', 'reject') AND candidate_sha IS NOT NULL) OR
            (action NOT IN ('accept', 'reject') AND candidate_sha IS NULL)
          ),
          CHECK (
            (consumed_at IS NULL AND consumed_by_principal_id IS NULL AND consumed_outcome IS NULL AND decision_json IS NULL) OR
            (consumed_at IS NOT NULL AND consumed_by_principal_id IS NOT NULL AND consumed_outcome IS NOT NULL AND decision_json IS NOT NULL)
          )
        ) STRICT;
        CREATE INDEX collaboration_action_tokens_work_item
          ON collaboration_action_tokens(work_item_id, created_at DESC);

        CREATE TABLE collaboration_control_events (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          work_item_version INTEGER NOT NULL CHECK (work_item_version > 0),
          action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'retry', 'cancel', 'accept', 'reject')),
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          token_id TEXT NOT NULL REFERENCES collaboration_action_tokens(id),
          candidate_sha TEXT,
          reason TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER collaboration_control_events_no_update
          BEFORE UPDATE ON collaboration_control_events
          BEGIN SELECT RAISE(ABORT, 'control events are immutable'); END;
        CREATE TRIGGER collaboration_control_events_no_delete
          BEFORE DELETE ON collaboration_control_events
          BEGIN SELECT RAISE(ABORT, 'control events are immutable'); END;
      `);
    },
  },
  {
    version: 6,
    name: "add-fenced-recovery-and-delivery-lifecycle",
    checksum: "v6:instance-node-run-leases-containment-outbox-circuit-retention-degradation",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_instance_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          CHECK (expires_at > heartbeat_at)
        ) STRICT;

        ALTER TABLE collaboration_work_nodes ADD COLUMN lease_owner TEXT;
        ALTER TABLE collaboration_work_nodes ADD COLUMN lease_expires_at INTEGER;
        ALTER TABLE collaboration_work_nodes ADD COLUMN lease_fence INTEGER;
        ALTER TABLE collaboration_work_nodes
          ADD COLUMN runtime_state TEXT NOT NULL DEFAULT 'dormant'
          CHECK (runtime_state IN (
            'dormant', 'leased', 'running', 'interrupted', 'validating',
            'succeeded', 'failed', 'needs_configuration'
          ));

        ALTER TABLE collaboration_runs ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE collaboration_runs ADD COLUMN instance_owner TEXT;
        ALTER TABLE collaboration_runs ADD COLUMN instance_fence INTEGER;
        ALTER TABLE collaboration_runs ADD COLUMN node_lease_fence INTEGER;
        ALTER TABLE collaboration_runs ADD COLUMN heartbeat_at INTEGER;
        ALTER TABLE collaboration_runs ADD COLUMN runtime_identity_json TEXT;
        ALTER TABLE collaboration_runs
          ADD COLUMN containment_state TEXT NOT NULL DEFAULT 'unverified'
          CHECK (containment_state IN ('unverified', 'verified', 'empty'));
        ALTER TABLE collaboration_runs
          ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'unclassified'
          CHECK (recovery_state IN (
            'unclassified', 'resumable', 'candidate_produced', 'interrupted',
            'unsafe_to_retry', 'needs_configuration'
          ));
        ALTER TABLE collaboration_runs ADD COLUMN retention_until INTEGER;
        ALTER TABLE collaboration_runs ADD COLUMN cleaned_at INTEGER;
        CREATE UNIQUE INDEX collaboration_one_running_attempt
          ON collaboration_runs(work_item_id, plan_revision, node_id)
          WHERE status = 'running';

        ALTER TABLE collaboration_outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (delivery_state IN ('pending', 'claimed', 'sent', 'dead_letter', 'superseded'));
        ALTER TABLE collaboration_outbox ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0);
        ALTER TABLE collaboration_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE collaboration_outbox ADD COLUMN claim_owner TEXT;
        ALTER TABLE collaboration_outbox ADD COLUMN claim_fence INTEGER;
        ALTER TABLE collaboration_outbox ADD COLUMN claim_expires_at INTEGER;
        ALTER TABLE collaboration_outbox ADD COLUMN last_error TEXT;
        ALTER TABLE collaboration_outbox ADD COLUMN dead_lettered_at INTEGER;
        UPDATE collaboration_outbox
          SET delivery_state = CASE
            WHEN sent_at IS NOT NULL THEN 'sent'
            WHEN superseded_at IS NOT NULL THEN 'superseded'
            ELSE 'pending'
          END,
          next_attempt_at = created_at;
        CREATE INDEX collaboration_outbox_dispatchable
          ON collaboration_outbox(delivery_state, next_attempt_at, created_at);

        CREATE TABLE collaboration_provider_circuits (
          provider_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
          consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
          opened_at INTEGER,
          retry_at INTEGER,
          probe_owner TEXT,
          probe_fence INTEGER,
          last_failure_class TEXT,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          CHECK (
            (state = 'closed' AND opened_at IS NULL AND retry_at IS NULL AND probe_owner IS NULL AND probe_fence IS NULL) OR
            (state = 'open' AND opened_at IS NOT NULL AND retry_at IS NOT NULL AND probe_owner IS NULL AND probe_fence IS NULL) OR
            (state = 'half_open' AND opened_at IS NOT NULL AND retry_at IS NOT NULL AND probe_owner IS NOT NULL AND probe_fence IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE collaboration_runtime_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          mode TEXT NOT NULL CHECK (mode IN ('ready', 'degraded')),
          reason TEXT,
          low_disk INTEGER NOT NULL DEFAULT 0 CHECK (low_disk IN (0, 1)),
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          CHECK ((mode = 'ready' AND reason IS NULL) OR (mode = 'degraded' AND reason IS NOT NULL))
        ) STRICT;
        INSERT INTO collaboration_runtime_state
          (singleton, mode, reason, low_disk, updated_at, version)
          VALUES (1, 'ready', NULL, 0, 0, 1);
      `);
    },
  },
  {
    version: 7,
    name: "bind-containment-and-recovery-cas",
    checksum: "v7:containment-binding-row-versions-expiring-provider-probe",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
        ALTER TABLE collaboration_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
        ALTER TABLE collaboration_runs ADD COLUMN containment_fingerprint TEXT;
        ALTER TABLE collaboration_runs ADD COLUMN containment_binding_json TEXT;
        ALTER TABLE collaboration_test_evidence ADD COLUMN containment_fingerprint TEXT;
        ALTER TABLE collaboration_test_evidence ADD COLUMN containment_binding_json TEXT;
        ALTER TABLE collaboration_provider_circuits ADD COLUMN probe_expires_at INTEGER;
      `);
    },
  },
  {
    version: 8,
    name: "add-durable-restore-guard",
    checksum: "v8:restore-review-guard-and-private-alert-retry",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_restore_guard (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL CHECK (state IN ('live', 'review_required')),
          source_backup_hash TEXT,
          restored_at INTEGER,
          rearmed_at INTEGER,
          rearmed_by TEXT,
          version INTEGER NOT NULL CHECK (version > 0),
          CHECK (
            (state = 'live') OR
            (state = 'review_required' AND source_backup_hash IS NOT NULL AND restored_at IS NOT NULL)
          )
        ) STRICT;
        INSERT INTO collaboration_restore_guard
          (singleton, state, source_backup_hash, restored_at, rearmed_at, rearmed_by, version)
          VALUES (1, 'live', NULL, NULL, NULL, NULL, 1);

        CREATE TABLE collaboration_private_alert_state (
          code TEXT PRIMARY KEY,
          digest TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'sent', 'discarded')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          last_attempt_at INTEGER,
          delivered_at INTEGER,
          CHECK ((delivery_state = 'sent' AND delivered_at IS NOT NULL) OR delivery_state <> 'sent')
        ) STRICT;
      `);
    },
  },
  {
    version: 9,
    name: "add-idempotent-owner-text-commands",
    checksum: "v9:owner-text-command-event-outcomes-command-status-outbox",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_owner_text_commands (
          source_event_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          outcome_json TEXT NOT NULL,
          processed_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER collaboration_owner_text_commands_no_update
          BEFORE UPDATE ON collaboration_owner_text_commands
          BEGIN SELECT RAISE(ABORT, 'owner text command events are immutable'); END;
        CREATE TRIGGER collaboration_owner_text_commands_no_delete
          BEFORE DELETE ON collaboration_owner_text_commands
          BEGIN SELECT RAISE(ABORT, 'owner text command events are immutable'); END;

        ALTER TABLE collaboration_outbox RENAME TO collaboration_outbox_v9;
        CREATE TABLE collaboration_outbox (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('work_item', 'association', 'plan')),
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'primary_status_card', 'association_choice_card', 'invalid_reference_card',
            'clarification_card', 'plan_status_card', 'command_status_card'
          )),
          dedupe_key TEXT NOT NULL UNIQUE,
          supersession_key TEXT,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          superseded_at INTEGER,
          delivery_state TEXT NOT NULL DEFAULT 'pending'
            CHECK (delivery_state IN ('pending', 'claimed', 'sent', 'dead_letter', 'superseded')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          claim_owner TEXT,
          claim_fence INTEGER,
          claim_expires_at INTEGER,
          last_error TEXT,
          dead_lettered_at INTEGER
        ) STRICT;
        INSERT INTO collaboration_outbox
          (id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind, dedupe_key,
           supersession_key, payload_json, created_at, sent_at, superseded_at, delivery_state, attempt,
           next_attempt_at, claim_owner, claim_fence, claim_expires_at, last_error, dead_lettered_at)
        SELECT id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind, dedupe_key,
               supersession_key, payload_json, created_at, sent_at, superseded_at, delivery_state, attempt,
               next_attempt_at, claim_owner, claim_fence, claim_expires_at, last_error, dead_lettered_at
        FROM collaboration_outbox_v9;
        DROP TABLE collaboration_outbox_v9;
        CREATE INDEX collaboration_outbox_pending ON collaboration_outbox(sent_at, created_at);
        CREATE INDEX collaboration_outbox_dispatchable
          ON collaboration_outbox(delivery_state, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 10,
    name: "add-independent-candidate-verification",
    checksum: "v10:immutable-verifier-and-meta-reviews",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_candidate_reviews (
          id TEXT PRIMARY KEY,
          candidate_run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          stage TEXT NOT NULL CHECK (stage IN ('verifier', 'meta')),
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          status TEXT NOT NULL CHECK (status IN (
            'passed', 'failed', 'needs_clarification', 'needs_configuration', 'stale'
          )),
          agent_id TEXT NOT NULL,
          snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
          spec_hash TEXT NOT NULL,
          candidate_sha TEXT NOT NULL,
          verdict_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (candidate_run_id, stage, attempt)
        ) STRICT;
        CREATE INDEX collaboration_candidate_reviews_current
          ON collaboration_candidate_reviews(candidate_run_id, stage, status, attempt DESC);
        CREATE TRIGGER collaboration_candidate_reviews_no_update
          BEFORE UPDATE ON collaboration_candidate_reviews
          BEGIN SELECT RAISE(ABORT, 'candidate reviews are immutable'); END;
        CREATE TRIGGER collaboration_candidate_reviews_no_delete
          BEFORE DELETE ON collaboration_candidate_reviews
          BEGIN SELECT RAISE(ABORT, 'candidate reviews are immutable'); END;
      `);
    },
  },
  {
    version: 11,
    name: "add-attachment-ingestion-and-evidence",
    checksum: "v11:public-attachment-provenance-immutable-evidence-projection-claim",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_attachments (
          id TEXT PRIMARY KEY,
          external_event_id TEXT NOT NULL REFERENCES collaboration_external_events(id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          provider TEXT NOT NULL CHECK (provider = 'dingtalk'),
          capability_ref TEXT NOT NULL CHECK (
            length(capability_ref) = 64 AND
            capability_ref = lower(capability_ref) AND
            lower(capability_ref) NOT GLOB '*[^0-9a-f]*'
          ),
          resource_kind TEXT NOT NULL CHECK (resource_kind IN ('file', 'picture', 'audio', 'video')),
          display_name TEXT,
          media_type TEXT,
          size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
          ingest_state TEXT NOT NULL CHECK (ingest_state IN (
            'pending', 'downloading', 'stored', 'extracting', 'ready', 'unsupported', 'failed'
          )),
          content_hash TEXT CHECK (
            content_hash IS NULL OR (
              length(content_hash) = 64 AND
              content_hash = lower(content_hash) AND
              lower(content_hash) NOT GLOB '*[^0-9a-f]*'
            )
          ),
          managed_storage_key TEXT CHECK (
            managed_storage_key IS NULL OR (
              managed_storage_key GLOB 'attachments/*' AND
              managed_storage_key NOT GLOB '*://*' AND
              managed_storage_key NOT GLOB '/*' AND
              managed_storage_key NOT GLOB '*..*'
            )
          ),
          error_code TEXT,
          evidence_projected_at INTEGER CHECK (evidence_projected_at IS NULL OR evidence_projected_at >= 0),
          evidence_projection_owner TEXT,
          evidence_projection_expires_at INTEGER CHECK (
            evidence_projection_expires_at IS NULL OR evidence_projection_expires_at >= 0
          ),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          next_attempt_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (external_event_id, ordinal),
          UNIQUE (external_event_id, capability_ref),
          CHECK ((content_hash IS NULL) = (managed_storage_key IS NULL)),
          CHECK (
            ingest_state NOT IN ('stored', 'extracting', 'ready') OR
            (content_hash IS NOT NULL AND managed_storage_key IS NOT NULL)
          ),
          CHECK (evidence_projected_at IS NULL OR ingest_state = 'ready'),
          CHECK (
            (evidence_projection_owner IS NULL) = (evidence_projection_expires_at IS NULL)
          ),
          CHECK (
            evidence_projected_at IS NULL OR
            (evidence_projection_owner IS NULL AND evidence_projection_expires_at IS NULL)
          )
        ) STRICT;
        CREATE INDEX collaboration_attachments_pending
          ON collaboration_attachments(ingest_state, next_attempt_at, created_at, ordinal);
        CREATE INDEX collaboration_attachments_external_event
          ON collaboration_attachments(external_event_id, ordinal);

        CREATE TABLE collaboration_attachment_extractions (
          id TEXT PRIMARY KEY,
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          extractor TEXT NOT NULL,
          extractor_version TEXT NOT NULL,
          source_hash TEXT NOT NULL CHECK (
            length(source_hash) = 64 AND
            source_hash = lower(source_hash) AND
            lower(source_hash) NOT GLOB '*[^0-9a-f]*'
          ),
          status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'unsupported')),
          extracted_characters INTEGER NOT NULL DEFAULT 0 CHECK (extracted_characters >= 0),
          metadata_json TEXT NOT NULL,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (attachment_id, attempt),
          UNIQUE (id, attachment_id),
          CHECK ((status = 'succeeded' AND error_code IS NULL) OR status <> 'succeeded')
        ) STRICT;
        CREATE INDEX collaboration_attachment_extractions_attachment
          ON collaboration_attachment_extractions(attachment_id, attempt DESC);

        CREATE TABLE collaboration_attachment_chunks (
          id TEXT PRIMARY KEY,
          extraction_id TEXT NOT NULL REFERENCES collaboration_attachment_extractions(id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK (
            length(content_hash) = 64 AND
            content_hash = lower(content_hash) AND
            lower(content_hash) NOT GLOB '*[^0-9a-f]*'
          ),
          character_start INTEGER NOT NULL CHECK (character_start >= 0),
          character_end INTEGER NOT NULL CHECK (character_end >= character_start),
          created_at INTEGER NOT NULL,
          UNIQUE (extraction_id, ordinal)
        ) STRICT;
        CREATE INDEX collaboration_attachment_chunks_extraction
          ON collaboration_attachment_chunks(extraction_id, ordinal);

        CREATE TABLE collaboration_work_item_evidence (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          extraction_id TEXT,
          evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('attachment', 'extraction', 'chunk')),
          chunk_ordinal INTEGER CHECK (chunk_ordinal IS NULL OR chunk_ordinal >= 0),
          evidence_hash TEXT NOT NULL CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash = lower(evidence_hash) AND
            lower(evidence_hash) NOT GLOB '*[^0-9a-f]*'
          ),
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (work_item_id, attachment_id, evidence_kind, evidence_hash),
          FOREIGN KEY (extraction_id, attachment_id)
            REFERENCES collaboration_attachment_extractions(id, attachment_id),
          FOREIGN KEY (extraction_id, chunk_ordinal)
            REFERENCES collaboration_attachment_chunks(extraction_id, ordinal),
          CHECK (
            (evidence_kind = 'attachment' AND extraction_id IS NULL AND chunk_ordinal IS NULL) OR
            (evidence_kind = 'extraction' AND extraction_id IS NOT NULL AND chunk_ordinal IS NULL) OR
            (evidence_kind = 'chunk' AND extraction_id IS NOT NULL AND chunk_ordinal IS NOT NULL)
          )
        ) STRICT;
        CREATE INDEX collaboration_work_item_evidence_work_item
          ON collaboration_work_item_evidence(work_item_id, created_at, id);
        CREATE INDEX collaboration_work_item_evidence_attachment
          ON collaboration_work_item_evidence(attachment_id, extraction_id);

        CREATE TABLE collaboration_attachment_spec_projections (
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          content_hash TEXT NOT NULL CHECK (
            length(content_hash) = 64 AND
            content_hash = lower(content_hash) AND
            lower(content_hash) NOT GLOB '*[^0-9a-f]*'
          ),
          work_item_id TEXT NOT NULL,
          snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (attachment_id, content_hash),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;
        CREATE INDEX collaboration_attachment_spec_projections_work_item
          ON collaboration_attachment_spec_projections(work_item_id, snapshot_revision);

        CREATE TRIGGER collaboration_attachment_provenance_no_update
          BEFORE UPDATE ON collaboration_attachments
          WHEN NEW.id <> OLD.id OR
               NEW.external_event_id <> OLD.external_event_id OR
               NEW.ordinal <> OLD.ordinal OR
               NEW.provider <> OLD.provider OR
               NEW.capability_ref <> OLD.capability_ref OR
               NEW.resource_kind <> OLD.resource_kind OR
               NEW.display_name IS NOT OLD.display_name OR
               NEW.media_type IS NOT OLD.media_type OR
               NEW.size_bytes IS NOT OLD.size_bytes
          BEGIN SELECT RAISE(ABORT, 'attachment provenance is immutable'); END;
        CREATE TRIGGER collaboration_work_item_evidence_matches_event
          BEFORE INSERT ON collaboration_work_item_evidence
          WHEN NOT EXISTS (
            SELECT 1
            FROM collaboration_attachments attachment
            JOIN collaboration_external_events event ON event.id = attachment.external_event_id
            WHERE attachment.id = NEW.attachment_id AND event.work_item_id = NEW.work_item_id
          )
          BEGIN SELECT RAISE(ABORT, 'attachment evidence work item mismatch'); END;
        CREATE TRIGGER collaboration_attachment_extractions_no_update
          BEFORE UPDATE ON collaboration_attachment_extractions
          BEGIN SELECT RAISE(ABORT, 'attachment extractions are immutable'); END;
        CREATE TRIGGER collaboration_attachment_extractions_no_delete
          BEFORE DELETE ON collaboration_attachment_extractions
          BEGIN SELECT RAISE(ABORT, 'attachment extractions are immutable'); END;
        CREATE TRIGGER collaboration_attachment_chunks_no_update
          BEFORE UPDATE ON collaboration_attachment_chunks
          BEGIN SELECT RAISE(ABORT, 'attachment chunks are immutable'); END;
        CREATE TRIGGER collaboration_attachment_chunks_no_delete
          BEFORE DELETE ON collaboration_attachment_chunks
          BEGIN SELECT RAISE(ABORT, 'attachment chunks are immutable'); END;
        CREATE TRIGGER collaboration_work_item_evidence_no_update
          BEFORE UPDATE ON collaboration_work_item_evidence
          BEGIN SELECT RAISE(ABORT, 'work item evidence is immutable'); END;
        CREATE TRIGGER collaboration_work_item_evidence_no_delete
          BEFORE DELETE ON collaboration_work_item_evidence
          BEGIN SELECT RAISE(ABORT, 'work item evidence is immutable'); END;
        CREATE TRIGGER collaboration_attachment_spec_projections_no_update
          BEFORE UPDATE ON collaboration_attachment_spec_projections
          BEGIN SELECT RAISE(ABORT, 'attachment spec projections are immutable'); END;
        CREATE TRIGGER collaboration_attachment_spec_projections_no_delete
          BEFORE DELETE ON collaboration_attachment_spec_projections
          BEGIN SELECT RAISE(ABORT, 'attachment spec projections are immutable'); END;
      `);
    },
  },
  {
    version: 12,
    name: "durable-natural-intake",
    checksum: "v12:source-bound-natural-intake-claims",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_natural_intake_jobs (
          source_event_id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          status TEXT NOT NULL CHECK(status IN ('pending','running','applied','failed','superseded')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
          claim_token TEXT,
          lease_until INTEGER,
          base_revision INTEGER NOT NULL,
          result_revision INTEGER,
          proposal_json TEXT,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (work_item_id, base_revision) REFERENCES collaboration_work_item_snapshots(work_item_id, revision),
          FOREIGN KEY (work_item_id, result_revision) REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;
        CREATE INDEX collaboration_natural_intake_pending ON collaboration_natural_intake_jobs(status, created_at);
        CREATE TRIGGER collaboration_natural_intake_source_matches
          BEFORE INSERT ON collaboration_natural_intake_jobs
          WHEN NOT EXISTS (SELECT 1 FROM collaboration_external_events e WHERE e.source='dingtalk'
            AND e.source_event_id=NEW.source_event_id AND e.work_item_id=NEW.work_item_id)
          BEGIN SELECT RAISE(ABORT, 'natural intake source mismatch'); END;
        CREATE TRIGGER collaboration_natural_intake_provenance_immutable
          BEFORE UPDATE ON collaboration_natural_intake_jobs
          WHEN OLD.status='applied' OR NEW.source_event_id<>OLD.source_event_id OR NEW.work_item_id<>OLD.work_item_id
            OR NEW.base_revision<>OLD.base_revision OR NEW.created_at<>OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'natural intake provenance is immutable'); END;
        CREATE TRIGGER collaboration_natural_intake_no_delete
          BEFORE DELETE ON collaboration_natural_intake_jobs
          BEGIN SELECT RAISE(ABORT, 'natural intake provenance is immutable'); END;
      `);
    },
  },
  {
    version: 13, name: "durable-natural-association", checksum: "v13:scoped-association-before-intake",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_natural_association_jobs (
        event_id TEXT PRIMARY KEY REFERENCES collaboration_external_events(id),
        status TEXT NOT NULL CHECK(status IN ('pending','running','routed','projected','clarify','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
        claim_token TEXT, lease_until INTEGER, proposal_json TEXT
      ) STRICT;
      CREATE TRIGGER collaboration_natural_association_result_immutable BEFORE UPDATE ON collaboration_natural_association_jobs
        WHEN OLD.status='projected' OR NEW.event_id<>OLD.event_id
        BEGIN SELECT RAISE(ABORT,'natural association result is immutable'); END;
    `); },
  },
  {
    version: 14, name: "bounded-natural-projection", checksum: "v14:durable-projection-attempts",
    apply(database) { database.exec(`
      ALTER TABLE collaboration_natural_association_jobs ADD COLUMN projection_attempts INTEGER NOT NULL DEFAULT 0
        CHECK(projection_attempts BETWEEN 0 AND 3);
    `); },
  },
  {
    version: 15, name: "durable-execution-dispatch", checksum: "v15:pre-run-attempt-reservation",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_execution_dispatches (
        work_item_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        instance_owner TEXT NOT NULL,
        instance_fence INTEGER NOT NULL CHECK(instance_fence > 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(work_item_id,attempt),
        FOREIGN KEY(work_item_id,plan_revision) REFERENCES collaboration_plan_revisions(work_item_id,revision)
      ) STRICT;
      CREATE TRIGGER collaboration_execution_dispatch_no_update BEFORE UPDATE ON collaboration_execution_dispatches
        BEGIN SELECT RAISE(ABORT,'execution dispatch is immutable'); END;
      CREATE TRIGGER collaboration_execution_dispatch_no_delete BEFORE DELETE ON collaboration_execution_dispatches
        BEGIN SELECT RAISE(ABORT,'execution dispatch is immutable'); END;
    `); },
  },
  {
    version: 16, name: "execution-preparation-results", checksum: "v16:immutable-preparation-outcomes",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_execution_preparation_results (
        work_item_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('failed','interrupted','unsettled')),
        work_item_version INTEGER NOT NULL CHECK(work_item_version > 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(work_item_id,attempt),
        FOREIGN KEY(work_item_id,attempt) REFERENCES collaboration_execution_dispatches(work_item_id,attempt)
      ) STRICT;
      CREATE TRIGGER collaboration_preparation_no_update BEFORE UPDATE ON collaboration_execution_preparation_results
        BEGIN SELECT RAISE(ABORT,'preparation result is immutable'); END;
      CREATE TRIGGER collaboration_preparation_no_delete BEFORE DELETE ON collaboration_execution_preparation_results
        BEGIN SELECT RAISE(ABORT,'preparation result is immutable'); END;
    `); },
  },
  {
    version: 17, name: "sent-association-choice-provenance", checksum: "v17:immutable-delivered-choice-order",
    apply(database) { database.exec(`
      ALTER TABLE collaboration_outbox ADD COLUMN delivery_sequence INTEGER;
      CREATE UNIQUE INDEX collaboration_outbox_delivery_sequence ON collaboration_outbox(delivery_sequence) WHERE delivery_sequence IS NOT NULL;
      CREATE TABLE collaboration_sent_association_choices (
        outbox_id TEXT PRIMARY KEY REFERENCES collaboration_outbox(id),
        external_event_id TEXT NOT NULL REFERENCES collaboration_external_events(id),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        sent_at INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER collaboration_sent_choices_no_update BEFORE UPDATE ON collaboration_sent_association_choices
        BEGIN SELECT RAISE(ABORT,'sent choices are immutable'); END;
      CREATE TRIGGER collaboration_sent_choices_no_delete BEFORE DELETE ON collaboration_sent_association_choices
        BEGIN SELECT RAISE(ABORT,'sent choices are immutable'); END;
    `); },
  },
  {
    version: 18, name: "acceptance-mapping-provenance", checksum: "v18:immutable-mapping-attempts-and-review",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_acceptance_mapping_attempts (
        request_key TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
        request_json TEXT NOT NULL CHECK(json_valid(request_json)), created_at INTEGER NOT NULL,
        PRIMARY KEY(request_key,attempt)
      ) STRICT;
      CREATE TABLE collaboration_acceptance_mapping_results (
        request_key TEXT NOT NULL, attempt INTEGER NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at INTEGER NOT NULL,
        PRIMARY KEY(request_key,attempt), FOREIGN KEY(request_key,attempt) REFERENCES collaboration_acceptance_mapping_attempts(request_key,attempt)
      ) STRICT;
      CREATE TRIGGER collaboration_mapping_attempt_no_update BEFORE UPDATE ON collaboration_acceptance_mapping_attempts BEGIN SELECT RAISE(ABORT,'mapping attempt is immutable'); END;
      CREATE TRIGGER collaboration_mapping_attempt_no_delete BEFORE DELETE ON collaboration_acceptance_mapping_attempts BEGIN SELECT RAISE(ABORT,'mapping attempt is immutable'); END;
      CREATE TRIGGER collaboration_mapping_result_no_update BEFORE UPDATE ON collaboration_acceptance_mapping_results BEGIN SELECT RAISE(ABORT,'mapping result is immutable'); END;
      CREATE TRIGGER collaboration_mapping_result_no_delete BEFORE DELETE ON collaboration_acceptance_mapping_results BEGIN SELECT RAISE(ABORT,'mapping result is immutable'); END;
    `); },
  },
  {
    version: 19, name: "durable-verification-lifecycle", checksum: "v19:verification-sessions-commands-proofs-settlements",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_verification_sessions (
          id TEXT PRIMARY KEY, candidate_run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          repository_path TEXT NOT NULL, plan_revision INTEGER NOT NULL, snapshot_revision INTEGER NOT NULL,
          candidate_sha TEXT NOT NULL, instance_owner TEXT NOT NULL, instance_fence INTEGER NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX verification_sessions_repository ON collaboration_verification_sessions(repository_path);
        CREATE TABLE collaboration_verification_commands (
          session_id TEXT NOT NULL REFERENCES collaboration_verification_sessions(id), ordinal INTEGER NOT NULL,
          binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,ordinal)
        ) STRICT;
        CREATE TABLE collaboration_verification_proofs (
          session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, proof_json TEXT NOT NULL CHECK(json_valid(proof_json)), created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,ordinal), FOREIGN KEY(session_id,ordinal) REFERENCES collaboration_verification_commands(session_id,ordinal)
        ) STRICT;
        CREATE TABLE collaboration_verification_settlements (
          session_id TEXT PRIMARY KEY REFERENCES collaboration_verification_sessions(id),
          evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER verification_commands_open BEFORE INSERT ON collaboration_verification_commands
          WHEN EXISTS(SELECT 1 FROM collaboration_verification_settlements WHERE session_id=NEW.session_id)
          BEGIN SELECT RAISE(ABORT,'verification already settled'); END;
        CREATE TRIGGER verification_proofs_open BEFORE INSERT ON collaboration_verification_proofs
          WHEN EXISTS(SELECT 1 FROM collaboration_verification_settlements WHERE session_id=NEW.session_id)
          BEGIN SELECT RAISE(ABORT,'verification already settled'); END;
      `);
      for(const table of ["sessions","commands","proofs","settlements"]) for(const operation of ["UPDATE","DELETE"]) {
        database.exec(`CREATE TRIGGER verification_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_verification_${table}
          BEGIN SELECT RAISE(ABORT,'verification lifecycle is immutable'); END;`);
      }
    },
  },
  {
    version: 20, name: "durable-execution-lifecycle", checksum: "v20:execution-sessions-commands-proofs-settlements",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_execution_sessions (
          id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, plan_revision INTEGER NOT NULL,
          repository_path TEXT NOT NULL, base_sha TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0),
          instance_owner TEXT NOT NULL, instance_fence INTEGER NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(work_item_id,attempt),
          FOREIGN KEY(work_item_id,plan_revision) REFERENCES collaboration_plan_revisions(work_item_id,revision)
        ) STRICT;
        CREATE INDEX execution_sessions_repository ON collaboration_execution_sessions(repository_path);
        CREATE TABLE collaboration_execution_commands (
          session_id TEXT NOT NULL REFERENCES collaboration_execution_sessions(id), ordinal INTEGER NOT NULL,
          binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,ordinal)
        ) STRICT;
        CREATE TABLE collaboration_execution_proofs (
          session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, proof_json TEXT NOT NULL CHECK(json_valid(proof_json)), created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id,ordinal), FOREIGN KEY(session_id,ordinal) REFERENCES collaboration_execution_commands(session_id,ordinal)
        ) STRICT;
        CREATE TABLE collaboration_execution_settlements (
          session_id TEXT PRIMARY KEY REFERENCES collaboration_execution_sessions(id),
          evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at INTEGER NOT NULL
        ) STRICT;
      `);
      for (const table of ["sessions", "commands", "proofs", "settlements"]) for (const operation of ["UPDATE", "DELETE"]) {
        database.exec(`CREATE TRIGGER execution_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_execution_${table}
          BEGIN SELECT RAISE(ABORT,'execution lifecycle is immutable'); END;`);
      }
      for (const table of ["commands", "proofs"]) database.exec(`CREATE TRIGGER execution_${table}_open BEFORE INSERT ON collaboration_execution_${table}
        WHEN EXISTS(SELECT 1 FROM collaboration_execution_settlements WHERE session_id=NEW.session_id)
        BEGIN SELECT RAISE(ABORT,'execution already settled'); END;`);
    },
  },
  {
    version: 21, name: "lifecycle-finalization-intent", checksum: "v21:immutable-coordinator-finished-boundaries",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_execution_finalization_intents (
          session_id TEXT PRIMARY KEY REFERENCES collaboration_execution_sessions(id),
          command_count INTEGER NOT NULL CHECK(command_count>=0), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER execution_finalization_no_update BEFORE UPDATE ON collaboration_execution_finalization_intents
          BEGIN SELECT RAISE(ABORT,'execution finalization is immutable'); END;
        CREATE TRIGGER execution_finalization_no_delete BEFORE DELETE ON collaboration_execution_finalization_intents
          BEGIN SELECT RAISE(ABORT,'execution finalization is immutable'); END;
      `);
      for (const table of ["commands", "proofs"]) database.exec(`CREATE TRIGGER execution_${table}_finalizing BEFORE INSERT ON collaboration_execution_${table}
        WHEN EXISTS(SELECT 1 FROM collaboration_execution_finalization_intents WHERE session_id=NEW.session_id)
        BEGIN SELECT RAISE(ABORT,'execution already finalizing'); END;`);
      database.exec(`
        CREATE TABLE collaboration_verification_finalization_intents (
          session_id TEXT PRIMARY KEY REFERENCES collaboration_verification_sessions(id),
          command_count INTEGER NOT NULL CHECK(command_count>=0), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER verification_finalization_no_update BEFORE UPDATE ON collaboration_verification_finalization_intents
          BEGIN SELECT RAISE(ABORT,'verification finalization is immutable'); END;
        CREATE TRIGGER verification_finalization_no_delete BEFORE DELETE ON collaboration_verification_finalization_intents
          BEGIN SELECT RAISE(ABORT,'verification finalization is immutable'); END;
      `);
      for (const table of ["commands", "proofs"]) database.exec(`CREATE TRIGGER verification_${table}_finalizing BEFORE INSERT ON collaboration_verification_${table}
        WHEN EXISTS(SELECT 1 FROM collaboration_verification_finalization_intents WHERE session_id=NEW.session_id)
        BEGIN SELECT RAISE(ABORT,'verification already finalizing'); END;`);
    },
  },
  {
    version: 22, name: "attachment-failure-receipts", checksum: "v22:immutable-attachment-attempt-failures",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_attachment_failures (
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          attempt INTEGER NOT NULL CHECK(attempt>0),
          error_code TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (attachment_id, attempt)
        ) STRICT;
        CREATE TRIGGER attachment_failures_no_update BEFORE UPDATE ON collaboration_attachment_failures
          BEGIN SELECT RAISE(ABORT,'attachment failure receipts are immutable'); END;
        CREATE TRIGGER attachment_failures_no_delete BEFORE DELETE ON collaboration_attachment_failures
          BEGIN SELECT RAISE(ABORT,'attachment failure receipts are immutable'); END;
      `);
    },
  },
  {
    version: 23, name: "attachment-projection-failure-receipts", checksum: "v23:immutable-claimed-projection-failures-with-backoff",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_attachment_projection_failures (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          claim_token TEXT NOT NULL UNIQUE,
          error_code TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          retry_after INTEGER NOT NULL CHECK(retry_after>=created_at)
        ) STRICT;
        CREATE INDEX attachment_projection_failure_order ON collaboration_attachment_projection_failures(attachment_id,sequence DESC);
        CREATE TRIGGER attachment_projection_failures_no_update BEFORE UPDATE ON collaboration_attachment_projection_failures
          BEGIN SELECT RAISE(ABORT,'projection failure receipts are immutable'); END;
        CREATE TRIGGER attachment_projection_failures_no_delete BEFORE DELETE ON collaboration_attachment_projection_failures
          BEGIN SELECT RAISE(ABORT,'projection failure receipts are immutable'); END;
      `);
    },
  },
  {
    version: 24, name: "owner-attachment-projection-recovery", checksum: "v24:immutable-owner-bound-projection-recovery",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_attachment_projection_recoveries (
          id TEXT PRIMARY KEY,
          attachment_id TEXT NOT NULL REFERENCES collaboration_attachments(id),
          boundary_sequence INTEGER NOT NULL REFERENCES collaboration_attachment_projection_failures(sequence),
          source_event_id TEXT NOT NULL UNIQUE,
          actor_principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
          created_at INTEGER NOT NULL,
          UNIQUE(attachment_id,boundary_sequence)
        ) STRICT;
        CREATE TABLE collaboration_attachment_recovery_requests (
          source_event_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          outcome_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      for (const table of ["projection_recoveries", "recovery_requests"]) for (const operation of ["UPDATE", "DELETE"]) {
        database.exec(`CREATE TRIGGER attachment_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_attachment_${table}
          BEGIN SELECT RAISE(ABORT,'attachment recovery is immutable'); END;`);
      }
    },
  },
  {
    version: 25, name: "owner-natural-intake-recovery", checksum: "v25:immutable-owner-bound-intake-recovery",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_natural_intake_recovery_requests (
          source_event_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          outcome_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE collaboration_natural_intake_recoveries (
          id TEXT PRIMARY KEY,
          request_source_event_id TEXT NOT NULL REFERENCES collaboration_natural_intake_recovery_requests(source_event_id) DEFERRABLE INITIALLY DEFERRED,
          input_source_event_id TEXT NOT NULL REFERENCES collaboration_natural_intake_jobs(source_event_id),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          generation INTEGER NOT NULL CHECK(generation>0),
          prior_attempts INTEGER NOT NULL CHECK(prior_attempts=3),
          prior_error_code TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          actor_principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
          created_at INTEGER NOT NULL,
          UNIQUE(input_source_event_id,generation),
          UNIQUE(request_source_event_id,input_source_event_id)
        ) STRICT;
        CREATE TRIGGER natural_intake_recovery_matches_source BEFORE INSERT ON collaboration_natural_intake_recoveries
          WHEN NOT EXISTS(SELECT 1 FROM collaboration_natural_intake_jobs j WHERE j.source_event_id=NEW.input_source_event_id AND j.work_item_id=NEW.work_item_id AND j.status='failed' AND j.attempts=NEW.prior_attempts)
          BEGIN SELECT RAISE(ABORT,'natural intake recovery source mismatch'); END;
      `);
      for (const table of ["recoveries", "recovery_requests"]) for (const operation of ["UPDATE", "DELETE"]) {
        database.exec(`CREATE TRIGGER natural_intake_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_natural_intake_${table}
          BEGIN SELECT RAISE(ABORT,'natural intake recovery is immutable'); END;`);
      }
    },
  },
  {
    version: 26, name: "document-resource-ownership", checksum: "v26:document-create-receipt-cleanup-journal",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_document_resources (
          container_name TEXT PRIMARY KEY,
          image TEXT NOT NULL,
          docker_context TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          container_id TEXT,
          cleanup_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_acknowledged IN (0,1)),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER document_resources_identity_immutable BEFORE UPDATE ON collaboration_document_resources
          WHEN NEW.container_name!=OLD.container_name OR NEW.image!=OLD.image OR NEW.docker_context!=OLD.docker_context
            OR NEW.source_hash!=OLD.source_hash OR NEW.created_at!=OLD.created_at
            OR (OLD.container_id IS NOT NULL AND NEW.container_id IS NOT OLD.container_id)
            OR NEW.cleanup_acknowledged<OLD.cleanup_acknowledged
          BEGIN SELECT RAISE(ABORT,'document resource identity is immutable'); END;
        CREATE TRIGGER document_resources_no_delete BEFORE DELETE ON collaboration_document_resources
          BEGIN SELECT RAISE(ABORT,'document resource journal cannot be deleted'); END;
        CREATE INDEX document_resources_unresolved ON collaboration_document_resources(docker_context,cleanup_acknowledged,created_at);
      `);
    },
  },
  {
    version: 27, name: "fenced-document-resource-recovery", checksum: "v27:instance-bound-document-recovery-budget",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_document_resources ADD COLUMN instance_owner TEXT;
        ALTER TABLE collaboration_document_resources ADD COLUMN instance_fence INTEGER;
        ALTER TABLE collaboration_document_resources ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 3);
        ALTER TABLE collaboration_document_resources ADD COLUMN recovery_verified_absent INTEGER NOT NULL DEFAULT 0 CHECK(recovery_verified_absent IN (0,1));
        CREATE TRIGGER document_resources_recovery_immutable BEFORE UPDATE ON collaboration_document_resources
          WHEN NEW.instance_owner IS NOT OLD.instance_owner OR NEW.instance_fence IS NOT OLD.instance_fence
            OR NEW.recovery_attempts<OLD.recovery_attempts OR NEW.recovery_verified_absent<OLD.recovery_verified_absent
          BEGIN SELECT RAISE(ABORT,'document recovery identity is immutable'); END;
      `);
    },
  },
  {
    version: 28, name: "durable-delivery-query-attempts", checksum: "v28:bounded-fenced-query-only-outbox-recovery",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_delivery_queries (
          outbox_id TEXT NOT NULL REFERENCES collaboration_outbox(id),
          attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
          snapshot_hash TEXT NOT NULL,
          instance_owner TEXT NOT NULL,
          instance_fence INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          next_attempt_at INTEGER NOT NULL,
          completed_at INTEGER,
          outcome TEXT CHECK(outcome IN ('confirmed','unconfirmed','no_receipt','superseded')),
          PRIMARY KEY(outbox_id,attempt)
        ) STRICT;
        CREATE TRIGGER delivery_queries_ordered BEFORE INSERT ON collaboration_delivery_queries
          WHEN NEW.attempt != (SELECT COALESCE(MAX(attempt),0)+1 FROM collaboration_delivery_queries WHERE outbox_id=NEW.outbox_id)
          BEGIN SELECT RAISE(ABORT,'delivery query attempt out of order'); END;
        CREATE TRIGGER delivery_queries_immutable BEFORE UPDATE ON collaboration_delivery_queries
          WHEN NEW.outbox_id!=OLD.outbox_id OR NEW.attempt!=OLD.attempt OR NEW.snapshot_hash!=OLD.snapshot_hash
            OR NEW.instance_owner!=OLD.instance_owner OR NEW.instance_fence!=OLD.instance_fence
            OR NEW.started_at!=OLD.started_at OR NEW.expires_at!=OLD.expires_at OR NEW.next_attempt_at!=OLD.next_attempt_at
            OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR NEW.outcome IS NULL
          BEGIN SELECT RAISE(ABORT,'delivery query evidence is immutable'); END;
        CREATE TRIGGER delivery_queries_no_delete BEFORE DELETE ON collaboration_delivery_queries
          BEGIN SELECT RAISE(ABORT,'delivery query evidence cannot be deleted'); END;
      `);
    },
  },
  {
    version: 29,
    name: "bind-verification-to-fenced-runtime-policy",
    checksum: "v29:immutable-fenced-runtime-verification-policy-hashes",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_verification_runtime_policies (
          instance_fence INTEGER PRIMARY KEY CHECK(instance_fence > 0),
          instance_owner TEXT NOT NULL,
          policies_json TEXT NOT NULL,
          configured_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER verification_runtime_policies_immutable BEFORE UPDATE ON collaboration_verification_runtime_policies
          BEGIN SELECT RAISE(ABORT,'runtime verification policy is immutable'); END;
        CREATE TRIGGER verification_runtime_policies_no_delete BEFORE DELETE ON collaboration_verification_runtime_policies
          BEGIN SELECT RAISE(ABORT,'runtime verification policy cannot be deleted'); END;
      `);
    },
  },
  {
    version: 30, name: "one-time-owner-mapping-recovery", checksum: "v30:separate-immutable-fourth-mapping-attempt",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_mapping_recovery_attempts (
          request_key TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt=4),
          request_json TEXT NOT NULL CHECK(json_valid(request_json)
            AND json_type(request_json,'$.ownerAuthorizedRecovery') IS 'object'
            AND json_extract(request_json,'$.ownerAuthorizedRecovery.afterAttempt') IS 3
            AND json_type(request_json,'$.ownerAuthorizedRecovery.referenceHash') IS 'text'
            AND length(json_extract(request_json,'$.ownerAuthorizedRecovery.referenceHash'))=64),
          created_at INTEGER NOT NULL, prior_attempt INTEGER NOT NULL DEFAULT 3 CHECK(prior_attempt=3),
          PRIMARY KEY(request_key,attempt),
          FOREIGN KEY(request_key,prior_attempt) REFERENCES collaboration_acceptance_mapping_attempts(request_key,attempt)
        ) STRICT;
        CREATE TABLE collaboration_mapping_recovery_results (
          request_key TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt=4), receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(request_key,attempt),
          FOREIGN KEY(request_key,attempt) REFERENCES collaboration_mapping_recovery_attempts(request_key,attempt)
        ) STRICT;
        CREATE TRIGGER mapping_recovery_attempt_no_update BEFORE UPDATE ON collaboration_mapping_recovery_attempts BEGIN SELECT RAISE(ABORT,'mapping recovery is immutable'); END;
        CREATE TRIGGER mapping_recovery_attempt_no_delete BEFORE DELETE ON collaboration_mapping_recovery_attempts BEGIN SELECT RAISE(ABORT,'mapping recovery is immutable'); END;
        CREATE TRIGGER mapping_recovery_result_no_update BEFORE UPDATE ON collaboration_mapping_recovery_results BEGIN SELECT RAISE(ABORT,'mapping recovery is immutable'); END;
        CREATE TRIGGER mapping_recovery_result_no_delete BEFORE DELETE ON collaboration_mapping_recovery_results BEGIN SELECT RAISE(ABORT,'mapping recovery is immutable'); END;
        CREATE VIEW collaboration_mapping_all_attempts AS
          SELECT request_key,attempt,request_json,created_at FROM collaboration_acceptance_mapping_attempts UNION ALL
          SELECT request_key,attempt,request_json,created_at FROM collaboration_mapping_recovery_attempts;
        CREATE VIEW collaboration_mapping_all_results AS
          SELECT request_key,attempt,receipt_json,created_at FROM collaboration_acceptance_mapping_results UNION ALL
          SELECT request_key,attempt,receipt_json,created_at FROM collaboration_mapping_recovery_results;
      `);
    },
  },
  {
    version: 31, name: "coordinator-startup-epoch-proof", checksum: "v31:immutable-pre-session-coordinator-proof",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_coordinator_proofs (
          instance_owner TEXT NOT NULL,
          instance_fence INTEGER PRIMARY KEY CHECK(instance_fence>0),
          proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(proof_json)<=32768),
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER coordinator_proofs_precede_work BEFORE INSERT ON collaboration_coordinator_proofs
          WHEN EXISTS(SELECT 1 FROM collaboration_execution_sessions WHERE instance_owner=NEW.instance_owner AND instance_fence=NEW.instance_fence)
            OR EXISTS(SELECT 1 FROM collaboration_verification_sessions WHERE instance_owner=NEW.instance_owner AND instance_fence=NEW.instance_fence)
          BEGIN SELECT RAISE(ABORT,'coordinator proof must precede all sessions'); END;
        CREATE TRIGGER coordinator_proofs_no_update BEFORE UPDATE ON collaboration_coordinator_proofs
          BEGIN SELECT RAISE(ABORT,'coordinator proof is immutable'); END;
        CREATE TRIGGER coordinator_proofs_no_delete BEFORE DELETE ON collaboration_coordinator_proofs
          BEGIN SELECT RAISE(ABORT,'coordinator proof is immutable'); END;
      `);
    },
  },
  {
    version: 32, name: "durable-online-document-reads", checksum: "v32:source-bound-read-jobs-and-immutable-receipts",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_online_read_jobs (
          id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          source_event_id TEXT NOT NULL, normalized_hash TEXT NOT NULL, reference_hash TEXT NOT NULL,
          grant_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','ready','failed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
          claim_token TEXT, instance_owner TEXT, instance_fence INTEGER, error_code TEXT,
          projected_revision INTEGER, projection_attempts INTEGER NOT NULL DEFAULT 0 CHECK(projection_attempts BETWEEN 0 AND 3), created_at INTEGER NOT NULL,
          UNIQUE(source_event_id,reference_hash)
        ) STRICT;
        CREATE TABLE collaboration_online_read_receipts (
          job_id TEXT PRIMARY KEY REFERENCES collaboration_online_read_jobs(id),
          receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=4194304),
          receipt_hash TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER online_read_receipts_no_update BEFORE UPDATE ON collaboration_online_read_receipts
          BEGIN SELECT RAISE(ABORT,'online receipt is immutable'); END;
        CREATE TRIGGER online_read_receipts_no_delete BEFORE DELETE ON collaboration_online_read_receipts
          BEGIN SELECT RAISE(ABORT,'online receipt is immutable'); END;
        CREATE TRIGGER online_read_jobs_binding BEFORE UPDATE ON collaboration_online_read_jobs
          WHEN NEW.id<>OLD.id OR NEW.work_item_id<>OLD.work_item_id OR NEW.source_event_id<>OLD.source_event_id
            OR NEW.normalized_hash<>OLD.normalized_hash OR NEW.reference_hash<>OLD.reference_hash
            OR NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.attempts<OLD.attempts OR NEW.projection_attempts<OLD.projection_attempts
          BEGIN SELECT RAISE(ABORT,'online source and budget are immutable'); END;
        CREATE TRIGGER online_read_jobs_no_delete BEFORE DELETE ON collaboration_online_read_jobs
          BEGIN SELECT RAISE(ABORT,'online read history is immutable'); END;
      `);
    },
  },
  {
    version: 33, name: "source-bound-material-interpretations", checksum: "v33:immutable-original-and-bounded-material-intake",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_natural_material_jobs (
          id TEXT PRIMARY KEY REFERENCES collaboration_online_read_receipts(job_id),
          source_event_id TEXT NOT NULL, work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          receipt_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','applied','failed','superseded')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
          claim_token TEXT, lease_until INTEGER, base_revision INTEGER NOT NULL,
          result_revision INTEGER, proposal_json TEXT, error_code TEXT, created_at INTEGER NOT NULL,
          FOREIGN KEY (work_item_id,base_revision) REFERENCES collaboration_work_item_snapshots(work_item_id,revision),
          FOREIGN KEY (work_item_id,result_revision) REFERENCES collaboration_work_item_snapshots(work_item_id,revision)
        ) STRICT;
        CREATE TRIGGER natural_material_source BEFORE INSERT ON collaboration_natural_material_jobs
          WHEN NOT EXISTS (SELECT 1 FROM collaboration_online_read_jobs j JOIN collaboration_online_read_receipts r ON r.job_id=j.id
            JOIN collaboration_natural_intake_jobs n ON n.source_event_id=j.source_event_id AND n.work_item_id=j.work_item_id AND n.status='applied'
            WHERE j.id=NEW.id AND j.work_item_id=NEW.work_item_id AND j.source_event_id=NEW.source_event_id
              AND r.receipt_hash=NEW.receipt_hash AND j.status='ready')
          BEGIN SELECT RAISE(ABORT,'material interpretation source mismatch'); END;
        CREATE TRIGGER natural_material_immutable BEFORE UPDATE ON collaboration_natural_material_jobs
          WHEN OLD.status='applied' OR NEW.id<>OLD.id OR NEW.source_event_id<>OLD.source_event_id OR NEW.work_item_id<>OLD.work_item_id
            OR NEW.receipt_hash<>OLD.receipt_hash OR NEW.base_revision<>OLD.base_revision OR NEW.created_at<>OLD.created_at OR NEW.attempts<OLD.attempts
          BEGIN SELECT RAISE(ABORT,'material interpretation history is immutable'); END;
        CREATE TRIGGER natural_material_no_delete BEFORE DELETE ON collaboration_natural_material_jobs
          BEGIN SELECT RAISE(ABORT,'material interpretation history is immutable'); END;
        CREATE VIEW collaboration_natural_all_jobs AS
          SELECT source_event_id AS job_key,'event' AS job_kind,source_event_id,work_item_id,status,attempts,claim_token,lease_until,base_revision,result_revision,proposal_json,error_code,created_at FROM collaboration_natural_intake_jobs
          UNION ALL SELECT id AS job_key,'material' AS job_kind,source_event_id,work_item_id,status,attempts,claim_token,lease_until,base_revision,result_revision,proposal_json,error_code,created_at FROM collaboration_natural_material_jobs;
      `);
    },
  },
  {
    version: 34, name: "owner-material-intake-recovery", checksum: "v34:single-use-owner-material-recovery-generation",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_natural_material_jobs ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation>=0);
        CREATE TABLE collaboration_natural_material_recoveries (
          id TEXT PRIMARY KEY, request_source_event_id TEXT NOT NULL REFERENCES collaboration_natural_intake_recovery_requests(source_event_id) DEFERRABLE INITIALLY DEFERRED,
          material_job_id TEXT NOT NULL REFERENCES collaboration_natural_material_jobs(id),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id), generation INTEGER NOT NULL CHECK(generation>0),
          prior_attempts INTEGER NOT NULL CHECK(prior_attempts=3), prior_error_code TEXT NOT NULL CHECK(prior_error_code='natural_intake_unavailable'),
          input_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          owner_generation INTEGER NOT NULL CHECK(owner_generation>0), created_at INTEGER NOT NULL,
          UNIQUE(material_job_id,generation), UNIQUE(request_source_event_id,material_job_id)
        ) STRICT;
        CREATE TRIGGER natural_material_recovery_source BEFORE INSERT ON collaboration_natural_material_recoveries
          WHEN NOT EXISTS(SELECT 1 FROM collaboration_natural_material_jobs j JOIN collaboration_online_read_jobs r ON r.id=j.id
            WHERE j.id=NEW.material_job_id AND j.work_item_id=NEW.work_item_id AND j.status='failed' AND j.attempts=3
              AND j.error_code=NEW.prior_error_code AND j.recovery_generation+1=NEW.generation
              AND j.receipt_hash=NEW.receipt_hash AND r.normalized_hash=NEW.input_hash)
          BEGIN SELECT RAISE(ABORT,'material recovery source mismatch'); END;
        CREATE TRIGGER natural_material_recovery_no_update BEFORE UPDATE ON collaboration_natural_material_recoveries
          BEGIN SELECT RAISE(ABORT,'material recovery is immutable'); END;
        CREATE TRIGGER natural_material_recovery_no_delete BEFORE DELETE ON collaboration_natural_material_recoveries
          BEGIN SELECT RAISE(ABORT,'material recovery is immutable'); END;
        DROP TRIGGER natural_material_immutable;
        CREATE TRIGGER natural_material_immutable BEFORE UPDATE ON collaboration_natural_material_jobs
          WHEN OLD.status='applied' OR NEW.id<>OLD.id OR NEW.source_event_id<>OLD.source_event_id OR NEW.work_item_id<>OLD.work_item_id
            OR NEW.receipt_hash<>OLD.receipt_hash OR NEW.base_revision<>OLD.base_revision OR NEW.created_at<>OLD.created_at
            OR ((NEW.attempts<OLD.attempts OR NEW.recovery_generation<>OLD.recovery_generation) AND NOT (
              OLD.status='failed' AND OLD.attempts=3 AND OLD.error_code='natural_intake_unavailable'
              AND NEW.status='pending' AND NEW.attempts=0 AND NEW.recovery_generation=OLD.recovery_generation+1
              AND EXISTS(SELECT 1 FROM collaboration_natural_material_recoveries r WHERE r.material_job_id=OLD.id
                AND r.generation=NEW.recovery_generation AND r.receipt_hash=OLD.receipt_hash)))
          BEGIN SELECT RAISE(ABORT,'material interpretation history is immutable'); END;
      `);
    },
  },
  {
    version: 35, name: 'owner-online-read-recovery', checksum: 'v35:source-and-grant-bound-single-use-read-recovery',
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_online_read_jobs ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation>=0);
        CREATE TABLE collaboration_online_read_recoveries (
          id TEXT PRIMARY KEY, request_source_event_id TEXT NOT NULL REFERENCES collaboration_natural_intake_recovery_requests(source_event_id) DEFERRABLE INITIALLY DEFERRED,
          job_id TEXT NOT NULL REFERENCES collaboration_online_read_jobs(id), work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          generation INTEGER NOT NULL CHECK(generation>0), prior_attempts INTEGER NOT NULL CHECK(prior_attempts BETWEEN 0 AND 3),
          prior_error_code TEXT NOT NULL CHECK(prior_error_code IN ('online_document_not_authorized','online_document_read_unverified','online_document_source_or_grant_changed')),
          input_hash TEXT NOT NULL, reference_hash TEXT NOT NULL, prior_grant_fingerprint TEXT NOT NULL, grant_fingerprint TEXT NOT NULL CHECK(length(grant_fingerprint)=64),
          actor_principal_id TEXT NOT NULL REFERENCES collaboration_principals(id), owner_generation INTEGER NOT NULL CHECK(owner_generation>0), created_at INTEGER NOT NULL,
          UNIQUE(job_id,generation), UNIQUE(request_source_event_id,job_id)
        ) STRICT;
        CREATE TRIGGER online_read_recovery_source BEFORE INSERT ON collaboration_online_read_recoveries
          WHEN NOT EXISTS(SELECT 1 FROM collaboration_online_read_jobs j WHERE j.id=NEW.job_id AND j.work_item_id=NEW.work_item_id
            AND j.status='failed' AND j.attempts=NEW.prior_attempts AND j.error_code=NEW.prior_error_code
            AND ((j.error_code='online_document_not_authorized' AND j.attempts=0) OR (j.error_code='online_document_read_unverified' AND j.attempts=3)
              OR j.error_code='online_document_source_or_grant_changed')
            AND j.recovery_generation+1=NEW.generation AND j.normalized_hash=NEW.input_hash AND j.reference_hash=NEW.reference_hash
            AND j.grant_fingerprint=NEW.prior_grant_fingerprint AND NOT EXISTS(SELECT 1 FROM collaboration_online_read_receipts r WHERE r.job_id=j.id))
          BEGIN SELECT RAISE(ABORT,'online read recovery source mismatch'); END;
        CREATE TRIGGER online_read_recovery_no_update BEFORE UPDATE ON collaboration_online_read_recoveries
          BEGIN SELECT RAISE(ABORT,'online read recovery is immutable'); END;
        CREATE TRIGGER online_read_recovery_no_delete BEFORE DELETE ON collaboration_online_read_recoveries
          BEGIN SELECT RAISE(ABORT,'online read recovery is immutable'); END;
        DROP TRIGGER online_read_jobs_binding;
        CREATE TRIGGER online_read_jobs_binding BEFORE UPDATE ON collaboration_online_read_jobs
          WHEN NEW.id<>OLD.id OR NEW.work_item_id<>OLD.work_item_id OR NEW.source_event_id<>OLD.source_event_id
            OR NEW.normalized_hash<>OLD.normalized_hash OR NEW.reference_hash<>OLD.reference_hash OR NEW.created_at<>OLD.created_at
            OR NEW.projection_attempts<OLD.projection_attempts
            OR ((NEW.grant_fingerprint<>OLD.grant_fingerprint OR NEW.attempts<OLD.attempts OR NEW.recovery_generation<>OLD.recovery_generation
              OR (OLD.status='failed' AND NEW.status<>'failed')) AND NOT (
              OLD.status='failed' AND NEW.status='pending' AND NEW.attempts=0 AND NEW.recovery_generation=OLD.recovery_generation+1
              AND NOT EXISTS(SELECT 1 FROM collaboration_online_read_receipts b WHERE b.job_id=OLD.id)
              AND EXISTS(SELECT 1 FROM collaboration_online_read_recoveries r WHERE r.job_id=OLD.id AND r.generation=NEW.recovery_generation
                AND r.input_hash=OLD.normalized_hash AND r.reference_hash=OLD.reference_hash AND r.prior_attempts=OLD.attempts
                AND r.prior_error_code=OLD.error_code AND r.prior_grant_fingerprint=OLD.grant_fingerprint AND r.grant_fingerprint=NEW.grant_fingerprint)))
          BEGIN SELECT RAISE(ABORT,'online source and budget are immutable'); END;
      `);
    },
  },
  {
    version: 36, name: "conversation-intent-before-mutation", checksum: "v36:durable-read-only-conversation-routing",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_conversation_intents (
        event_id TEXT PRIMARY KEY REFERENCES collaboration_external_events(id),
        source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
        context_outbox_sequence INTEGER NOT NULL DEFAULT 0 CHECK(context_outbox_sequence>=0),
        requested_work_item_id TEXT REFERENCES collaboration_work_items(id),
        status TEXT NOT NULL CHECK(status IN ('pending','running','routed','applied','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
        projection_attempts INTEGER NOT NULL DEFAULT 0 CHECK(projection_attempts BETWEEN 0 AND 3),
        target_work_item_id TEXT REFERENCES collaboration_work_items(id),
        proposal_json TEXT, claim_token TEXT, lease_until INTEGER
      ) STRICT;
      CREATE TRIGGER conversation_intent_binding BEFORE UPDATE ON collaboration_conversation_intents
        WHEN OLD.status IN ('applied','failed') OR NEW.event_id<>OLD.event_id OR NEW.source_hash<>OLD.source_hash
          OR NEW.requested_work_item_id IS NOT OLD.requested_work_item_id OR NEW.attempts<OLD.attempts
          OR NEW.context_outbox_sequence<>OLD.context_outbox_sequence
          OR (OLD.proposal_json IS NOT NULL AND NEW.target_work_item_id IS NOT OLD.target_work_item_id)
          OR NEW.projection_attempts<OLD.projection_attempts
          OR (OLD.proposal_json IS NOT NULL AND NEW.proposal_json IS NOT OLD.proposal_json)
        BEGIN SELECT RAISE(ABORT,'conversation intent source, result and budget are immutable'); END;
    `); },
  },
  {
    version: 37, name: "fixed-approval-presentation", checksum: "v37:owner-candidate-and-actual-delivery-bound-presentation",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_approval_presentations (
        outbox_id TEXT PRIMARY KEY REFERENCES collaboration_outbox(id),
        work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id), work_item_version INTEGER NOT NULL CHECK(work_item_version>0),
        conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id), plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
        snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>0), run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
        candidate_sha TEXT NOT NULL, spec_hash TEXT NOT NULL,
        verifier_review_id TEXT NOT NULL REFERENCES collaboration_candidate_reviews(id), meta_review_id TEXT NOT NULL REFERENCES collaboration_candidate_reviews(id),
        owner_binding_id TEXT NOT NULL REFERENCES collaboration_owner_bindings(id), owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK(expires_at=created_at+900000), sent_at INTEGER, source_event_id TEXT, delivery_sequence INTEGER,
        CHECK((sent_at IS NULL AND source_event_id IS NULL AND delivery_sequence IS NULL) OR
          (sent_at IS NOT NULL AND source_event_id IS NOT NULL AND delivery_sequence IS NOT NULL AND
           sent_at>=created_at AND sent_at<expires_at AND length(source_event_id) BETWEEN 1 AND 512 AND delivery_sequence>0))
      ) STRICT;
      CREATE TRIGGER approval_presentation_binding BEFORE UPDATE ON collaboration_approval_presentations
        WHEN NEW.outbox_id<>OLD.outbox_id OR NEW.work_item_id<>OLD.work_item_id OR NEW.work_item_version<>OLD.work_item_version
          OR NEW.conversation_id<>OLD.conversation_id OR NEW.plan_revision<>OLD.plan_revision OR NEW.snapshot_revision<>OLD.snapshot_revision
          OR NEW.run_id<>OLD.run_id OR NEW.candidate_sha<>OLD.candidate_sha OR NEW.spec_hash<>OLD.spec_hash
          OR NEW.verifier_review_id<>OLD.verifier_review_id OR NEW.meta_review_id<>OLD.meta_review_id
          OR NEW.owner_binding_id<>OLD.owner_binding_id OR NEW.owner_generation<>OLD.owner_generation
          OR NEW.payload_hash<>OLD.payload_hash OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
          OR (OLD.sent_at IS NOT NULL AND (NEW.sent_at IS NOT OLD.sent_at OR NEW.source_event_id IS NOT OLD.source_event_id OR NEW.delivery_sequence IS NOT OLD.delivery_sequence))
        BEGIN SELECT RAISE(ABORT,'approval presentation binding is immutable'); END;
      CREATE TRIGGER approval_presentation_no_delete BEFORE DELETE ON collaboration_approval_presentations
        BEGIN SELECT RAISE(ABORT,'approval presentation history is immutable'); END;
    `); },
  },
  {
    version: 38, name: "candidate-supplemental-recheck-budget", checksum: "v38:immutable-session-bound-three-attempt-recheck-budget",
    apply(database) { database.exec(`
      CREATE TABLE collaboration_candidate_recheck_attempts (
        session_id TEXT PRIMARY KEY REFERENCES collaboration_verification_sessions(id),
        candidate_run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
        candidate_sha TEXT NOT NULL CHECK(length(candidate_sha) IN (40,64) AND candidate_sha NOT GLOB '*[^a-f0-9]*'),
        contract_hash TEXT NOT NULL CHECK(length(contract_hash)=64 AND contract_hash NOT GLOB '*[^a-f0-9]*'),
        attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
        verifier_attempt INTEGER NOT NULL CHECK(verifier_attempt>0),
        instance_owner TEXT NOT NULL CHECK(length(instance_owner) BETWEEN 1 AND 512),
        instance_fence INTEGER NOT NULL CHECK(instance_fence>0), created_at INTEGER NOT NULL,
        UNIQUE(candidate_run_id,contract_hash,attempt), UNIQUE(candidate_run_id,verifier_attempt)
      ) STRICT;
      CREATE TRIGGER candidate_recheck_budget BEFORE INSERT ON collaboration_candidate_recheck_attempts
        WHEN NEW.attempt<>(SELECT COALESCE(MAX(attempt),0)+1 FROM collaboration_candidate_recheck_attempts
          WHERE candidate_run_id=NEW.candidate_run_id AND contract_hash=NEW.contract_hash)
          OR NEW.verifier_attempt<=(SELECT COALESCE(MAX(verifier_attempt),0) FROM collaboration_candidate_recheck_attempts
            WHERE candidate_run_id=NEW.candidate_run_id)
        BEGIN SELECT RAISE(ABORT,'candidate recheck budget sequence mismatch'); END;
      CREATE TRIGGER candidate_recheck_session_binding BEFORE INSERT ON collaboration_candidate_recheck_attempts
        WHEN NOT EXISTS(SELECT 1 FROM collaboration_verification_sessions s
          WHERE s.id=NEW.session_id AND s.candidate_run_id=NEW.candidate_run_id AND s.candidate_sha=NEW.candidate_sha
            AND s.instance_owner=NEW.instance_owner AND s.instance_fence=NEW.instance_fence
            AND NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM collaboration_verification_finalization_intents f WHERE f.session_id=s.id)
            AND NOT EXISTS(SELECT 1 FROM collaboration_verification_commands c WHERE c.session_id=s.id))
        BEGIN SELECT RAISE(ABORT,'candidate recheck session binding mismatch'); END;
      CREATE TRIGGER candidate_recheck_no_update BEFORE UPDATE ON collaboration_candidate_recheck_attempts
        BEGIN SELECT RAISE(ABORT,'candidate recheck budget is immutable'); END;
      CREATE TRIGGER candidate_recheck_no_delete BEFORE DELETE ON collaboration_candidate_recheck_attempts
        BEGIN SELECT RAISE(ABORT,'candidate recheck budget is immutable'); END;
    `); },
  },
  {
    version:39,name:"verified-result-delivery",checksum:"v39:fixed-candidate-result-body-and-accepted-delivery",
    apply(database){database.exec(`
      CREATE TABLE collaboration_candidate_result_bindings (
        outbox_id TEXT PRIMARY KEY REFERENCES collaboration_outbox(id),
        work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id), work_item_version INTEGER NOT NULL CHECK(work_item_version>0),
        conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id), plan_revision INTEGER NOT NULL CHECK(plan_revision>0), snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>0),
        candidate_run_id TEXT NOT NULL REFERENCES collaboration_runs(id), base_sha TEXT NOT NULL, candidate_sha TEXT NOT NULL,
        spec_hash TEXT NOT NULL CHECK(length(spec_hash)=64), spec_identity_hash TEXT NOT NULL CHECK(length(spec_identity_hash)=64), policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), serialized_hash TEXT NOT NULL CHECK(length(serialized_hash)=64), created_at INTEGER NOT NULL,
        UNIQUE(candidate_run_id,spec_hash,policy_hash,work_item_version)
      ) STRICT;
      CREATE TABLE collaboration_candidate_result_deliveries (
        outbox_id TEXT PRIMARY KEY REFERENCES collaboration_candidate_result_bindings(outbox_id),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), serialized_hash TEXT NOT NULL CHECK(length(serialized_hash)=64),
        source_event_id TEXT NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 512), delivery_sequence INTEGER NOT NULL CHECK(delivery_sequence>0), sent_at INTEGER NOT NULL,
        idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash)=64), channel TEXT NOT NULL CHECK(channel IN ('session','proactive')),
        destination_hash TEXT NOT NULL CHECK(length(destination_hash)=64), confirmation_kind TEXT NOT NULL CHECK(confirmation_kind IN ('business_response','accepted_receipt'))
      ) STRICT;
      CREATE TRIGGER candidate_result_delivery_binding BEFORE INSERT ON collaboration_candidate_result_deliveries
        WHEN NOT EXISTS(SELECT 1 FROM collaboration_candidate_result_bindings b JOIN collaboration_outbox o ON o.id=b.outbox_id
          WHERE b.outbox_id=NEW.outbox_id AND b.payload_hash=NEW.payload_hash AND b.serialized_hash=NEW.serialized_hash
            AND o.delivery_state='sent' AND o.sent_at=NEW.sent_at AND o.delivery_sequence=NEW.delivery_sequence AND o.superseded_at IS NULL)
        BEGIN SELECT RAISE(ABORT,'candidate result delivery is not bound'); END;
    `);
      for(const table of ["bindings","deliveries"])for(const operation of ["UPDATE","DELETE"]){
        database.exec(`CREATE TRIGGER candidate_result_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_candidate_result_${table}
          BEGIN SELECT RAISE(ABORT,'candidate result evidence is immutable'); END;`);
      }
    },
  },
  {
    version: 40, name: "bounded-candidate-revision", checksum: "v40:immutable-parent-bound-candidate-revision-and-supersession",
    apply(database) {
      const now = Date.now();
      if (database.prepare("SELECT 1 FROM collaboration_instance_lease WHERE expires_at>? UNION ALL SELECT 1 FROM collaboration_work_nodes WHERE lease_expires_at>? UNION ALL SELECT 1 FROM collaboration_outbox WHERE claim_expires_at>? LIMIT 1").get(now, now, now) ||
        database.prepare("SELECT 1 FROM collaboration_runs WHERE status='running' UNION ALL SELECT 1 FROM collaboration_execution_sessions s WHERE NOT EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=s.id) UNION ALL SELECT 1 FROM collaboration_verification_sessions s WHERE NOT EXISTS(SELECT 1 FROM collaboration_verification_settlements f WHERE f.session_id=s.id) LIMIT 1").get() ||
        database.prepare("SELECT 1 FROM collaboration_execution_dispatches d WHERE NOT EXISTS(SELECT 1 FROM collaboration_execution_sessions s WHERE s.work_item_id=d.work_item_id AND s.attempt=d.attempt) AND NOT EXISTS(SELECT 1 FROM collaboration_execution_preparation_results p WHERE p.work_item_id=d.work_item_id AND p.attempt=d.attempt AND p.state='failed' AND p.created_at<=?) LIMIT 1").get(now)) {
        throw new Error("candidate_revision_migration_requires_quiescence");
      }
      database.exec(`
        CREATE TABLE collaboration_candidate_revision_requests (
          request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          work_item_version INTEGER NOT NULL CHECK(work_item_version>0), plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
          snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>0), node_id TEXT NOT NULL,
          parent_run_id TEXT NOT NULL REFERENCES collaboration_runs(id), parent_sha TEXT NOT NULL,
          base_sha TEXT NOT NULL, build_parent_sha TEXT NOT NULL CHECK(build_parent_sha=parent_sha),
          attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3), grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
          issued_at INTEGER NOT NULL CHECK(issued_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at=issued_at+900000),
          UNIQUE(request_id,work_item_id,attempt),
          FOREIGN KEY(work_item_id,plan_revision,node_id) REFERENCES collaboration_work_nodes(work_item_id,plan_revision,node_id),
          FOREIGN KEY(work_item_id,snapshot_revision) REFERENCES collaboration_work_item_snapshots(work_item_id,revision),
          CHECK(json_extract(grant_json,'$.requestId') IS request_id AND json_extract(grant_json,'$.requestHash') IS request_hash
            AND json_extract(grant_json,'$.workItemId') IS work_item_id AND json_extract(grant_json,'$.workItemVersion') IS work_item_version
            AND json_extract(grant_json,'$.planRevision') IS plan_revision AND json_extract(grant_json,'$.snapshotRevision') IS snapshot_revision
            AND json_extract(grant_json,'$.nodeId') IS node_id AND json_extract(grant_json,'$.parentRunId') IS parent_run_id
            AND json_extract(grant_json,'$.parentSha') IS parent_sha AND json_extract(grant_json,'$.baseSha') IS base_sha
            AND json_extract(grant_json,'$.buildParentSha') IS build_parent_sha AND json_extract(grant_json,'$.attempt') IS attempt
            AND json_extract(grant_json,'$.maxAttempts') IS 3 AND json_extract(grant_json,'$.issuedAt') IS issued_at
            AND json_extract(grant_json,'$.expiresAt') IS expires_at)
        ) STRICT;
        CREATE INDEX candidate_revision_parent ON collaboration_candidate_revision_requests(parent_run_id,parent_sha);
        CREATE TABLE collaboration_candidate_revision_stages (
          request_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('reserved','started')),
          work_item_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
          instance_owner TEXT NOT NULL, instance_fence INTEGER NOT NULL CHECK(instance_fence>0),
          session_id TEXT REFERENCES collaboration_execution_sessions(id), created_at INTEGER NOT NULL CHECK(created_at>=0),
          PRIMARY KEY(request_id,stage), UNIQUE(work_item_id,attempt,stage), UNIQUE(session_id),
          FOREIGN KEY(request_id,work_item_id,attempt) REFERENCES collaboration_candidate_revision_requests(request_id,work_item_id,attempt),
          CHECK((stage='reserved' AND session_id IS NULL) OR (stage='started' AND session_id IS NOT NULL))
        ) STRICT;
        CREATE TRIGGER candidate_revision_parent_binding BEFORE INSERT ON collaboration_candidate_revision_requests
          WHEN NOT EXISTS(SELECT 1 FROM collaboration_runs r JOIN collaboration_candidates c ON c.run_id=r.id
            JOIN collaboration_work_items w ON w.id=r.work_item_id JOIN collaboration_plan_revisions p ON p.work_item_id=w.id AND p.revision=w.current_plan_revision
            WHERE r.id=NEW.parent_run_id AND r.work_item_id=NEW.work_item_id AND r.plan_revision=NEW.plan_revision AND r.node_id=NEW.node_id
              AND r.status='succeeded' AND r.result_sha=NEW.parent_sha AND r.base_sha=NEW.base_sha
              AND c.state='target_tests_passed' AND c.result_sha=NEW.parent_sha AND c.base_sha=NEW.base_sha
              AND w.version=NEW.work_item_version AND w.current_plan_revision=NEW.plan_revision
              AND w.control_state='active' AND w.definition_status='ready_for_execution' AND w.status NOT IN ('accepted','cancelled')
              AND p.status='published' AND p.snapshot_revision=NEW.snapshot_revision
              AND r.attempt=(SELECT MAX(latest.attempt) FROM collaboration_runs latest JOIN collaboration_candidates candidate ON candidate.run_id=latest.id
                WHERE latest.work_item_id=w.id AND latest.plan_revision=NEW.plan_revision AND latest.status='succeeded' AND candidate.state='target_tests_passed' AND candidate.result_sha IS NOT NULL)
              AND NEW.attempt=1+max(COALESCE((SELECT MAX(x.attempt) FROM collaboration_runs x WHERE x.work_item_id=w.id),0),
                COALESCE((SELECT MAX(x.attempt) FROM collaboration_execution_dispatches x WHERE x.work_item_id=w.id),0),
                COALESCE((SELECT MAX(x.attempt) FROM collaboration_execution_sessions x WHERE x.work_item_id=w.id),0)))
          BEGIN SELECT RAISE(ABORT,'candidate revision parent binding mismatch'); END;
        CREATE TRIGGER candidate_revision_request_conflict BEFORE INSERT ON collaboration_candidate_revision_requests
          WHEN EXISTS(SELECT 1 FROM collaboration_candidate_revision_requests q WHERE q.work_item_id=NEW.work_item_id
            AND ((NOT EXISTS(SELECT 1 FROM collaboration_candidate_revision_stages s WHERE s.request_id=q.request_id) AND q.expires_at>NEW.issued_at)
              OR (EXISTS(SELECT 1 FROM collaboration_candidate_revision_stages s WHERE s.request_id=q.request_id) AND NOT (
                NOT EXISTS(SELECT 1 FROM collaboration_execution_sessions e WHERE e.work_item_id=q.work_item_id AND e.attempt=q.attempt
                  AND NOT EXISTS(SELECT 1 FROM collaboration_execution_settlements f WHERE f.session_id=e.id AND f.created_at<=NEW.issued_at))
                AND (EXISTS(SELECT 1 FROM collaboration_runs r JOIN collaboration_execution_sessions e ON e.id=r.id
                    JOIN collaboration_execution_settlements f ON f.session_id=e.id LEFT JOIN collaboration_candidates c ON c.run_id=r.id
                    WHERE r.work_item_id=q.work_item_id AND r.attempt=q.attempt AND f.created_at<=NEW.issued_at
                      AND r.status IN ('failed','invalid','timed_out','needs_configuration') AND r.finished_at>=r.started_at AND r.finished_at<=NEW.issued_at
                      AND ((r.result_sha IS NULL AND c.result_sha IS NULL) OR (r.result_sha IS NOT NULL AND c.result_sha=r.result_sha
                        AND r.base_sha=q.base_sha AND c.base_sha=q.base_sha
                        AND c.state IN ('test_failed','invalid','needs_configuration','not_verified')
                        AND EXISTS(SELECT 1 FROM collaboration_candidate_revision_stages s WHERE s.request_id=q.request_id AND s.stage='started' AND s.session_id=r.id)
                        AND json_type(c.quality_json,'$.lineage')='object' AND (SELECT count(*) FROM json_each(c.quality_json,'$.lineage'))=8
                        AND json_extract(c.quality_json,'$.lineage.version')=1 AND json_extract(c.quality_json,'$.lineage.requestId')=q.request_id
                        AND json_extract(c.quality_json,'$.lineage.requestHash')=q.request_hash AND json_extract(c.quality_json,'$.lineage.parentRunId')=q.parent_run_id
                        AND json_extract(c.quality_json,'$.lineage.parentSha')=q.parent_sha AND json_extract(c.quality_json,'$.lineage.baseSha')=q.base_sha
                        AND json_extract(c.quality_json,'$.lineage.buildParentSha')=q.build_parent_sha AND json_extract(c.quality_json,'$.lineage.candidateSha')=r.result_sha)))
                  OR (NOT EXISTS(SELECT 1 FROM collaboration_runs r WHERE r.work_item_id=q.work_item_id AND r.attempt=q.attempt)
                    AND EXISTS(SELECT 1 FROM collaboration_execution_preparation_results p WHERE p.work_item_id=q.work_item_id AND p.attempt=q.attempt AND p.state='failed' AND p.created_at<=NEW.issued_at)))))))
          BEGIN SELECT RAISE(ABORT,'candidate revision request conflict'); END;
        CREATE TRIGGER candidate_revision_stage_binding BEFORE INSERT ON collaboration_candidate_revision_stages
          WHEN NOT EXISTS(SELECT 1 FROM collaboration_candidate_revision_requests q JOIN collaboration_execution_dispatches d
              ON d.work_item_id=q.work_item_id AND d.attempt=q.attempt
            WHERE q.request_id=NEW.request_id AND q.work_item_id=NEW.work_item_id AND q.attempt=NEW.attempt
              AND q.issued_at<=NEW.created_at AND NEW.created_at<q.expires_at
              AND d.plan_revision=q.plan_revision AND d.instance_owner=NEW.instance_owner AND d.instance_fence=NEW.instance_fence
              AND d.created_at>=q.issued_at AND d.created_at<=NEW.created_at
              AND (NEW.stage='reserved' OR EXISTS(SELECT 1 FROM collaboration_candidate_revision_stages previous
                JOIN collaboration_execution_sessions e ON e.id=NEW.session_id
                WHERE previous.request_id=NEW.request_id AND previous.stage='reserved'
                  AND previous.instance_owner=NEW.instance_owner AND previous.instance_fence=NEW.instance_fence AND previous.created_at<=NEW.created_at
                  AND e.work_item_id=q.work_item_id AND e.plan_revision=q.plan_revision AND e.attempt=q.attempt
                  AND e.base_sha=q.base_sha AND e.repository_path=json_extract(q.grant_json,'$.repository')
                  AND e.instance_owner=NEW.instance_owner AND e.instance_fence=NEW.instance_fence
                  AND e.created_at>=previous.created_at AND e.created_at<=NEW.created_at)))
          BEGIN SELECT RAISE(ABORT,'candidate revision stage binding mismatch'); END;
      `);
      for (const table of ["requests", "stages"]) for (const operation of ["UPDATE", "DELETE"]) database.exec(`
        CREATE TRIGGER candidate_revision_${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON collaboration_candidate_revision_${table}
          BEGIN SELECT RAISE(ABORT,'candidate revision history is immutable'); END;`);
      const blocking = "(q.issued_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND q.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) OR EXISTS(SELECT 1 FROM collaboration_candidate_revision_stages s WHERE s.request_id=q.request_id))";
      for (const [table, column] of [["verification_sessions", "candidate_run_id"], ["candidate_reviews", "candidate_run_id"], ["candidate_recheck_attempts", "candidate_run_id"]]) database.exec(`
        CREATE TRIGGER candidate_revision_blocks_${table} BEFORE INSERT ON collaboration_${table}
          WHEN EXISTS(SELECT 1 FROM collaboration_candidate_revision_requests q WHERE q.parent_run_id=NEW.${column} AND ${blocking})
          BEGIN SELECT RAISE(ABORT,'candidate superseded by revision'); END;`);
      database.exec(`CREATE TRIGGER candidate_revision_blocks_accept BEFORE UPDATE OF accepted_candidate_sha,status,control_state ON collaboration_work_items
        WHEN NEW.accepted_candidate_sha IS NOT NULL AND EXISTS(SELECT 1 FROM collaboration_candidate_revision_requests q
          WHERE q.work_item_id=NEW.id AND q.parent_sha=NEW.accepted_candidate_sha AND ${blocking})
        BEGIN SELECT RAISE(ABORT,'candidate superseded by revision'); END;`);
    },
  },
  { version: 41, name: "source-bound-conversation-turns", checksum: "v41:immutable-parent-and-scoped-turn-parts", apply: applyTurnPartsMigration },
];

export interface MigrationState {
  schemaVersion: number;
  appliedMigrations: number;
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function applyCollaborationMigrations(database: DatabaseSync): MigrationState {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM collaboration_schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;

  for (const row of applied) {
    const known = migrations.find((migration) => migration.version === row.version);
    if (!known || known.name !== row.name || known.checksum !== row.checksum) {
      throw new Error(`Collaboration migration ${row.version} does not match this service build`);
    }
  }

  for (const migration of migrations) {
    if (applied.some((row) => row.version === migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database
        .prepare(
          "INSERT INTO collaboration_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, Date.now());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const schemaVersion = userVersion(database);
  const countRow = database.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get() as {
    count: number;
  };
  if (schemaVersion !== COLLABORATION_SCHEMA_VERSION || countRow.count !== migrations.length) {
    throw new Error(
      `Collaboration schema is inconsistent (user_version=${schemaVersion}, migrations=${countRow.count})`,
    );
  }
  return { schemaVersion, appliedMigrations: countRow.count };
}

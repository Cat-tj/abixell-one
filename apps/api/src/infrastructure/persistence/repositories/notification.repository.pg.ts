import type { Pool, QueryResultRow } from "pg";
import type {
  Notification,
  NotificationChannel,
  NotificationRepository,
  NotificationStatus,
  NotificationTemplate,
} from "../../../domain/notification/notification.entity.js";

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly pool: Pool) {}

  async createTemplate(input: {
    tenantId: string;
    eventType: string;
    channel: NotificationChannel;
    subjectTemplate: string | null;
    bodyTemplate: string;
  }): Promise<NotificationTemplate> {
    const result = await this.pool.query(
      `INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.tenantId, input.eventType, input.channel, input.subjectTemplate, input.bodyTemplate],
    );
    return mapTemplate(result.rows[0]);
  }

  async listTemplates(tenantId: string): Promise<NotificationTemplate[]> {
    const result = await this.pool.query(
      `SELECT * FROM notification_templates WHERE tenant_id = $1 ORDER BY event_type, channel`,
      [tenantId],
    );
    return result.rows.map(mapTemplate);
  }

  async findTemplate(
    tenantId: string,
    eventType: string,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null> {
    const result = await this.pool.query(
      `SELECT * FROM notification_templates WHERE tenant_id = $1 AND event_type = $2 AND channel = $3`,
      [tenantId, eventType, channel],
    );
    return result.rows[0] ? mapTemplate(result.rows[0]) : null;
  }

  async createNotification(input: {
    tenantId: string;
    domainEventId: string | null;
    eventType: string;
    channel: NotificationChannel;
    recipientUserId: string | null;
    subject: string | null;
    body: string;
    status: NotificationStatus;
    errorMessage: string | null;
    sentAt: Date | null;
  }): Promise<Notification> {
    const result = await this.pool.query(
      `INSERT INTO notifications
         (tenant_id, domain_event_id, event_type, channel, recipient_user_id, subject, body, status, error_message, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.tenantId,
        input.domainEventId,
        input.eventType,
        input.channel,
        input.recipientUserId,
        input.subject,
        input.body,
        input.status,
        input.errorMessage,
        input.sentAt,
      ],
    );
    return mapNotification(result.rows[0]);
  }

  async listForRecipient(tenantId: string, recipientUserId: string, limit: number): Promise<Notification[]> {
    const result = await this.pool.query(
      `SELECT n.*, de.entity_type AS entity_type, de.entity_id AS entity_id
         FROM notifications n
         LEFT JOIN domain_events de ON de.id = n.domain_event_id
        WHERE n.tenant_id = $1 AND n.recipient_user_id = $2
        ORDER BY n.created_at DESC LIMIT $3`,
      [tenantId, recipientUserId, limit],
    );
    return result.rows.map(mapNotification);
  }

  async listForTenant(tenantId: string, limit: number): Promise<Notification[]> {
    const result = await this.pool.query(
      `SELECT * FROM notifications WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map(mapNotification);
  }

  async markRead(id: string, recipientUserId: string): Promise<Notification | null> {
    const result = await this.pool.query(
      `UPDATE notifications SET read_at = now()
       WHERE id = $1 AND recipient_user_id = $2
       RETURNING *`,
      [id, recipientUserId],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }

  async findById(id: string): Promise<Notification | null> {
    const result = await this.pool.query(`SELECT * FROM notifications WHERE id = $1`, [id]);
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }
}

function mapTemplate(row: QueryResultRow): NotificationTemplate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    channel: row.channel,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function mapNotification(row: QueryResultRow): Notification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    domainEventId: row.domain_event_id,
    eventType: row.event_type,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    channel: row.channel,
    recipientUserId: row.recipient_user_id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    errorMessage: row.error_message,
    sentAt: row.sent_at,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

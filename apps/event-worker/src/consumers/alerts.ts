/**
 * Owner alerts for parked/quarantined events (spec 06 §4: parking/DLQ has an
 * owner and alert). Fields are identifiers and codes only — never payloads,
 * error messages or raw record bytes — so alerts are safe for any channel.
 * Emitted only AFTER the park/quarantine write is durable.
 */
export interface OwnerAlert {
  kind: 'EVENT_PARKED' | 'RECORD_QUARANTINED';
  owner: string;
  consumerName: string;
  reasonCode: string;
  source: { topic: string; partition: number; offset: string };
  tenantId?: string;
  eventType?: string;
  parkedId?: string;
  attempts?: number;
}
export interface AlertSink { alert(alert: Readonly<OwnerAlert>): void }

/** Default sink: one JSON line on stderr for the log pipeline / alert rules (OBS-01). */
export const stderrAlertSink: AlertSink = {
  alert(alert) { process.stderr.write(JSON.stringify({ level: 'alert', ...alert }) + '\n'); },
};

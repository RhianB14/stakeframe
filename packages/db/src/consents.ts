/**
 * Versioned consent service (STK-F1-07).
 *
 * - The catalog (`core.legal_document`) is the single source of truth for the document
 *   types, versions and content hashes users must accept. Nothing here trusts versions,
 *   timestamps or user ids coming from the client.
 * - Acceptance rows (`core.consent_record`) are append-only: every write is an INSERT,
 *   the unique (user, document) constraint plus `ON CONFLICT DO NOTHING` make repeated
 *   submissions idempotent, and a broken catalog entry fails closed instead of recording
 *   consent against drifted content.
 * - Every error is the sanitized code itself — no SQL, table, host or user data.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { consentRecord, legalDocument } from './core-schema.js';
import type { Database } from './index.js';

export const LEGAL_DOCUMENT_TYPES = ['terms_of_use', 'privacy_policy', 'minimum_age'] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];
/** Every required document must be accepted explicitly; this set gates the catalog. */
export const REQUIRED_LEGAL_DOCUMENT_TYPES: readonly LegalDocumentType[] = LEGAL_DOCUMENT_TYPES;

export type ConsentErrorCode = 'CONSENT_INVALID' | 'CONSENT_UNAVAILABLE';

export class ConsentError extends Error {
  constructor(public readonly code: ConsentErrorCode) {
    super(code);
    this.name = 'ConsentError';
  }
}

/** SHA-256 (hex) of the document content exactly as stored in the catalog. */
export function hashDocumentContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export type CurrentDocument = {
  id: string;
  type: LegalDocumentType;
  version: string;
  title: string;
  summary: string;
  textUrl: string;
  effectiveAt: Date;
  /** SHA-256 recorded for this version (content verified against it at read time). */
  contentHash: string;
  /** Content hash matches `contentMd`, i.e. the version was not tampered with. */
  intact: boolean;
};

export type ConsentDocumentStatus = {
  type: LegalDocumentType;
  version: string;
  title: string;
  summary: string;
  textUrl: string;
  effectiveAt: Date;
  /** An acceptance exists for this exact version and content hash. */
  accepted: boolean;
  /** The user accepted an earlier version/hash of this document (re-acceptance due). */
  stale: boolean;
  /** The stored content no longer matches its recorded hash (fail-closed). */
  integrity: 'ok' | 'changed';
  acceptedAt: Date | null;
};

export type ConsentStatus = {
  /** Required, currently effective documents the user must have accepted. */
  documents: ConsentDocumentStatus[];
  pendingTypes: LegalDocumentType[];
  allAccepted: boolean;
};

/**
 * Read-only guard so tests and operators can confirm the drift behavior without touching
 * the hashing boundary.
 */
export function documentContentIsIntact(document: { contentMd: string; contentHash: string }) {
  return hashDocumentContent(document.contentMd) === document.contentHash;
}

export function createConsentsService(database: Database) {
  type ConsentExecutor = Pick<Database['orm'], 'select'>;
  /** Required documents that are currently effective (`current` + `effective_at <= now`). */
  async function currentDocuments(
    executor: ConsentExecutor = database.orm,
  ): Promise<CurrentDocument[]> {
    const rows = await executor
      .select({
        id: legalDocument.id,
        type: legalDocument.docType,
        version: legalDocument.version,
        title: legalDocument.title,
        summary: legalDocument.summary,
        contentMd: legalDocument.contentMd,
        contentHash: legalDocument.contentHash,
        textUrl: legalDocument.textUrl,
        effectiveAt: legalDocument.effectiveAt,
      })
      .from(legalDocument)
      .where(
        and(
          eq(legalDocument.status, 'current'),
          eq(legalDocument.required, true),
          lte(legalDocument.effectiveAt, sql`now()`),
        ),
      )
      .orderBy(asc(legalDocument.docType), asc(legalDocument.version));
    return rows.map(({ contentMd, ...rest }) => ({
      ...rest,
      intact: documentContentIsIntact({ contentMd, contentHash: rest.contentHash }),
    }));
  }

  async function statusFor(userId: string): Promise<ConsentStatus> {
    const documents = await currentDocuments();
    const records = await database.orm
      .select({
        documentId: consentRecord.documentId,
        docType: consentRecord.docType,
        documentVersion: consentRecord.documentVersion,
        documentHash: consentRecord.documentHash,
        acceptedAt: consentRecord.acceptedAt,
      })
      .from(consentRecord)
      .where(eq(consentRecord.userId, userId));
    const byDocument = new Map(records.map((record) => [record.documentId, record]));
    const hasTypeHistory = new Set(records.map((record) => record.docType));
    const statuses: ConsentDocumentStatus[] = documents.map((document) => {
      const record = byDocument.get(document.id);
      const accepted =
        document.intact &&
        record !== undefined &&
        record.documentVersion === document.version &&
        record.documentHash === document.contentHash;
      return {
        type: document.type,
        version: document.version,
        title: document.title,
        summary: document.summary,
        textUrl: document.textUrl,
        effectiveAt: document.effectiveAt,
        accepted,
        // An earlier acceptance of the same document type exists (previous version or
        // drifted content): re-acceptance is due.
        stale: !accepted && hasTypeHistory.has(document.type),
        integrity: document.intact ? 'ok' : 'changed',
        acceptedAt: accepted ? (record?.acceptedAt ?? null) : null,
      };
    });
    const pendingTypes = statuses.filter((status) => !status.accepted).map((s) => s.type);
    return {
      documents: statuses,
      pendingTypes,
      allAccepted: statuses.length > 0 && pendingTypes.length === 0,
    };
  }

  type AcceptanceInput = { type: LegalDocumentType; version?: string };

  /**
   * Records the acceptance of every required, currently effective document in ONE
   * transaction. `ON CONFLICT DO NOTHING` against the unique (user, document) key makes
   * repeated calls idempotent; any failure rolls the whole batch back, so partial
   * acceptances never persist.
   */
  async function accept(
    userId: string,
    input: AcceptanceInput[],
  ): Promise<{ accepted: { type: LegalDocumentType; version: string; acceptedAt: Date }[] }> {
    return database.orm.transaction(async (transaction) => {
      const documents = await currentDocuments(transaction);
      const acceptable = documents.filter((document) => document.intact);
      if (acceptable.length === 0) throw new ConsentError('CONSENT_UNAVAILABLE');
      const expected = new Set(acceptable.map((document) => document.type));
      const provided = new Set<LegalDocumentType>();
      for (const item of input) {
        provided.add(item.type);
        const document = acceptable.find((candidate) => candidate.type === item.type);
        // The client may echo the version it saw; anything other than the currently
        // effective version is refused instead of silently downgraded.
        if (!document || (item.version !== undefined && item.version !== document.version)) {
          throw new ConsentError('CONSENT_INVALID');
        }
      }
      if (provided.size !== expected.size || [...expected].some((type) => !provided.has(type))) {
        throw new ConsentError('CONSENT_INVALID');
      }
      for (const document of acceptable) {
        await transaction
          .insert(consentRecord)
          .values({
            userId,
            documentId: document.id,
            docType: document.type,
            documentVersion: document.version,
            documentHash: document.contentHash,
          })
          .onConflictDoNothing({
            target: [consentRecord.userId, consentRecord.documentId],
          });
      }
      const accepted = await transaction
        .select({
          docType: consentRecord.docType,
          documentVersion: consentRecord.documentVersion,
          acceptedAt: consentRecord.acceptedAt,
        })
        .from(consentRecord)
        .where(eq(consentRecord.userId, userId))
        .orderBy(asc(consentRecord.docType));
      return {
        accepted: accepted.map((record) => ({
          type: record.docType,
          version: record.documentVersion,
          acceptedAt: record.acceptedAt,
        })),
      };
    });
  }

  /** Own acceptance history only; deterministic order (newest first, id as tiebreak). */
  async function historyFor(userId: string) {
    const records = await database.orm
      .select({
        id: consentRecord.id,
        type: consentRecord.docType,
        version: consentRecord.documentVersion,
        acceptedAt: consentRecord.acceptedAt,
      })
      .from(consentRecord)
      .where(eq(consentRecord.userId, userId))
      .orderBy(desc(consentRecord.acceptedAt), desc(consentRecord.id));
    return records.map(({ type, version, acceptedAt }) => ({ type, version, acceptedAt }));
  }

  /** Public document text (versioned, no session required). */
  async function documentText(type: LegalDocumentType, version: string) {
    const rows = await database.orm
      .select({ contentMd: legalDocument.contentMd })
      .from(legalDocument)
      .where(and(eq(legalDocument.docType, type), eq(legalDocument.version, version)))
      .limit(1);
    return rows[0]?.contentMd ?? null;
  }

  return { currentDocuments, statusFor, accept, historyFor, documentText };
}

export type ConsentsService = ReturnType<typeof createConsentsService>;

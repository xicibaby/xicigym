export type RecordType = 'food' | 'training' | 'body_checkin' | 'posture' | 'extra_activity';
export type RecordStatus = 'draft' | 'confirmed' | 'archived';
export type InputMethod = 'text' | 'voice' | 'photo' | 'form';
export type TrustLevel = 'user_confirmed' | 'calculated' | 'estimated' | 'missing' | 'unknown';
export type Intensity = 'low' | 'moderate' | 'high' | 'unknown';

export interface FoodItem {
  name: string;
  quantity?: number;
  unit?: string;
  caloriesKcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  brand?: string;
}
export interface FoodPayload {
  mealType?: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
  items?: FoodItem[];
  /** Legacy-compatible free-text field; prefer notes for new clients. */
  note?: string;
  notes?: string;
  consumedAt?: string;
}
export interface TrainingExercise {
  name: string;
  sets?: number;
  reps?: number;
  loadKg?: number;
  intensity?: string;
  restSeconds?: number;
  completed?: boolean;
}
export interface TrainingPayload {
  activityType?: string;
  exercises?: TrainingExercise[];
  durationMinutes?: number;
  intensity?: Intensity;
  perceivedExertion?: number;
  painReported?: boolean;
  painNotes?: string;
  notes?: string;
  startedAt?: string;
  endedAt?: string;
  equipment?: string;
}
export interface BodyCheckinPayload {
  sleepHours?: number;
  sleepQuality?: number;
  energy?: number;
  fatigue?: number;
  painLevel?: number;
  recovery?: number;
  soreness?: number;
  notes?: string;
  checkedAt?: string;
}
export interface PosturePayload {
  photoRefs?: string[];
  visibleFeatures?: string[];
  notes?: string;
  standardPhoto?: boolean;
  limitations?: string;
  capturedAt?: string;
}
export interface ExtraActivityPayload {
  activityType?: string;
  durationMinutes?: number;
  intensity?: Intensity;
  steps?: number;
  distanceKm?: number;
  notes?: string;
  startedAt?: string;
  endedAt?: string;
}
export type RecordPayload = FoodPayload | TrainingPayload | BodyCheckinPayload | PosturePayload | ExtraActivityPayload;

export interface FieldEvidence {
  field: string;
  trustLevel: TrustLevel;
  /** Required for estimated values; should explain the estimate basis. */
  reason?: string;
  /** Optional value snapshot; missing values should be null or omitted. */
  value?: unknown;
  source?: string;
}

export interface UnifiedRecord<TPayload extends RecordPayload = RecordPayload> {
  schemaVersion: number;
  recordId: string;
  userId: string;
  recordType: RecordType;
  status: RecordStatus;
  inputMethod: InputMethod;
  createdAt: string;
  updatedAt: string;
  revision: number;
  payload: TPayload;
  fieldEvidence: FieldEvidence[];
  metadata?: Record<string, unknown>;
}

export interface ValidationIssue { path: string; code: string; message: string }
export interface ValidationResult<T> { ok: boolean; errors: ValidationIssue[]; value?: T }
export const RECORD_TYPES: readonly RecordType[];
export const RECORD_STATUSES: readonly RecordStatus[];
export const INPUT_METHODS: readonly InputMethod[];
export const TRUST_LEVELS: readonly TrustLevel[];
export const RECORD_PAYLOAD_FIELDS: Readonly<Record<RecordType, readonly string[]>>;
export function validateRecord(input: unknown, options?: { requireComplete?: boolean }): ValidationResult<UnifiedRecord>;
export function validateRecordPayload(recordType: RecordType, payload: unknown, options?: { requireComplete?: boolean }): ValidationIssue[];
export function createRecordDraft(input: Partial<UnifiedRecord>): UnifiedRecord;

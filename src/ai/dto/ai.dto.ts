import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AI_PAGES, type AiPage } from '../product-knowledge';

/** Long enough for any real question; keeps every request to the model small */
export const MAX_AI_MESSAGE_LENGTH = 2000;

/** Languages of the interface — the assistant answers in the one the user reads */
export const AI_LOCALES = ['ru', 'en', 'ky'] as const;
export type AiLocale = (typeof AI_LOCALES)[number];

/**
 * The value exactly as sent (see RawValue: implicit conversion would turn an object
 * into the string "[object Object]"), trimmed when it is a string.
 */
const rawTrimmed = ({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}) => {
  const value = obj[key];
  return typeof value === 'string' ? value.trim() : value;
};

/**
 * POST /ai/conversations — without eventId (or null): a general conversation about the app.
 * With it: about that event; the recipient comes from my match in it, never from the request.
 */
export class CreateConversationDto {
  @IsOptional()
  @IsUUID('4', { message: 'Pick a Secret Santa event' })
  eventId?: string | null;
}

/** POST /ai/conversations/:id/messages */
export class SendMessageDto {
  @Transform(rawTrimmed)
  @IsString({ message: 'Write a message' })
  @IsNotEmpty({ message: 'Write a message' })
  @MaxLength(MAX_AI_MESSAGE_LENGTH, {
    message: `A message is ${MAX_AI_MESSAGE_LENGTH} characters max`,
  })
  content: string;

  @IsOptional()
  @IsIn(AI_LOCALES)
  locale?: AiLocale;

  /** The app page the user came from — one of a fixed list, never free text */
  @IsOptional()
  @IsIn(AI_PAGES)
  page?: AiPage;
}

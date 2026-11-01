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

export const MAX_AI_MESSAGE_LENGTH = 2000;
export const AI_LOCALES = ['ru', 'en', 'ky'] as const;
export type AiLocale = (typeof AI_LOCALES)[number];

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

export class CreateConversationDto {
  @IsOptional()
  @IsUUID('4', { message: 'Pick a Secret Santa event' })
  eventId?: string | null;
}

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

  @IsOptional()
  @IsIn(AI_PAGES)
  page?: AiPage;
}

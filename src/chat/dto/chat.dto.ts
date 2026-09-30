import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Long enough for any group-chat message; keeps every row and broadcast small */
export const MAX_CHAT_MESSAGE_LENGTH = 1000;

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

/** POST /events/:id/messages */
export class SendChatMessageDto {
  @Transform(rawTrimmed)
  @IsString({ message: 'Write a message' })
  @IsNotEmpty({ message: 'Write a message' })
  @MaxLength(MAX_CHAT_MESSAGE_LENGTH, {
    message: `A message is ${MAX_CHAT_MESSAGE_LENGTH} characters max`,
  })
  content: string;
}

/** GET /events/:id/messages?before=<message id> — the page of messages older than that one */
export class ListChatMessagesQuery {
  @IsOptional()
  @IsUUID('4')
  before?: string;
}

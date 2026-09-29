import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** "" from an emptied input means "no value" */
const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

// For every optional field: omitted = leave as is (PATCH), null = clear it.

export class CreateEventDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Give your event a name' })
  @MaxLength(80, { message: 'Event name is 80 characters max' })
  name: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(500, { message: 'Description is 500 characters max' })
  description?: string | null;

  /** YYYY-MM-DD — the day gifts are exchanged */
  @IsOptional()
  @Transform(trimOrNull)
  @IsDateString({ strict: true }, { message: 'Pick a valid date' })
  eventDate?: string | null;

  @IsOptional()
  @IsInt({ message: 'Budget must be a whole number' })
  @Min(0)
  @Max(10_000_000)
  budgetMin?: number | null;

  @IsOptional()
  @IsInt({ message: 'Budget must be a whole number' })
  @Min(0)
  @Max(10_000_000)
  budgetMax?: number | null;

  @IsOptional()
  @IsInt()
  @Min(3, { message: 'A Secret Santa needs at least 3 people' })
  @Max(500, { message: 'Up to 500 participants' })
  maxParticipants?: number | null;
}

/** PATCH — the same fields, all optional */
export class UpdateEventDto {
  // Omitted = unchanged; null is validated (and rejected) instead of reaching the NOT NULL column
  @ValidateIf((o: UpdateEventDto) => o.name !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Give your event a name' })
  @MaxLength(80, { message: 'Event name is 80 characters max' })
  name?: string;

  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(500, { message: 'Description is 500 characters max' })
  description?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsDateString({ strict: true }, { message: 'Pick a valid date' })
  eventDate?: string | null;

  @IsOptional()
  @IsInt({ message: 'Budget must be a whole number' })
  @Min(0)
  @Max(10_000_000)
  budgetMin?: number | null;

  @IsOptional()
  @IsInt({ message: 'Budget must be a whole number' })
  @Min(0)
  @Max(10_000_000)
  budgetMax?: number | null;

  @IsOptional()
  @IsInt()
  @Min(3, { message: 'A Secret Santa needs at least 3 people' })
  @Max(500, { message: 'Up to 500 participants' })
  maxParticipants?: number | null;
}

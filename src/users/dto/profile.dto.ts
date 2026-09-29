import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const MAX_INTERESTS = 20;
export const MAX_WISHLIST_ITEMS = 30;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** "" from an emptied input means "no value" */
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  return value.trim() || null;
};

/** Trimmed, empty ones dropped, duplicates removed ignoring case ("Coffee" = "coffee") */
const normalizeInterests = ({ value }: { value: unknown }) => {
  if (!Array.isArray(value)) return value;
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      result.push(item); // let @IsString reject it
      continue;
    }
    const interest = item.replace(/\s+/g, ' ').trim();
    const key = interest.toLowerCase();
    if (!interest || seen.has(key)) continue;
    seen.add(key);
    result.push(interest);
  }
  return result;
};

/** PATCH /profile — send only what changes */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(60, { message: 'Name is too long' })
  name?: string;

  @IsOptional()
  @Transform(normalizeInterests)
  @IsArray()
  @ArrayMaxSize(MAX_INTERESTS, {
    message: `Up to ${MAX_INTERESTS} interests`,
  })
  @IsString({ each: true })
  @MaxLength(30, { each: true, message: 'Each interest is 30 characters max' })
  interests?: string[];
}

/** Body for POST and PUT /profile/wishlist — PUT replaces the whole item */
export class WishlistItemDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Name the gift' })
  @MaxLength(120, { message: 'Gift name is 120 characters max' })
  title: string;

  // Whole сом; null / omitted = "no idea"
  @IsOptional()
  @IsInt({ message: 'Price must be a whole number' })
  @Min(0, { message: 'Price cannot be negative' })
  @Max(10_000_000, { message: 'Price looks too high' })
  priceApprox?: number | null;

  @IsOptional()
  @Transform(trimOrNull)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Link must start with http:// or https://' },
  )
  @MaxLength(2000)
  url?: string | null;
}

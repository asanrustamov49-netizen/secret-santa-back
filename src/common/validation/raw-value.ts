import { Transform } from 'class-transformer';

/**
 * Validate the value exactly as it arrived in the JSON body.
 *
 * The global ValidationPipe converts payloads implicitly to the declared type
 * (enableImplicitConversion — handy for "5" → 5 in query strings). For fields
 * where the type itself matters that is wrong: "false" would become `true`, and
 * a number 12345678 would pass as the 8-character password "12345678".
 */
export const RawValue = () =>
  Transform(
    ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key],
  );
